//! Reaching a TCP port through AWS Session Manager, with no SSH server in the
//! path.
//!
//! **What this removes is the bastion, not the relay.** A session still runs
//! through an instance registered with SSM, and the traffic still goes through
//! it — but that instance needs no sshd, no key of ours, and no inbound port
//! open, and it is reached by IAM rather than by a credential we hold. That is
//! the whole difference from [`crate::port_forward`], and the reason this
//! exists: a managed database (RDS, ElastiCache, DocumentDB) used to require
//! keeping a real SSH bastion alive purely so this app could dial through it.
//!
//! **Why not [`crate::proxy_command`], which already launches SSM.** That one
//! runs `AWS-StartSSHSession`, whose stdin/stdout *are* the transport — a byte
//! stream handed straight to `russh`. Port forwarding is a different shape:
//! `AWS-StartPortForwardingSessionToRemoteHost` opens a **local TCP port** and
//! says so on stdout, and the client then dials that port like any other. The
//! two share their diagnostics ([`crate::proxy_command::hint_for`]) and the
//! plugin-PATH fix, and nothing else.
//!
//! **The real work here is the lifetime, not the invocation.** The `aws` call
//! itself is four arguments. What costs is everything around it: knowing when
//! the port is actually listening (before that, dialling it fails), noticing
//! the helper died (otherwise a database session hangs on a port nobody is
//! serving), and saying which of the two happened — "the tunnel went down" and
//! "the database refused" are the same `ConnectionRefused` to the caller.
//!
//! No shell is involved, unlike [`crate::proxy_command`]: every argument here
//! is built by this module rather than typed by the user, so there is nothing
//! to quote and no command line to inject into. The user's own text (an
//! instance id, a profile) travels as one argument each.

use serde::Serialize;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};

use crate::sync_ext::MutexExt;

/// The SSM document that forwards to a *third* host reachable from the
/// instance, rather than to a port on the instance itself
/// (`AWS-StartPortForwardingSession`). A managed database is never on the
/// instance, so this is always the one wanted here.
const PORT_FORWARD_DOCUMENT: &str = "AWS-StartPortForwardingSessionToRemoteHost";

/// How long to wait for the plugin to announce its port.
///
/// Generous on purpose: opening a session is several round trips to AWS plus
/// the agent's own handshake, and a cold instance regularly takes a few
/// seconds. The cost of being wrong in the tight direction is a connection
/// that fails on a slow day and works on a fast one — the worst kind of bug to
/// be told about.
const OPEN_TIMEOUT: Duration = Duration::from_secs(30);

/// How much of the helper's output is kept for diagnostics. It says what went
/// wrong in its first line or two; past that it is per-connection chatter.
const OUTPUT_LIMIT: usize = 4096;

/// Everything needed to open one forwarding session.
#[derive(Debug, Clone, PartialEq)]
pub struct SsmSpec {
    /// The SSM-registered instance the session runs through (`i-…`/`mi-…`).
    pub target: String,
    /// `--profile`, when the CLI's default isn't the right account.
    pub profile: Option<String>,
    /// `--region`, when the profile doesn't already pin one.
    pub region: Option<String>,
    /// The address to reach *from the instance* — the provider endpoint,
    /// which typically only resolves inside the VPC.
    pub remote_host: String,
    pub remote_port: u16,
}

impl SsmSpec {
    /// The `aws` arguments for this spec, in order.
    ///
    /// Split out from the spawning so the command line is assertable without
    /// running anything — the parameters blob in particular is JSON built by
    /// hand, and a typo in it fails as an opaque document validation error.
    pub fn args(&self) -> Vec<String> {
        // Every value here is a *parameter*, never interpolated into a shell
        // string, so `serde_json` doing the escaping is the whole of the
        // quoting story.
        let parameters = serde_json::json!({
            "host": [self.remote_host],
            "portNumber": [self.remote_port.to_string()],
            // "0" asks the plugin for an OS-assigned free port, which it then
            // announces on stdout. Choosing one ourselves would mean racing
            // every other program on this machine for it, and the plugin
            // fails outright rather than falling back when it loses.
            "localPortNumber": ["0"],
        })
        .to_string();

        let mut args = vec![
            "ssm".to_string(),
            "start-session".to_string(),
            "--target".to_string(),
            self.target.clone(),
            "--document-name".to_string(),
            PORT_FORWARD_DOCUMENT.to_string(),
            "--parameters".to_string(),
            parameters,
        ];
        if let Some(profile) = self.profile.as_deref().filter(|p| !p.is_empty()) {
            args.push("--profile".to_string());
            args.push(profile.to_string());
        }
        if let Some(region) = self.region.as_deref().filter(|r| !r.is_empty()) {
            args.push("--region".to_string());
            args.push(region.to_string());
        }
        args
    }

    /// How this session is described in an error the user reads.
    pub fn describe(&self) -> String {
        let mut description = format!("SSM via {}", self.target);
        if let Some(profile) = self.profile.as_deref().filter(|p| !p.is_empty()) {
            description.push_str(&format!(" (profil {profile})"));
        }
        description
    }
}

/// A live forwarding session: a local port, and the helper serving it.
///
/// Must be kept alive for as long as whatever dials [`Self::local_port`] —
/// dropping it kills the helper (`kill_on_drop`), which closes the port. Every
/// caller therefore stores it beside the session it opened, exactly as
/// `SshLease` is stored (see `CLAUDE.md` on leases outliving what they opened).
#[derive(Debug)]
pub struct SsmTunnel {
    child: tokio::sync::Mutex<Child>,
    local_port: u16,
    output: Arc<Mutex<String>>,
    spec: SsmSpec,
}

impl SsmTunnel {
    /// The loopback port now serving the remote database.
    pub fn local_port(&self) -> u16 {
        self.local_port
    }

    pub fn spec(&self) -> &SsmSpec {
        &self.spec
    }

    /// Whatever the helper has printed so far, trimmed.
    pub fn output_snapshot(&self) -> String {
        self.output.lock_recover().trim().to_string()
    }

    /// `Some(message)` once the helper has exited, `None` while it is still
    /// running. Never blocks.
    ///
    /// This is the question that separates "the tunnel went down" from "the
    /// database refused": both reach the caller as a connection error on
    /// `127.0.0.1`, and only one of them is worth telling the user to check
    /// their credentials over.
    pub async fn exited(&self) -> Option<String> {
        let status = self.child.lock().await.try_wait().ok().flatten()?;
        let mut message = format!(
            "le tunnel {} s'est arrêté ({status}) — la base n'est plus joignable par le port local",
            self.spec.describe()
        );
        let output = self.output_snapshot();
        if !output.is_empty() {
            message.push('\n');
            message.push_str(&output);
        }
        if let Some(hint) = crate::proxy_command::hint_for(&output) {
            message.push_str("\n\n");
            message.push_str(&hint);
        }
        Some(message)
    }

    /// Takes a connection failure against the local port and says what really
    /// happened, so the user isn't sent to look at the database when the
    /// tunnel is what died.
    ///
    /// Deliberately checks the helper *after* the failure rather than before:
    /// a tunnel that dies during the dial is the case this exists for, and a
    /// pre-flight check would have passed.
    pub async fn explain_failure(&self, error: &str) -> String {
        match self.exited().await {
            Some(died) => died,
            None => format!(
                "le tunnel {} est ouvert (port local {}), mais la base n'a pas répondu : {error}",
                self.spec.describe(),
                self.local_port
            ),
        }
    }

    /// Kills the helper and waits for it, closing the port.
    ///
    /// Dropping does the same, minus the wait — this exists so a caller
    /// tearing a session down deliberately doesn't leave the port in
    /// `TIME_WAIT` limbo while the next attempt tries to open one.
    pub async fn stop(self) {
        let mut child = self.child.lock().await;
        let _ = child.kill().await;
    }
}

/// Opens a forwarding session and waits until its port is actually listening.
pub async fn open(spec: SsmSpec) -> anyhow::Result<SsmTunnel> {
    let mut command = Command::new("aws");
    command.args(spec.args());
    open_with(command, spec).await
}

/// [`open`], with the command injected.
///
/// Split out purely so the lifecycle — port announced, helper died, helper
/// silent — is testable without AWS, a network, or credentials: a test passes
/// a `sh -c` that prints whatever line it wants to exercise. That lifecycle is
/// the part with the bugs in it; the `aws` invocation is [`SsmSpec::args`],
/// which is asserted separately.
pub async fn open_with(mut command: Command, spec: SsmSpec) -> anyhow::Result<SsmTunnel> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // The helper exists only to serve this tunnel; when the tunnel goes,
        // so must it, or every closed connection leaks a process holding a
        // port open.
        .kill_on_drop(true);

    // Same reasoning as `proxy_command::spawn`: `aws ssm start-session` hands
    // over to `session-manager-plugin`, found on PATH — and a plugin installed
    // after this app started is invisible to it, which reads as "I installed
    // it and it still doesn't work".
    if let Some(path) = crate::proxy_command::path_with_plugin_dirs(
        &std::env::var_os("PATH").unwrap_or_default(),
        &crate::proxy_command::installed_plugin_dirs(),
    ) {
        command.env("PATH", path);
    }

    // Windows gives a console to any console subsystem process it starts:
    // without this, a black window pops up in front of the app for the life of
    // the tunnel.
    // No `use std::os::windows::process::CommandExt` here: `tokio`'s own
    // `Command` re-exposes `creation_flags` inherently, so importing the trait
    // is an unused import — and the CI's Windows job runs clippy with
    // `-D warnings`, where an unused import fails the build. Invisible from
    // WSL, which never compiles this block. Same shape as `proxy_command`.
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = command
        .spawn()
        .map_err(|e| anyhow::anyhow!("`aws ssm start-session` n'a pas pu être lancée : {e}"))?;

    let output = Arc::new(Mutex::new(String::new()));
    let (port_tx, port_rx) = tokio::sync::oneshot::channel();

    // stdout carries both the announcement and, afterwards, per-connection
    // chatter. Drained for the whole life of the tunnel rather than until the
    // port is found: a helper whose pipe fills up blocks on its next write,
    // which would stall the tunnel itself.
    if let Some(handle) = child.stdout.take() {
        let sink = output.clone();
        let mut port_tx = Some(port_tx);
        tokio::spawn(async move {
            let mut lines = BufReader::new(handle).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                // A let-chain, which short-circuits — *not* a
                // `(Some(port), Some(tx))` tuple pattern, which evaluates both
                // sides before matching. That form consumed the sender on the
                // very first line ("Starting session with SessionId: …", which
                // every session prints), and dropping it made the receiver
                // report a helper that never announced a port. It read as a
                // plugin problem and was ours; the test above pins it.
                if let Some(port) = parse_opened_port(&line)
                    && let Some(tx) = port_tx.take()
                {
                    let _ = tx.send(port);
                }
                append_bounded(&sink, &line);
            }
        });
    }
    if let Some(handle) = child.stderr.take() {
        let sink = output.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(handle).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                append_bounded(&sink, &line);
            }
        });
    }

    // Three ways this ends, and each needs its own message: the port opened,
    // the helper gave up, or neither happened in time.
    let outcome = tokio::select! {
        port = port_rx => port.ok().ok_or_else(|| "le helper s'est arrêté sans annoncer de port".to_string()),
        status = child.wait() => Err(match status {
            Ok(status) => format!("`aws ssm start-session` s'est arrêtée ({status})"),
            Err(e) => format!("`aws ssm start-session` n'a pas pu être suivie : {e}"),
        }),
        _ = tokio::time::sleep(OPEN_TIMEOUT) => Err(format!(
            "`aws ssm start-session` n'a pas ouvert de port en {} s",
            OPEN_TIMEOUT.as_secs()
        )),
    };

    let local_port = match outcome {
        Ok(port) => port,
        Err(cause) => {
            // Give the readers a moment to finish draining: a helper that
            // fails immediately loses the race against this path, and the line
            // explaining *why* would still be sitting in the pipe. The same
            // bug `proxy_command::stderr_flushed` exists for.
            tokio::time::sleep(Duration::from_millis(200)).await;
            return Err(anyhow::anyhow!(failure_message(&spec, &cause, &output.lock_recover())));
        }
    };

    Ok(SsmTunnel { child: tokio::sync::Mutex::new(child), local_port, output, spec })
}

/// Assembles what the user is shown when a tunnel never opened: what was
/// attempted, what the helper said, and what to do about it.
fn failure_message(spec: &SsmSpec, cause: &str, output: &str) -> String {
    let mut message = format!(
        "impossible d'ouvrir le tunnel SSM vers {}:{} via {} : {cause}",
        spec.remote_host,
        spec.remote_port,
        spec.target
    );
    let output = output.trim();
    if !output.is_empty() {
        message.push('\n');
        message.push_str(output);
    }
    // Shared with `ProxyCommand`, which meets the same failures through the
    // same CLI — a remediation written twice is a remediation that drifts.
    if let Some(hint) = crate::proxy_command::hint_for(output).or_else(|| ssm_specific_hint(output)) {
        message.push_str("\n\n");
        message.push_str(&hint);
    }
    message
}

/// The failures specific to *port forwarding*, which `ProxyCommand` never
/// meets because it uses a different document and opens no local port.
fn ssm_specific_hint(output: &str) -> Option<String> {
    let haystack = output.to_lowercase();
    let hint = if haystack.contains("invaliddocument") || haystack.contains("document with name") {
        "Le document `AWS-StartPortForwardingSessionToRemoteHost` est introuvable dans \
         cette région. Il est fourni par AWS : vérifier la région (`--region`), et que le \
         compte n'a pas restreint les documents SSM utilisables."
    } else if haystack.contains("address already in use") || haystack.contains("bind") {
        "Le plugin n'a pas pu ouvrir de port local. Un pare-feu local ou une politique \
         de sécurité peut bloquer l'écoute sur la boucle locale."
    } else {
        return None;
    };
    Some(hint.to_string())
}

/// Recognises the plugin's port announcement.
///
/// The line is `Port 51234 opened for sessionId user-0123…`, printed once the
/// listener is actually accepting — which is why it, rather than the process
/// having started, is what [`open`] waits for. Dialling before it appears
/// fails with a plain connection refusal that looks exactly like a database
/// being down.
///
/// Matched loosely on purpose (a leading `Port`, a number, then `opened`)
/// rather than against the exact sentence: the plugin's wording has changed
/// across versions, and being strict here means a working tunnel reported as a
/// timeout.
pub fn parse_opened_port(line: &str) -> Option<u16> {
    let rest = line.trim().strip_prefix("Port ")?;
    let (number, rest) = rest.split_once(' ')?;
    if !rest.trim_start().starts_with("opened") {
        return None;
    }
    number.parse().ok()
}

/// Appends a line to the bounded diagnostics buffer.
fn append_bounded(sink: &Arc<Mutex<String>>, line: &str) {
    let mut buffer = sink.lock_recover();
    if buffer.len() >= OUTPUT_LIMIT {
        return;
    }
    buffer.push_str(line);
    buffer.push('\n');
}

/// What a trial run established, for the form's "Tester" button.
///
/// Three outcomes rather than two, because the middle one is a real and common
/// state: the session opened (so the CLI, the credentials, the IAM policy and
/// the SSM agent are all fine) but the instance cannot reach the database
/// (wrong endpoint, or a security group that doesn't allow it). Collapsing
/// that into "failed" would send the user to re-check credentials that
/// already work.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind", rename_all_fields = "camelCase")]
pub enum SsmProbe {
    /// A connection went through the tunnel and stayed up: the instance
    /// reaches the database.
    Reached { local_port: u16 },
    /// The tunnel opened, but a connection through it did not survive — the
    /// far leg, from the instance to the database, is what is broken.
    Opened { local_port: u16, detail: String },
    Failed { message: String, hint: Option<String> },
}

/// Opens a tunnel, tries one connection through it, and tears it down.
///
/// The connection attempt is what makes this worth a button: opening a session
/// only proves AWS let us, which is the half that rarely breaks. It is a bare
/// TCP connect and nothing more — no protocol is spoken and no credential is
/// sent, so this can be run against a production database without appearing in
/// its logs as a failed login.
pub async fn probe(spec: SsmSpec) -> SsmProbe {
    let tunnel = match open(spec).await {
        Ok(tunnel) => tunnel,
        Err(e) => {
            let message = e.to_string();
            let hint = crate::proxy_command::hint_for(&message).or_else(|| ssm_specific_hint(&message));
            return SsmProbe::Failed { message, hint };
        }
    };

    let local_port = tunnel.local_port();
    let outcome = match tokio::time::timeout(
        Duration::from_secs(10),
        tokio::net::TcpStream::connect(("127.0.0.1", local_port)),
    )
    .await
    {
        Ok(Ok(_stream)) => SsmProbe::Reached { local_port },
        Ok(Err(e)) => SsmProbe::Opened { local_port, detail: tunnel.explain_failure(&e.to_string()).await },
        Err(_) => SsmProbe::Opened {
            local_port,
            detail: tunnel.explain_failure("aucune réponse en 10 s").await,
        },
    };
    tunnel.stop().await;
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec() -> SsmSpec {
        SsmSpec {
            target: "i-0abc123".to_string(),
            profile: None,
            region: None,
            remote_host: "db.eu-west-1.rds.amazonaws.com".to_string(),
            remote_port: 5432,
        }
    }

    #[test]
    fn builds_the_documented_command_line() {
        let args = spec().args();
        assert_eq!(&args[0..2], &["ssm".to_string(), "start-session".to_string()]);

        let document = args.iter().position(|a| a == "--document-name").expect("--document-name");
        assert_eq!(args[document + 1], "AWS-StartPortForwardingSessionToRemoteHost");

        let target = args.iter().position(|a| a == "--target").expect("--target");
        assert_eq!(args[target + 1], "i-0abc123");

        // The parameters blob is JSON built by hand: every value is an array
        // of strings, which is what the document declares and what a plain
        // string silently fails validation against.
        let parameters = args.iter().position(|a| a == "--parameters").expect("--parameters");
        let blob: serde_json::Value = serde_json::from_str(&args[parameters + 1]).expect("valid JSON");
        assert_eq!(blob["host"], serde_json::json!(["db.eu-west-1.rds.amazonaws.com"]));
        assert_eq!(blob["portNumber"], serde_json::json!(["5432"]));
        assert_eq!(blob["localPortNumber"], serde_json::json!(["0"]), "0 asks for an OS-assigned port");

        // Neither flag is passed when unset, so the CLI's own default profile
        // and region apply — passing an empty string would override them with
        // nothing and fail.
        assert!(!args.contains(&"--profile".to_string()));
        assert!(!args.contains(&"--region".to_string()));
    }

    #[test]
    fn passes_profile_and_region_when_set() {
        let args = SsmSpec { profile: Some("prod".to_string()), region: Some("eu-west-3".to_string()), ..spec() }.args();
        let profile = args.iter().position(|a| a == "--profile").expect("--profile");
        assert_eq!(args[profile + 1], "prod");
        let region = args.iter().position(|a| a == "--region").expect("--region");
        assert_eq!(args[region + 1], "eu-west-3");

        // An empty string is what a cleared form field produces, and is not
        // the same as "the user chose this profile".
        let args = SsmSpec { profile: Some(String::new()), region: Some(String::new()), ..spec() }.args();
        assert!(!args.contains(&"--profile".to_string()), "empty is unset, not a choice");
        assert!(!args.contains(&"--region".to_string()));
    }

    #[test]
    fn recognises_the_plugins_port_announcement() {
        assert_eq!(parse_opened_port("Port 51234 opened for sessionId user-0123456789abcdef."), Some(51234));
        // Leading whitespace, and the wording without the trailing sentence —
        // both seen across plugin versions.
        assert_eq!(parse_opened_port("  Port 5432 opened"), Some(5432));

        // Lines that are emphatically not the announcement. The middle one
        // matters most: "Port 5432 is not available" must not be read as a
        // successful open, or the caller dials a port nobody is serving.
        assert_eq!(parse_opened_port("Starting session with SessionId: user-0123"), None);
        assert_eq!(parse_opened_port("Port 5432 is not available"), None);
        assert_eq!(parse_opened_port("Waiting for connections..."), None);
        assert_eq!(parse_opened_port("Connection accepted for session user-0123"), None);
        assert_eq!(parse_opened_port("Port abcd opened"), None);
        assert_eq!(parse_opened_port(""), None);
    }

    /// A fake helper standing in for `aws ssm start-session`, so the lifecycle
    /// is exercised without AWS, a network, or credentials.
    #[cfg(unix)]
    fn fake_helper(script: &str) -> Command {
        let mut command = Command::new("sh");
        command.arg("-c").arg(script);
        command
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn opens_when_the_helper_announces_a_port() {
        let tunnel = open_with(
            fake_helper("echo 'Starting session with SessionId: user-0123'; echo 'Port 51234 opened for sessionId user-0123.'; sleep 30"),
            spec(),
        )
        .await
        .expect("the announced port must open the tunnel");

        assert_eq!(tunnel.local_port(), 51234);
        assert_eq!(tunnel.exited().await, None, "the helper is still running");
        tunnel.stop().await;
    }

    /// The failure that motivated the whole module: a helper that dies has to
    /// be reported as the tunnel failing, carrying what it actually said —
    /// not as a database that refused a connection.
    #[cfg(unix)]
    #[tokio::test]
    async fn reports_the_helpers_own_words_when_it_dies() {
        let error = open_with(
            fake_helper("echo 'An error occurred (TargetNotConnected) when calling the StartSession operation' >&2; exit 254"),
            spec(),
        )
        .await
        .expect_err("a helper that exits cannot have opened a tunnel");

        let message = error.to_string();
        assert!(message.contains("TargetNotConnected"), "le message doit porter la sortie du helper : {message}");
        assert!(message.contains("i-0abc123"), "et ce qui était tenté : {message}");
        assert!(
            message.contains("agent SSM"),
            "et la remédiation partagée avec ProxyCommand, sinon elle n'existe que pour lui : {message}"
        );
    }

    /// A helper that starts, says nothing useful and stays up is the case a
    /// naive implementation reports as success — the port is never opened, so
    /// dialling it would fail later and blame the database.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_helper_that_never_announces_a_port_is_a_failure() {
        // The wait is bounded by `OPEN_TIMEOUT`, which is far too long for a
        // test; the helper exiting is what ends it here, and the assertion is
        // that a silent-then-gone helper never yields a tunnel.
        let error = open_with(fake_helper("echo 'Waiting for connections...'; sleep 0.2"), spec())
            .await
            .expect_err("no announced port means no tunnel");
        assert!(error.to_string().contains("tunnel SSM"), "obtenu : {error}");
    }

    /// The distinction the module exists to make, on the path where it is
    /// hardest: the tunnel opened, then died under the caller.
    #[cfg(unix)]
    #[tokio::test]
    async fn tells_a_dead_tunnel_apart_from_a_refusing_database() {
        let tunnel = open_with(fake_helper("echo 'Port 51234 opened for sessionId x.'; sleep 30"), spec())
            .await
            .expect("opens");

        let alive = tunnel.explain_failure("connection refused").await;
        assert!(alive.contains("est ouvert"), "tunnel vivant → la base est en cause : {alive}");
        assert!(alive.contains("connection refused"), "et l'erreur d'origine est gardée : {alive}");

        // Kill the helper the way a real one dies — under the caller, with no
        // warning — and ask the same question again.
        tunnel.child.lock().await.kill().await.expect("kill");
        let dead = tunnel.explain_failure("connection refused").await;
        assert!(dead.contains("s'est arrêté"), "tunnel mort → le tunnel est en cause : {dead}");
        assert!(
            !dead.contains("la base n'a pas répondu"),
            "et surtout pas les deux explications à la fois : {dead}"
        );
    }
}
