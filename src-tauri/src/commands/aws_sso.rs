//! Setting up an AWS SSO session and its profiles, from the app.
//!
//! See [`termius_core::aws_sso`] for why this writes real `~/.aws/config`
//! entries and drives `aws sso login` rather than piloting the
//! `aws configure sso` wizard.

use crate::commands::aws::AwsFailure;
use crate::state::AppState;
use tauri::{AppHandle, Emitter, State};
use termius_core::aws_inventory;
use termius_core::aws_sso::{self, ProfileSpec, SsoAccount, SsoSessionStatus};
use termius_core::sync_ext::MutexExt;

/// Line of `aws sso login` output, forwarded as it arrives so the panel can
/// show the verification URL and code while the CLI waits for the browser.
pub const SSO_LOGIN_OUTPUT_EVENT: &str = "aws-sso-output";

#[tauri::command]
pub fn save_aws_sso_session(
    name: String,
    start_url: String,
    region: String,
) -> Result<(), AwsFailure> {
    aws_sso::save_session(name.trim(), start_url.trim(), region.trim()).map_err(Into::into)
}

/// Runs the device-authorisation flow. Resolves once the CLI has finished —
/// which is after the user has authenticated in their browser, so this call is
/// deliberately long-lived.
#[tauri::command]
pub async fn aws_sso_login(app: AppHandle, session: String) -> Result<(), AwsFailure> {
    let mut emit = |line: String| {
        let _ = app.emit(SSO_LOGIN_OUTPUT_EVENT, line);
    };
    aws_sso::login(session.trim(), &mut emit)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn list_aws_sso_accounts(
    start_url: String,
    region: String,
    session: String,
) -> Result<Vec<SsoAccount>, AwsFailure> {
    aws_sso::list_accounts(start_url.trim(), region.trim(), session.trim())
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub fn save_aws_sso_profiles(profiles: Vec<ProfileSpec>) -> Result<(), AwsFailure> {
    aws_sso::save_profiles(&profiles).map_err(Into::into)
}

/// Account id → name, so a profile can show what it actually reaches rather
/// than a twelve-digit number.
///
/// **Reads the cache only — no network, no CLI, returns instantly.** Resolving
/// these names for real means one `aws` subprocess per SSO session, several
/// seconds of it, and the three panels that display them each paid that at
/// mount. They now paint from here and call [`refresh_aws_account_names`] in
/// the background.
///
/// An empty map on a first run is the honest answer, not a failure: the panels
/// already fall back to showing the account id, and the refresh replaces it a
/// few seconds later.
#[tauri::command]
pub fn list_aws_account_names() -> std::collections::HashMap<String, String> {
    termius_core::aws_account_cache::load().names
}

/// Resolves account names for real and updates the cache.
///
/// Slow by nature (see above) — meant to be called *after* painting, never
/// awaited before showing something. Best effort: an unreachable session
/// simply contributes nothing.
#[tauri::command]
pub async fn refresh_aws_account_names() -> std::collections::HashMap<String, String> {
    aws_sso::account_names().await
}

/// Every SSO session with its current sign-in state. Two local file reads and
/// no network call, so the identities panel opens instantly — and still says
/// something useful when the machine is offline.
#[tauri::command]
pub fn list_aws_sso_status() -> Vec<SsoSessionStatus> {
    aws_sso::list_status()
}

/// The sessions about to stop working that something actually depends on.
///
/// Polled while the app runs, so it reads local files only — `~/.aws/config`
/// for the sessions and their profiles, the CLI's token cache for their state,
/// the workspace for what pins them. Deliberately **not**
/// [`super::aws::list_aws_profiles`], which shells out to `aws configure
/// list-profiles`: spawning a process every minute to power a badge is not a
/// trade worth making. The cost is that a profile living only in
/// `~/.aws/credentials` contributes no alert — it has no `sso_session` either,
/// so there would be nothing to say about it.
#[tauri::command]
pub fn list_aws_session_alerts(state: State<'_, AppState>) -> Vec<aws_sso::SessionAlert> {
    let profiles = aws_sso::config_path()
        .and_then(|path| std::fs::read_to_string(path).ok())
        .map(|content| aws_inventory::parse_config(&content))
        .unwrap_or_default();
    let hosts = aws_inventory::hosts_by_profile(&state.workspace.lock_recover());
    aws_sso::alerts(
        &aws_sso::list_status(),
        &profiles,
        &hosts,
        aws_sso::EXPIRY_WARNING_SECS,
    )
}

/// Removes a profile from `~/.aws/config` *and* `~/.aws/credentials`.
///
/// Both, because `aws configure list-profiles` reads both: deleting from one
/// only would leave the profile in the list and look like nothing happened.
#[tauri::command]
pub fn delete_aws_profile(name: String) -> Result<(), AwsFailure> {
    aws_sso::delete_profile(name.trim()).map_err(Into::into)
}

/// Removes an `[sso-session]` block. The profiles pointing at it are left
/// alone — the panel says how many there are before asking.
#[tauri::command]
pub fn delete_aws_sso_session(name: String) -> Result<(), AwsFailure> {
    aws_sso::delete_sso_session(name.trim()).map_err(Into::into)
}
