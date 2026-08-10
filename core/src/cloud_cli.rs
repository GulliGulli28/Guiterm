//! Running a cloud provider's own CLI, and making sense of it when it refuses.
//!
//! Shared by [`crate::azure_inventory`] and [`crate::gcp_inventory`], which do
//! the same three things — run a CLI, read JSON, classify the failure — and
//! differ only in the words each provider uses.
//!
//! **Why not reuse `aws_inventory::run_aws`.** Same shape, deliberately not
//! merged. That runner's error classification is AWS-specific all the way
//! through: it shares [`crate::proxy_command::hint_for`] with the SSM path on
//! purpose, and `is_expired_session` exists to decide whether a *reconnect SSO*
//! button appears. Folding three providers into it would mean one table of
//! remedies pretending to speak for all of them, which is exactly the
//! factorisation `ansible_inventory` refused for the matching rule.
//!
//! **No SDK, no credentials of our own** — same bargain as the EC2 import: we
//! shell out to the CLI the user has already logged in with, so their tenant,
//! their MFA and their SSO keep working untouched and this app never holds a
//! cloud secret. The cost is that the CLI must be installed and authenticated,
//! which is a visible failure ([`CloudCliError`]) rather than a silent one.

use serde::Serialize;
use std::time::Duration;

/// How long any single provider CLI call may take.
///
/// Generous, and more so than the `aws` runner's 45 s: both `az` and `gcloud`
/// are Python programs that may refresh a token on the way, and `az vm list
/// --show-details` fans out to the network interfaces of every VM in the
/// subscription. A slow answer is far better than a wrong "it didn't respond".
const CLI_TIMEOUT: Duration = Duration::from_secs(90);

/// Why a provider CLI call couldn't be made sense of.
///
/// Typed rather than a string so the panel can offer the matching remedy —
/// notably telling "you haven't logged in" (one command away) apart from "you
/// aren't allowed" (not fixable from here).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind", rename_all_fields = "camelCase")]
pub enum CloudCliError {
    /// The CLI isn't installed, or isn't on this process's PATH.
    CliMissing {
        /// The command that was looked for (`az`, `gcloud`), so the message
        /// can name it rather than say "the CLI".
        program: String,
        /// Where to get it.
        install_hint: String,
    },
    /// It ran and said nobody is logged in. Fixable by one command, which the
    /// panel shows — this is the common first-run failure, and reading it in
    /// raw provider jargon sends people looking for the wrong problem.
    NotLoggedIn {
        program: String,
        message: String,
        login_hint: String,
    },
    /// It ran and refused for some other reason: denied permissions, unknown
    /// subscription, a quota. Not fixable by logging in again, so it must not
    /// offer to.
    Refused { message: String },
    /// It answered something we couldn't read.
    Unreadable { message: String },
}

impl CloudCliError {
    pub fn message(&self) -> String {
        match self {
            Self::CliMissing { program, .. } => format!("La CLI `{program}` est introuvable."),
            Self::NotLoggedIn { message, .. }
            | Self::Refused { message }
            | Self::Unreadable { message } => message.clone(),
        }
    }
}

/// Which provider is being run — the small amount that actually differs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Provider {
    Azure,
    Gcp,
}

impl Provider {
    /// The command name, without any platform extension.
    pub fn program(self) -> &'static str {
        match self {
            Self::Azure => "az",
            Self::Gcp => "gcloud",
        }
    }

    /// What a host imported from this provider records in
    /// [`crate::model::HostSource`].
    pub fn source_kind(self) -> &'static str {
        match self {
            Self::Azure => "azure",
            Self::Gcp => "gcp",
        }
    }

    fn install_hint(self) -> &'static str {
        match self {
            Self::Azure => {
                "Installez Azure CLI (https://aka.ms/installazurecli), puis `az login`."
            }
            Self::Gcp => {
                "Installez le SDK Google Cloud (https://cloud.google.com/sdk/docs/install), \
                 puis `gcloud auth login`."
            }
        }
    }

    fn login_hint(self) -> &'static str {
        match self {
            Self::Azure => "Lancez `az login` dans un terminal, puis réessayez.",
            Self::Gcp => "Lancez `gcloud auth login` dans un terminal, puis réessayez.",
        }
    }
}

/// The program names to try, in order, for `program` on this platform.
///
/// **This is the whole reason `run` isn't three lines.** `aws` ships as
/// `aws.exe`, so `Command::new("aws")` finds it: `CreateProcess` appends `.exe`
/// to an extensionless name and nothing else. `az` and `gcloud` ship as
/// **batch shims** — there is no `az.exe` anywhere on a normal Azure CLI
/// install — so the same call fails with `NotFound` on a machine where the CLI
/// is installed and correctly on PATH. Copying the `aws` runner verbatim would
/// have told those users their CLI was missing.
///
/// Spelling the extension out is enough: Rust's `Command` resolves `az.cmd`
/// through PATH *and* runs it through the batch interpreter itself, with the
/// argument escaping that fix required (CVE-2024-24576). Verified on rustc
/// 1.96.1 — `Command::new("az")` fails, `Command::new("az.cmd")` succeeds. So
/// we never build a `cmd.exe /C` line of our own, and never inherit its
/// quoting hazards.
///
/// Takes `windows` rather than reading `cfg!` inside so the ordering is
/// testable from any platform — this repo's tests run on Linux, and a
/// `#[cfg(windows)]` test of the Windows behaviour would simply never run
/// where it is developed.
pub fn candidate_programs(program: &str, windows: bool) -> Vec<String> {
    if windows {
        // `.cmd` first: it is what both providers actually ship. The bare name
        // second covers a future `.exe` and keeps the Unix spelling working if
        // someone puts a real executable ahead on PATH.
        vec![format!("{program}.cmd"), program.to_string()]
    } else {
        vec![program.to_string()]
    }
}

/// Runs a provider CLI and returns its stdout.
pub async fn run(provider: Provider, args: &[&str]) -> Result<String, CloudCliError> {
    let program = provider.program();
    for candidate in candidate_programs(program, cfg!(windows)) {
        match run_one(&candidate, args).await {
            Ok(output) => return Ok(output),
            // Only a "there is no such program" answer is worth trying the
            // next spelling for. Anything else means the CLI ran, and running
            // it a second time would double a network call — or, worse, repeat
            // a side effect if this is ever used for something that has one.
            Err(Missing) => continue,
            Err(Failed(err)) => return Err(classify(provider, &err)),
        }
    }

    Err(CloudCliError::CliMissing {
        program: program.to_string(),
        install_hint: provider.install_hint().to_string(),
    })
}

/// Runs a provider CLI that takes a while, reporting its output as it arrives.
///
/// Separate from [`run`] because the interesting part happens *during* the
/// wait rather than at the end: `az login` prints a verification URL — and,
/// with a device code, the code itself — then blocks until the user has
/// finished in their browser. Collecting the output and showing it afterwards
/// would hide precisely the lines that make the wait actionable. Same shape
/// and same reasoning as `aws_sso::login`.
pub async fn run_streaming(
    provider: Provider,
    args: &[&str],
    on_line: &mut (dyn FnMut(String) + Send),
) -> Result<(), CloudCliError> {
    let program = provider.program();
    for candidate in candidate_programs(program, cfg!(windows)) {
        match stream_one(&candidate, args, on_line).await {
            Ok(()) => return Ok(()),
            Err(Missing) => continue,
            Err(Failed(err)) => return Err(classify(provider, &err)),
        }
    }
    Err(CloudCliError::CliMissing {
        program: program.to_string(),
        install_hint: provider.install_hint().to_string(),
    })
}

async fn stream_one(
    program: &str,
    args: &[&str],
    on_line: &mut (dyn FnMut(String) + Send),
) -> Result<(), RunFailure> {
    use tokio::io::AsyncBufReadExt;

    let mut command = tokio::process::Command::new(program);
    command
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .current_dir(crate::proxy_command::helper_working_dir())
        .kill_on_drop(true);
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err(Missing),
        Err(e) => return Err(Failed(format!("`{program}` n'a pas pu être lancée : {e}"))),
    };

    // Both streams matter, for the reason `aws_sso::login` records: these CLIs
    // have moved the verification URL between stdout and stderr across
    // versions, so reading only one has shown users an empty wait.
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    for stream in [
        child.stdout.take().map(|s| Box::new(s) as Box<dyn tokio::io::AsyncRead + Unpin + Send>),
        child.stderr.take().map(|s| Box::new(s) as Box<dyn tokio::io::AsyncRead + Unpin + Send>),
    ]
    .into_iter()
    .flatten()
    {
        let tx = tx.clone();
        tokio::spawn(async move {
            let mut lines = tokio::io::BufReader::new(stream).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if tx.send(line).is_err() {
                    break;
                }
            }
        });
    }
    drop(tx);

    let mut transcript = Vec::new();
    while let Some(line) = rx.recv().await {
        transcript.push(line.clone());
        on_line(line);
    }

    let status = child
        .wait()
        .await
        .map_err(|e| Failed(format!("`{program}` s'est terminée anormalement : {e}")))?;
    if status.success() {
        return Ok(());
    }
    Err(Failed(transcript.join("\n")))
}

/// Either the program doesn't exist under this spelling, or it ran and we have
/// something to say about the result.
enum RunFailure {
    Missing,
    Failed(String),
}
use RunFailure::{Failed, Missing};

async fn run_one(program: &str, args: &[&str]) -> Result<String, RunFailure> {
    let mut command = tokio::process::Command::new(program);
    command
        .args(args)
        .stdin(std::process::Stdio::null())
        // Never inherit the app's own working directory — and here it is not a
        // precaution but a reproduced failure. Running `az.cmd` from this
        // repo's UNC checkout makes `cmd.exe` print "Les chemins d'accès UNC ne
        // sont pas prise en charge" to stderr before falling back to the
        // Windows directory. The call still succeeds, so it would have gone
        // unnoticed until the day a *failing* call had that warning glued to
        // the front of its real error message.
        .current_dir(crate::proxy_command::helper_working_dir())
        .kill_on_drop(true);
    // Same reasoning as `proxy_command::spawn` and the `aws` runner: no console
    // window flashing on Windows for a call the user never asked to see.
    #[cfg(windows)]
    {
        // No `use std::os::windows::process::CommandExt` here: tokio's
        // `Command` carries `creation_flags` as an inherent method, so the
        // trait import is dead code — and `-D warnings` in the Windows CI job
        // would reject it. The `aws` runner omits it for the same reason.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let output = match tokio::time::timeout(CLI_TIMEOUT, command.output()).await {
        Ok(Ok(output)) => output,
        Ok(Err(e)) if e.kind() == std::io::ErrorKind::NotFound => return Err(Missing),
        Ok(Err(e)) => return Err(Failed(format!("`{program}` n'a pas pu être exécutée : {e}"))),
        Err(_) => {
            return Err(Failed(format!(
                "`{program}` n'a pas répondu dans le temps imparti."
            )))
        }
    };

    if !output.status.success() {
        return Err(Failed(String::from_utf8_lossy(&output.stderr).into_owned()));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// Turns a provider's refusal into a typed error with a remedy.
///
/// Matched on the *idea* rather than on exact sentences, for the reason
/// `aws_inventory::is_expired_session` documents: each provider words this
/// several ways across CLI versions and locales, and a list of literal phrases
/// would rot silently — the login button would just stop appearing.
pub fn classify(provider: Provider, stderr: &str) -> CloudCliError {
    let lowered = stderr.to_lowercase();
    let message = stderr.trim().to_string();

    // The shell saying the program doesn't exist, rather than the program
    // saying anything — reachable when a shim exists but is broken.
    if lowered.contains("is not recognized as an internal")
        || lowered.contains("n'est pas reconnu en tant que")
        || lowered.contains("command not found")
    {
        return CloudCliError::CliMissing {
            program: provider.program().to_string(),
            install_hint: provider.install_hint().to_string(),
        };
    }

    if is_not_logged_in(provider, &lowered) {
        return CloudCliError::NotLoggedIn {
            program: provider.program().to_string(),
            message,
            login_hint: provider.login_hint().to_string(),
        };
    }

    CloudCliError::Refused { message }
}

/// Whether a refusal means "nobody is logged in" rather than "you may not".
///
/// The distinction matters because only the first is fixed by the button the
/// panel offers. Being wrong in the permissive direction would send someone to
/// re-authenticate over and over against a permissions problem.
fn is_not_logged_in(provider: Provider, lowered: &str) -> bool {
    match provider {
        // `az` says "Please run 'az login' to setup account", and
        // "AADSTS700082 / refresh token has expired" once a session lapses.
        Provider::Azure => {
            lowered.contains("az login")
                || lowered.contains("please run 'az account set'")
                || (lowered.contains("refresh token") && lowered.contains("expired"))
                || lowered.contains("no subscription found")
        }
        // `gcloud` says "You do not currently have an active account selected"
        // and points at `gcloud auth login`; reauth failures say so outright.
        Provider::Gcp => {
            lowered.contains("gcloud auth login")
                || lowered.contains("do not currently have an active account")
                || lowered.contains("reauthentication failed")
                || lowered.contains("credentials are no longer valid")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The bug this module exists for. If someone ever "simplifies" this back
    /// to a bare program name, Windows users with a perfectly good Azure CLI
    /// are told it isn't installed — and nothing else in the suite notices,
    /// because every other test runs on Linux.
    #[test]
    fn windows_tries_the_cmd_shim_first() {
        assert_eq!(candidate_programs("az", true), vec!["az.cmd", "az"]);
        assert_eq!(
            candidate_programs("gcloud", true),
            vec!["gcloud.cmd", "gcloud"]
        );
    }

    #[test]
    fn unix_uses_the_bare_name_only() {
        assert_eq!(candidate_programs("az", false), vec!["az"]);
        assert_eq!(candidate_programs("gcloud", false), vec!["gcloud"]);
    }

    #[test]
    fn a_missing_cli_is_told_apart_from_a_refusal() {
        let missing = classify(Provider::Azure, "'az' is not recognized as an internal command");
        assert!(matches!(missing, CloudCliError::CliMissing { .. }));

        let refused = classify(
            Provider::Azure,
            "AuthorizationFailed: does not have authorization to perform action",
        );
        assert!(matches!(refused, CloudCliError::Refused { .. }));
    }

    #[test]
    fn azure_login_prompts_are_recognised() {
        for stderr in [
            "Please run 'az login' to setup account.",
            // Captured verbatim from a real `az vm list` on 2026-08-10, on a
            // subscription whose session had lapsed. Kept whole, jargon and
            // trace ids included, because that is what the classifier actually
            // receives — a hand-tidied sample would prove less.
            "ERROR: V2Error: invalid_grant AADSTS700082: The refresh token has expired due to \
             inactivity. The token was issued on 2026-04-20T14:30:28.0990908Z and was inactive \
             for 90.00:00:00. Trace ID: af03a572-be25-4d2e-9d0a-f26981260f00 Correlation ID: \
             57edf5de-7629-426f-ad47-30d87fa3e2ad Timestamp: 2026-08-10 08:19:37Z. Status: \
             Response_Status.Status_InteractionRequired, Error code: 3399614467, Tag: 558133255",
        ] {
            assert!(
                matches!(
                    classify(Provider::Azure, stderr),
                    CloudCliError::NotLoggedIn { .. }
                ),
                "« {stderr} » devrait être reconnu comme une absence de connexion"
            );
        }
    }

    #[test]
    fn gcp_login_prompts_are_recognised() {
        for stderr in [
            "ERROR: (gcloud.compute.instances.list) You do not currently have an active account selected.",
            "ERROR: (gcloud.compute.instances.list) There was a problem refreshing your current auth tokens: Reauthentication failed.",
        ] {
            assert!(
                matches!(
                    classify(Provider::Gcp, stderr),
                    CloudCliError::NotLoggedIn { .. }
                ),
                "« {stderr} » devrait être reconnu comme une absence de connexion"
            );
        }
    }

    /// A permissions refusal must not offer to log in again: the user would
    /// re-authenticate successfully and hit the very same wall.
    #[test]
    fn a_permissions_refusal_does_not_offer_to_log_in() {
        let err = classify(
            Provider::Gcp,
            "ERROR: (gcloud.compute.instances.list) Required 'compute.instances.list' permission for 'projects/foo'",
        );
        assert!(matches!(err, CloudCliError::Refused { .. }));
    }

    #[test]
    fn source_kinds_are_stable_strings() {
        // Written into `workspace.json`; changing one orphans every host
        // already imported under the old spelling.
        assert_eq!(Provider::Azure.source_kind(), "azure");
        assert_eq!(Provider::Gcp.source_kind(), "gcp");
    }
}
