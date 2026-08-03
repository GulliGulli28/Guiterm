//! Importing EC2 instances as hosts, through the user's own `aws` CLI.
//!
//! See [`termius_core::aws_inventory`] for why this shells out rather than
//! using an SDK. Nothing here holds a credential.

use crate::state::AppState;
use serde::{Deserialize, Serialize};
use tauri::State;
use termius_core::aws_inventory::{self, AwsCliError, AwsInstance, AwsProfile};
use termius_core::model::{AuthMethod, GroupId, Host, Workspace};
use termius_core::store;
use termius_core::sync_ext::MutexExt;
use termius_core::vault::{self, SecretKind};

/// A CLI failure, flattened for the frontend: the typed reason plus the text
/// to show. Kept as one shape so the panel renders every failure the same way
/// instead of branching on each.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AwsFailure {
    pub reason: AwsCliError,
    pub message: String,
}

impl From<AwsCliError> for AwsFailure {
    fn from(reason: AwsCliError) -> Self {
        Self {
            message: reason.message(),
            reason,
        }
    }
}

#[tauri::command]
pub async fn list_aws_profiles() -> Result<Vec<AwsProfile>, AwsFailure> {
    aws_inventory::list_profiles().await.map_err(Into::into)
}

#[tauri::command]
pub async fn discover_aws_instances(
    profile: String,
    region: String,
) -> Result<Vec<AwsInstance>, AwsFailure> {
    aws_inventory::discover(&profile, &region)
        .await
        .map_err(Into::into)
}

/// One instance the user ticked, with the choices the panel let them make.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AwsImportSelection {
    pub instance_id: String,
    pub label: String,
    pub username: String,
    pub group_id: Option<GroupId>,
    /// Tags carried over onto the host, so fleet targeting by tag works on
    /// imported machines the same way it does on hand-made ones.
    #[serde(default)]
    pub tags: Vec<String>,
}

/// SSH credentials applied to every host of one import.
///
/// One set for the batch rather than one per instance: machines imported
/// together are, in practice, reached with the same key — and a per-instance
/// form for something that is nearly always identical would make the common
/// case worse to serve the rare one. Anything unusual stays editable per host
/// afterwards.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AwsImportAuth {
    pub auth: AuthMethod,
    /// Password or key passphrase. Goes to the vault, never to workspace.json —
    /// same path as `hosts::save_host`.
    pub secret: Option<String>,
}

#[tauri::command]
pub fn import_aws_instances(
    state: State<'_, AppState>,
    selections: Vec<AwsImportSelection>,
    profile: String,
    region: String,
    credentials: AwsImportAuth,
) -> Result<Workspace, String> {
    let mut workspace = state.workspace.lock_recover();
    let proxy = aws_inventory::ssm_proxy_command(&profile, &region);
    let secret = credentials.secret.filter(|s| !s.is_empty());
    for selection in selections {
        // The instance id goes in as the address: it's what the proxy command
        // targets, and a private IP would be unreachable by definition — these
        // are machines with no route to them.
        let mut host = Host::new(selection.label, selection.instance_id, selection.username);
        host.proxy_command = Some(proxy.clone());
        host.group_id = selection.group_id;
        host.tags = selection.tags;
        host.auth = credentials.auth.clone();

        // Mirrors `hosts::save_host`: which slot a secret belongs in depends on
        // the auth method, and a key held in the keychain carries its own
        // passphrase under the key's id rather than the host's.
        if let Some(secret) = secret.as_deref() {
            match &credentials.auth {
                AuthMethod::Password | AuthMethod::KeyboardInteractive => {
                    let _ = vault::store(host.id, SecretKind::Password, secret);
                }
                AuthMethod::PrivateKey { key_id: None, .. } => {
                    let _ = vault::store(host.id, SecretKind::KeyPassphrase, secret);
                }
                _ => {}
            }
        }
        workspace.hosts.push(host);
    }
    store::save(&workspace).map_err(|e| e.to_string())?;
    Ok(workspace.clone())
}
