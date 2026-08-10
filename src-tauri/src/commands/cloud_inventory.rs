//! Importing Azure VMs and GCP instances as hosts, through the user's own
//! `az` / `gcloud` CLIs.
//!
//! See [`termius_core::cloud_cli`] for why this shells out rather than using an
//! SDK, and for the Windows batch-shim trap that makes the runner more than a
//! one-liner. Nothing here holds a cloud credential.
//!
//! One command per provider rather than one taking a provider argument: the
//! frontend has one panel each, and a discriminated string parameter would be
//! a dispatch that neither `tsc` nor `assertNever` could check.

use crate::state::AppState;
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use termius_core::cloud_cli::{CloudCliError, Provider};
use termius_core::cloud_inventory::{self, CloudInstance, CloudScope, CloudSelection};
use termius_core::model::{AuthMethod, HostId, Workspace};
use termius_core::store;
use termius_core::sync_ext::MutexExt;
use termius_core::vault::{self, SecretKind};
use termius_core::{azure_auth, azure_inventory, gcp_inventory};

/// Each line `az login` prints while it waits. Mirrors `aws-sso-output`.
const AZURE_LOGIN_OUTPUT_EVENT: &str = "azure-login-output";

/// A CLI failure, flattened for the frontend: the typed reason plus the text to
/// show. Same shape as `AwsFailure`, deliberately — the panels render a failure
/// the same way, and the reason is what decides whether a "log in" button
/// appears rather than the frontend matching on message text.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudFailure {
    pub reason: CloudCliError,
    pub message: String,
}

impl From<CloudCliError> for CloudFailure {
    fn from(reason: CloudCliError) -> Self {
        Self {
            message: reason.message(),
            reason,
        }
    }
}

// ─── Azure ───────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn list_azure_subscriptions() -> Result<Vec<CloudScope>, CloudFailure> {
    azure_inventory::list_subscriptions()
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn discover_azure_vms(
    subscription: Option<String>,
) -> Result<Vec<CloudInstance>, CloudFailure> {
    azure_inventory::list_vms(subscription.as_deref())
        .await
        .map_err(Into::into)
}

/// Signs in to Azure, streaming the CLI's output so the wait is legible.
///
/// The whole point of it being a command: an expired session used to end the
/// story with "go run `az login` somewhere else".
#[tauri::command]
pub async fn azure_login(
    app: AppHandle,
    tenant: Option<String>,
    device_code: bool,
) -> Result<(), CloudFailure> {
    let mut emit = |line: String| {
        let _ = app.emit(AZURE_LOGIN_OUTPUT_EVENT, line);
    };
    azure_auth::login(tenant.as_deref(), device_code, &mut emit)
        .await
        .map_err(Into::into)
}

/// Signs out, so the next sign-in can reach a different tenant instead of
/// silently reusing the cached account.
#[tauri::command]
pub async fn azure_logout() -> Result<(), CloudFailure> {
    azure_auth::logout().await.map_err(Into::into)
}

#[tauri::command]
pub fn import_azure_hosts(
    state: State<'_, AppState>,
    selections: Vec<CloudSelection>,
    auth: AuthMethod,
    secret: Option<String>,
) -> Result<Workspace, String> {
    import(state, Provider::Azure, selections, auth, secret)
}

// ─── GCP ─────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn list_gcp_projects() -> Result<Vec<CloudScope>, CloudFailure> {
    gcp_inventory::list_projects().await.map_err(Into::into)
}

#[tauri::command]
pub async fn discover_gcp_instances(
    project: Option<String>,
) -> Result<Vec<CloudInstance>, CloudFailure> {
    gcp_inventory::list_instances(project.as_deref())
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub fn import_gcp_hosts(
    state: State<'_, AppState>,
    selections: Vec<CloudSelection>,
    auth: AuthMethod,
    secret: Option<String>,
) -> Result<Workspace, String> {
    import(state, Provider::Gcp, selections, auth, secret)
}

// ─── Shared ──────────────────────────────────────────────────────────────

/// `secret` applies to the whole batch, and only to the hosts this import
/// *creates* — refreshing must never overwrite a credential given to an
/// existing host afterwards. Same shape and same reasoning as
/// `inventory::import_ansible_hosts`.
fn import(
    state: State<'_, AppState>,
    provider: Provider,
    selections: Vec<CloudSelection>,
    auth: AuthMethod,
    secret: Option<String>,
) -> Result<Workspace, String> {
    let mut workspace = state.workspace.lock_recover();
    let outcome = cloud_inventory::apply_import(&mut workspace, provider, selections, &auth);

    if let Some(secret) = secret.filter(|s| !s.is_empty()).as_deref() {
        for id in &outcome.added {
            store_batch_secret(*id, &auth, secret);
        }
    }
    store::save(&workspace).map_err(|e| e.to_string())?;
    Ok(workspace.clone())
}

/// Files a batch credential in the slot its auth method uses.
///
/// Mirrors `inventory::store_batch_secret` and `hosts::save_host`: which slot a
/// secret belongs in depends on the method, and a key held in the keychain
/// carries its passphrase under the *key's* id rather than the host's.
fn store_batch_secret(host_id: HostId, auth: &AuthMethod, secret: &str) {
    match auth {
        AuthMethod::Password | AuthMethod::KeyboardInteractive => {
            let _ = vault::store(host_id, SecretKind::Password, secret);
        }
        AuthMethod::PrivateKey { key_id: None, .. } => {
            let _ = vault::store(host_id, SecretKind::KeyPassphrase, secret);
        }
        _ => {}
    }
}
