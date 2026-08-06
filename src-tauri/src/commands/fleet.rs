use crate::state::AppState;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};
use termius_core::fleet::{self, FleetTarget, HostOutcome};
use termius_core::fleet_history::{self, FleetRun};
use termius_core::model::HostId;
use termius_core::sync_ext::MutexExt;

/// Per-host stdout/stderr kept in the persisted history is capped to this many
/// chars — the live UI still gets the full output via the event; only the audit
/// record is trimmed, to keep `fleet_history.json` from ballooning on a verbose
/// command run across many hosts.
const MAX_STORED_OUTPUT: usize = 4000;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct FleetOutcomeEvent {
    run_id: String,
    outcome: HostOutcome,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct FleetDoneEvent {
    run_id: String,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn truncate(s: String, max: usize) -> String {
    if s.chars().count() <= max {
        return s;
    }
    let mut out: String = s.chars().take(max).collect();
    out.push_str("\n… (tronqué)");
    out
}

/// Copy of an outcome with its output trimmed for storage (see [`MAX_STORED_OUTPUT`]).
fn for_history(o: &HostOutcome) -> HostOutcome {
    let mut o = o.clone();
    o.stdout = truncate(o.stdout, MAX_STORED_OUTPUT);
    o.stderr = truncate(o.stderr, MAX_STORED_OUTPUT);
    o
}

/// Shared by [`run_fleet_command`] (one `command` for every host) and
/// `commands::adaptive::run_adaptive_plan` (a different command per
/// platform group) — everything past "which command does each host run" is
/// identical: fan out via [`fleet::run_on_hosts`], stream a
/// `fleet-run-outcome` event per host as it finishes, then a single
/// `fleet-run-done`, and record the completed run to the persisted history.
/// `summary_command` is what the history list displays for the run (the
/// literal command for a classic run, the natural-language intent for an
/// adaptive one); `per_host_commands` is `Some` only for the latter, so the
/// history can also show exactly what ran on each host.
/// `program_text` is the DSL source of an adaptive run, kept so the run can be
/// undone later — see [`termius_core::fleet_history::FleetRun::program_text`]
/// for why neither of the other two fields can stand in for it.
pub(crate) async fn execute_and_record(
    app: &AppHandle,
    state: &AppState,
    run_id: String,
    commands: HashMap<FleetTarget, String>,
    summary_command: String,
    per_host_commands: Option<HashMap<HostId, String>>,
    program_text: Option<String>,
) -> Result<(), String> {
    let started_at_ms = now_ms();
    // Snapshot the workspace so the run sees a consistent view even if the user
    // edits hosts while it's in flight.
    let workspace = Arc::new(state.workspace.lock_recover().clone());
    let targets: Vec<FleetTarget> = commands.keys().cloned().collect();

    // Captured *before* the run, from facts already collected: after
    // `set-hostname` the old name is gone, so there would be nothing left to
    // restore. Only recorded for a run that can be undone at all.
    let previous_hostnames = program_text.as_ref().map(|_| {
        targets
            .iter()
            .filter_map(|target| match target {
                FleetTarget::Ssh { host_id } => Some(*host_id),
                _ => None,
            })
            .filter_map(|host_id| {
                let hostname = workspace
                    .host(host_id)?
                    .last_facts
                    .as_ref()?
                    .hostname
                    .clone()?;
                Some((host_id, hostname))
            })
            .collect::<HashMap<HostId, String>>()
    });
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<HostOutcome>();
    tokio::spawn(fleet::run_on_hosts(workspace, commands, fleet::DEFAULT_CONCURRENCY, tx));

    let mut collected: Vec<HostOutcome> = Vec::new();
    while let Some(outcome) = rx.recv().await {
        collected.push(for_history(&outcome));
        // Emit the full (untruncated) outcome to the live view; ignore emit
        // failures (webview gone) so the run is still fully drained and recorded.
        let _ = app.emit("fleet-run-outcome", FleetOutcomeEvent { run_id: run_id.clone(), outcome });
    }
    let _ = app.emit("fleet-run-done", FleetDoneEvent { run_id });

    let run = FleetRun {
        id: uuid::Uuid::new_v4(),
        started_at_ms,
        command: summary_command,
        targets,
        outcomes: collected,
        per_host_commands,
        program_text,
        previous_hostnames,
    };
    {
        let mut history = state.fleet_history.lock_recover();
        fleet_history::record(&mut history, run);
        if let Err(e) = fleet_history::save(&history) {
            tracing::warn!("échec de l'enregistrement de l'historique de flotte : {e}");
        }
    }
    Ok(())
}

/// Runs `command` on every target in `targets` — an SSH host, a Docker exec
/// container, or the local machine (see [`FleetTarget`]) — off any PTY.
/// `run_id` is minted by the frontend so several runs can be in flight at
/// once and be told apart on the shared event channel — the command itself
/// resolves only once every target has reported. See [`execute_and_record`]
/// for the shared streaming/history mechanics.
#[tauri::command]
pub async fn run_fleet_command(
    app: AppHandle,
    state: State<'_, AppState>,
    run_id: String,
    targets: Vec<FleetTarget>,
    command: String,
) -> Result<(), String> {
    let commands = fleet::uniform_commands(&targets, &command);
    // No program text: a free command is arbitrary shell, which is precisely
    // what cannot be inverted. The history marks the run as un-undoable rather
    // than offering a button that would guess.
    execute_and_record(&app, &state, run_id, commands, command, None, None).await
}

/// Returns the persisted fleet run history, newest first.
#[tauri::command]
pub fn get_fleet_history(state: State<'_, AppState>) -> Vec<FleetRun> {
    state.fleet_history.lock_recover().clone()
}
