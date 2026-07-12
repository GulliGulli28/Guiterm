use crate::state::{AppState, RdpViewSession};
use rdp_ipc::{ClientMessage, ConnectRequest, SidecarMessage};
use serde::Serialize;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::CommandEvent;
use termius_core::model::HostId;
use termius_core::sync_ext::MutexExt;
use termius_core::vault::{self, SecretKind};
use tokio::io::AsyncWriteExt as _;
use uuid::Uuid;

#[derive(Serialize, Clone)]
struct RdpViewErrorEvent {
    id: String,
    message: String,
}

#[derive(Serialize, Clone)]
struct RdpViewClosedEvent {
    id: String,
}

/// Starts an embedded, view-only RDP session against `host_id`
/// (`HostKind::Rdp`) by spawning the `rdp-sidecar` process and streaming its
/// decoded framebuffer back as `rdp-view-frame`/`rdp-view-error`/
/// `rdp-view-closed` events, all carrying this call's returned session id.
///
/// See `core::rdp` for the older launcher-mode alternative (still used by
/// `connect_rdp`) and CLAUDE.md's "Pourquoi un processus RDP séparé" section
/// for why this runs in a separate process instead of linking IronRDP
/// directly into this binary.
///
/// Mouse/keyboard input is forwarded separately, see `send_rdp_view_input`.
/// `width`/`height`: the view's container size at connect time (measured by
/// `RdpTab.tsx`), used as the session's initial resolution instead of an
/// arbitrary fixed default — the sidecar clamps them to MS-RDPEDISP's valid
/// range regardless.
///
/// `channel`: a dedicated `tauri::ipc::Channel` this call's caller creates
/// just for this session, used to stream `SidecarMessage::Image` frames back
/// as raw bytes (see the frame-building comment below) instead of a JSON
/// `rdp-view-frame` event — this is the hot path (one message per dirty
/// rectangle), so skipping JSON-stringify + base64 on the way out (and
/// JSON-parse + base64-decode on `RdpTab.tsx`'s side) is worth the extra
/// argument. `rdp-view-error`/`rdp-view-closed` stay plain events: they fire
/// at most once per session, so their JSON overhead is irrelevant.
#[tauri::command]
pub async fn connect_rdp_view(
    app: AppHandle,
    state: State<'_, AppState>,
    host_id: HostId,
    width: u16,
    height: u16,
    channel: Channel,
) -> Result<String, String> {
    let host = state
        .workspace
        .lock_recover()
        .hosts
        .iter()
        .find(|h| h.id == host_id)
        .cloned()
        .ok_or_else(|| "hôte inconnu".to_string())?;

    let password = vault::load(host_id, SecretKind::Password)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "aucun mot de passe enregistré pour cet hôte".to_string())?;

    let request = ConnectRequest { host: host.address.clone(), port: host.port, username: host.username.clone(), password, width, height };

    let (mut events, child) = app
        .shell()
        .sidecar("rdp-sidecar")
        .map_err(|e| format!("rdp-sidecar introuvable : {e}"))?
        .set_raw_out(true)
        .spawn()
        .map_err(|e| format!("échec du lancement de rdp-sidecar : {e}"))?;

    let session_id = Uuid::new_v4().to_string();

    let mut line = serde_json::to_vec(&request).expect("ConnectRequest always serializes");
    line.push(b'\n');
    let mut child = child;
    child.write(&line).map_err(|e| format!("écriture vers rdp-sidecar : {e}"))?;

    state.rdp_views.lock_recover().insert(session_id.clone(), RdpViewSession { child });

    let (mut duplex_read, mut duplex_write) = tokio::io::duplex(256 * 1024);
    let crash_app = app.clone();
    let crash_id = session_id.clone();
    tokio::spawn(async move {
        // In a release build the app has no console (`windows_subsystem =
        // "windows"` in main.rs), so `tracing::warn!`/`tracing::error!` below
        // land nowhere the user can see — a real panic's message (printed by
        // Rust's default panic hook to the sidecar's stderr) would otherwise
        // vanish entirely, leaving only a generic "session closed" once
        // `duplex_write` drops. Keep a short tail of stderr so an abnormal
        // exit can carry it into an `rdp-view-error` the UI actually shows.
        const STDERR_TAIL_MAX: usize = 4096;
        let mut stderr_tail: Vec<u8> = Vec::new();
        while let Some(event) = events.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => {
                    if duplex_write.write_all(&bytes).await.is_err() {
                        break;
                    }
                }
                CommandEvent::Stderr(bytes) => {
                    tracing::warn!(stderr = %String::from_utf8_lossy(&bytes), "rdp-sidecar");
                    stderr_tail.extend_from_slice(&bytes);
                    let excess = stderr_tail.len().saturating_sub(STDERR_TAIL_MAX);
                    if excess > 0 {
                        stderr_tail.drain(0..excess);
                    }
                }
                CommandEvent::Error(e) => {
                    tracing::error!(error = %e, "rdp-sidecar pipe error");
                    let _ = crash_app.emit(
                        "rdp-view-error",
                        RdpViewErrorEvent { id: crash_id.clone(), message: format!("erreur de communication avec rdp-sidecar : {e}") },
                    );
                    break;
                }
                CommandEvent::Terminated(payload) => {
                    // A graceful exit (whether the session ended cleanly or
                    // with a handled error) always writes its own
                    // `SidecarMessage` to stdout before the process returns
                    // `()` from `main`, which exits 0 — see `main.rs`. A
                    // non-zero/signalled exit here means the process crashed
                    // (e.g. panicked) without going through that path.
                    if payload.code != Some(0) {
                        let detail = String::from_utf8_lossy(&stderr_tail).trim().to_string();
                        let message = if detail.is_empty() {
                            format!("rdp-sidecar s'est arrêté de façon inattendue (code {:?}, signal {:?})", payload.code, payload.signal)
                        } else {
                            format!("rdp-sidecar a planté : {detail}")
                        };
                        let _ = crash_app.emit("rdp-view-error", RdpViewErrorEvent { id: crash_id.clone(), message });
                    }
                    break;
                }
                _ => {}
            }
        }
    });

    let bridge_id = session_id.clone();
    let bridge_app = app.clone();
    tokio::spawn(async move {
        loop {
            let message = match SidecarMessage::read_from(&mut duplex_read).await {
                Ok(Some(msg)) => msg,
                Ok(None) => {
                    let _ = bridge_app.emit("rdp-view-closed", RdpViewClosedEvent { id: bridge_id.clone() });
                    break;
                }
                Err(e) => {
                    let _ = bridge_app.emit("rdp-view-error", RdpViewErrorEvent { id: bridge_id.clone(), message: e.to_string() });
                    break;
                }
            };
            match message {
                SidecarMessage::Image { canvas_width, canvas_height, x, y, width, height, pixels } => {
                    // 12-byte little-endian header (canvas_width, canvas_height,
                    // x, y, width, height — each u16) followed by raw RGBA8
                    // pixels, sent as `InvokeResponseBody::Raw` through the
                    // per-session channel: no JSON/base64 for this hot path.
                    // `RdpTab.tsx`'s `parseRdpFrame` mirrors this layout exactly.
                    let mut frame = Vec::with_capacity(12 + pixels.len());
                    frame.extend_from_slice(&canvas_width.to_le_bytes());
                    frame.extend_from_slice(&canvas_height.to_le_bytes());
                    frame.extend_from_slice(&x.to_le_bytes());
                    frame.extend_from_slice(&y.to_le_bytes());
                    frame.extend_from_slice(&width.to_le_bytes());
                    frame.extend_from_slice(&height.to_le_bytes());
                    frame.extend_from_slice(&pixels);
                    if channel.send(InvokeResponseBody::Raw(frame)).is_err() {
                        break;
                    }
                }
                SidecarMessage::Error(msg) => {
                    let _ = bridge_app.emit("rdp-view-error", RdpViewErrorEvent { id: bridge_id.clone(), message: msg });
                    break;
                }
                SidecarMessage::Closed => {
                    let _ = bridge_app.emit("rdp-view-closed", RdpViewClosedEvent { id: bridge_id.clone() });
                    break;
                }
            }
        }
    });

    Ok(session_id)
}

/// Forwards one mouse/keyboard event to an already-connected session's
/// `rdp-sidecar` stdin. `message` is decoded straight from the frontend's
/// `invoke()` call — see `rdp_ipc::ClientMessage` for the wire shape and
/// `rdp-sidecar/src/input.rs` for how it becomes an RDP scancode/PDU.
#[tauri::command]
pub fn send_rdp_view_input(state: State<'_, AppState>, session_id: String, message: ClientMessage) -> Result<(), String> {
    let mut sessions = state.rdp_views.lock_recover();
    let session = sessions.get_mut(&session_id).ok_or_else(|| "session inconnue".to_string())?;
    let mut line = serde_json::to_vec(&message).expect("ClientMessage always serializes");
    line.push(b'\n');
    session.child.write(&line).map_err(|e| format!("écriture vers rdp-sidecar : {e}"))
}

#[tauri::command]
pub fn close_rdp_view(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    if let Some(session) = state.rdp_views.lock_recover().remove(&session_id) {
        // Best-effort: the sidecar also exits on its own once its stdout
        // pipe breaks (main.rs's write loop hits a closed reader), so a
        // failed kill here (already-dead process) isn't an error.
        let _ = session.child.kill();
    }
    Ok(())
}

/// Recursively flattens `entry` (and, if it's a directory, everything
/// beneath it) from `source_cwd` on `pane` into `out`, in the shape
/// `rdp_ipc::PushedFile` needs (see its doc comment for the wire format
/// `rdp-sidecar` expects). `relative_prefix`: the `\`-joined path of
/// already-visited parent directories within this drag, `None` at the top
/// level. A symlink is pushed as itself (its target's content, for a file),
/// never descended into — same rationale as `transfer::copy_entry`:
/// following a symlinked directory could walk a tree that lives entirely
/// outside what the user actually dragged.
fn collect_pushed_files<'a>(
    pane: &'a termius_core::transfer::PaneRef,
    cwd: &'a str,
    entry: &'a termius_core::sftp::Entry,
    relative_prefix: Option<&'a str>,
    out: &'a mut Vec<rdp_ipc::PushedFile>,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send + 'a>> {
    Box::pin(async move {
        let is_real_dir = entry.is_dir && !entry.is_symlink;
        if is_real_dir {
            out.push(rdp_ipc::PushedFile {
                local_path: String::new(),
                name: entry.name.clone(),
                relative_path: relative_prefix.map(str::to_string),
                is_dir: true,
                size: 0,
            });
            let child_cwd = termius_core::sftp::join(cwd, &entry.name);
            let child_prefix = match relative_prefix {
                Some(prefix) => format!("{prefix}\\{}", entry.name),
                None => entry.name.clone(),
            };
            let children = termius_core::transfer::list(pane, &child_cwd).await.map_err(|e| e.to_string())?;
            for child in &children {
                collect_pushed_files(pane, &child_cwd, child, Some(&child_prefix), out).await?;
            }
        } else {
            let local_path = termius_core::transfer::resolve_local_path(pane, cwd, entry).await.map_err(|e| e.to_string())?;
            out.push(rdp_ipc::PushedFile {
                local_path: local_path.to_string_lossy().into_owned(),
                name: entry.name.clone(),
                relative_path: relative_prefix.map(str::to_string),
                is_dir: false,
                size: entry.size,
            });
        }
        Ok(())
    })
}

/// Recursively flattens a real local filesystem `path` into `out`, same
/// output shape as `collect_pushed_files` above but walking `std::fs`
/// directly instead of a `RemoteFileClient` pane. Used only by
/// `push_rdp_view_clipboard_paths` (OS-level drag-and-drop straight from
/// Windows Explorer, see `TransferTab.tsx`'s `onDragDropEvent` handler) —
/// unlike a drag that starts inside the app's own file browser, a native OS
/// drop can come from *any* directory the user has open in Explorer, not
/// necessarily whatever the local pane's `cwd` happens to be, so there is no
/// already-open pane to route this through at all.
fn collect_local_pushed_files(path: &std::path::Path, relative_prefix: Option<&str>, out: &mut Vec<rdp_ipc::PushedFile>) -> Result<(), String> {
    let name = path
        .file_name()
        .ok_or_else(|| format!("chemin sans nom de fichier : {}", path.display()))?
        .to_string_lossy()
        .into_owned();
    let metadata = std::fs::symlink_metadata(path).map_err(|e| format!("{} : {e}", path.display()))?;
    let is_symlink = metadata.file_type().is_symlink();
    // A symlinked directory is pushed as itself, never descended into — same
    // rationale as `collect_pushed_files`/`transfer::copy_entry`.
    if metadata.is_dir() && !is_symlink {
        out.push(rdp_ipc::PushedFile { local_path: String::new(), name: name.clone(), relative_path: relative_prefix.map(str::to_string), is_dir: true, size: 0 });
        let child_prefix = match relative_prefix {
            Some(prefix) => format!("{prefix}\\{name}"),
            None => name.clone(),
        };
        let entries = std::fs::read_dir(path).map_err(|e| format!("{} : {e}", path.display()))?;
        for entry in entries {
            let entry = entry.map_err(|e| e.to_string())?;
            collect_local_pushed_files(&entry.path(), Some(&child_prefix), out)?;
        }
    } else {
        out.push(rdp_ipc::PushedFile {
            local_path: path.to_string_lossy().into_owned(),
            name,
            relative_path: relative_prefix.map(str::to_string),
            is_dir: false,
            size: metadata.len(),
        });
    }
    Ok(())
}

/// Same as `push_rdp_view_clipboard_entries`, but for paths dropped straight
/// from the OS (Windows Explorer → the embedded RDP view) rather than
/// entries picked from one of this app's own transfer panes — see
/// `collect_local_pushed_files`'s doc comment for why that needs a separate
/// code path instead of reusing a `PaneRef`.
#[tauri::command]
pub fn push_rdp_view_clipboard_paths(state: State<'_, AppState>, session_id: String, paths: Vec<String>) -> Result<(), String> {
    let mut files = Vec::new();
    for p in &paths {
        collect_local_pushed_files(std::path::Path::new(p), None, &mut files)?;
    }
    send_rdp_view_input(state, session_id, ClientMessage::PushClipboardFiles { files })
}

/// Pushes one or more transfer-pane entries (files and/or whole folders,
/// local or remote — SFTP/Docker entries are downloaded to a private temp
/// file first, see `transfer::resolve_local_path`) onto an embedded RDP
/// session's clipboard — the sidecar simulates a Ctrl+V right after (see
/// `paste_key_sequence` in `rdp-sidecar/src/main.rs`), so this pastes
/// automatically rather than requiring the user to press Ctrl+V — see
/// `rdp_ipc::ClientMessage::PushClipboardFiles`'s doc comment for why this
/// is a one-shot push rather than a live OS clipboard mirror. `session_id`
/// identifies the target RDP view (the same id `connect_rdp_view`
/// returned); `source_pane_id`/`source_cwd` identify where `entries` came
/// from, same convention as `copy_entry`.
#[tauri::command]
pub async fn push_rdp_view_clipboard_entries(
    state: State<'_, AppState>,
    session_id: String,
    source_pane_id: String,
    source_cwd: String,
    entries: Vec<termius_core::sftp::Entry>,
) -> Result<(), String> {
    let pane = crate::commands::sftp::pane_ref(&state, &source_pane_id)?;
    let mut files = Vec::new();
    for entry in &entries {
        collect_pushed_files(&pane, &source_cwd, entry, None, &mut files).await?;
    }
    send_rdp_view_input(state, session_id, ClientMessage::PushClipboardFiles { files })
}
