use termius_core::sync_ext::MutexExt;
use crate::commands::terminal::{NewShellSession, register_shell_session};
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

/// The tail of a container's log, stdout and stderr interleaved.
///
/// Reuses the daemon connection cached per host, like every other Docker
/// command here — reading a log costs no handshake.
#[tauri::command]
pub async fn docker_container_logs(
    state: State<'_, AppState>,
    host_id: HostId,
    container_id: String,
    tail: usize,
) -> Result<String, String> {
    let workspace = state.workspace.lock_recover().clone();
    let host = find_host(&workspace, host_id)?;
    let client = docker::connect_for_host(&workspace, &host).await.map_err(|e| e.to_string())?;
    docker::container_logs(&client, &container_id, tail).await.map_err(|e| e.to_string())
}

/// Starts, stops or restarts a container. Removal is deliberately not offered
/// — see [`docker::ContainerAction`].
#[tauri::command]
pub async fn docker_container_action(
    state: State<'_, AppState>,
    host_id: HostId,
    container_id: String,
    action: docker::ContainerAction,
) -> Result<Vec<docker::ContainerSummary>, String> {
    let workspace = state.workspace.lock_recover().clone();
    let host = find_host(&workspace, host_id)?;
    let client = docker::connect_for_host(&workspace, &host).await.map_err(|e| e.to_string())?;
    docker::container_action(&client, &container_id, action).await.map_err(|e| e.to_string())?;
    // Returns the refreshed list rather than `()`: the caller's next move is
    // always to re-render the container list, and a stop/start changes state
    // the list is showing.
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

    // `true` : Docker/K8s exec ne connaissent pas les sessions persistantes
    // (tmux n'est presque jamais dans un conteneur), donc chaque connexion
    // ouvre bien un shell neuf, et les commandes de démarrage lui reviennent.
    Ok(register_shell_session(
        app,
        &state,
        &workspace,
        NewShellSession { host_id, backend: TerminalBackend::Docker, channel, session, replay_startup: true },
    )
    .await)
}
