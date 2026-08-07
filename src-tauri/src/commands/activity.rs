//! The unified activity journal, read on demand.
//!
//! Its own module rather than a function beside the fleet history: this reads
//! three trails that belong to three other modules and owns none of them —
//! see [`termius_core::activity`] for why they are merged at read time and
//! never on disk.

use crate::state::AppState;
use tauri::State;
use termius_core::activity::{self, ActivityEvent, ActivityKind, Filter};
use termius_core::model::HostId;
use termius_core::sync_ext::MutexExt;

/// The filter as the frontend sends it. Every field optional, so the tab's
/// initial "everything" state is an empty object rather than five nulls the
/// caller has to spell out.
#[derive(Debug, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ActivityFilterInput {
    pub kinds: Vec<ActivityKind>,
    pub since_ms: Option<u64>,
    pub until_ms: Option<u64>,
    pub host_id: Option<HostId>,
    pub search: Option<String>,
}

impl From<ActivityFilterInput> for Filter {
    fn from(input: ActivityFilterInput) -> Self {
        Filter {
            kinds: input.kinds,
            since_ms: input.since_ms,
            until_ms: input.until_ms,
            host_id: input.host_id,
            search: input.search,
        }
    }
}

/// The merged timeline, most recent first.
///
/// Hosts come from the workspace rather than being re-read from disk: the
/// journal only needs them to turn ids and labels into something readable, and
/// the in-memory workspace is already the authority on that.
#[tauri::command]
pub fn list_activity(state: State<'_, AppState>, filter: Option<ActivityFilterInput>) -> Vec<ActivityEvent> {
    let hosts = state.workspace.lock_recover().hosts.clone();
    activity::collect(&hosts, &filter.unwrap_or_default().into())
}

/// The same timeline as a file the user picked, in CSV or JSON.
///
/// Exported from the *filtered* set on purpose: what you see is what you get,
/// which is the only rule that doesn't need explaining next to an export
/// button. Writing goes through `secure_file::write_private` like every other
/// file this app creates — an activity log names hosts and commands.
#[tauri::command]
pub fn export_activity(
    state: State<'_, AppState>,
    path: String,
    format: String,
    filter: Option<ActivityFilterInput>,
) -> Result<usize, String> {
    let hosts = state.workspace.lock_recover().hosts.clone();
    let events: Vec<ActivityEvent> = activity::collect(&hosts, &filter.unwrap_or_default().into());

    let contents = match format.as_str() {
        "csv" => activity::to_csv(&events),
        "json" => serde_json::to_string_pretty(&events).map_err(|e| e.to_string())?,
        other => return Err(format!("format d'export inconnu : {other}")),
    };
    termius_core::secure_file::write_private(std::path::Path::new(&path), contents.as_bytes())
        .map_err(|e| format!("impossible d'écrire « {path} » : {e}"))?;
    Ok(events.len())
}
