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

use serde::Serialize;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader, Join};
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
            let _ = tokio::time::timeout(std::time::Duration::from_millis(1500), task).await;
        }
        self.stderr_snapshot()
    }

    /// A ready-to-show account of what was run and what it said, for the
    /// connection error. The expanded command line belongs in there: the user
    /// wrote a template with `%h`/`%p` in it, so seeing the line that actually
    /// executed is often the whole diagnosis — a token that didn't expand, an
    /// instance id landing where a hostname was expected.
    pub async fn failure_detail(&mut self) -> String {
        let stderr = self.stderr_flushed().await;
        let mut detail = format!("commande : {}", self.command);
        if !stderr.is_empty() {
            detail.push('\n');
            detail.push_str(&stderr);
        }
        detail
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

/// A directory the helper can safely be started in: the user's home, falling
/// back to the temp directory. Both are always local paths, which is the point
/// — see the `current_dir` call in [`spawn`].
fn helper_working_dir() -> std::path::PathBuf {
    directories::BaseDirs::new()
        .map(|dirs| dirs.home_dir().to_path_buf())
        .filter(|home| home.is_dir())
        .unwrap_or_else(std::env::temp_dir)
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
        // Never inherit the app's own working directory. A helper has no
        // business depending on where the app was launched from — and on
        // Windows it actively breaks: `cmd.exe` refuses to run with a UNC path
        // (`\\server\share\...`) as its current directory, printing "UNC paths
        // are not supported" to stderr before falling back. That warning then
        // surfaces as the connection's error message, hiding the real cause.
        .current_dir(helper_working_dir())
        // The helper exists only to carry this connection; when the connection
        // goes, so must it, or every closed session leaks a process.
        .kill_on_drop(true);

    // Windows gives a console to any console subsystem process it starts, and
    // `cmd.exe` is one — so without this a black console window pops up in
    // front of the app and sits there for the whole session. The helper has no
    // use for a console of its own: all three of its streams are pipes we
    // hold.
    #[cfg(windows)]
    {
        /// `CREATE_NO_WINDOW` — from the Win32 process creation flags.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        builder.creation_flags(CREATE_NO_WINDOW);
    }

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

/// What a trial run of a proxy command established, for the "Tester" button.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind", rename_all_fields = "camelCase")]
pub enum ProxyProbe {
    /// The helper carried us all the way to something speaking SSH.
    ///
    /// This is a far stronger result than "the command started": the server
    /// sends its identification string as soon as a TCP connection to sshd is
    /// established, so seeing it proves the CLI exists, the credentials are
    /// valid, the target is reachable, its port is open and a real SSH server
    /// is listening — everything except the user's own authentication, which
    /// this deliberately never attempts.
    Reached { banner: String },
    /// It started and is still running, but nothing came back in time. Usually
    /// a tunnel pointed at a port where nothing is listening.
    Silent,
    /// It stopped, or never started.
    Failed {
        message: String,
        /// A remediation when the output is one we recognise.
        hint: Option<String>,
    },
}

/// Recognises a helper's own error output and says what to do about it.
///
/// Deliberately a small table of the failures that actually cost time rather
/// than an attempt at understanding every cloud CLI: each entry here is one a
/// user hit for real. The PATH remark on the first two matters more than it
/// looks — a program installed *after* the app was started is invisible to it
/// until the app is restarted, which reads as "I installed it and it still
/// doesn't work".
pub fn hint_for(output: &str) -> Option<String> {
    let haystack = output.to_lowercase();
    let hint = if haystack.contains("sessionmanagerplugin is not found") {
        "Le plugin Session Manager d'AWS n'est pas installé. Une fois : \
         `winget install Amazon.SessionManagerPlugin`, puis relancer Guiterm — \
         une application déjà lancée garde l'ancien PATH et ne verra pas le plugin."
    } else if haystack.contains("session token not found")
        || haystack.contains("unauthorizedexception")
    {
        "La session SSO n'est plus valide côté AWS : se reconnecter (le jeton en \
         cache a expiré, ou il appartient à une autre session)."
    } else if haystack.contains("is not recognized as an internal")
        || haystack.contains("n'est pas reconnu en tant que")
        || haystack.contains("command not found")
        // Bare "not found" only when it reads like a shell reporting a missing
        // program (`sh: aws: not found`). It used to match anything containing
        // the words — so AWS answering "Session token not found or invalid"
        // was explained as a missing executable, sending the user to check
        // their PATH for a problem that was purely a stale token.
        || haystack.contains(": not found")
        || haystack.contains("no such file or directory")
    {
        "Le programme de la commande est introuvable. Vérifier son installation et \
         qu'il est dans le PATH — et si l'installation vient d'être faite, relancer \
         Guiterm : une application déjà lancée garde l'ancien PATH."
    } else if haystack.contains("expiredtoken") || haystack.contains("token included in the request is expired") {
        "La session AWS a expiré : `aws sso login --profile <profil>`. Penser à \
         préciser `--profile` dans la commande, sinon c'est le profil par défaut qui \
         est utilisé."
    } else if haystack.contains("unable to locate credentials")
        || haystack.contains("nocredentialproviders")
    {
        "Aucun identifiant AWS trouvé pour cette commande. Ajouter `--profile <profil>` \
         (le profil par défaut n'est pas forcément celui qui est connecté)."
    } else if haystack.contains("targetnotconnected") {
        "L'instance n'est pas enregistrée auprès de SSM : agent SSM arrêté, rôle \
         d'instance sans `AmazonSSMManagedInstanceCore`, ou aucune route vers le \
         service SSM (NAT ou endpoints VPC ssm/ssmmessages/ec2messages)."
    } else if haystack.contains("accessdenied") || haystack.contains("not authorized") {
        "Identifiants valides mais droits insuffisants pour ouvrir la session \
         (`ssm:StartSession` sur l'instance et sur le document utilisé)."
    } else {
        return None;
    };
    Some(hint.to_string())
}

/// Runs a proxy command for real, just long enough to find out whether it
/// reaches an SSH server, and reports what happened.
///
/// Never authenticates and never keeps the tunnel: the helper is killed as
/// soon as the answer is known (dropping [`ProxyProcess`] does it). Safe to
/// run from a settings form — the worst it does is open and immediately close
/// one session on the target.
pub async fn probe(
    template: &str,
    address: &str,
    port: u16,
    username: &str,
    timeout: Duration,
) -> ProxyProbe {
    let (mut proxy, mut transport) = match spawn(template, address, port, username) {
        Ok(started) => started,
        Err(e) => {
            return ProxyProbe::Failed {
                hint: hint_for(&e.to_string()),
                message: e.to_string(),
            };
        }
    };

    let mut buffer = [0u8; 256];
    match tokio::time::timeout(timeout, transport.read(&mut buffer)).await {
        // Bytes came back: the far end is talking. Report its greeting, which
        // is what makes the success believable rather than a bare green tick.
        Ok(Ok(n)) if n > 0 => {
            let banner = String::from_utf8_lossy(&buffer[..n]);
            let banner = banner.lines().next().unwrap_or("").trim().to_string();
            if banner.starts_with("SSH-") {
                ProxyProbe::Reached { banner }
            } else {
                // Something answered, but it isn't an SSH server — a tunnel
                // pointed at the wrong port, or a helper printing a banner of
                // its own onto the transport (which would corrupt the
                // handshake, so it's worth saying).
                ProxyProbe::Failed {
                    message: format!(
                        "la commande a répondu, mais ce n'est pas un serveur SSH : « {banner} »"
                    ),
                    hint: Some(
                        "Vérifier le port visé par la commande, et qu'elle n'écrit rien \
                         d'autre que le flux SSH sur sa sortie standard."
                            .to_string(),
                    ),
                }
            }
        }
        // Clean end of stream: the helper gave up. Its own words explain why.
        Ok(Ok(_)) | Ok(Err(_)) => {
            let detail = proxy.stderr_flushed().await;
            let message = if detail.is_empty() {
                "la commande s'est arrêtée sans rien renvoyer".to_string()
            } else {
                detail.clone()
            };
            ProxyProbe::Failed {
                hint: hint_for(&detail),
                message,
            }
        }
        Err(_) => {
            // Still running but mute. Its stderr may still say something
            // useful (a progress line, a warning), so it is worth reporting.
            let detail = proxy.stderr_snapshot();
            if detail.is_empty() {
                ProxyProbe::Silent
            } else {
                ProxyProbe::Failed {
                    hint: hint_for(&detail),
                    message: detail,
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The "missing program" hint used to fire on any output containing the
    /// words "not found", which is how an AWS token error got explained as a
    /// PATH problem. Tightening it must not lose the real cases — those are
    /// the ones this hint exists for.
    #[test]
    fn a_missing_program_is_still_recognised_after_tightening_not_found() {
        for output in [
            "'aws' is not recognized as an internal or external command",
            "aws : n'est pas reconnu en tant que commande interne",
            "bash: aws: command not found",
            "sh: 1: aws: not found",
            "No such file or directory (os error 2)",
        ] {
            let hint = hint_for(output).unwrap_or_else(|| panic!("aucune remédiation pour : {output}"));
            assert!(hint.contains("PATH"), "attendu la remédiation d'exécutable pour : {output}");
        }
    }

    #[test]
    fn a_dead_sso_token_is_not_explained_as_a_missing_program() {
        let hint = hint_for(
            "An error occurred (UnauthorizedException) when calling the ListAccounts operation: Session token not found or invalid",
        )
        .expect("un jeton mort a une remédiation");
        assert!(!hint.contains("PATH"), "obtenu : {hint}");
        assert!(hint.contains("reconnecter"), "obtenu : {hint}");
    }

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

    /// The helper starts in a directory of our choosing, not wherever the app
    /// happened to be launched from.
    ///
    /// Found in real use: the app had been started from a UNC path
    /// (`\\wsl.localhost\...`), `cmd.exe` refuses to run with one as its
    /// current directory, and its "UNC paths are not supported" warning went
    /// out on stderr — where it landed in the user's connection error,
    /// looking like the cause of a failure it had nothing to do with.
    #[tokio::test]
    async fn the_helper_does_not_inherit_the_apps_working_directory() {
        let (mut proxy, _transport) =
            spawn(if cfg!(windows) { "cd 1>&2" } else { "pwd >&2" }, "srv", 22, "u")
                .expect("spawning a shell command should succeed");

        let reported = proxy.stderr_flushed().await;
        assert_eq!(
            std::path::Path::new(reported.trim()),
            helper_working_dir(),
            "le helper doit démarrer dans le dossier choisi, pas dans celui de l'app"
        );
        assert!(
            !reported.trim_start().starts_with("\\\\"),
            "un chemin UNC comme dossier courant est exactement ce que cmd.exe refuse : {reported:?}"
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
