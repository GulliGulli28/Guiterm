//! The channel through which SSH keyboard-interactive authentication asks the
//! user something mid-handshake.
//!
//! Keyboard-interactive (RFC 4256) is how servers drive MFA/OTP: instead of
//! taking one credential up front, the server sends a *series* of prompts
//! ("Password:", then "Verification code:"), each of which has to be answered
//! before it will say whether authentication succeeded. That makes it the one
//! auth method that cannot be resolved from stored configuration alone — it
//! needs a live round trip to whoever is sitting in front of the app.
//!
//! `core` has no UI and no Tauri dependency, so it can't do that itself. It
//! defines the shape of the conversation ([`Prompter`]) and keeps a
//! process-wide instance ([`set_prompter`]); `src-tauri` installs one that
//! forwards to the frontend and waits for the answer. Same
//! ambient-global shape as [`crate::vault`] and [`crate::ssh_pool`], for the
//! same reason: `ssh::connect` is reached from a dozen call sites that have no
//! business knowing about prompting.
//!
//! When no prompter is installed (tests, examples, the CLI-less paths),
//! authentication fails with a clear message rather than hanging forever
//! waiting for an answer that can never come.
use std::sync::{Arc, OnceLock};

/// One question from the server.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptField {
    /// The server's own wording, shown verbatim — it's the only thing that
    /// tells the user *which* factor is being asked for, and it varies by
    /// deployment ("Verification code:", "Duo passcode or option (1-3):"…).
    pub prompt: String,
    /// Whether the typed characters may be shown. `false` for anything
    /// secret-like, which is what the server says for passwords; an OTP is
    /// often sent with `echo: true` since it's single-use.
    pub echo: bool,
}

/// A round of questions. A single authentication can go through several of
/// these — the server decides how many.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InfoRequest {
    /// Server-supplied title. Often empty.
    pub name: String,
    /// Server-supplied explanatory text. Often empty.
    pub instructions: String,
    pub prompts: Vec<PromptField>,
}

/// Asks the user the questions in an [`InfoRequest`].
///
/// Implementations must return exactly as many answers as there were prompts,
/// in the same order — that's what the protocol expects. Returning `Err`
/// (user cancelled, timed out, no UI available) aborts the authentication,
/// which is the correct outcome: there is no way to guess an OTP.
#[async_trait::async_trait]
pub trait Prompter: Send + Sync {
    async fn prompt(&self, host_label: &str, request: InfoRequest) -> anyhow::Result<Vec<String>>;
}

static PROMPTER: OnceLock<Arc<dyn Prompter>> = OnceLock::new();

/// Installs the process-wide prompter. Called once at startup; later calls are
/// ignored (`OnceLock`), so a stray second call can't swap the UI out from
/// under an in-flight authentication.
pub fn set_prompter(prompter: Arc<dyn Prompter>) {
    let _ = PROMPTER.set(prompter);
}

/// The installed prompter, or `None` when nothing registered one.
pub fn prompter() -> Option<Arc<dyn Prompter>> {
    PROMPTER.get().cloned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_prompter_is_installed_by_default() {
        // Guards the fallback path in `ssh::authenticate`: with no prompter,
        // a keyboard-interactive host must fail with an explanation instead of
        // waiting on an answer that will never arrive.
        //
        // Note this asserts the *initial* state; it would see a prompter if
        // another test in this binary installed one, which is precisely why
        // nothing else here does.
        assert!(prompter().is_none());
    }
}
