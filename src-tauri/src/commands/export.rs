use termius_core::sync_ext::MutexExt;
use crate::state::AppState;
use tauri::State;
use termius_core::{export as ex, model::{HostId, Workspace}, store, vault};

/// Fills each key's `content` from the master vault (when unlocked) so an export
/// *with* key material still carries the PEM — in vault mode it no longer lives
/// in `workspace.json`.
fn hydrate_key_content(workspace: &mut Workspace) {
    for key in &mut workspace.keychain {
        if key.content.is_none()
            && let Ok(Some(c)) = vault::load_key_content(key.id)
        {
            key.content = Some(c);
        }
    }
}

/// After an import, if the master vault is unlocked, move any cleartext key
/// content that came in with the file into the vault and drop it from
/// `workspace.json`, preserving the "keys encrypted at rest" invariant.
fn absorb_key_content_into_vault(workspace: &mut Workspace) {
    if !vault::is_unlocked() {
        return;
    }
    for key in &mut workspace.keychain {
        if let Some(content) = key.content.take() {
            // Keep the cleartext if the vault write fails, so the key isn't lost.
            if vault::store_key_content(key.id, &content).is_err() {
                key.content = Some(content);
            }
        }
    }
}

#[tauri::command]
pub fn export_workspace(
    state: State<'_, AppState>,
    path: String,
    include_key_material: bool,
) -> Result<(), String> {
    let mut workspace = state.workspace.lock_recover().clone();
    if include_key_material {
        hydrate_key_content(&mut workspace);
    }
    let data = ex::make_workspace_export(&workspace, include_key_material);
    let json = serde_json::to_string_pretty(&data).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn import_workspace(
    state: State<'_, AppState>,
    path: String,
    replace: bool,
) -> Result<termius_core::model::Workspace, String> {
    let json = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let file: ex::WorkspaceExport =
        serde_json::from_str(&json).map_err(|e| format!("Format invalide : {}", e))?;

    let mut workspace = state.workspace.lock_recover();
    if replace {
        *workspace = file.workspace;
    } else {
        ex::merge_workspace(&mut workspace, file.workspace);
    }
    absorb_key_content_into_vault(&mut workspace);
    store::save(&workspace).map_err(|e| e.to_string())?;
    Ok(workspace.clone())
}

#[tauri::command]
pub fn export_host(
    state: State<'_, AppState>,
    host_id: HostId,
    path: String,
    include_key_material: bool,
) -> Result<(), String> {
    let mut workspace = state.workspace.lock_recover().clone();
    if include_key_material {
        hydrate_key_content(&mut workspace);
    }
    let data = ex::make_host_export(&workspace, host_id, include_key_material)
        .ok_or_else(|| "Hôte introuvable".to_string())?;
    let json = serde_json::to_string_pretty(&data).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn export_text(path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, content).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn import_host_from_file(
    state: State<'_, AppState>,
    path: String,
) -> Result<termius_core::model::Workspace, String> {
    let json = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let file: ex::HostExport =
        serde_json::from_str(&json).map_err(|e| format!("Format invalide : {}", e))?;

    let mut workspace = state.workspace.lock_recover();
    ex::import_host(&mut workspace, file);
    absorb_key_content_into_vault(&mut workspace);
    store::save(&workspace).map_err(|e| e.to_string())?;
    Ok(workspace.clone())
}
