//! Configuration drift: which hosts no longer match a described state.
//!
//! See [`termius_core::drift`] for why the wanted state is an ordinary DSL
//! program, why there are three verdicts rather than two, and why nothing here
//! runs on a timer.

use crate::state::AppState;
use std::sync::Arc;
use tauri::State;
use termius_core::model::HostId;
use termius_core::sync_ext::MutexExt;
use termius_core::{adaptive, drift, fleet};

/// Checks `program_text` against `host_ids` and reports each host's verdicts.
///
/// Parsed through the same strict parser as a run, so a program that wouldn't
/// execute can't be silently "checked" either — the error comes back as the
/// parser's own message.
#[tauri::command]
pub async fn check_drift(
    state: State<'_, AppState>,
    host_ids: Vec<HostId>,
    program_text: String,
) -> Result<Vec<drift::HostDrift>, String> {
    let program = adaptive::parse_program(&program_text)?;
    // Snapshot, like the fleet executor: the check sees one consistent
    // workspace even if hosts are edited while it is in flight.
    let workspace = Arc::new(state.workspace.lock_recover().clone());
    Ok(drift::check(workspace, host_ids, &program, fleet::DEFAULT_CONCURRENCY).await)
}
