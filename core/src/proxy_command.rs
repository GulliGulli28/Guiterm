//! Reaching a host through a helper process instead of a direct TCP
//! connection — OpenSSH's `ProxyCommand`.
//!
//! The helper is launched locally, and its stdin/stdout *are* the transport:
//! whatever it writes is what the SSH client reads, and vice versa. That is
//! all `ProxyCommand` ever was, and it's why one small feature covers a whole
//! category of otherwise unreachable machines — cloud VMs with no public IP
//! and no inbound SSH, reached through AWS SSM Session Manager, GCP IAP,
//! Azure Bastion, `cloudflared access ssh`, Teleport, or a site's own jump
//! tooling. None of those need to be known here; they are all just a command
//! that relays bytes.
//!
//! This plugs into the same place bastion chaining already does: a hop's
//! transport is any `AsyncRead + AsyncWrite`, handed to
//! `russh::client::connect_stream` (see [`crate::ssh`]'s module docs).
//! Chaining gets that stream from a `direct-tcpip` channel on the previous
//! hop; here it comes from a child process instead.
//!
//! **The command runs through the user's shell**, exactly as OpenSSH runs it,
//! so quoting and pipelines behave the way the documentation of whichever
//! cloud tool the user copied it from says they do. It is configuration the
//! user typed for their own machine, on the same footing as `~/.ssh/config`.

use std::process::Stdio;
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncBufReadExt, BufReader, Join};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};

use crate::sync_ext::MutexExt;

/// The transport handed to `russh`: the helper's stdout to read from, its
/// stdin to write to.
pub type ProxyTransport = Join<ChildStdout, ChildStdin>;

/// How much of the helper's stderr is kept for diagnostics. A helper that
/// fails usually says why in its first line or two; a helper that spews is
/// not worth holding in memory for the life of a session.
const STDERR_LIMIT: usize = 4096;

/// A running proxy helper.
///
/// Must be kept alive for as long as the connection that rides on it: dropping
/// it kills the helper (`kill_on_drop`), which is what closes the tunnel when
/// a session ends. [`crate::ssh::Connection`] owns it for that reason.
pub struct ProxyProcess {
    /// Never read — held so that dropping `ProxyProcess` drops the `Child`,
    /// which kills the helper.
    _child: Child,
    stderr: Arc<Mutex<String>>,
    reader: Option<tokio::task::JoinHandle<()>>,
    command: String,
}

impl ProxyProcess {
    /// What the helper has written to stderr so far.
    ///
    /// The only clue available when the SSH handshake fails because the helper
    /// failed rather than the server: `aws ssm start-session` with an expired
    /// login, a missing binary, a typo'd instance id — all of them produce a
    /// perfectly ordinary "handshake failed" on their own, which tells the
    /// user nothing about what to fix.
    pub fn stderr_snapshot(&self) -> String {
        self.stderr.lock_recover().trim().to_string()
    }

    /// Same, but first gives the reader task a chance to finish draining.
    ///
    /// A helper that fails immediately loses the race against the error path:
    /// its stdio closes, the handshake fails with "Broken pipe", and the
    /// message explaining *why* is still sitting unread in the pipe. Snapshot
    /// it too early and the user is told about a broken pipe instead of their
    /// expired credentials — which is exactly what happened before this
    /// existed.
    ///
    /// Bounded, because the helper may equally be alive and simply not
    /// speaking SSH; then there is nothing to wait for and whatever arrived so
    /// far is the best answer available. Only ever called on the failure path.
    pub async fn stderr_flushed(&mut self) -> String {
        if let Some(task) = self.reader.take() {
            let _ = tokio::time::timeout(std::time::Duration::from_millis(500), task).await;
        }
        self.stderr_snapshot()
    }

    /// The command line as actually run, after token expansion.
    pub fn command(&self) -> &str {
        &self.command
    }
}

/// Substitutes OpenSSH's `ProxyCommand` tokens: `%h` host, `%p` port, `%r`
/// remote username, `%%` a literal percent.
///
/// Single-pass on purpose — a substituted value that happens to contain `%p`
/// (an address from an inventory, a username with a percent in it) must not be
/// expanded again. Unknown tokens are left as they were written rather than
/// swallowed: `%d` is far more likely to be a typo the user needs to see than
/// something we should silently delete from their command line.
pub fn expand(template: &str, address: &str, port: u16, username: &str) -> String {
    let mut out = String::with_capacity(template.len());
    let mut chars = template.chars();
    while let Some(c) = chars.next() {
        if c != '%' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('h') => out.push_str(address),
            Some('p') => out.push_str(&port.to_string()),
            Some('r') => out.push_str(username),
            Some('%') => out.push('%'),
            Some(other) => {
                out.push('%');
                out.push(other);
            }
            None => out.push('%'),
        }
    }
    out
}

/// Launches `template` (after [`expand`]) and returns the helper plus the byte
/// stream to run the SSH handshake over.
///
/// Returned as two values rather than one struct because `connect_stream`
/// takes the stream by value while the helper has to outlive it.
pub fn spawn(
    template: &str,
    address: &str,
    port: u16,
    username: &str,
) -> anyhow::Result<(ProxyProcess, ProxyTransport)> {
    let command = expand(template, address, port, username);

    // Through the shell, like OpenSSH: these commands are copied from cloud
    // provider documentation and routinely contain quoting the user expects to
    // be honoured.
    let mut builder = if cfg!(windows) {
        let mut c = Command::new("cmd");
        c.arg("/C").arg(&command);
        c
    } else {
        let mut c = Command::new("sh");
        c.arg("-c").arg(&command);
        c
    };
    builder
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // The helper exists only to carry this connection; when the connection
        // goes, so must it, or every closed session leaks a process.
        .kill_on_drop(true);

    let mut child = builder
        .spawn()
        .map_err(|e| anyhow::anyhow!("could not start the proxy command '{command}': {e}"))?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| anyhow::anyhow!("proxy command '{command}' exposed no stdout"))?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| anyhow::anyhow!("proxy command '{command}' exposed no stdin"))?;

    // Drained continuously rather than read on failure: a helper whose stderr
    // pipe fills up blocks on its next write, which would stall the tunnel
    // itself rather than just cost us the diagnostics.
    let stderr = Arc::new(Mutex::new(String::new()));
    let reader = child.stderr.take().map(|handle| {
        let sink = stderr.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(handle).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let mut buffer = sink.lock_recover();
                if buffer.len() >= STDERR_LIMIT {
                    break;
                }
                buffer.push_str(&line);
                buffer.push('\n');
            }
        })
    });

    Ok((
        ProxyProcess {
            _child: child,
            stderr,
            reader,
            command,
        },
        tokio::io::join(stdout, stdin),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn substitutes_the_openssh_tokens() {
        assert_eq!(
            expand(
                "aws ssm start-session --target %h --parameters portNumber=%p",
                "i-0abc123",
                22,
                "ec2-user"
            ),
            "aws ssm start-session --target i-0abc123 --parameters portNumber=22"
        );
        assert_eq!(expand("connect %r@%h:%p", "srv", 2222, "deploy"), "connect deploy@srv:2222");
    }

    #[test]
    fn a_doubled_percent_is_a_literal_one() {
        assert_eq!(expand("echo 100%% --to %h", "srv", 22, "u"), "echo 100% --to srv");
    }

    // A substituted value is not itself a template. An address carrying "%p"
    // must survive verbatim, or a hostname out of a cloud inventory could
    // rewrite the command line it was substituted into.
    #[test]
    fn substituted_values_are_not_expanded_again() {
        assert_eq!(expand("reach %h", "weird%p.example", 22, "u"), "reach weird%p.example");
        assert_eq!(expand("as %r", "srv", 22, "%h%h"), "as %h%h");
    }

    // Left alone rather than dropped: a user who typed the wrong token needs
    // to see it in the error, not to have it silently vanish.
    #[test]
    fn unknown_tokens_are_left_as_written() {
        assert_eq!(expand("x %d y", "srv", 22, "u"), "x %d y");
        assert_eq!(expand("trailing %", "srv", 22, "u"), "trailing %");
    }

    /// The exact contrast [`ProxyProcess::stderr_flushed`] exists for.
    ///
    /// `#[tokio::test]` runs on a current-thread runtime, so the drain task
    /// cannot have run before the first await point: the plain snapshot is
    /// *deterministically* empty here, and only the flushing accessor has
    /// anything to report. That difference is the whole difference between
    /// telling the user "Broken pipe" and telling them their credentials
    /// expired — which is what a helper that dies instantly actually
    /// produced before this existed.
    #[tokio::test]
    async fn flushing_is_what_makes_a_fast_failure_reportable() {
        let message = "identifiants expires";
        let (mut proxy, _transport) = spawn(
            if cfg!(windows) {
                "echo identifiants expires 1>&2"
            } else {
                "echo 'identifiants expires' >&2"
            },
            "srv",
            22,
            "u",
        )
        .expect("spawning a shell command should succeed");

        assert_eq!(
            proxy.stderr_snapshot(),
            "",
            "sans point d'attente, la tâche de drainage ne peut pas encore avoir tourné — \
             si ce n'est plus vrai, ce test ne prouve plus rien"
        );
        let flushed = proxy.stderr_flushed().await;
        assert!(
            flushed.contains(message),
            "stderr du helper perdu sur le chemin d'erreur : {flushed:?}"
        );
    }

    /// Bounded, not blocking: a helper that stays alive and simply never
    /// speaks SSH must not hold the error path open indefinitely.
    #[tokio::test]
    async fn flushing_gives_up_on_a_helper_that_keeps_running() {
        let (mut proxy, _transport) = spawn(
            if cfg!(windows) { "ping -n 30 127.0.0.1 > NUL" } else { "sleep 30" },
            "srv",
            22,
            "u",
        )
        .expect("spawning a shell command should succeed");

        let started = std::time::Instant::now();
        let _ = proxy.stderr_flushed().await;
        assert!(
            started.elapsed() < std::time::Duration::from_secs(2),
            "l'attente de stderr doit être bornée, a pris {:?}",
            started.elapsed()
        );
    }
}
