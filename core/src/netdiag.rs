//! Network diagnostics run across a fleet: « depuis ces machines, qu'est-ce
//! qui répond ? »
//!
//! The generalisation of [`crate::reachability`], which answers the same
//! question for one tool (a TCP connect). Everything that made that module
//! work is kept rather than rebuilt:
//!
//! - **Nothing is installed on the target.** Each tool is a small script built
//!   here and run through the fleet executor, so an SSH host, a Docker
//!   container, a Kubernetes pod and this machine need no separate
//!   implementation.
//! - **The script classifies nothing.** It reports which tool it found, that
//!   tool's exit code and how long it took, then its raw output. Every verdict
//!   is a pure function over strings in Rust — testable against the real
//!   wording of `dig`, `curl` and friends without a network.
//! - **A refusal and a silence are different failures**, and so are a name that
//!   doesn't resolve and a network with no route. Folding them into "it didn't
//!   work" throws away the only thing that tells you what to fix.
//!
//! **Two flavours, not one.** `default_local_shell()` is `powershell.exe` on
//! Windows, so the moment the local machine is one of the sources — "do *I*
//! reach it", which is half of what anyone asks during an incident — a POSIX
//! script is handed to PowerShell and does nothing useful. [`Flavour`] picks
//! the right script per target. (The same gap exists today in
//! `reachability`'s own local path on Windows.)

use crate::reachability;
use serde::{Deserialize, Serialize};

/// The marker each script prints, so a verdict is read off a token of ours
/// rather than off a message that changes with the tool, its version and the
/// machine's locale.
const MARKER: &str = "GUITERM-NETDIAG";

/// How long a connect-style probe waits before calling a silence a silence.
pub const TCP_TIMEOUT_SECS: u8 = reachability::PROBE_TIMEOUT_SECS;
/// DNS resolution is either quick or broken; a long wait tells you nothing new.
pub const DNS_TIMEOUT_SECS: u8 = 5;
/// HTTP gets longer: a slow application is a real answer, not a timeout.
pub const HTTP_TIMEOUT_SECS: u8 = 10;

/// Which shell dialect a target speaks.
///
/// Chosen per target rather than per run: a fleet routinely mixes Linux hosts
/// with this Windows machine, and one run has to cope with both.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Flavour {
    Posix,
    Powershell,
}

/// Which dialect a target speaks, given the shell the local machine would use.
///
/// Takes `local_shell` rather than reading it, so the decision is testable from
/// any platform — this repo's tests run on Linux, and the case that matters is
/// the Windows one.
pub fn flavour_for_shell(target: &crate::fleet::FleetTarget, local_shell: &str) -> Flavour {
    match target {
        // Only the local machine can be non-POSIX: an SSH host, a Docker
        // container and a Kubernetes pod all get a POSIX shell by definition of
        // how the fleet executor reaches them.
        crate::fleet::FleetTarget::Local
            if crate::local_shell::is_windows_native_shell(local_shell) =>
        {
            Flavour::Powershell
        }
        _ => Flavour::Posix,
    }
}

/// The flavour to use for `target` on this machine.
pub fn flavour_for(target: &crate::fleet::FleetTarget) -> Flavour {
    flavour_for_shell(target, &crate::local_shell::default_local_shell())
}

/// One diagnostic to run.
///
/// `rename_all_fields` rather than `rename_all` alone: on an internally tagged
/// enum the latter renames only the variant names, never the struct variants'
/// fields — the trap this repo has hit six times.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum DiagTool {
    /// A TCP connect — what `telnet host port` is used for.
    Tcp { port: u16 },
    /// Name resolution, from the target's own resolver.
    Dns,
    /// An HTTP(S) request: status, time, and whether the certificate verified.
    Http {
        secure: bool,
        /// `None` uses the scheme's default (80/443).
        port: Option<u16>,
        /// Request path, always starting with `/`.
        path: String,
    },
    /// ICMP echo. Frequently unavailable — it needs a privileged socket, and
    /// slim container images ship no `ping` at all — which is reported as
    /// [`DiagVerdict::Unavailable`] rather than as a failure.
    Ping { count: u8 },
    /// The path taken, hop by hop. The slowest tool here by a wide margin, and
    /// the least often installed.
    Traceroute { max_hops: u8 },
}

impl DiagTool {
    /// A stable short name, used as a column heading and in results.
    pub fn label(&self) -> String {
        match self {
            Self::Tcp { port } => format!("TCP {port}"),
            Self::Dns => "DNS".to_string(),
            Self::Http { secure, port, .. } => match port {
                Some(port) => format!("HTTP{} {port}", if *secure { "S" } else { "" }),
                None => format!("HTTP{}", if *secure { "S" } else { "" }),
            },
            Self::Ping { .. } => "Ping".to_string(),
            Self::Traceroute { .. } => "Traceroute".to_string(),
        }
    }

    /// How long this tool may take, which is what a caller has to budget for.
    ///
    /// Traceroute is the reason results stream rather than arrive in a batch:
    /// it is an order of magnitude slower than everything else here.
    pub fn timeout_secs(&self) -> u16 {
        match self {
            Self::Tcp { .. } => u16::from(TCP_TIMEOUT_SECS),
            Self::Dns => u16::from(DNS_TIMEOUT_SECS),
            Self::Http { .. } => u16::from(HTTP_TIMEOUT_SECS),
            Self::Ping { count } => u16::from(*count) * 2 + 5,
            Self::Traceroute { max_hops } => u16::from(*max_hops) * 3 + 10,
        }
    }
}

/// What one tool found on one target.
///
/// Seven variants rather than a boolean and a message, because seven different
/// things to do next. A closed port is not a filtered one; a name that doesn't
/// resolve is not a network problem; a missing tool is not a failed test.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum DiagVerdict {
    /// It worked. `summary` is the short answer — a latency, a status, the
    /// addresses resolved.
    Ok { summary: String },
    /// Something answered and said no: a closed port, an HTTP 4xx/5xx.
    Refused { summary: String },
    /// Nothing answered at all: dropped on the way — firewall, security group,
    /// missing route.
    Silent { summary: String },
    /// The tool ran and produced something, but it doesn't settle the question.
    ///
    /// Exists for traceroute, where it is the *normal* outcome: most routers
    /// and firewalls on the public internet drop traceroute probes, so a trace
    /// that ends in asterisks says nothing about whether the destination is
    /// reachable — and reporting that as a silence, in red, next to an HTTP 301
    /// in green is a contradiction the app invented rather than observed.
    Inconclusive { summary: String },
    /// The name doesn't resolve from that target, which is a different problem
    /// from the network entirely.
    UnknownHost,
    /// No route to the network that address is on.
    Unreachable,
    /// Nothing on that target can answer this question — no `dig`, no `curl`.
    /// Reported as its own thing rather than as a failure: the target is fine,
    /// the question just can't be asked there. Common in slim containers.
    Unavailable { tool: String },
    /// The probe itself couldn't be run or couldn't be made sense of; the raw
    /// output is kept rather than forced into a category above.
    Failed { message: String },
}

/// Rejects a request path that isn't plainly a path.
///
/// The second interpolation point, after the address. `validate_host` guards
/// the destination; without this, a path is just as good a way into the shell
/// script — and it is a free-text field the user types.
pub fn validate_path(path: &str) -> Result<(), String> {
    if path.is_empty() {
        return Ok(());
    }
    if !path.starts_with('/') {
        return Err("Le chemin doit commencer par « / ».".to_string());
    }
    if path.len() > 1024 {
        return Err("Chemin trop long.".to_string());
    }
    // An allow-list, same reasoning as `reachability::validate_host`: what a
    // legitimate path looks like is a short closed description, what a
    // dangerous one looks like is not.
    if !path
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '.' | '-' | '_' | '~' | '=' | '&' | '?' | '+' | '%' | ':' | ','))
    {
        return Err("Chemin invalide : caractère non autorisé.".to_string());
    }
    Ok(())
}

/// Validates everything a run interpolates into a script.
pub fn validate(destination: &str, tools: &[DiagTool]) -> Result<(), String> {
    reachability::validate_host(destination)?;
    if tools.is_empty() {
        return Err("Choisir au moins un diagnostic.".to_string());
    }
    for tool in tools {
        match tool {
            DiagTool::Tcp { port } if *port == 0 => {
                return Err("Indiquer un port entre 1 et 65535.".to_string())
            }
            DiagTool::Http { path, port, .. } => {
                validate_path(path)?;
                if matches!(port, Some(0)) {
                    return Err("Indiquer un port entre 1 et 65535.".to_string());
                }
            }
            _ => {}
        }
    }
    Ok(())
}

/// The URL an HTTP tool requests against `destination`.
fn http_url(destination: &str, secure: bool, port: Option<u16>, path: &str) -> String {
    let scheme = if secure { "https" } else { "http" };
    let authority = match port {
        Some(port) => format!("{destination}:{port}"),
        None => destination.to_string(),
    };
    let path = if path.is_empty() { "/" } else { path };
    format!("{scheme}://{authority}{path}")
}

// ─── Scripts ─────────────────────────────────────────────────────────────

/// The command to run for one tool on one target.
///
/// Callers must have run [`validate`] first: `destination` and any path are
/// interpolated into a shell script, and that validation is the only thing
/// between a diagnostic and command execution across a whole fleet.
pub fn script(tool: &DiagTool, destination: &str, flavour: Flavour) -> String {
    match (tool, flavour) {
        // Delegated wholesale rather than rewritten: this is the same question
        // `reachability` already answers, with the tool-fallback chain and the
        // classification it took real incidents to get right.
        (DiagTool::Tcp { port }, Flavour::Posix) => {
            reachability::probe_script(destination, *port, TCP_TIMEOUT_SECS)
        }
        (DiagTool::Tcp { port }, Flavour::Powershell) => powershell_tcp(destination, *port),
        (DiagTool::Dns, Flavour::Posix) => posix_dns(destination),
        (DiagTool::Dns, Flavour::Powershell) => powershell_dns(destination),
        (DiagTool::Ping { count }, Flavour::Posix) => posix_ping(destination, *count),
        (DiagTool::Ping { count }, Flavour::Powershell) => powershell_ping(destination, *count),
        (DiagTool::Traceroute { max_hops }, Flavour::Posix) => posix_traceroute(destination, *max_hops),
        (DiagTool::Traceroute { max_hops }, Flavour::Powershell) => {
            powershell_traceroute(destination, *max_hops)
        }
        (DiagTool::Http { secure, port, path }, flavour) => {
            let url = http_url(destination, *secure, *port, path);
            // curl on both sides: Windows 10 1803+ ships `curl.exe`, so one
            // invocation and one parser cover both flavours. Where it is
            // missing the script says `notool`, which reads as "can't ask
            // here" rather than as a failure.
            match flavour {
                Flavour::Posix => posix_http(&url),
                Flavour::Powershell => powershell_http(&url),
            }
        }
    }
}

/// `sh -c`-wrapped POSIX DNS lookup, preferring whatever the target has.
fn posix_dns(destination: &str) -> String {
    let t = DNS_TIMEOUT_SECS;
    let script = format!(
        "h={destination}; t={t}; T=\"\"; \
         if command -v timeout >/dev/null 2>&1; then T=\"timeout $t\"; fi; \
         s=$(date +%s 2>/dev/null || echo 0); \
         if command -v getent >/dev/null 2>&1; then \
         m=$($T getent ahosts \"$h\" 2>&1); c=$?; v=getent; \
         elif command -v dig >/dev/null 2>&1; then \
         m=$($T dig +short \"$h\" 2>&1); c=$?; v=dig; \
         elif command -v nslookup >/dev/null 2>&1; then \
         m=$($T nslookup \"$h\" 2>&1); c=$?; v=nslookup; \
         else v=notool; c=0; m=\"\"; fi; \
         e=$(date +%s 2>/dev/null || echo 0); \
         echo {MARKER} $v $c $((e-s)); echo \"$m\""
    );
    format!("sh -c '{script}'")
}

/// The `-w` format both flavours share, so one parser reads both.
const CURL_FORMAT: &str = "%{http_code} %{time_total}";

fn posix_http(url: &str) -> String {
    let t = HTTP_TIMEOUT_SECS;
    let script = format!(
        "u={url}; t={t}; \
         s=$(date +%s 2>/dev/null || echo 0); \
         if command -v curl >/dev/null 2>&1; then \
         m=$(curl -sS -o /dev/null -w \"{CURL_FORMAT}\" --max-time $t \"$u\" 2>&1); c=$?; v=curl; \
         else v=notool; c=0; m=\"\"; fi; \
         e=$(date +%s 2>/dev/null || echo 0); \
         echo {MARKER} $v $c $((e-s)); echo \"$m\""
    );
    format!("sh -c '{script}'")
}

fn powershell_http(url: &str) -> String {
    let t = HTTP_TIMEOUT_SECS;
    // `curl.exe`, never the `curl` alias — in Windows PowerShell that name is
    // an alias for `Invoke-WebRequest`, which takes none of these flags and
    // would fail in a way that looks like the site is down.
    format!(
        "$ErrorActionPreference='SilentlyContinue'; \
         $s=Get-Date; \
         if (Get-Command curl.exe -ErrorAction SilentlyContinue) {{ \
         $m=(& curl.exe -sS -o NUL -w '{CURL_FORMAT}' --max-time {t} '{url}' 2>&1 | Out-String); $c=$LASTEXITCODE; $v='curl' \
         }} else {{ $v='notool'; $c=0; $m='' }}; \
         $e=Get-Date; \
         Write-Output \"{MARKER} $v $c $([int]($e-$s).TotalSeconds)\"; \
         Write-Output $m"
    )
}

fn posix_ping(destination: &str, count: u8) -> String {
    let deadline = u16::from(count) * 2 + 3;
    let script = format!(
        "h={destination}; n={count}; \
         s=$(date +%s 2>/dev/null || echo 0); \
         if command -v ping >/dev/null 2>&1; then \
         m=$(ping -c $n -w {deadline} \"$h\" 2>&1 || ping -c $n \"$h\" 2>&1); c=$?; v=ping; \
         else v=notool; c=0; m=\"\"; fi; \
         e=$(date +%s 2>/dev/null || echo 0); \
         echo {MARKER} $v $c $((e-s)); echo \"$m\""
    );
    format!("sh -c '{script}'")
}

/// `-w` is a GNU/iputils flag; busybox and BSD `ping` reject it, hence the
/// second attempt without it. Without that fallback an Alpine container — the
/// most common slim image there is — would report every host as unreachable.
fn powershell_ping(destination: &str, count: u8) -> String {
    format!(
        "$ErrorActionPreference='SilentlyContinue'; \
         $s=Get-Date; $v='ping'; \
         $m=(& ping.exe -n {count} '{destination}' 2>&1 | Out-String); $c=$LASTEXITCODE; \
         $e=Get-Date; \
         Write-Output \"{MARKER} $v $c $([int]($e-$s).TotalSeconds)\"; \
         Write-Output $m"
    )
}

fn posix_traceroute(destination: &str, max_hops: u8) -> String {
    let script = format!(
        "h={destination}; \
         s=$(date +%s 2>/dev/null || echo 0); \
         if command -v traceroute >/dev/null 2>&1; then \
         m=$(traceroute -n -m {max_hops} -w 2 \"$h\" 2>&1); c=$?; v=traceroute; \
         elif command -v tracepath >/dev/null 2>&1; then \
         m=$(tracepath -n -m {max_hops} \"$h\" 2>&1); c=$?; v=tracepath; \
         else v=notool; c=0; m=\"\"; fi; \
         e=$(date +%s 2>/dev/null || echo 0); \
         echo {MARKER} $v $c $((e-s)); echo \"$m\""
    );
    format!("sh -c '{script}'")
}

fn powershell_traceroute(destination: &str, max_hops: u8) -> String {
    format!(
        "$ErrorActionPreference='SilentlyContinue'; \
         $s=Get-Date; $v='tracert'; \
         $m=(& tracert.exe -d -h {max_hops} -w 2000 '{destination}' 2>&1 | Out-String); $c=$LASTEXITCODE; \
         $e=Get-Date; \
         Write-Output \"{MARKER} $v $c $([int]($e-$s).TotalSeconds)\"; \
         Write-Output $m"
    )
}

fn powershell_tcp(destination: &str, port: u16) -> String {
    // .NET rather than `Test-NetConnection`: the cmdlet has no usable timeout
    // (it can hang for tens of seconds on a filtered port, which is exactly
    // the case worth reporting quickly) and isn't present on every edition.
    let ms = u32::from(TCP_TIMEOUT_SECS) * 1000;
    format!(
        "$ErrorActionPreference='SilentlyContinue'; \
         $s=Get-Date; $v='dotnet'; $c=0; $m=''; \
         try {{ \
         $cl=New-Object System.Net.Sockets.TcpClient; \
         $r=$cl.BeginConnect('{destination}',{port},$null,$null); \
         if ($r.AsyncWaitHandle.WaitOne({ms})) {{ \
         try {{ $cl.EndConnect($r); $c=0; $m='connected' }} catch {{ $c=1; $m=$_.Exception.Message }} \
         }} else {{ $c=124; $m='timeout' }}; \
         $cl.Close() \
         }} catch {{ $c=2; $m=$_.Exception.Message }}; \
         $e=Get-Date; \
         Write-Output \"{MARKER} $v $c $([int]($e-$s).TotalSeconds)\"; \
         Write-Output $m"
    )
}

fn powershell_dns(destination: &str) -> String {
    // `[System.Net.Dns]` rather than `Resolve-DnsName`: the cmdlet lives in an
    // optional Windows feature, and its absence would read as a DNS failure.
    format!(
        "$ErrorActionPreference='SilentlyContinue'; \
         $s=Get-Date; $v='dotnet'; \
         try {{ $a=[System.Net.Dns]::GetHostAddresses('{destination}'); $c=0; \
         $m=(($a | ForEach-Object {{ $_.IPAddressToString }}) -join ' ') }} \
         catch {{ $c=1; $m=$_.Exception.Message }}; \
         $e=Get-Date; \
         Write-Output \"{MARKER} $v $c $([int]($e-$s).TotalSeconds)\"; \
         Write-Output $m"
    )
}

// ─── Parsing ─────────────────────────────────────────────────────────────

/// The marker line's fields, plus everything the tool printed after it.
struct Reported {
    via: String,
    code: i32,
    body: String,
}

fn read_marker(stdout: &str, stderr: &str) -> Result<Reported, DiagVerdict> {
    let Some(line) = stdout.lines().find(|l| l.trim_start().starts_with(MARKER)) else {
        // The marker missing means the script never ran to the end; whatever
        // the shell said instead is the only clue there is.
        let message = [stderr.trim(), stdout.trim()]
            .into_iter()
            .find(|text| !text.is_empty())
            .unwrap_or("Le diagnostic n'a rien renvoyé.")
            .to_string();
        return Err(DiagVerdict::Failed { message });
    };
    let mut fields = line.split_whitespace().skip(1);
    let via = fields.next().unwrap_or_default().to_string();
    let code: i32 = fields.next().and_then(|c| c.parse().ok()).unwrap_or(-1);
    let body = stdout
        .lines()
        .skip_while(|l| !l.trim_start().starts_with(MARKER))
        .skip(1)
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string();
    Ok(Reported { via, code, body })
}

/// Reads the verdict out of one tool's output.
pub fn parse(tool: &DiagTool, flavour: Flavour, stdout: &str, stderr: &str) -> DiagVerdict {
    // The POSIX TCP probe is `reachability`'s, so its reading is too — down to
    // the exit codes and wording it already classifies correctly.
    if matches!((tool, flavour), (DiagTool::Tcp { .. }, Flavour::Posix)) {
        return from_reachability(reachability::parse_verdict(stdout, stderr));
    }
    let reported = match read_marker(stdout, stderr) {
        Ok(reported) => reported,
        Err(verdict) => return verdict,
    };
    if reported.via == "notool" {
        return DiagVerdict::Unavailable { tool: missing_tool_for(tool) };
    }
    match tool {
        DiagTool::Tcp { .. } => parse_powershell_tcp(&reported),
        DiagTool::Dns => parse_dns(&reported),
        DiagTool::Http { .. } => parse_http(&reported),
        DiagTool::Ping { .. } => parse_ping(&reported),
        DiagTool::Traceroute { max_hops } => parse_traceroute(&reported, *max_hops),
    }
}

/// Everything the tool itself printed, marker line excluded.
///
/// What the UI unfolds under a cell. Traceroute is the reason it exists — a
/// hop count is a summary of the one output people actually want to read line
/// by line — but every tool benefits from being inspectable rather than
/// reduced to a verdict.
pub fn body_of(stdout: &str, stderr: &str) -> String {
    let body = match stdout.lines().position(|l| l.trim_start().starts_with(MARKER)) {
        Some(index) => stdout.lines().skip(index + 1).collect::<Vec<_>>().join("\n"),
        // No marker: the script never got that far, so its raw output is all
        // there is — and that is exactly when it matters most.
        None => stdout.to_string(),
    };
    let combined = match (body.trim(), stderr.trim()) {
        (b, "") => b.to_string(),
        ("", e) => e.to_string(),
        (b, e) => format!("{b}\n{e}"),
    };
    // Capped: a traceroute is thirty lines, but a tool that goes wrong can
    // print megabytes, and this travels through an event to the webview.
    const MAX: usize = 8_000;
    if combined.len() > MAX {
        let mut cut = MAX;
        while cut > 0 && !combined.is_char_boundary(cut) {
            cut -= 1;
        }
        format!("{}\n… (sortie tronquée)", &combined[..cut])
    } else {
        combined
    }
}

/// What to name in "no tool available here".
fn missing_tool_for(tool: &DiagTool) -> String {
    match tool {
        DiagTool::Tcp { .. } => "bash, nc ou curl".to_string(),
        DiagTool::Dns => "getent, dig ou nslookup".to_string(),
        DiagTool::Http { .. } => "curl".to_string(),
        DiagTool::Ping { .. } => "ping".to_string(),
        DiagTool::Traceroute { .. } => "traceroute ou tracepath".to_string(),
    }
}

/// Reads a ping run, whichever `ping` produced it.
///
/// **A non-zero exit is not enough to call it a failure**: `ping` exits 1 when
/// *some* packets were lost as well as when all were, and reporting partial
/// loss as "unreachable" would hide the more interesting answer — a link that
/// works badly, which is exactly what someone reaches for ping to find.
fn parse_ping(reported: &Reported) -> DiagVerdict {
    let lowered = reported.body.to_lowercase();
    // Said by iputils, BSD and Windows alike, in that order of wording.
    if lowered.contains("unknown host")
        || lowered.contains("name or service not known")
        || lowered.contains("could not find host")
        || lowered.contains("cannot resolve")
    {
        return DiagVerdict::UnknownHost;
    }
    if lowered.contains("network is unreachable") || lowered.contains("réseau inaccessible") {
        return DiagVerdict::Unreachable;
    }

    let received = ping_received(&reported.body);
    let latency = ping_average_ms(&reported.body);
    match (received, latency) {
        // Nothing came back at all: silence, not a refusal.
        (Some(0), _) => DiagVerdict::Silent {
            summary: "aucune réponse".to_string(),
        },
        (Some(received), Some(ms)) => DiagVerdict::Ok {
            summary: format!("{received} rép., {ms:.0} ms"),
        },
        (Some(received), None) => DiagVerdict::Ok {
            summary: format!("{received} réponse(s)"),
        },
        // No statistics line to read. `ping` prints one on every platform when
        // it ran at all, so its absence means something else went wrong.
        (None, _) if reported.code == 0 => DiagVerdict::Ok {
            summary: "répond".to_string(),
        },
        (None, _) => DiagVerdict::Failed {
            message: if reported.body.is_empty() {
                format!("ping a quitté avec le code {}.", reported.code)
            } else {
                reported.body.clone()
            },
        },
    }
}

/// Packets received, from the statistics line each `ping` prints.
///
/// Three wordings: iputils/BSD `"N packets transmitted, M received"`, Windows
/// English `"Received = M"`, Windows French `"Reçus = M"`.
fn ping_received(body: &str) -> Option<u32> {
    for line in body.lines() {
        let lowered = line.to_lowercase();
        if let Some(index) = lowered.find(" received") {
            // "4 packets transmitted, 4 received, 0% packet loss"
            if let Some(value) = lowered[..index].split_whitespace().last().and_then(|v| v.parse().ok()) {
                return Some(value);
            }
        }
        for marker in ["received = ", "reçus = ", "recus = "] {
            if let Some(rest) = lowered.split(marker).nth(1) {
                let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
                if let Ok(value) = digits.parse() {
                    return Some(value);
                }
            }
        }
    }
    None
}

/// Average round-trip time, from whichever summary line carries it.
fn ping_average_ms(body: &str) -> Option<f64> {
    for line in body.lines() {
        let lowered = line.to_lowercase();
        // iputils / BSD: "rtt min/avg/max/mdev = 0.041/0.052/0.068/0.010 ms"
        if lowered.contains("min/avg/max") {
            let values = lowered.split('=').nth(1)?.trim();
            let avg = values.split('/').nth(1)?;
            return avg.replace(',', ".").trim().parse().ok();
        }
        // Windows: "Average = 24ms" / "Moyenne = 24ms"
        for marker in ["average = ", "moyenne = "] {
            if let Some(rest) = lowered.split(marker).nth(1) {
                let digits: String = rest
                    .chars()
                    .take_while(|c| c.is_ascii_digit() || *c == '.' || *c == ',')
                    .collect();
                if let Ok(value) = digits.replace(',', ".").parse() {
                    return Some(value);
                }
            }
        }
    }
    None
}

/// Reads a traceroute, summarising it to what fits in a cell.
///
/// The full output stays available — the point of the summary is that a column
/// can't hold thirty hops, not that the hops don't matter.
fn parse_traceroute(reported: &Reported, max_hops: u8) -> DiagVerdict {
    let lowered = reported.body.to_lowercase();
    if lowered.contains("unknown host")
        || lowered.contains("name or service not known")
        || lowered.contains("unable to resolve")
        || lowered.contains("impossible de résoudre")
    {
        return DiagVerdict::UnknownHost;
    }
    if lowered.contains("network is unreachable") {
        return DiagVerdict::Unreachable;
    }

    let hops = traceroute_hops(&reported.body);
    if hops == 0 {
        return DiagVerdict::Failed {
            message: if reported.body.is_empty() {
                format!("traceroute a quitté avec le code {}.", reported.code)
            } else {
                reported.body.clone()
            },
        };
    }
    // A trace ending in timeouts did not arrive — but that is **not** a
    // verdict about the destination. Most routers and firewalls on the public
    // internet drop traceroute probes, so this is the ordinary outcome for a
    // host that answers HTTPS perfectly well. Calling it a silence put a red
    // cell next to a green one and invented a contradiction.
    //
    // Whether the hop limit was reached is the part that *is* informative: it
    // separates "the path went dark" from "we simply stopped counting".
    if traceroute_ends_in_silence(&reported.body) {
        return DiagVerdict::Inconclusive {
            summary: if hops >= u32::from(max_hops) {
                format!("limite de {max_hops} sauts atteinte")
            } else {
                format!("{hops} sauts, puis plus de réponse")
            },
        };
    }
    DiagVerdict::Ok { summary: format!("{hops} sauts") }
}

/// Numbered hop lines, whichever tool wrote them.
fn traceroute_hops(body: &str) -> u32 {
    body.lines()
        .filter(|line| {
            let trimmed = line.trim_start();
            let digits: String = trimmed.chars().take_while(|c| c.is_ascii_digit()).collect();
            // A hop line starts with its number; a header or a summary doesn't.
            !digits.is_empty()
                && trimmed[digits.len()..]
                    .starts_with(|c: char| c.is_whitespace() || c == ':')
        })
        .count() as u32
}

/// Whether the last hops all timed out — the trace never reached anything.
fn traceroute_ends_in_silence(body: &str) -> bool {
    let hop_lines: Vec<&str> = body
        .lines()
        .filter(|line| {
            let trimmed = line.trim_start();
            let digits: String = trimmed.chars().take_while(|c| c.is_ascii_digit()).collect();
            !digits.is_empty()
                && trimmed[digits.len()..]
                    .starts_with(|c: char| c.is_whitespace() || c == ':')
        })
        .collect();
    // Two in a row rather than one: a single silent hop in the middle of a
    // working path is routine (a router that doesn't answer but forwards).
    hop_lines
        .iter()
        .rev()
        .take(2)
        .filter(|line| is_silent_hop(line))
        .count()
        == 2
        && hop_lines.len() >= 2
}

/// A hop line with no reply at all: only asterisks where the times go.
fn is_silent_hop(line: &str) -> bool {
    let after_number = line.trim_start().trim_start_matches(|c: char| c.is_ascii_digit());
    let body = after_number.trim_start_matches([' ', ':', '\t']);
    !body.is_empty() && body.chars().all(|c| c == '*' || c.is_whitespace())
}

/// Maps the reachability probe's verdict onto this module's, which is a
/// superset. Total on purpose: a variant added there must be decided here.
fn from_reachability(verdict: reachability::Verdict) -> DiagVerdict {
    use reachability::Verdict;
    match verdict {
        Verdict::Open { via } => DiagVerdict::Ok { summary: format!("ouvert (via {via})") },
        Verdict::Refused { .. } => DiagVerdict::Refused { summary: "connexion refusée".to_string() },
        Verdict::Filtered { .. } => DiagVerdict::Silent { summary: "aucune réponse".to_string() },
        Verdict::UnknownHost { .. } => DiagVerdict::UnknownHost,
        Verdict::Unreachable { .. } => DiagVerdict::Unreachable,
        Verdict::NoTool => DiagVerdict::Unavailable { tool: "bash, nc ou curl".to_string() },
        Verdict::Failed { message } => DiagVerdict::Failed { message },
    }
}

fn parse_powershell_tcp(reported: &Reported) -> DiagVerdict {
    match reported.code {
        0 => DiagVerdict::Ok { summary: "ouvert".to_string() },
        124 => DiagVerdict::Silent { summary: "aucune réponse".to_string() },
        _ => {
            let lowered = reported.body.to_lowercase();
            if lowered.contains("no such host") || lowered.contains("aucun hôte") {
                DiagVerdict::UnknownHost
            } else if lowered.contains("unreachable") || lowered.contains("injoignable") {
                DiagVerdict::Unreachable
            } else if lowered.contains("refus") || lowered.contains("actively refused") {
                DiagVerdict::Refused { summary: "connexion refusée".to_string() }
            } else if reported.body.is_empty() {
                DiagVerdict::Failed { message: "Échec sans message.".to_string() }
            } else {
                DiagVerdict::Failed { message: reported.body.clone() }
            }
        }
    }
}

fn parse_dns(reported: &Reported) -> DiagVerdict {
    let addresses = dns_addresses(&reported.via, &reported.body);
    if !addresses.is_empty() {
        // Capped: a round-robin record can carry dozens, and the column exists
        // to answer "does it resolve, and to roughly what".
        let shown = addresses.iter().take(3).cloned().collect::<Vec<_>>().join(", ");
        let summary = if addresses.len() > 3 {
            format!("{shown} (+{})", addresses.len() - 3)
        } else {
            shown
        };
        return DiagVerdict::Ok { summary };
    }
    // A resolver that answers "no such name" exits non-zero on every tool
    // here, and an empty answer means the same thing: the name is unknown.
    if reported.code != 0 || addresses.is_empty() {
        return DiagVerdict::UnknownHost;
    }
    DiagVerdict::Failed { message: reported.body.clone() }
}

/// Every address in a resolver's output, whichever resolver it was.
///
/// Split by tool because the marker line already says which one ran — the
/// reason `reachability`'s script reports `$v` at all.
fn dns_addresses(via: &str, body: &str) -> Vec<String> {
    let mut found: Vec<String> = Vec::new();
    for line in body.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let candidate = match via {
            // `1.2.3.4  STREAM  name` — the address is the first field, and the
            // same address repeats once per socket type.
            "getent" => line.split_whitespace().next(),
            // One value per line, but CNAMEs come through too.
            "dig" => Some(line),
            // `Address: 1.2.3.4`, after a first block describing the server
            // itself — which is why only lines after `Name:` count.
            "nslookup" => line.strip_prefix("Address:").map(str::trim),
            // PowerShell's .NET path prints them space-separated on one line.
            "dotnet" => Some(line),
            _ => Some(line),
        };
        let Some(candidate) = candidate else { continue };
        for token in candidate.split_whitespace() {
            if looks_like_address(token) && !found.iter().any(|a| a == token) {
                found.push(token.to_string());
            }
        }
    }
    if via == "nslookup" {
        // The resolver's own address is reported first, before the answer —
        // dropping it is the difference between "it resolves" and "there is a
        // DNS server", which are not the same claim.
        if found.len() > 1 {
            found.remove(0);
        }
    }
    found
}

/// Whether a token is an IPv4 or IPv6 literal, rather than a name or a CNAME.
fn looks_like_address(token: &str) -> bool {
    let token = token.trim_end_matches('.');
    if token.is_empty() {
        return false;
    }
    let ipv4 = token.split('.').count() == 4
        && token.split('.').all(|part| !part.is_empty() && part.chars().all(|c| c.is_ascii_digit()));
    let ipv6 = token.contains(':')
        && token.chars().all(|c| c.is_ascii_hexdigit() || c == ':');
    ipv4 || ipv6
}

fn parse_http(reported: &Reported) -> DiagVerdict {
    // curl's own exit codes, the ones worth telling apart. Anything else falls
    // through to the message, which curl writes in plain words.
    match reported.code {
        6 => return DiagVerdict::UnknownHost,
        7 => return DiagVerdict::Silent { summary: "connexion impossible".to_string() },
        28 => return DiagVerdict::Silent { summary: "délai dépassé".to_string() },
        // A certificate that doesn't verify is a real answer about a real
        // problem, not a network failure — and saying "unreachable" would send
        // someone looking at firewalls.
        35 | 60 => {
            return DiagVerdict::Refused {
                summary: "certificat TLS non validé".to_string(),
            }
        }
        _ => {}
    }
    let Some((status, seconds)) = http_status_and_time(&reported.body) else {
        return DiagVerdict::Failed {
            message: if reported.body.is_empty() {
                format!("curl a quitté avec le code {}.", reported.code)
            } else {
                reported.body.clone()
            },
        };
    };
    let ms = (seconds * 1000.0).round() as i64;
    let summary = format!("{status} en {ms} ms");
    // The server answered either way; 4xx/5xx is it saying no, which is a
    // different thing to investigate than nothing answering at all.
    if (400..600).contains(&status) {
        DiagVerdict::Refused { summary }
    } else if status == 0 {
        DiagVerdict::Failed { message: reported.body.clone() }
    } else {
        DiagVerdict::Ok { summary }
    }
}

/// Reads the `-w` line curl was asked to print.
fn http_status_and_time(body: &str) -> Option<(i32, f64)> {
    // curl may have written a warning first (`-sS` keeps errors), so the
    // format line is the last non-empty one rather than the only one.
    let line = body.lines().rev().find(|l| !l.trim().is_empty())?;
    let mut fields = line.split_whitespace();
    let status: i32 = fields.next()?.parse().ok()?;
    // `time_total` is locale-formatted by some curl builds — a comma decimal
    // separator is exactly what a French Windows would produce.
    let seconds: f64 = fields.next()?.replace(',', ".").parse().ok()?;
    Some((status, seconds))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn marker(via: &str, code: i32, body: &str) -> String {
        format!("{MARKER} {via} {code} 0\n{body}")
    }

    // ─── Validation ──────────────────────────────────────────────────────

    /// The whole reason validation exists: this string is interpolated into a
    /// script that runs on every host of a fleet.
    #[test]
    fn a_destination_that_could_escape_the_script_is_refused() {
        for hostile in [
            "example.com; rm -rf /",
            "example.com'; id; '",
            "$(id)",
            "`id`",
            "a b",
            "example.com|id",
        ] {
            assert!(
                validate(hostile, &[DiagTool::Dns]).is_err(),
                "« {hostile} » doit être refusé"
            );
        }
        assert!(validate("example.com", &[DiagTool::Dns]).is_ok());
        assert!(validate("10.0.0.1", &[DiagTool::Dns]).is_ok());
    }

    /// The second interpolation point, and the one easy to forget: the path is
    /// free text too.
    #[test]
    fn a_hostile_path_is_refused() {
        for hostile in ["/'; id; '", "/a b", "/$(id)", "/`id`", "/a|b", "/a;b"] {
            assert!(validate_path(hostile).is_err(), "« {hostile} » doit être refusé");
        }
        assert!(validate_path("/health").is_ok());
        assert!(validate_path("/api/v1/status?verbose=1&x=2").is_ok());
        assert!(validate_path("").is_ok(), "un chemin vide vaut /");
        assert!(validate_path("health").is_err(), "doit commencer par /");
    }

    #[test]
    fn a_run_needs_at_least_one_tool() {
        assert!(validate("example.com", &[]).is_err());
    }

    // ─── Scripts ─────────────────────────────────────────────────────────

    /// The bug this module exists to avoid: a POSIX script handed to
    /// PowerShell. The two must not be the same string.
    #[test]
    fn the_two_flavours_produce_different_scripts() {
        for tool in [
            DiagTool::Tcp { port: 443 },
            DiagTool::Dns,
            DiagTool::Http { secure: true, port: None, path: String::new() },
            DiagTool::Ping { count: 4 },
            DiagTool::Traceroute { max_hops: 15 },
        ] {
            let posix = script(&tool, "example.com", Flavour::Posix);
            let powershell = script(&tool, "example.com", Flavour::Powershell);
            assert_ne!(posix, powershell, "{tool:?} rend le même script pour les deux saveurs");
            assert!(posix.starts_with("sh -c "), "{tool:?} : le POSIX doit passer par sh");
            assert!(!powershell.starts_with("sh -c "), "{tool:?} : PowerShell ne doit pas");
        }
    }

    /// Delegation rather than a second implementation — asserted, because
    /// "we'll reuse it" is exactly the kind of intention that quietly rots.
    #[test]
    fn the_posix_tcp_probe_is_reachabilitys_own() {
        assert_eq!(
            script(&DiagTool::Tcp { port: 22 }, "10.0.0.1", Flavour::Posix),
            reachability::probe_script("10.0.0.1", 22, TCP_TIMEOUT_SECS),
        );
    }

    /// `curl` in Windows PowerShell is an alias for `Invoke-WebRequest`, which
    /// takes none of these flags — the request would fail in a way that reads
    /// as "the site is down".
    #[test]
    fn the_powershell_http_script_calls_curl_exe() {
        let s = script(&DiagTool::Http { secure: true, port: None, path: String::new() }, "example.com", Flavour::Powershell);
        assert!(s.contains("curl.exe"), "doit appeler curl.exe explicitement");
    }

    #[test]
    fn the_url_is_built_from_scheme_port_and_path() {
        assert_eq!(http_url("example.com", true, None, ""), "https://example.com/");
        assert_eq!(http_url("example.com", false, None, "/health"), "http://example.com/health");
        assert_eq!(http_url("10.0.0.1", false, Some(8080), "/x"), "http://10.0.0.1:8080/x");
    }

    // ─── TCP ─────────────────────────────────────────────────────────────

    #[test]
    fn powershell_tcp_tells_the_four_outcomes_apart() {
        let tool = DiagTool::Tcp { port: 443 };
        let p = |code: i32, body: &str| parse(&tool, Flavour::Powershell, &marker("dotnet", code, body), "");

        assert!(matches!(p(0, "connected"), DiagVerdict::Ok { .. }));
        assert!(matches!(p(124, "timeout"), DiagVerdict::Silent { .. }));
        assert!(matches!(
            p(1, "No connection could be made because the target machine actively refused it"),
            DiagVerdict::Refused { .. }
        ));
        assert!(matches!(p(2, "No such host is known"), DiagVerdict::UnknownHost));
    }

    /// The POSIX side must go through `reachability`, verdict mapping and all.
    #[test]
    fn posix_tcp_verdicts_come_through_mapped() {
        let tool = DiagTool::Tcp { port: 443 };
        let stdout = "GUITERM-PROBE bash 0 0\n";
        assert!(matches!(parse(&tool, Flavour::Posix, stdout, ""), DiagVerdict::Ok { .. }));
    }

    // ─── DNS ─────────────────────────────────────────────────────────────

    /// Real `getent ahosts` output: the same address once per socket type.
    #[test]
    fn getent_output_is_read_without_duplicates() {
        let body = "93.184.216.34  STREAM example.com\n93.184.216.34  DGRAM\n93.184.216.34  RAW";
        match parse(&DiagTool::Dns, Flavour::Posix, &marker("getent", 0, body), "") {
            DiagVerdict::Ok { summary } => assert_eq!(summary, "93.184.216.34"),
            other => panic!("attendu Ok, obtenu {other:?}"),
        }
    }

    /// `dig +short` mixes CNAMEs in with the addresses; only addresses count.
    #[test]
    fn dig_output_keeps_addresses_and_drops_cnames() {
        let body = "example.map.fastly.net.\n151.101.1.91\n151.101.65.91";
        match parse(&DiagTool::Dns, Flavour::Posix, &marker("dig", 0, body), "") {
            DiagVerdict::Ok { summary } => assert_eq!(summary, "151.101.1.91, 151.101.65.91"),
            other => panic!("attendu Ok, obtenu {other:?}"),
        }
    }

    /// nslookup answers with the *resolver's* address first. Counting it would
    /// turn "there is a DNS server" into "the name resolves".
    #[test]
    fn nslookup_does_not_mistake_the_resolver_for_the_answer() {
        let body = "Server:\t127.0.0.53\nAddress:\t127.0.0.53#53\n\nNon-authoritative answer:\nName:\texample.com\nAddress: 93.184.216.34";
        match parse(&DiagTool::Dns, Flavour::Posix, &marker("nslookup", 0, body), "") {
            DiagVerdict::Ok { summary } => assert_eq!(summary, "93.184.216.34"),
            other => panic!("attendu Ok, obtenu {other:?}"),
        }
    }

    #[test]
    fn a_name_that_resolves_to_nothing_is_unknown_not_failed() {
        assert!(matches!(
            parse(&DiagTool::Dns, Flavour::Posix, &marker("dig", 0, ""), ""),
            DiagVerdict::UnknownHost
        ));
        assert!(matches!(
            parse(&DiagTool::Dns, Flavour::Posix, &marker("getent", 2, ""), ""),
            DiagVerdict::UnknownHost
        ));
    }

    #[test]
    fn many_addresses_are_summarised_rather_than_listed() {
        let body = "1.1.1.1\n2.2.2.2\n3.3.3.3\n4.4.4.4\n5.5.5.5";
        match parse(&DiagTool::Dns, Flavour::Posix, &marker("dig", 0, body), "") {
            DiagVerdict::Ok { summary } => assert_eq!(summary, "1.1.1.1, 2.2.2.2, 3.3.3.3 (+2)"),
            other => panic!("attendu Ok, obtenu {other:?}"),
        }
    }

    #[test]
    fn ipv6_answers_are_recognised() {
        match parse(&DiagTool::Dns, Flavour::Powershell, &marker("dotnet", 0, "2606:2800:220:1:248:1893:25c8:1946"), "") {
            DiagVerdict::Ok { summary } => assert!(summary.starts_with("2606:")),
            other => panic!("attendu Ok, obtenu {other:?}"),
        }
    }

    // ─── HTTP ────────────────────────────────────────────────────────────

    fn http() -> DiagTool {
        DiagTool::Http { secure: true, port: None, path: String::new() }
    }

    #[test]
    fn a_2xx_is_ok_with_its_timing() {
        match parse(&http(), Flavour::Posix, &marker("curl", 0, "200 0.342156"), "") {
            DiagVerdict::Ok { summary } => assert_eq!(summary, "200 en 342 ms"),
            other => panic!("attendu Ok, obtenu {other:?}"),
        }
    }

    /// The server answered — that is not the same failure as silence, and the
    /// remedies have nothing in common.
    #[test]
    fn a_5xx_is_a_refusal_not_a_silence() {
        assert!(matches!(
            parse(&http(), Flavour::Posix, &marker("curl", 0, "503 0.100000"), ""),
            DiagVerdict::Refused { .. }
        ));
        assert!(matches!(
            parse(&http(), Flavour::Posix, &marker("curl", 0, "404 0.050000"), ""),
            DiagVerdict::Refused { .. }
        ));
    }

    #[test]
    fn curl_exit_codes_map_to_the_right_failure() {
        let p = |code: i32| parse(&http(), Flavour::Posix, &marker("curl", code, "erreur"), "");
        assert!(matches!(p(6), DiagVerdict::UnknownHost));
        assert!(matches!(p(7), DiagVerdict::Silent { .. }));
        assert!(matches!(p(28), DiagVerdict::Silent { .. }));
        assert!(matches!(p(60), DiagVerdict::Refused { .. }), "certificat invalide = une réponse");
    }

    /// A French Windows curl writes `0,342`. Parsed as-is it would yield 0 ms
    /// and quietly report every request as instantaneous.
    #[test]
    fn a_comma_decimal_separator_is_understood() {
        match parse(&http(), Flavour::Posix, &marker("curl", 0, "200 0,342156"), "") {
            DiagVerdict::Ok { summary } => assert_eq!(summary, "200 en 342 ms"),
            other => panic!("attendu Ok, obtenu {other:?}"),
        }
    }

    // ─── Missing tools and broken runs ───────────────────────────────────

    /// A slim container with no `dig` is not a network problem, and saying so
    /// is the difference between "fix your firewall" and "install a tool".
    #[test]
    fn a_missing_tool_is_its_own_verdict() {
        match parse(&DiagTool::Dns, Flavour::Posix, &marker("notool", 0, ""), "") {
            DiagVerdict::Unavailable { tool } => assert!(tool.contains("dig")),
            other => panic!("attendu Unavailable, obtenu {other:?}"),
        }
        match parse(&http(), Flavour::Powershell, &marker("notool", 0, ""), "") {
            DiagVerdict::Unavailable { tool } => assert_eq!(tool, "curl"),
            other => panic!("attendu Unavailable, obtenu {other:?}"),
        }
    }

    /// No marker at all means the script never finished — the shell's own
    /// complaint is the only clue, and dropping it would leave "unreadable".
    #[test]
    fn a_missing_marker_keeps_whatever_the_shell_said() {
        match parse(&DiagTool::Dns, Flavour::Posix, "", "sh: command not found") {
            DiagVerdict::Failed { message } => assert!(message.contains("command not found")),
            other => panic!("attendu Failed, obtenu {other:?}"),
        }
    }

    /// The gap this module was written for: on Windows the local machine runs
    /// PowerShell, so a POSIX script sent there does nothing useful. Remote
    /// targets are POSIX whatever this machine is.
    #[test]
    fn only_the_local_target_can_be_powershell() {
        use crate::fleet::FleetTarget;
        use crate::model::HostId;

        let ssh = FleetTarget::Ssh { host_id: HostId::nil() };
        assert_eq!(flavour_for_shell(&FleetTarget::Local, "powershell.exe"), Flavour::Powershell);
        assert_eq!(flavour_for_shell(&FleetTarget::Local, "/bin/bash"), Flavour::Posix);
        assert_eq!(
            flavour_for_shell(&ssh, "powershell.exe"),
            Flavour::Posix,
            "un hôte SSH reste POSIX même si cette machine est sous Windows"
        );
    }

    // ─── Ping ────────────────────────────────────────────────────────────

    fn ping() -> DiagTool {
        DiagTool::Ping { count: 4 }
    }

    /// Real iputils output, the Linux default.
    #[test]
    fn iputils_ping_is_read_with_its_average() {
        let body = "PING example.com (93.184.216.34) 56(84) bytes of data.\n\
                    64 bytes from 93.184.216.34: icmp_seq=1 ttl=56 time=11.7 ms\n\
                    \n--- example.com ping statistics ---\n\
                    4 packets transmitted, 4 received, 0% packet loss, time 3005ms\n\
                    rtt min/avg/max/mdev = 11.512/11.702/11.884/0.132 ms";
        match parse(&ping(), Flavour::Posix, &marker("ping", 0, body), "") {
            DiagVerdict::Ok { summary } => assert_eq!(summary, "4 rép., 12 ms"),
            other => panic!("attendu Ok, obtenu {other:?}"),
        }
    }

    /// Real Windows `ping.exe` output, in French — the locale of the machine
    /// this is developed on, and one where none of the English markers match.
    #[test]
    fn french_windows_ping_is_read_too() {
        let body = "Envoi d'une requête 'ping' sur example.com [93.184.216.34] avec 32 octets de données :\n\
                    Réponse de 93.184.216.34 : octets=32 temps=24 ms TTL=56\n\
                    \nStatistiques Ping pour 93.184.216.34:\n\
                    Paquets : envoyés = 4, reçus = 4, perdus = 0 (perte 0%),\n\
                    Durée approximative des boucles en millisecondes :\n\
                    Minimum = 23ms, Maximum = 25ms, Moyenne = 24ms";
        match parse(&ping(), Flavour::Powershell, &marker("ping", 0, body), "") {
            DiagVerdict::Ok { summary } => assert_eq!(summary, "4 rép., 24 ms"),
            other => panic!("attendu Ok, obtenu {other:?}"),
        }
    }

    /// The case a naive "exit code != 0 means failure" would get wrong: `ping`
    /// exits 1 on *partial* loss too, and a link that works badly is exactly
    /// what someone reaches for ping to find.
    #[test]
    fn partial_packet_loss_is_still_an_answer() {
        let body = "--- example.com ping statistics ---\n\
                    4 packets transmitted, 2 received, 50% packet loss, time 3010ms\n\
                    rtt min/avg/max/mdev = 11.512/11.702/11.884/0.132 ms";
        match parse(&ping(), Flavour::Posix, &marker("ping", 1, body), "") {
            DiagVerdict::Ok { summary } => assert_eq!(summary, "2 rép., 12 ms"),
            other => panic!("une perte partielle reste une réponse, obtenu {other:?}"),
        }
    }

    #[test]
    fn total_packet_loss_is_a_silence() {
        let body = "4 packets transmitted, 0 received, 100% packet loss, time 3070ms";
        assert!(matches!(
            parse(&ping(), Flavour::Posix, &marker("ping", 1, body), ""),
            DiagVerdict::Silent { .. }
        ));
    }

    #[test]
    fn ping_tells_dns_and_routing_apart() {
        assert!(matches!(
            parse(&ping(), Flavour::Posix, &marker("ping", 2, "ping: nope.invalid: Name or service not known"), ""),
            DiagVerdict::UnknownHost
        ));
        assert!(matches!(
            parse(&ping(), Flavour::Posix, &marker("ping", 2, "connect: Network is unreachable"), ""),
            DiagVerdict::Unreachable
        ));
    }

    /// The common container case, and the reason this isn't reported as a
    /// network failure.
    #[test]
    fn a_container_without_ping_says_so() {
        match parse(&ping(), Flavour::Posix, &marker("notool", 0, ""), "") {
            DiagVerdict::Unavailable { tool } => assert_eq!(tool, "ping"),
            other => panic!("attendu Unavailable, obtenu {other:?}"),
        }
    }

    // ─── Traceroute ──────────────────────────────────────────────────────

    fn traceroute() -> DiagTool {
        DiagTool::Traceroute { max_hops: 15 }
    }

    #[test]
    fn a_completed_trace_counts_its_hops() {
        let body = "traceroute to example.com (93.184.216.34), 15 hops max, 60 byte packets\n\
                    \x201  192.168.1.1  0.412 ms  0.389 ms  0.371 ms\n\
                    \x202  10.0.0.1  8.112 ms  8.090 ms  8.070 ms\n\
                    \x203  93.184.216.34  11.702 ms  11.680 ms  11.660 ms";
        match parse(&traceroute(), Flavour::Posix, &marker("traceroute", 0, body), "") {
            DiagVerdict::Ok { summary } => assert_eq!(summary, "3 sauts"),
            other => panic!("attendu Ok, obtenu {other:?}"),
        }
    }

    /// A trace that dies in timeouts did not arrive — but it says nothing
    /// about the destination, because most of the internet drops traceroute
    /// probes. **This is the bug found in use**: reported as a silence, it put
    /// a red cell next to an HTTPS 301 in green and invented a contradiction.
    #[test]
    fn a_trace_that_ends_in_timeouts_is_inconclusive_not_a_silence() {
        let body = "\x201  192.168.1.1  0.412 ms  0.389 ms  0.371 ms\n\
                    \x202  10.0.0.1  8.112 ms  8.090 ms  8.070 ms\n\
                    \x203  * * *\n\
                    \x204  * * *";
        match parse(&DiagTool::Traceroute { max_hops: 30 }, Flavour::Posix, &marker("traceroute", 0, body), "") {
            DiagVerdict::Inconclusive { summary } => assert_eq!(summary, "4 sauts, puis plus de réponse"),
            other => panic!("attendu Inconclusive, obtenu {other:?}"),
        }
    }

    /// The other half of the same bug: with a low hop limit, a public
    /// destination is simply further away than we counted. "Puis silence" read
    /// as a failure; "limite atteinte" says what actually happened.
    #[test]
    fn stopping_at_the_hop_limit_says_so() {
        let body: String = (1..=15)
            .map(|hop| format!("{hop:2}  * * *\n"))
            .collect();
        match parse(&DiagTool::Traceroute { max_hops: 15 }, Flavour::Posix, &marker("traceroute", 0, &body), "") {
            DiagVerdict::Inconclusive { summary } => assert_eq!(summary, "limite de 15 sauts atteinte"),
            other => panic!("attendu Inconclusive, obtenu {other:?}"),
        }
    }

    /// One silent router in the middle of a working path is routine — it
    /// doesn't answer but it forwards. Calling that a silence would flag half
    /// the internet as broken.
    #[test]
    fn one_silent_hop_in_the_middle_is_not_a_silence() {
        let body = "\x201  192.168.1.1  0.412 ms\n\
                    \x202  * * *\n\
                    \x203  93.184.216.34  11.702 ms";
        assert!(matches!(
            parse(&traceroute(), Flavour::Posix, &marker("traceroute", 0, body), ""),
            DiagVerdict::Ok { .. }
        ));
    }

    /// Windows `tracert` numbers its hops the same way but words everything
    /// else differently.
    #[test]
    fn windows_tracert_output_is_counted_too() {
        let body = "Détermination de l'itinéraire vers example.com [93.184.216.34]\n\
                    avec un maximum de 15 sauts :\n\
                    \n\x20 1     1 ms     1 ms     1 ms  192.168.1.1\n\
                    \x20 2    12 ms    11 ms    12 ms  93.184.216.34\n\
                    \nItinéraire déterminé.";
        match parse(&traceroute(), Flavour::Powershell, &marker("tracert", 0, body), "") {
            DiagVerdict::Ok { summary } => assert_eq!(summary, "2 sauts"),
            other => panic!("attendu Ok, obtenu {other:?}"),
        }
    }

    /// The hop lines have to survive to the UI: a hop count is a summary of
    /// the one output people actually want to read line by line.
    #[test]
    fn the_raw_output_is_kept_for_the_details_panel() {
        let body = "\x201  192.168.1.1  0.412 ms\n\x202  10.0.0.1  8.112 ms";
        let raw = body_of(&marker("traceroute", 0, body), "");
        assert!(raw.contains("192.168.1.1"));
        assert!(raw.contains("10.0.0.1"));
        assert!(!raw.contains(MARKER), "la ligne de marqueur est un détail interne");
    }

    /// When the script never reached the marker, its raw output is all there
    /// is — and that is exactly when someone needs to read it.
    #[test]
    fn the_raw_output_survives_a_missing_marker() {
        assert!(body_of("", "sh: traceroute: not found").contains("not found"));
        assert!(body_of("sortie brute", "").contains("sortie brute"));
    }

    #[test]
    fn a_huge_output_is_truncated_rather_than_shipped_whole() {
        let huge = "x".repeat(50_000);
        let raw = body_of(&marker("traceroute", 0, &huge), "");
        assert!(raw.len() < 9_000, "longueur {}", raw.len());
        assert!(raw.ends_with("(sortie tronquée)"));
    }

    #[test]
    fn a_missing_traceroute_names_both_candidates() {
        match parse(&traceroute(), Flavour::Posix, &marker("notool", 0, ""), "") {
            DiagVerdict::Unavailable { tool } => {
                assert!(tool.contains("traceroute") && tool.contains("tracepath"));
            }
            other => panic!("attendu Unavailable, obtenu {other:?}"),
        }
    }

    /// Traceroute is the reason the command layer streams instead of batching.
    #[test]
    fn traceroute_is_by_far_the_slowest_tool() {
        let slowest = traceroute().timeout_secs();
        for other in [DiagTool::Tcp { port: 1 }, DiagTool::Dns, http(), ping()] {
            assert!(
                slowest > other.timeout_secs(),
                "{other:?} devrait être plus rapide qu'un traceroute"
            );
        }
    }

    /// busybox and BSD `ping` reject `-w`; without the second attempt, an
    /// Alpine container — the most common slim image there is — would report
    /// every host as unreachable.
    #[test]
    fn the_posix_ping_script_falls_back_without_the_deadline_flag() {
        let s = script(&ping(), "example.com", Flavour::Posix);
        assert!(s.contains("|| ping -c $n"), "il manque le repli sans -w : {s}");
    }

    #[test]
    fn tool_labels_are_readable() {
        assert_eq!(DiagTool::Tcp { port: 443 }.label(), "TCP 443");
        assert_eq!(DiagTool::Dns.label(), "DNS");
        assert_eq!(ping().label(), "Ping");
        assert_eq!(traceroute().label(), "Traceroute");
        assert_eq!(DiagTool::Http { secure: true, port: None, path: String::new() }.label(), "HTTPS");
        assert_eq!(DiagTool::Http { secure: false, port: Some(8080), path: String::new() }.label(), "HTTP 8080");
    }

    /// The wire shape the frontend sends. A Rust→Rust roundtrip would stay
    /// green even if the fields never got renamed — both sides would agree on
    /// the same wrong casing. This is the trap that has hit this repo six
    /// times, so the JSON is written by hand.
    #[test]
    fn the_tool_is_read_from_hand_written_camel_case_json() {
        let tcp: DiagTool = serde_json::from_str(r#"{"kind":"tcp","port":443}"#).unwrap();
        assert_eq!(tcp, DiagTool::Tcp { port: 443 });

        let http: DiagTool =
            serde_json::from_str(r#"{"kind":"http","secure":true,"port":8443,"path":"/health"}"#).unwrap();
        assert_eq!(http, DiagTool::Http { secure: true, port: Some(8443), path: "/health".to_string() });

        let dns: DiagTool = serde_json::from_str(r#"{"kind":"dns"}"#).unwrap();
        assert_eq!(dns, DiagTool::Dns);
    }

    #[test]
    fn the_verdict_is_written_in_camel_case_for_the_frontend() {
        let json = serde_json::to_value(DiagVerdict::Unavailable { tool: "curl".to_string() }).unwrap();
        assert_eq!(json["kind"], "unavailable");
        assert_eq!(json["tool"], "curl");

        let json = serde_json::to_value(DiagVerdict::UnknownHost).unwrap();
        assert_eq!(json["kind"], "unknownHost");
    }
}
