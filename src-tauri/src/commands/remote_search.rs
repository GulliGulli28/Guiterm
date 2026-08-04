//! Searching a host's filesystem.
//!
//! See [`termius_core::remote_search`] for why every search is bounded and
//! why the command building and the parsing are pure functions there rather
//! than here.

use crate::state::AppState;
use tauri::State;
use termius_core::model::HostId;
use termius_core::remote_search::{self, SearchMode, SearchOutcome};
use termius_core::ssh;
use termius_core::ssh_pool;
use termius_core::sync_ext::MutexExt;

/// How many hits are worth bringing back. Past this the answer to "where is
/// it" stops being a list and starts being another search.
const LIMIT: usize = 200;

/// Runs a search on `host_id` and returns what it found.
///
/// SSH only, deliberately: the results are meant to be opened, and opening one
/// goes through the file-pane machinery, which needs a host it can also browse.
/// Docker and K8s targets have that machinery too — extending this to them is
/// a matter of choosing a container or a pod first, which is a picker this
/// panel doesn't have.
#[tauri::command]
pub async fn search_remote_files(
    state: State<'_, AppState>,
    host_id: HostId,
    mode: SearchMode,
    root: String,
    pattern: String,
) -> Result<SearchOutcome, String> {
    remote_search::validate_root(&root)?;
    remote_search::validate_pattern(&pattern)?;

    let workspace = state.workspace.lock_recover().clone();
    // Through the pool, like every other connection in the app: a search is
    // usually run while a terminal on that host is already open, and opening a
    // second full connection for it would be a whole TCP+handshake+auth for
    // one command.
    let lease = ssh_pool::acquire(&workspace, host_id)
        .await
        .map_err(|e| e.to_string())?;
    let command = remote_search::search_command(mode, &root, &pattern, LIMIT);
    let output = ssh::run_command_capture(&lease.connection(), &command)
        .await
        .map_err(|e| e.to_string())?;

    Ok(remote_search::parse_outcome(
        mode,
        &output.stdout,
        output.exit_code,
        LIMIT,
    ))
}
