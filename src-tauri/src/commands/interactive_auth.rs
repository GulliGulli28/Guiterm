//! Bridges `core`'s keyboard-interactive prompting (MFA/OTP) to the frontend.
//!
//! `core::interactive_auth` defines *what* has to be asked but has no way to
//! ask it; this is the half that does. A prompt round becomes an
//! `ssh-auth-prompt` event carrying a fresh id, and the authentication —
//! which is mid-handshake, blocking inside `ssh::connect` — parks on a
//! oneshot channel until the frontend calls [`submit_ssh_auth_prompt`] with
//! that id.
//!
//! **Answers are never logged and never persisted.** They are one-time
//! credentials (an OTP is worthless a minute later, and a password belongs in
//! the vault, not here): they travel from the modal straight into the SSH
//! handshake and are dropped.
use crate::state::AppState;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use termius_core::interactive_auth::{InfoRequest, Prompter};
use termius_core::sync_ext::MutexExt;
use tokio::sync::oneshot;

/// How long a prompt waits for an answer before the connection is abandoned.
///
/// Not unbounded: the SSH handshake is held open for the whole duration, and
/// a modal dismissed by a window close (or simply forgotten) would otherwise
/// pin that connection — and its pool slot — for the lifetime of the app.
/// Generous enough to fetch a phone and read a code from it.
const PROMPT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(180);

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AuthPromptEvent {
    /// Correlates this round with the `submit_ssh_auth_prompt` that answers
    /// it — several hosts can be authenticating at once (a fleet run against
    /// a group of MFA-protected hosts, say).
    id: String,
    host_label: String,
    request: InfoRequest,
}

/// Installed once at startup (`main.rs`) as the process-wide prompter.
pub struct FrontendPrompter {
    app: AppHandle,
}

impl FrontendPrompter {
    pub fn new(app: AppHandle) -> Self {
        Self { app }
    }
}

#[async_trait::async_trait]
impl Prompter for FrontendPrompter {
    async fn prompt(&self, host_label: &str, request: InfoRequest) -> anyhow::Result<Vec<String>> {
        let id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel::<Vec<String>>();

        {
            let state = self.app.state::<AppState>();
            state.auth_prompts.lock_recover().insert(id.clone(), tx);
        }

        let expected = request.prompts.len();
        self.app
            .emit(
                "ssh-auth-prompt",
                AuthPromptEvent { id: id.clone(), host_label: host_label.to_string(), request },
            )
            .map_err(|e| anyhow::anyhow!("impossible d'afficher la demande d'authentification : {e}"))?;

        let answers = match tokio::time::timeout(PROMPT_TIMEOUT, rx).await {
            // Cancelled: the frontend dropped the sender (modal dismissed) or
            // the app is shutting down.
            Ok(Err(_)) => {
                anyhow::bail!("authentification interactive annulée");
            }
            Ok(Ok(answers)) => answers,
            Err(_) => {
                // Nobody is going to answer now — drop the slot so a late
                // submit can't resolve a handshake that has already failed.
                self.app.state::<AppState>().auth_prompts.lock_recover().remove(&id);
                anyhow::bail!("délai dépassé pour l'authentification interactive");
            }
        };

        if answers.len() != expected {
            anyhow::bail!("réponses incomplètes pour l'authentification interactive");
        }
        Ok(answers)
    }
}

/// Called by the modal once the user has filled the prompts in. Unknown ids
/// are ignored rather than reported: the round they belonged to has already
/// timed out or been abandoned, and there is nothing the user could do about
/// it.
#[tauri::command]
pub fn submit_ssh_auth_prompt(state: State<'_, AppState>, id: String, answers: Vec<String>) {
    let sender = state.auth_prompts.lock_recover().remove(&id);
    if let Some(sender) = sender {
        let _ = sender.send(answers);
    }
}

/// Called when the user dismisses the modal — fails that authentication
/// immediately instead of leaving the handshake waiting out [`PROMPT_TIMEOUT`].
#[tauri::command]
pub fn cancel_ssh_auth_prompt(state: State<'_, AppState>, id: String) {
    // Dropping the sender closes the channel, which the waiting side reads as
    // a cancellation.
    state.auth_prompts.lock_recover().remove(&id);
}
