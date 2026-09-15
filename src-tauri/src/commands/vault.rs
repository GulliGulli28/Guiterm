//! Master-password vault commands: enable/disable the encrypted secret store,
//! unlock/lock it for the session, and change the password. When enabling or
//! disabling we must move the existing secrets between the OS keychain and the
//! encrypted file — that migration list is built here (the command layer knows
//! the workspace); `core::vault` performs the actual backend switch.
use crate::state::AppState;
use tauri::State;
use termius_core::model::{HostId, KeyId, Workspace};
use termius_core::store;
use termius_core::sync_ext::MutexExt;
use termius_core::vault::{self, SecretKind, VaultStatus};

/// Every `(id, kind)` slot that could hold a secret in `workspace`: a per-host
/// password or passphrase, plus each keychain key's passphrase.
fn secret_slots(workspace: &Workspace) -> Vec<(HostId, SecretKind)> {
    let mut slots = Vec::new();
    for host in &workspace.hosts {
        slots.push((host.id, SecretKind::Password));
        slots.push((host.id, SecretKind::KeyPassphrase));
    }
    for key in &workspace.keychain {
        slots.push((key.id, SecretKind::KeyPassphrase));
    }
    slots
}

/// Reads whichever of `slots` currently hold a secret, via the active backend.
fn collect_secrets(slots: &[(HostId, SecretKind)]) -> Vec<(HostId, SecretKind, String)> {
    slots
        .iter()
        .filter_map(|&(id, kind)| match vault::load(id, kind) {
            Ok(Some(secret)) => Some((id, kind, secret)),
            _ => None,
        })
        .collect()
}

#[tauri::command]
pub fn master_password_status() -> VaultStatus {
    vault::status()
}

#[tauri::command]
pub fn set_master_password(state: State<'_, AppState>, password: String) -> Result<(), String> {
    if password.is_empty() {
        return Err("le mot de passe maître ne peut pas être vide".to_string());
    }
    // Snapshot the keychain secrets and the cleartext key contents *before*
    // switching backends (while the keychain backend is still active).
    let (slots, key_contents) = {
        let workspace = state.workspace.lock_recover();
        let key_contents: Vec<(KeyId, String)> = workspace
            .keychain
            .iter()
            .filter_map(|k| k.content.clone().map(|c| (k.id, c)))
            .collect();
        (secret_slots(&workspace), key_contents)
    };
    let migrate = collect_secrets(&slots);
    vault::enable(&password, &migrate).map_err(|e| e.to_string())?;

    // The vault is now unlocked: move each key's PEM into it and drop the
    // cleartext copy from workspace.json.
    for (id, content) in &key_contents {
        vault::store_key_content(*id, content).map_err(|e| e.to_string())?;
    }
    let mut workspace = state.workspace.lock_recover();
    for key in &mut workspace.keychain {
        if key_contents.iter().any(|(id, _)| *id == key.id) {
            key.content = None;
        }
    }
    store::save(&workspace).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn unlock_vault(state: State<'_, AppState>, password: String) -> Result<(), String> {
    vault::unlock(&password).map_err(|e| e.to_string())?;
    // Les jetons et clés GuiVault vivent dans ce coffre : maintenant
    // lisibles, la session peut être restaurée.
    if let Err(e) = state.guivault.restore() {
        tracing::warn!("compte GuiVault non restauré après déverrouillage : {e}");
    }
    Ok(())
}

#[tauri::command]
pub fn lock_vault() -> Result<(), String> {
    vault::lock();
    Ok(())
}

#[tauri::command]
pub fn change_master_password(current: String, new: String) -> Result<(), String> {
    if new.is_empty() {
        return Err("le nouveau mot de passe ne peut pas être vide".to_string());
    }
    vault::change_password(&current, &new).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn disable_master_password(
    state: State<'_, AppState>,
    current: String,
) -> Result<(), String> {
    // The vault must be unlocked so we can read the secrets back out and restore
    // them to the keychain.
    if !vault::status().unlocked {
        return Err("déverrouillez le coffre avant de le désactiver".to_string());
    }
    let (slots, key_ids) = {
        let workspace = state.workspace.lock_recover();
        let key_ids: Vec<KeyId> = workspace.keychain.iter().map(|k| k.id).collect();
        (secret_slots(&workspace), key_ids)
    };
    let migrate = collect_secrets(&slots);
    // Read key contents out of the vault before disabling — unreadable afterwards.
    let key_contents: Vec<(KeyId, String)> = key_ids
        .iter()
        .filter_map(|&id| match vault::load_key_content(id) {
            Ok(Some(content)) => Some((id, content)),
            _ => None,
        })
        .collect();

    vault::disable(&current, &migrate).map_err(|e| e.to_string())?;

    // Vault gone: restore the key PEMs to workspace.json (0600) so key auth still works.
    let mut workspace = state.workspace.lock_recover();
    for (id, content) in key_contents {
        if let Some(key) = workspace.keychain.iter_mut().find(|k| k.id == id) {
            key.content = Some(content);
        }
    }
    store::save(&workspace).map_err(|e| e.to_string())
}
