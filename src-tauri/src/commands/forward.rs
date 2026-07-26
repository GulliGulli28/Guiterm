use termius_core::sync_ext::MutexExt;
use crate::state::{AppState, ForwardSession};
use tauri::State;
use termius_core::model::PortForwardId;
use termius_core::{port_forward, ssh_pool};

#[tauri::command]
pub async fn start_forward(
    state: State<'_, AppState>,
    forward_id: PortForwardId,
) -> Result<(), String> {
    if state
        .forwards
        .lock_recover()
        .contains_key(&forward_id)
    {
        return Ok(());
    }
    let (workspace, forward) = {
        let workspace = state.workspace.lock_recover();
        let forward = workspace
            .port_forwards
            .iter()
            .find(|f| f.id == forward_id)
            .cloned()
            .ok_or_else(|| "tunnel inconnu".to_string())?;
        (workspace.clone(), forward)
    };

    let connection = ssh_pool::acquire(&workspace, forward.host_id)
        .await
        .map_err(|e| e.to_string())?;
    let active = port_forward::start(connection.connection(), forward)
        .await
        .map_err(|e| e.to_string())?;
    state
        .forwards
        .lock_recover()
        .insert(forward_id, ForwardSession { connection, active });
    Ok(())
}

#[tauri::command]
pub async fn stop_forward(
    state: State<'_, AppState>,
    forward_id: PortForwardId,
) -> Result<(), String> {
    let session = state
        .forwards
        .lock_recover()
        .remove(&forward_id);
    if let Some(session) = session {
        session.active.stop(&session.connection).await;
    }
    Ok(())
}

#[tauri::command]
pub fn running_forwards(state: State<'_, AppState>) -> Vec<PortForwardId> {
    state
        .forwards
        .lock_recover()
        .keys()
        .copied()
        .collect()
}
