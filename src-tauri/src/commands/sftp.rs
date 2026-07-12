use termius_core::sync_ext::MutexExt;
use crate::state::{AppState, Pane};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter, Manager, State};
use termius_core::docker;
use termius_core::docker_pane::DockerPaneClient;
use termius_core::model::HostId;
use termius_core::sftp::{Entry, RemoteFileClient, SftpClient};
use termius_core::ssh;
use termius_core::transfer::{self, PaneRef};
use uuid::Uuid;

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PaneSource {
    Local,
    Remote {
        #[serde(rename = "hostId")]
        host_id: HostId,
    },
    /// A Docker exec host's container filesystem — `container_id` picked the
    /// same way `connect_docker_exec` picks one (see `HostsPanel.tsx`'s
    /// `openDockerPicker`/`ConnectionPickerModal`), just for a pane instead
    /// of a shell. Both fields need an explicit `rename`: `rename_all` on an
    /// internally-tagged enum only renames the variant names (the `"kind"`
    /// values), not struct-variant field names — see `rdp_ipc::ClientMessage`
    /// in CLAUDE.md for the same gotcha hit before, apparently not
    /// remembered hard enough to avoid repeating it here.
    Docker {
        #[serde(rename = "hostId")]
        host_id: HostId,
        #[serde(rename = "containerId")]
        container_id: String,
    },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaneOpened {
    pub pane_id: String,
    pub cwd: String,
    pub entries: Vec<Entry>,
}

#[tauri::command]
pub async fn open_pane(
    state: State<'_, AppState>,
    source: PaneSource,
) -> Result<PaneOpened, String> {
    let pane_id = Uuid::new_v4().to_string();
    match source {
        PaneSource::Local => {
            let cwd = termius_core::local_fs::home_dir();
            let entries = termius_core::local_fs::list(&cwd).map_err(|e| e.to_string())?;
            state.panes.lock_recover().insert(
                pane_id.clone(),
                Pane {
                    connection: None,
                    client: None,
                },
            );
            Ok(PaneOpened {
                pane_id,
                cwd,
                entries,
            })
        }
        PaneSource::Remote { host_id } => {
            let workspace = state.workspace.lock_recover().clone();
            let connection = ssh::connect(&workspace, host_id)
                .await
                .map_err(|e| e.to_string())?;
            let client = Arc::new(
                SftpClient::open(&connection)
                    .await
                    .map_err(|e| e.to_string())?,
            );
            let cwd = client.home_dir().await.map_err(|e| e.to_string())?;
            let entries = client.list(&cwd).await.map_err(|e| e.to_string())?;
            state.panes.lock_recover().insert(
                pane_id.clone(),
                Pane {
                    connection: Some(connection),
                    client: Some(client),
                },
            );
            Ok(PaneOpened {
                pane_id,
                cwd,
                entries,
            })
        }
        PaneSource::Docker { host_id, container_id } => {
            let workspace = state.workspace.lock_recover().clone();
            let host = workspace.host(host_id).cloned().ok_or_else(|| "hôte inconnu".to_string())?;
            let docker = docker::connect_for_host(&workspace, &host).await.map_err(|e| e.to_string())?;
            let client: Arc<dyn RemoteFileClient> = Arc::new(DockerPaneClient::new(docker, container_id));
            // No SFTP-equivalent "home directory" query for an arbitrary
            // container — `/` is always a valid starting point, unlike
            // guessing at a user's home which may not even exist in a
            // minimal image.
            let cwd = "/".to_string();
            let entries = client.list(&cwd).await.map_err(|e| e.to_string())?;
            state.panes.lock_recover().insert(
                pane_id.clone(),
                Pane {
                    connection: None,
                    client: Some(client),
                },
            );
            Ok(PaneOpened {
                pane_id,
                cwd,
                entries,
            })
        }
    }
}

#[tauri::command]
pub fn close_pane(state: State<'_, AppState>, pane_id: String) -> Result<(), String> {
    state.panes.lock_recover().remove(&pane_id);
    Ok(())
}

#[derive(Serialize)]
pub struct PaneListed {
    pub cwd: String,
    pub entries: Vec<Entry>,
}

pub(crate) fn pane_ref(state: &AppState, pane_id: &str) -> Result<PaneRef, String> {
    let panes = state.panes.lock_recover();
    let pane = panes
        .get(pane_id)
        .ok_or_else(|| "pane inconnu".to_string())?;
    Ok(match &pane.client {
        Some(client) => PaneRef::Remote(client.clone()),
        None => PaneRef::Local,
    })
}

#[tauri::command]
pub async fn list_pane(
    state: State<'_, AppState>,
    pane_id: String,
    path: String,
) -> Result<PaneListed, String> {
    let reference = pane_ref(&state, &pane_id)?;
    let entries = transfer::list(&reference, &path)
        .await
        .map_err(|e| e.to_string())?;
    Ok(PaneListed { cwd: path, entries })
}

#[tauri::command]
pub async fn copy_entry(
    state: State<'_, AppState>,
    source_pane_id: String,
    source_cwd: String,
    entry: Entry,
    dest_pane_id: String,
    dest_cwd: String,
) -> Result<PaneListed, String> {
    let source = pane_ref(&state, &source_pane_id)?;
    let dest = pane_ref(&state, &dest_pane_id)?;
    transfer::copy_entry(&source, &source_cwd, &entry, &dest, &dest_cwd)
        .await
        .map_err(|e| e.to_string())?;
    let entries = transfer::list(&dest, &dest_cwd)
        .await
        .map_err(|e| e.to_string())?;
    Ok(PaneListed {
        cwd: dest_cwd,
        entries,
    })
}

#[tauri::command]
pub async fn pane_mkdir(
    state: State<'_, AppState>,
    pane_id: String,
    cwd: String,
    name: String,
) -> Result<PaneListed, String> {
    let reference = pane_ref(&state, &pane_id)?;
    transfer::mkdir(&reference, &cwd, &name)
        .await
        .map_err(|e| e.to_string())?;
    let entries = transfer::list(&reference, &cwd)
        .await
        .map_err(|e| e.to_string())?;
    Ok(PaneListed { cwd, entries })
}

#[tauri::command]
pub async fn pane_rename(
    state: State<'_, AppState>,
    pane_id: String,
    cwd: String,
    old_name: String,
    new_name: String,
) -> Result<PaneListed, String> {
    let reference = pane_ref(&state, &pane_id)?;
    transfer::rename(&reference, &cwd, &old_name, &new_name)
        .await
        .map_err(|e| e.to_string())?;
    let entries = transfer::list(&reference, &cwd)
        .await
        .map_err(|e| e.to_string())?;
    Ok(PaneListed { cwd, entries })
}

#[tauri::command]
pub async fn pane_remove(
    state: State<'_, AppState>,
    pane_id: String,
    cwd: String,
    entry: Entry,
) -> Result<PaneListed, String> {
    let reference = pane_ref(&state, &pane_id)?;
    transfer::remove(&reference, &cwd, &entry)
        .await
        .map_err(|e| e.to_string())?;
    let entries = transfer::list(&reference, &cwd)
        .await
        .map_err(|e| e.to_string())?;
    Ok(PaneListed { cwd, entries })
}

#[tauri::command]
pub async fn pane_chmod(
    state: State<'_, AppState>,
    pane_id: String,
    cwd: String,
    name: String,
    mode: u32,
) -> Result<PaneListed, String> {
    let reference = pane_ref(&state, &pane_id)?;
    transfer::set_permissions(&reference, &cwd, &name, mode)
        .await
        .map_err(|e| e.to_string())?;
    let entries = transfer::list(&reference, &cwd)
        .await
        .map_err(|e| e.to_string())?;
    Ok(PaneListed { cwd, entries })
}

/// Reads a small file's whole content for the quick-edit modal — no local temp
/// file involved. Callers are expected to gate on file size before calling this.
#[tauri::command]
pub async fn read_pane_file(
    state: State<'_, AppState>,
    pane_id: String,
    cwd: String,
    name: String,
) -> Result<String, String> {
    let reference = pane_ref(&state, &pane_id)?;
    transfer::read_text(&reference, &cwd, &name)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn write_pane_file(
    state: State<'_, AppState>,
    pane_id: String,
    cwd: String,
    name: String,
    content: String,
) -> Result<(), String> {
    let reference = pane_ref(&state, &pane_id)?;
    transfer::write_text(&reference, &cwd, &name, &content)
        .await
        .map_err(|e| e.to_string())
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TransferProgressEvent {
    transfer_id: String,
    bytes_done: u64,
    bytes_total: u64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TransferDoneEvent {
    transfer_id: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TransferErrorEvent {
    transfer_id: String,
    message: String,
}

/// Uploads local OS files (e.g. dropped from the file explorer) into `cwd` on `pane_id`.
/// Returns one transfer id per file immediately; progress/completion is reported via
/// `transfer-progress` / `transfer-done` / `transfer-error` events.
#[tauri::command]
pub async fn upload_paths(
    app: AppHandle,
    state: State<'_, AppState>,
    pane_id: String,
    cwd: String,
    local_paths: Vec<String>,
) -> Result<Vec<String>, String> {
    let reference = pane_ref(&state, &pane_id)?;
    let mut ids = Vec::with_capacity(local_paths.len());

    for local_path in local_paths {
        let transfer_id = Uuid::new_v4().to_string();
        let cancel_flag = Arc::new(AtomicBool::new(false));
        state
            .transfers
            .lock_recover()
            .insert(transfer_id.clone(), cancel_flag.clone());
        ids.push(transfer_id.clone());

        let reference = reference.clone();
        let cwd = cwd.clone();
        let app_handle = app.clone();
        let id_for_task = transfer_id.clone();

        tokio::spawn(async move {
            let result = upload_one(
                &reference,
                &cwd,
                &local_path,
                &id_for_task,
                &app_handle,
                &cancel_flag,
            )
            .await;
            match result {
                Ok(()) => {
                    let _ = app_handle.emit(
                        "transfer-done",
                        TransferDoneEvent {
                            transfer_id: id_for_task.clone(),
                        },
                    );
                }
                Err(e) => {
                    let _ = app_handle.emit(
                        "transfer-error",
                        TransferErrorEvent {
                            transfer_id: id_for_task.clone(),
                            message: e.to_string(),
                        },
                    );
                }
            }
            app_handle
                .state::<AppState>()
                .transfers
                .lock_recover()
                .remove(&id_for_task);
        });
    }
    Ok(ids)
}

async fn upload_one(
    dest: &PaneRef,
    dest_cwd: &str,
    local_path: &str,
    transfer_id: &str,
    app: &AppHandle,
    cancel: &AtomicBool,
) -> anyhow::Result<()> {
    let local = std::path::Path::new(local_path);
    let name = local
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .ok_or_else(|| anyhow::anyhow!("chemin invalide"))?;
    match dest {
        PaneRef::Local => {
            let dest_path = termius_core::sftp::join(dest_cwd, &name);
            tokio::fs::copy(local, dest_path).await?;
            Ok(())
        }
        PaneRef::Remote(client) => {
            let remote_path = termius_core::sftp::join(dest_cwd, &name);
            let transfer_id = transfer_id.to_string();
            let app = app.clone();
            let mut on_progress = move |done, total| {
                let _ = app.emit(
                    "transfer-progress",
                    TransferProgressEvent {
                        transfer_id: transfer_id.clone(),
                        bytes_done: done,
                        bytes_total: total,
                    },
                );
            };
            client.upload(local, &remote_path, cancel, &mut on_progress).await
        }
    }
}

#[tauri::command]
pub fn cancel_transfer(state: State<'_, AppState>, transfer_id: String) -> Result<(), String> {
    if let Some(flag) = state
        .transfers
        .lock_recover()
        .get(&transfer_id)
    {
        flag.store(true, Ordering::Relaxed);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Regression test for a real bug: `rename_all = "camelCase"` on an
    /// internally-tagged enum only renames variant names, not struct-variant
    /// field names — `container_id` needs its own explicit `#[serde(rename =
    /// "containerId")]` or the frontend's camelCase JSON fails to
    /// deserialize with `missing field container_id`, exactly what happened
    /// the first time this shipped (before this field had the rename).
    #[test]
    fn pane_source_docker_accepts_camel_case_field_names() {
        let json = r#"{"kind":"docker","hostId":"11111111-1111-1111-1111-111111111111","containerId":"abc123"}"#;
        let source: PaneSource = serde_json::from_str(json).expect("camelCase containerId must deserialize");
        match source {
            PaneSource::Docker { container_id, .. } => assert_eq!(container_id, "abc123"),
            _ => panic!("expected PaneSource::Docker"),
        }
    }
}
