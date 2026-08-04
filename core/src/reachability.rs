//! « Est-ce que cet hôte atteint telle adresse, sur tel port ? »
//!
//! The question asked constantly during an incident, and the reason it is worth
//! a feature rather than a terminal: **a refusal and a silence are not the same
//! failure**. A refused connection means something answered — the port is
//! closed, the service is down, you are looking at the right machine. A silence
//! means nothing answered — a security group, a firewall rule, a missing route.
//! The remedies have nothing in common, and "it doesn't work" hides which one
//! you are in.
//!
//! Nothing is installed on the target: the probe is a small POSIX script built
//! here and run through the fleet executor, so it works on an SSH host, in a
//! Docker container, in a Kubernetes pod or on this machine without a separate
//! implementation for each.
//!
//! **All the classification happens in Rust, not in the script.** The script
//! reports which tool it used and that tool's exit code, and nothing else — so
//! the interesting half is a pure function over strings, testable against the
//! real wording of `bash`, `nc` and `curl` without a network.

use serde::Serialize;

/// How long the probe waits before calling a silence a silence.
///
/// Five seconds: long enough that a slow-but-working path isn't reported as
/// filtered, short enough to stay a diagnostic rather than a wait.
pub const PROBE_TIMEOUT_SECS: u8 = 5;

/// The marker the script prints, so the verdict is read off a token of ours
/// rather than off a message that changes with the tool, its version and the
/// machine's locale.
const MARKER: &str = "GUITERM-PROBE";

/// Rejects anything that isn't plainly a hostname or an IP literal.
///
/// This string is interpolated into a shell script, so this is the only thing
/// standing between a diagnostic and command execution on every host of a
/// fleet. Deliberately an allow-list — the same reasoning as the argument
/// white-listing in [`crate::adaptive`]: what a legitimate value looks like is
/// a short, closed description, while what a dangerous one looks like is not.
pub fn validate_host(host: &str) -> Result<(), String> {
    let host = host.trim();
    if host.is_empty() {
        return Err("Indiquer une adresse à joindre.".to_string());
    }
    if host.len() > 253 {
        return Err("Adresse trop longue pour être un nom d'hôte.".to_string());
    }
    // Letters, digits, dot, dash, underscore — plus the colons of an IPv6
    // literal and the brackets it is usually written with.
    if !host
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | ':' | '[' | ']'))
    {
        return Err(
            "Adresse invalide : seuls les lettres, chiffres, `.`, `-`, `_` et `:` sont acceptés."
                .to_string(),
        );
    }
    Ok(())
}

/// The script run on the target.
///
/// Three tools tried in order of how likely they are to be there and how much
/// they tell us. `bash`'s `/dev/tcp` needs no binary at all but must be bounded
/// by `timeout`, so it is only used when both are present — an unbounded probe
/// could hang a fleet run for as long as the connection takes to give up, which
/// on a dropped packet is minutes.
///
/// The script never decides anything: it prints the tool and its exit code for
/// [`parse_verdict`] to read. Single quotes are absent on purpose — the whole
/// thing is wrapped in `sh -c '…'` so it runs under POSIX sh whatever login
/// shell the target uses (fish included).
/// The `nc` form the probe uses.
///
/// `-v` matters more than it looks: without it, BSD `nc` in `-z` mode says
/// *nothing at all* — refusal or timeout, same empty output — and macOS has no
/// `timeout`, so that silent branch is the one every macOS host takes. Shared
/// with the integration test so it exercises this platform's real `nc` wording
/// rather than a copy that can drift from it.
pub fn nc_command(host: &str, port: &str, timeout_secs: u8) -> String {
    format!("nc -v -w {timeout_secs} -z {host} {port}")
}

pub fn probe_script(host: &str, port: u16, timeout_secs: u8) -> String {
    // Built from the shell's own variables, so the one place that knows how to
    // call `nc` is `nc_command` — including for the test that runs it for real.
    let nc = nc_command("$h", "$p", timeout_secs);
    let script = format!(
        "h={host}; p={port}; t={timeout_secs}; T=\"\"; \
         if command -v timeout >/dev/null 2>&1; then T=\"timeout $t\"; fi; \
         s=$(date +%s 2>/dev/null || echo 0); \
         if [ -n \"$T\" ] && command -v bash >/dev/null 2>&1; then \
         m=$($T bash -c \"exec 3<>/dev/tcp/$h/$p\" 2>&1); c=$?; v=bash; \
         elif command -v nc >/dev/null 2>&1; then \
         m=$({nc} 2>&1); c=$?; v=nc; \
         elif command -v curl >/dev/null 2>&1; then \
         m=$(curl -sS --connect-timeout $t -o /dev/null http://$h:$p/ 2>&1); c=$?; v=curl; \
         else v=notool; c=0; m=\"\"; fi; \
         e=$(date +%s 2>/dev/null || echo 0); \
         echo {MARKER} $v $c $((e-s)); echo \"$m\""
    );
    format!("sh -c '{script}'")
}

/// What the probe found.
///
/// A tagged union rather than a boolean and a message, because the four
/// failures have four different remedies — which is the entire point of asking.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Verdict {
    /// The TCP connection was established.
    Open { via: String },
    /// Something answered and said no: port closed, service down.
    Refused { via: String },
    /// Nothing answered at all: dropped on the way — firewall, security group,
    /// missing route.
    Filtered { via: String },
    /// The name doesn't resolve from that host, which is a different problem
    /// from the network entirely.
    UnknownHost { via: String },
    /// No route to the network the address is on.
    Unreachable { via: String },
    /// Neither `bash`+`timeout`, `nc` nor `curl` — nothing to probe with.
    NoTool,
    /// The probe itself couldn't be made sense of; the raw output is kept
    /// rather than forced into one of the categories above.
    Failed { message: String },
}

/// Reads the verdict out of the probe's output.
///
/// `stderr` matters as much as `stdout`: when the marker is missing entirely
/// the interesting text is whatever the shell said instead, and reporting
/// "unreadable" without it would throw away the only clue.
pub fn parse_verdict(stdout: &str, stderr: &str) -> Verdict {
    let Some(line) = stdout.lines().find(|line| line.trim_start().starts_with(MARKER)) else {
        let message = [stderr.trim(), stdout.trim()]
            .into_iter()
            .find(|text| !text.is_empty())
            .unwrap_or("La sonde n'a rien renvoyé.")
            .to_string();
        return Verdict::Failed { message };
    };
    let mut fields = line.split_whitespace().skip(1);
    let via = fields.next().unwrap_or_default().to_string();
    let code: i32 = fields.next().and_then(|c| c.parse().ok()).unwrap_or(-1);
    // Seconds the probe took. Absent from an older marker line, and `0` when
    // the host has no `date` — both fall back to the message-only rules.
    let elapsed: i64 = fields.next().and_then(|s| s.parse().ok()).unwrap_or(0);
    // Everything after the marker line is the tool's own output.
    let message: String = stdout
        .lines()
        .skip_while(|line| !line.trim_start().starts_with(MARKER))
        .skip(1)
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string();

    if via == "notool" {
        return Verdict::NoTool;
    }
    // 124 is what `timeout` exits with when it had to kill the probe: nothing
    // answered for the whole window, which is the definition of filtered.
    if code == 124 {
        return Verdict::Filtered { via };
    }
    match via.as_str() {
        "bash" | "nc" => classify_stream_tool(&via, code, &message, elapsed),
        "curl" => classify_curl(&via, code, &message),
        _ => Verdict::Failed {
            message: if message.is_empty() { line.to_string() } else { message },
        },
    }
}

fn classify_stream_tool(via: &str, code: i32, message: &str, elapsed: i64) -> Verdict {
    if code == 0 {
        return Verdict::Open { via: via.to_string() };
    }
    if let Some(verdict) = classify_message(via, message) {
        return verdict;
    }
    // No explanation from the tool — which is the ordinary case for BSD `nc`,
    // silent in `-z` mode, and therefore for every probe run from macOS (no
    // `timeout` there, so the `bash` branch never applies).
    //
    // The timing decides it, and it is a better witness than any message: a
    // refusal is a packet coming back, so it lands instantly, while a drop
    // costs the whole window by definition. Treating a silent failure as a
    // silence was wrong exactly the wrong way round — it reported a closed
    // port on a reachable machine as a firewall.
    if elapsed >= i64::from(PROBE_TIMEOUT_SECS) - 1 {
        return Verdict::Filtered { via: via.to_string() };
    }
    if message.is_empty() {
        return Verdict::Refused { via: via.to_string() };
    }
    Verdict::Failed { message: message.to_string() }
}

/// curl says what happened through its exit code, which is more reliable than
/// its message — and crucially it distinguishes "never connected" (7) from
/// "connected, then the exchange went nowhere" (52/55/56/18). The second family
/// is a *success* here: this asks about reaching a port, not about speaking
/// HTTP to it, and a database answering nonsense to an HTTP request is a
/// database that is reachable.
fn classify_curl(via: &str, code: i32, message: &str) -> Verdict {
    match code {
        0 | 18 | 52 | 55 | 56 => Verdict::Open { via: via.to_string() },
        28 => Verdict::Filtered { via: via.to_string() },
        6 => Verdict::UnknownHost { via: via.to_string() },
        7 => classify_message(via, message).unwrap_or(Verdict::Filtered { via: via.to_string() }),
        _ => Verdict::Failed {
            message: if message.is_empty() { format!("curl a rendu {code}") } else { message.to_string() },
        },
    }
}

/// The three failures that are worth telling apart, matched on the idea rather
/// than on one exact sentence: every tool words them differently, and several
/// word them differently across versions and locales.
fn classify_message(via: &str, message: &str) -> Option<Verdict> {
    let lowered = message.to_lowercase();
    let via = via.to_string();
    if lowered.contains("refused") || lowered.contains("refus") {
        return Some(Verdict::Refused { via });
    }
    if lowered.contains("no route to host")
        || lowered.contains("network is unreachable")
        || lowered.contains("host is unreachable")
    {
        return Some(Verdict::Unreachable { via });
    }
    if lowered.contains("name or service not known")
        || lowered.contains("could not resolve")
        || lowered.contains("nodename nor servname")
        || lowered.contains("temporary failure in name resolution")
        || lowered.contains("no address associated with hostname")
    {
        return Some(Verdict::UnknownHost { via });
    }
    if lowered.contains("timed out") || lowered.contains("timeout") {
        return Some(Verdict::Filtered { via });
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The value is interpolated into a shell script that then runs on every
    /// host of a fleet. This is the check that keeps a diagnostic from becoming
    /// remote code execution.
    #[test]
    fn refuses_anything_that_could_escape_the_script() {
        for hostile in [
            "example.com; rm -rf /",
            "$(whoami)",
            "`id`",
            "a b",
            "example.com\nwhoami",
            "example.com|nc attaquant 1234",
            "'",
        ] {
            assert!(validate_host(hostile).is_err(), "accepté à tort : {hostile:?}");
        }
    }

    #[test]
    fn accepts_the_addresses_people_actually_type() {
        for legitimate in ["example.com", "10.0.4.12", "db-1.internal", "srv_01", "::1", "[fe80::1]"] {
            assert!(validate_host(legitimate).is_ok(), "refusé à tort : {legitimate}");
        }
        assert!(validate_host("  ").is_err(), "le vide n'est pas une adresse");
    }

    /// The script is wrapped in `sh -c '…'`; one single quote inside would end
    /// the quoting and hand the rest to the login shell.
    #[test]
    fn the_script_contains_no_single_quote_of_its_own() {
        let script = probe_script("10.0.4.12", 443, PROBE_TIMEOUT_SECS);
        assert_eq!(script.matches('\'').count(), 2, "seules les deux du sh -c : {script}");
        assert!(script.contains("h=10.0.4.12"));
        assert!(script.contains("p=443"));
    }

    /// The timing is what tells a refusal from a silence on a host whose tools
    /// say nothing — so the script has to measure it, on a `date` that every
    /// POSIX shell has.
    #[test]
    fn the_script_times_the_probe() {
        let script = probe_script("10.0.4.12", 443, PROBE_TIMEOUT_SECS);
        assert!(script.contains("date +%s"), "obtenu : {script}");
        assert!(script.contains("$((e-s))"), "l'écart doit être renvoyé : {script}");
    }

    /// A probe that came back instantly — the ordinary shape of a failure that
    /// had an answer.
    fn probe(via: &str, code: i32, message: &str) -> Verdict {
        probe_after(via, code, message, 0)
    }

    fn probe_after(via: &str, code: i32, message: &str, elapsed: i64) -> Verdict {
        parse_verdict(&format!("{MARKER} {via} {code} {elapsed}\n{message}\n"), "")
    }

    #[test]
    fn an_established_connection_reads_as_open() {
        assert_eq!(probe("bash", 0, ""), Verdict::Open { via: "bash".to_string() });
        assert_eq!(probe("nc", 0, ""), Verdict::Open { via: "nc".to_string() });
    }

    /// The distinction the whole feature exists for: something answered "no"
    /// versus nothing answered at all. Wordings taken from the real tools.
    #[test]
    fn a_refusal_and_a_silence_are_told_apart() {
        assert_eq!(
            probe("bash", 1, "bash: connect: Connection refused"),
            Verdict::Refused { via: "bash".to_string() }
        );
        assert_eq!(
            probe("nc", 1, "nc: connect to 10.0.4.12 port 443 (tcp) failed: Connection refused"),
            Verdict::Refused { via: "nc".to_string() }
        );
        // `timeout` had to kill it: nothing came back for the whole window.
        assert_eq!(probe("bash", 124, ""), Verdict::Filtered { via: "bash".to_string() });
        // `nc -w` gives up on its own, without a word — but it took the whole
        // window to do it, which is what says nothing came back.
        assert_eq!(
            probe_after("nc", 1, "", i64::from(PROBE_TIMEOUT_SECS)),
            Verdict::Filtered { via: "nc".to_string() }
        );
    }

    /// The failure the macOS CI found. There is no `timeout` on macOS, so the
    /// probe falls to `nc` — and BSD `nc -z` says nothing at all, refusal or
    /// not. Reading that silence as "filtered" reported a closed port on a
    /// perfectly reachable machine as a firewall: the exact opposite of the
    /// answer, and the one distinction this feature exists to make.
    ///
    /// The timing settles it: a refusal is a packet coming back, so it is
    /// instant; a drop costs the whole window.
    #[test]
    fn a_silent_tool_is_read_by_its_timing_not_by_its_silence() {
        assert_eq!(
            probe_after("nc", 1, "", 0),
            Verdict::Refused { via: "nc".to_string() },
            "échec immédiat et muet = quelque chose a répondu"
        );
        assert_eq!(
            probe_after("nc", 1, "", i64::from(PROBE_TIMEOUT_SECS) - 1),
            Verdict::Filtered { via: "nc".to_string() },
            "une seconde de marge : `date` ne compte qu'en secondes entières"
        );
    }

    /// A message always wins over the timing — it is the tool saying what
    /// happened rather than us inferring it.
    #[test]
    fn an_explanation_beats_the_stopwatch() {
        assert_eq!(
            probe_after("nc", 1, "nc: connect failed: Connection refused", i64::from(PROBE_TIMEOUT_SECS)),
            Verdict::Refused { via: "nc".to_string() },
            "un refus lent reste un refus"
        );
    }

    #[test]
    fn a_name_that_does_not_resolve_is_not_a_network_problem() {
        assert_eq!(
            probe("bash", 1, "bash: db-1.internal: Name or service not known"),
            Verdict::UnknownHost { via: "bash".to_string() }
        );
        assert_eq!(
            probe("curl", 6, "curl: (6) Could not resolve host: db-1.internal"),
            Verdict::UnknownHost { via: "curl".to_string() }
        );
    }

    #[test]
    fn a_missing_route_is_its_own_answer() {
        assert_eq!(
            probe("bash", 1, "bash: connect: No route to host"),
            Verdict::Unreachable { via: "bash".to_string() }
        );
        assert_eq!(
            probe("nc", 1, "nc: connect to 10.9.9.9 port 22 (tcp) failed: Network is unreachable"),
            Verdict::Unreachable { via: "nc".to_string() }
        );
    }

    /// Reaching a port is the question; speaking HTTP to it is not. A database
    /// answering nonsense to an HTTP request is a database that is reachable,
    /// and reporting that as a failure would be wrong for every non-HTTP port —
    /// which is most of them.
    #[test]
    fn curl_reaching_a_port_that_does_not_speak_http_is_still_open() {
        assert_eq!(
            probe("curl", 52, "curl: (52) Empty reply from server"),
            Verdict::Open { via: "curl".to_string() }
        );
        assert_eq!(probe("curl", 56, "curl: (56) Recv failure"), Verdict::Open { via: "curl".to_string() });
        assert_eq!(probe("curl", 28, "curl: (28) Connection timed out"), Verdict::Filtered { via: "curl".to_string() });
        assert_eq!(
            probe("curl", 7, "curl: (7) Failed to connect to 10.0.4.12 port 443: Connection refused"),
            Verdict::Refused { via: "curl".to_string() }
        );
    }

    #[test]
    fn a_host_with_nothing_to_probe_with_says_so() {
        assert_eq!(probe("notool", 0, ""), Verdict::NoTool);
    }

    /// A shell that refused the script leaves no marker at all. Its own words
    /// are the only clue there is, so they must survive.
    #[test]
    fn output_without_the_marker_keeps_the_shells_own_words() {
        let verdict = parse_verdict("", "sh: 1: command not found");
        assert_eq!(verdict, Verdict::Failed { message: "sh: 1: command not found".to_string() });
    }

    /// `rename_all` on an internally-tagged enum renames variants, never the
    /// fields of a struct variant — asserted on real JSON, since a Rust round
    /// trip proves nothing about what the frontend reads.
    #[test]
    fn the_json_carries_the_camel_cased_tag_the_frontend_reads() {
        let json = serde_json::to_value(Verdict::Refused { via: "nc".to_string() }).unwrap();
        assert_eq!(json["kind"], "refused");
        assert_eq!(json["via"], "nc");
        assert_eq!(serde_json::to_value(Verdict::NoTool).unwrap()["kind"], "noTool");
        let failed = serde_json::to_value(Verdict::Failed { message: "x".to_string() }).unwrap();
        assert_eq!(failed["kind"], "failed");
        assert_eq!(failed["message"], "x");
    }
}
