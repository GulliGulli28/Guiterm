//! Setting up an AWS SSO session and its profiles, from the app.
//!
//! See [`termius_core::aws_sso`] for why this writes real `~/.aws/config`
//! entries and drives `aws sso login` rather than piloting the
//! `aws configure sso` wizard.

use crate::commands::aws::AwsFailure;
use tauri::{AppHandle, Emitter};
use termius_core::aws_sso::{self, ProfileSpec, SsoAccount};

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
/// than a twelve-digit number. Best effort: an unreachable session simply
/// contributes nothing.
#[tauri::command]
pub async fn list_aws_account_names() -> std::collections::HashMap<String, String> {
    aws_sso::account_names().await
}
