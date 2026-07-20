use termius_core::sync_ext::MutexExt;
use crate::commands::terminal::register_shell_session;
use crate::state::{AppState, TerminalBackend};
use tauri::ipc::Channel;
use tauri::{AppHandle, State};
use termius_core::docker;
use termius_core::model::{Host, HostId, Workspace};

fn find_host(workspace: &Workspace, host_id: HostId) -> Result<Host, String> {
    workspace.host(host_id).cloned().ok_or_else(|| "hôte inconnu".to_string())
}

/// Lists the containers on `host_id`'s Docker daemon (`docker ps -a`
/// equivalent) — used by the container picker shown when connecting to a
/// `dockerExec` host. Connects directly or via SSH depending on
/// `Host::docker_via_host_id` — see [`docker::connect_for_host`].
#[tauri::command]
pub async fn list_docker_containers(
    state: State<'_, AppState>,
    host_id: HostId,
) -> Result<Vec<docker::ContainerSummary>, String> {
    let workspace = state.workspace.lock_recover().clone();
    let host = find_host(&workspace, host_id)?;
    let client = docker::connect_for_host(&workspace, &host).await.map_err(|e| e.to_string())?;
    docker::list_containers(&client).await.map_err(|e| e.to_string())
}

/// Opens an interactive `exec` session in `container_id` on `host_id`'s
/// Docker daemon, emitting output as `terminal-data` events exactly like
/// [`crate::commands::terminal::connect_terminal`] — the frontend drives it
/// with the very same `write_terminal`/`resize_terminal`/`close_terminal`
/// commands, unaware it isn't an SSH shell. `host.env_vars`/
/// `host.startup_snippets` run right after the shell opens, same as SSH —
/// see [`register_shell_session`].
#[tauri::command]
pub async fn connect_docker_exec(
    app: AppHandle,
    state: State<'_, AppState>,
    host_id: HostId,
    container_id: String,
    channel: Channel,
) -> Result<String, String> {
    let workspace = state.workspace.lock_recover().clone();
    let host = find_host(&workspace, host_id)?;
    let client = docker::connect_for_host(&workspace, &host).await.map_err(|e| e.to_string())?;
    let session = docker::open_exec(client, &container_id, 80, 24)
        .await
        .map_err(|e| e.to_string())?;

    Ok(register_shell_session(app, &state, &workspace, host_id, TerminalBackend::Docker, channel, session).await)
}
