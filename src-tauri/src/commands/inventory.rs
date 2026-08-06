//! Importing hosts from an Ansible inventory file.
//!
//! See [`termius_core::ansible_inventory`] for the syntaxes accepted and, more
//! importantly, for why a re-import matches on the inventory *name* rather
//! than on the address.

use crate::state::AppState;
use tauri::State;
use termius_core::ansible_inventory::{self, Inventory, InventorySelection};
use termius_core::model::{AuthMethod, HostId, Workspace};
use termius_core::store;
use termius_core::sync_ext::MutexExt;
use termius_core::vault::{self, SecretKind};

/// Reads and parses an inventory file.
///
/// Read-only, and separate from the import itself so the panel can show what
/// the file contains before anything is created — the same shape as the EC2
/// flow, where discovery and import are two steps.
#[tauri::command]
pub fn read_ansible_inventory(path: String) -> Result<Inventory, String> {
    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("Lecture de « {path} » impossible : {e}"))?;
    let inventory = ansible_inventory::parse(&content);
    if inventory.hosts.is_empty() && inventory.skipped.is_empty() {
        return Err(format!(
            "Aucun hôte trouvé dans « {path} ». \
             Est-ce bien un inventaire Ansible (forme INI ou YAML) ?"
        ));
    }
    Ok(inventory)
}

/// Creates or refreshes the hosts the user ticked.
///
/// `credentials` applies to the whole batch, and only to the hosts this import
/// *creates* — refreshing must never overwrite credentials given to an
/// existing host afterwards. Same reasoning, and same shape, as
/// `aws::import_aws_instances`.
#[tauri::command]
pub fn import_ansible_hosts(
    state: State<'_, AppState>,
    selections: Vec<InventorySelection>,
    auth: AuthMethod,
    secret: Option<String>,
) -> Result<Workspace, String> {
    let mut workspace = state.workspace.lock_recover();
    let outcome = ansible_inventory::apply_import(&mut workspace, selections, &auth);

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
/// Mirrors `hosts::save_host`: which slot a secret belongs in depends on the
/// method, and a key held in the keychain carries its passphrase under the
/// *key's* id rather than the host's.
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
