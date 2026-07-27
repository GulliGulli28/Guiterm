use termius_core::sync_ext::MutexExt;
use crate::commands::terminal::register_shell_session;
use crate::state::{AppState, TerminalBackend};
use tauri::ipc::Channel;
use tauri::{AppHandle, State};
use termius_core::k8s;
use termius_core::model::{Host, HostId, Workspace};

fn find_host(workspace: &Workspace, host_id: HostId) -> Result<Host, String> {
    workspace.host(host_id).cloned().ok_or_else(|| "hôte inconnu".to_string())
}

/// Lists the pods in `host_id`'s default namespace (`Host::username`, see
/// `HostKind::K8sExec`'s doc comment) — used by the pod picker shown when
/// connecting to a `k8sExec` host, mirroring `list_docker_containers`.
#[tauri::command]
pub async fn list_k8s_pods(state: State<'_, AppState>, host_id: HostId) -> Result<Vec<k8s::PodSummary>, String> {
    let workspace = state.workspace.lock_recover().clone();
    let host = find_host(&workspace, host_id)?;
    let client = k8s::connect(&host.address).await.map_err(|e| e.to_string())?;
    k8s::list_pods(&client, &host.username).await.map_err(|e| e.to_string())
}

/// The tail of a pod's log — the `kubectl logs` equivalent, and the mirror of
/// [`crate::commands::docker::docker_container_logs`]. `container_name` picks
/// one container in a multi-container pod; `None` lets the API server choose
/// when there is only one.
#[tauri::command]
pub async fn k8s_pod_logs(
    state: State<'_, AppState>,
    host_id: HostId,
    pod_name: String,
    container_name: Option<String>,
    tail: usize,
) -> Result<String, String> {
    let workspace = state.workspace.lock_recover().clone();
    let host = find_host(&workspace, host_id)?;
    let client = k8s::connect(&host.address).await.map_err(|e| e.to_string())?;
    k8s::pod_logs(&client, &host.username, &pod_name, container_name.as_deref(), tail)
        .await
        .map_err(|e| e.to_string())
}

/// Opens an interactive `exec` session in `pod_name`/`container_name` on
/// `host_id`'s cluster, emitting output over `channel` exactly like
/// [`crate::commands::terminal::connect_terminal`]/`connect_docker_exec` —
/// the frontend drives it with the very same
/// `write_terminal`/`resize_terminal`/`close_terminal` commands, unaware
/// it's neither SSH nor Docker. `host.env_vars`/`host.startup_snippets` run
/// right after the shell opens, same as both — see [`register_shell_session`].
#[tauri::command]
pub async fn connect_k8s_exec(
    app: AppHandle,
    state: State<'_, AppState>,
    host_id: HostId,
    pod_name: String,
    container_name: Option<String>,
    channel: Channel,
) -> Result<String, String> {
    let workspace = state.workspace.lock_recover().clone();
    let host = find_host(&workspace, host_id)?;
    let client = k8s::connect(&host.address).await.map_err(|e| e.to_string())?;
    let session = k8s::open_exec(client, &host.username, &pod_name, container_name.as_deref(), 80, 24)
        .await
        .map_err(|e| e.to_string())?;

    Ok(register_shell_session(app, &state, &workspace, host_id, TerminalBackend::K8s, channel, session).await)
}
