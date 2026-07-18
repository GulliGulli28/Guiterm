use crate::state::AppState;
use tauri::State;
use termius_core::model::{HostId, KeyId, PrivateKey, Workspace};
use termius_core::sync_ext::MutexExt;
use termius_core::vault::{self, SecretKind};
use termius_core::{keygen, sftp, ssh, store};

fn persist(workspace: &Workspace) -> Result<(), String> {
    store::save(workspace).map_err(|e| e.to_string())
}

/// Reads a keychain entry's PEM content with the same fallback order as
/// authentication itself: encrypted vault, then `workspace.json`, then the
/// original file on disk (only ever populated for *imported* keys).
fn resolve_key_content(key: &PrivateKey) -> Result<String, String> {
    let stored = vault::load_key_content(key.id)
        .map_err(|e| e.to_string())?
        .or_else(|| key.content.clone());
    match stored {
        Some(content) => Ok(content),
        None => std::fs::read_to_string(&key.path)
            .map_err(|e| format!("Impossible de lire la clé «{}» : {}", key.path, e)),
    }
}

#[tauri::command]
pub fn generate_private_key(
    state: State<'_, AppState>,
    name: String,
    algorithm: keygen::KeyAlgorithm,
    passphrase: Option<String>,
) -> Result<Workspace, String> {
    let mut workspace = state.workspace.lock_recover();
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("Le nom ne peut pas être vide".to_string());
    }

    let generated = keygen::generate(algorithm, &name, passphrase.as_deref())
        .map_err(|e| e.to_string())?;

    let id = KeyId::new_v4();
    let in_vault = vault::is_unlocked();
    if in_vault {
        vault::store_key_content(id, &generated.private_pem).map_err(|e| e.to_string())?;
    }
    let key = PrivateKey {
        id,
        name,
        path: format!("(clé générée dans Guiterm, id {id})"),
        content: if in_vault {
            None
        } else {
            Some(generated.private_pem)
        },
    };
    if let Some(pp) = passphrase.filter(|s| !s.is_empty()) {
        let _ = vault::store(key.id, SecretKind::KeyPassphrase, &pp);
    }
    workspace.keychain.push(key);
    persist(&workspace)?;
    Ok(workspace.clone())
}

#[tauri::command]
pub fn get_public_key(state: State<'_, AppState>, key_id: KeyId) -> Result<String, String> {
    let workspace = state.workspace.lock_recover();
    let key = workspace
        .keychain
        .iter()
        .find(|k| k.id == key_id)
        .ok_or_else(|| "clé inconnue".to_string())?;
    let content = resolve_key_content(key)?;
    let passphrase = vault::load(key_id, SecretKind::KeyPassphrase).map_err(|e| e.to_string())?;
    keygen::public_key_line(&content, passphrase.as_deref()).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn deploy_public_key(
    state: State<'_, AppState>,
    host_id: HostId,
    key_id: KeyId,
) -> Result<(), String> {
    let (workspace, key) = {
        let workspace = state.workspace.lock_recover();
        let key = workspace
            .keychain
            .iter()
            .find(|k| k.id == key_id)
            .ok_or_else(|| "clé inconnue".to_string())?
            .clone();
        (workspace.clone(), key)
    };
    // resolve_key_content can do a synchronous std::fs read (imported keys
    // not covered by the vault/workspace.json) — keep it off the tokio
    // worker thread, same reasoning as transfer.rs's spawn_blocking uses.
    // Done outside the lock_recover() block above so the mutex is never
    // held across an .await.
    let content = tokio::task::spawn_blocking(move || resolve_key_content(&key))
        .await
        .map_err(|e| e.to_string())??;
    let passphrase = vault::load(key_id, SecretKind::KeyPassphrase).map_err(|e| e.to_string())?;
    let public_key_line =
        keygen::public_key_line(&content, passphrase.as_deref()).map_err(|e| e.to_string())?;

    let connection = ssh::connect(&workspace, host_id)
        .await
        .map_err(|e| e.to_string())?;
    let sftp_client = sftp::SftpClient::open(&connection)
        .await
        .map_err(|e| e.to_string())?;
    keygen::deploy_public_key(&sftp_client, &public_key_line)
        .await
        .map_err(|e| e.to_string())
}
