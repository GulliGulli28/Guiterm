use crate::state::AppState;
use tauri::State;
use termius_core::{export as ex, model::HostId, store};

#[tauri::command]
pub fn export_workspace(state: State<'_, AppState>, path: String, include_key_material: bool) -> Result<(), String> {
    let workspace = state.workspace.lock().expect("lock poisoned").clone();
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
    let file: ex::WorkspaceExport = serde_json::from_str(&json)
        .map_err(|e| format!("Format invalide : {}", e))?;

    let mut workspace = state.workspace.lock().expect("lock poisoned");
    if replace {
        *workspace = file.workspace;
    } else {
        ex::merge_workspace(&mut workspace, file.workspace);
    }
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
    let workspace = state.workspace.lock().expect("lock poisoned").clone();
    let data = ex::make_host_export(&workspace, host_id, include_key_material)
        .ok_or_else(|| "Hôte introuvable".to_string())?;
    let json = serde_json::to_string_pretty(&data).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn import_host_from_file(
    state: State<'_, AppState>,
    path: String,
) -> Result<termius_core::model::Workspace, String> {
    let json = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let file: ex::HostExport = serde_json::from_str(&json)
        .map_err(|e| format!("Format invalide : {}", e))?;

    let mut workspace = state.workspace.lock().expect("lock poisoned");
    ex::import_host(&mut workspace, file);
    store::save(&workspace).map_err(|e| e.to_string())?;
    Ok(workspace.clone())
}
