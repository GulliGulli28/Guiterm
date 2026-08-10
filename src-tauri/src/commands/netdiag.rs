//! Running network diagnostics across a fleet.
//!
//! See [`termius_core::netdiag`] for why each tool is a script built in `core`
//! and classified in Rust, and for the two shell flavours.
//!
//! **Streamed, unlike `probe_reachability`.** That one answers in a batch
//! because its probe is bounded at five seconds, which its doc comment says
//! outright. Here a run is several tools across several targets — and tranche 2
//! adds `traceroute`, which alone takes tens of seconds. Waiting for the whole
//! grid before showing anything would turn a diagnostic into a blank screen.
//!
//! **Not recorded in the fleet history**, same rule as the reachability probe:
//! this asks a question and changes nothing, and burying real runs under
//! diagnostics would make the history worse at the one job it has.

use crate::state::AppState;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};
use termius_core::fleet::{self, FleetTarget};
use termius_core::model::HostId;
use termius_core::netdiag::{self, DiagTool, DiagVerdict};
use termius_core::sync_ext::MutexExt;

/// Which row of the grid an answer belongs to.
///
/// The two directions put different things on the rows, and flattening that to
/// a bare string would lose the distinction in the one place it matters — the
/// frontend, which has to label a row and can't guess what it is looking at.
#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum DiagRow {
    /// The diagnostic ran **on** this target, about the typed destination.
    From { target: FleetTarget },
    /// The diagnostic ran **here**, about this host.
    To { host_id: HostId },
}

/// One tool's answer for one row.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetdiagOutcome {
    /// Echoed back so the tab can ignore results from a run the user has
    /// already replaced — a slow target from the previous run would otherwise
    /// land in the new grid.
    pub run_id: String,
    pub row: DiagRow,
    pub tool: DiagTool,
    pub verdict: DiagVerdict,
    pub duration_ms: u64,
}

const OUTCOME_EVENT: &str = "netdiag-outcome";
const DONE_EVENT: &str = "netdiag-done";

/// Runs every tool against `destination`, from every target.
///
/// Returns as soon as the work is scheduled; results arrive on
/// `netdiag-outcome`, and `netdiag-done` closes the run.
#[tauri::command]
pub async fn run_netdiag(
    app: AppHandle,
    state: State<'_, AppState>,
    run_id: String,
    targets: Vec<FleetTarget>,
    destination: String,
    tools: Vec<DiagTool>,
) -> Result<(), String> {
    // Before anything is interpolated into a script that runs on a fleet.
    netdiag::validate(&destination, &tools)?;
    if targets.is_empty() {
        return Err("Choisir au moins un hôte depuis lequel diagnostiquer.".to_string());
    }

    // Snapshot, like a fleet run: the diagnostic sees a consistent workspace
    // even if the user edits a host while it is in flight.
    let workspace = Arc::new(state.workspace.lock_recover().clone());
    let destination = destination.trim().to_string();

    tokio::spawn(async move {
        // One `run_on_hosts` per tool rather than one script carrying them all.
        // The executor is keyed by target — a single command per target — and
        // concatenating tools would mean several markers in one stream, so the
        // parsers would no longer be the ones `core` tests. The extra commands
        // ride the same pooled SSH connection.
        let mut waves = Vec::with_capacity(tools.len());
        for tool in &tools {
            let commands: HashMap<FleetTarget, String> = targets
                .iter()
                .map(|target| {
                    // Per target, not per run: a fleet routinely mixes Linux
                    // hosts with this Windows machine.
                    let flavour = netdiag::flavour_for(target);
                    (target.clone(), netdiag::script(tool, &destination, flavour))
                })
                .collect();

            let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
            tokio::spawn(fleet::run_on_hosts(
                workspace.clone(),
                commands,
                fleet::DEFAULT_CONCURRENCY,
                tx,
            ));

            let app = app.clone();
            let run_id = run_id.clone();
            let tool = tool.clone();
            waves.push(tokio::spawn(async move {
                while let Some(outcome) = rx.recv().await {
                    let flavour = netdiag::flavour_for(&outcome.target);
                    // A target this app couldn't reach at all never ran the
                    // probe. That is a failure of our own connection, not an
                    // answer about the destination, and passing it off as one
                    // would lie about which link is broken.
                    let verdict = match &outcome.error {
                        Some(error) => DiagVerdict::Failed {
                            message: format!("Connexion à la source impossible : {error}"),
                        },
                        None => netdiag::parse(&tool, flavour, &outcome.stdout, &outcome.stderr),
                    };
                    let _ = app.emit(
                        OUTCOME_EVENT,
                        NetdiagOutcome {
                            run_id: run_id.clone(),
                            row: DiagRow::From { target: outcome.target },
                            tool: tool.clone(),
                            verdict,
                            duration_ms: outcome.duration_ms,
                        },
                    );
                }
            }));
        }

        for wave in waves {
            let _ = wave.await;
        }
        let _ = app.emit(DONE_EVENT, serde_json::json!({ "runId": run_id }));
    });

    Ok(())
}

/// Runs every tool from **this machine**, against each selected host.
///
/// **Not the fleet executor.** `run_on_hosts` is keyed by `FleetTarget`, and
/// here every probe runs on `Local` — ten hosts would collapse into one map
/// entry. So this is its own small runner: N local processes, bounded, each
/// aimed at a different address. The scripts and the parsers are the same ones
/// as the other direction; only the execution differs.
///
/// The point of this direction is that it needs **no SSH connection**, so it
/// still answers about a host that is exactly the thing that has broken.
#[tauri::command]
pub async fn run_netdiag_to_hosts(
    app: AppHandle,
    state: State<'_, AppState>,
    run_id: String,
    host_ids: Vec<HostId>,
    tools: Vec<DiagTool>,
) -> Result<(), String> {
    if host_ids.is_empty() {
        return Err("Choisir au moins un hôte à diagnostiquer.".to_string());
    }
    if tools.is_empty() {
        return Err("Choisir au moins un diagnostic.".to_string());
    }

    // Addresses are user-typed too, so each is validated exactly like a
    // destination — the allow-list is the only thing between a saved host and
    // a shell script. A host that fails it is reported rather than dropped: a
    // row silently missing from the grid is worse than one saying why.
    let workspace = state.workspace.lock_recover().clone();
    let mut jobs: Vec<(HostId, String)> = Vec::new();
    let mut rejected: Vec<(HostId, String)> = Vec::new();
    for host_id in host_ids {
        match workspace.host(host_id) {
            None => rejected.push((host_id, "hôte inconnu".to_string())),
            Some(host) => match netdiag::validate(&host.address, &tools) {
                Ok(()) => jobs.push((host_id, host.address.clone())),
                Err(why) => rejected.push((host_id, why)),
            },
        }
    }

    let flavour = netdiag::flavour_for(&FleetTarget::Local);
    let shell = termius_core::local_shell::default_local_shell();

    tokio::spawn(async move {
        for (host_id, why) in rejected {
            for tool in &tools {
                let _ = app.emit(
                    OUTCOME_EVENT,
                    NetdiagOutcome {
                        run_id: run_id.clone(),
                        row: DiagRow::To { host_id },
                        tool: tool.clone(),
                        verdict: DiagVerdict::Failed { message: why.clone() },
                        duration_ms: 0,
                    },
                );
            }
        }

        // Bounded like a fleet run: one process per host per tool, and a
        // twenty-host traceroute would otherwise start sixty at once.
        let semaphore = Arc::new(tokio::sync::Semaphore::new(fleet::DEFAULT_CONCURRENCY));
        let mut handles = Vec::new();
        for (host_id, address) in jobs {
            for tool in &tools {
                let (app, run_id, tool, shell) =
                    (app.clone(), run_id.clone(), tool.clone(), shell.clone());
                let semaphore = semaphore.clone();
                let script = netdiag::script(&tool, &address, flavour);
                handles.push(tokio::spawn(async move {
                    let _permit = semaphore.acquire().await;
                    let started = std::time::Instant::now();
                    let outcome = tokio::task::spawn_blocking(move || {
                        termius_core::local_shell::run_capture(&shell, &script)
                    })
                    .await;
                    let duration_ms = started.elapsed().as_millis() as u64;

                    let verdict = match outcome {
                        Ok(Ok(run)) => netdiag::parse(&tool, flavour, &run.stdout, &run.stderr),
                        Ok(Err(e)) => DiagVerdict::Failed {
                            message: format!("Exécution locale impossible : {e}"),
                        },
                        Err(e) => DiagVerdict::Failed {
                            message: format!("Tâche locale interrompue : {e}"),
                        },
                    };
                    let _ = app.emit(
                        OUTCOME_EVENT,
                        NetdiagOutcome {
                            run_id,
                            row: DiagRow::To { host_id },
                            tool,
                            verdict,
                            duration_ms,
                        },
                    );
                }));
            }
        }
        for handle in handles {
            let _ = handle.await;
        }
        let _ = app.emit(DONE_EVENT, serde_json::json!({ "runId": run_id }));
    });

    Ok(())
}
