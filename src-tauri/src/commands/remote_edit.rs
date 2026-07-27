use crate::commands::sftp::pane_ref;
use crate::state::AppState;
use serde::Serialize;
use tauri::{AppHandle, State};
use tauri_plugin_opener::OpenerExt;
use termius_core::remote_edit::{self, SyncOutcome};
use termius_core::sync_ext::MutexExt;
use termius_core::transfer::PaneRef;

/// One live edit, as the UI lists it.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RemoteEditListed {
    pub id: String,
    pub remote_path: String,
    pub name: String,
    /// Where the copy the editor has open actually lives — shown so a user
    /// whose sync failed can still find their work by hand.
    pub local_path: String,
}

/// Result of syncing one edit, reported per-edit rather than as one
/// aggregate: with several files open, "one conflicted" has to say *which*.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RemoteEditSync {
    pub id: String,
    pub name: String,
    /// `"unchanged"` | `"pushed"`, absent when `error` is set.
    pub outcome: Option<SyncOutcome>,
    pub error: Option<String>,
}

fn listed(edit: &remote_edit::RemoteEdit) -> RemoteEditListed {
    RemoteEditListed {
        id: edit.id.clone(),
        remote_path: edit.remote_path.clone(),
        name: edit.name().to_string(),
        local_path: edit.local_path.display().to_string(),
    }
}

/// Fetches a remote file into a private temp copy and hands that copy to
/// whatever the OS opens it with.
///
/// A **local** pane needs none of this — there is no copy to make and nothing
/// to push back, so the real file is opened directly and no session is
/// registered (the returned value is `None`, and the UI shows nothing to
/// track).
#[tauri::command]
pub async fn open_remote_file_in_editor(
    app: AppHandle,
    state: State<'_, AppState>,
    pane_id: String,
    cwd: String,
    name: String,
) -> Result<Option<RemoteEditListed>, String> {
    let pane = pane_ref(&state, &pane_id)?;
    if matches!(pane, PaneRef::Local) {
        let path = termius_core::sftp::join(&cwd, &name);
        app.opener()
            .open_path(&path, None::<&str>)
            .map_err(|e| format!("impossible d'ouvrir « {path} » : {e}"))?;
        return Ok(None);
    }

    let edit = remote_edit::begin(&pane, &cwd, &name).await.map_err(|e| e.to_string())?;
    let entry = listed(&edit);
    // Opened before registering: if the OS can't open it at all, there is no
    // point tracking an edit that will never happen — and `edit` dropping
    // here leaves only a temp file the OS will clean up.
    app.opener()
        .open_path(edit.local_path.display().to_string(), None::<&str>)
        .map_err(|e| format!("impossible d'ouvrir « {} » dans un éditeur : {e}", entry.name))?;
    state.remote_edits.lock_recover().insert(edit.id.clone(), edit);
    Ok(Some(entry))
}

#[tauri::command]
pub fn list_remote_edits(state: State<'_, AppState>) -> Vec<RemoteEditListed> {
    state.remote_edits.lock_recover().values().map(listed).collect()
}

/// Pushes back every edit whose local copy changed.
///
/// Called when the app regains focus — the moment a save made in another
/// window becomes relevant — and from the explicit "Tout renvoyer" action.
/// Sessions are taken out of the map for the duration so the lock isn't held
/// across the network, then put back: the same discipline
/// `commands::sql::resync_sql_session` uses, and for the same reason (a
/// failed sync must leave a still-usable session behind, not drop it).
#[tauri::command]
pub async fn sync_remote_edits(state: State<'_, AppState>) -> Result<Vec<RemoteEditSync>, String> {
    let ids: Vec<String> = state.remote_edits.lock_recover().keys().cloned().collect();
    let mut results = Vec::new();
    for id in ids {
        let Some(mut edit) = state.remote_edits.lock_recover().remove(&id) else { continue };
        let outcome = remote_edit::sync(&mut edit).await;
        let name = edit.name().to_string();
        state.remote_edits.lock_recover().insert(id.clone(), edit);
        results.push(match outcome {
            Ok(outcome) => RemoteEditSync { id, name, outcome: Some(outcome), error: None },
            Err(e) => RemoteEditSync { id, name, outcome: None, error: Some(e.to_string()) },
        });
    }
    Ok(results)
}

/// Final sync, then forget the edit and delete its temp copy.
///
/// A failing sync (a conflict, an unreachable host) **keeps** the session:
/// discarding it there would throw away the only copy of whatever was typed.
/// `discard_remote_edit` is the deliberate way out.
#[tauri::command]
pub async fn end_remote_edit(state: State<'_, AppState>, id: String) -> Result<SyncOutcome, String> {
    let mut edit = state
        .remote_edits
        .lock_recover()
        .remove(&id)
        .ok_or_else(|| "édition inconnue ou déjà terminée".to_string())?;
    match remote_edit::sync(&mut edit).await {
        Ok(outcome) => {
            remote_edit::discard(&edit).await;
            Ok(outcome)
        }
        Err(e) => {
            state.remote_edits.lock_recover().insert(id, edit);
            Err(e.to_string())
        }
    }
}

/// Drops an edit without pushing it back, temp copy included. The only way to
/// abandon local changes, so the UI asks first.
#[tauri::command]
pub async fn discard_remote_edit(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let edit = state.remote_edits.lock_recover().remove(&id);
    if let Some(edit) = edit {
        remote_edit::discard(&edit).await;
    }
    Ok(())
}
