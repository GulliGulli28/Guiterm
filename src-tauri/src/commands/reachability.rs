//! Running the reachability probe on one or several targets.
//!
//! See [`termius_core::reachability`] for why the probe distinguishes a
//! refusal from a silence, and why all the classification lives in `core`
//! rather than in the script.

use crate::state::AppState;
use serde::Serialize;
use std::sync::Arc;
use tauri::State;
use termius_core::fleet::{self, FleetTarget};
use termius_core::reachability::{self, Verdict, PROBE_TIMEOUT_SECS};
use termius_core::sync_ext::MutexExt;

/// One source's answer about one destination.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReachabilityOutcome {
    pub target: FleetTarget,
    pub verdict: Verdict,
    pub duration_ms: u64,
}

/// Asks every target whether it can reach `host:port`.
///
/// Batch rather than streamed, unlike a fleet run: the probe is bounded by
/// [`PROBE_TIMEOUT_SECS`] on every target and they run concurrently, so the
/// whole answer arrives in about the time of the slowest one — streaming would
/// add an event protocol for a wait that isn't there.
///
/// Deliberately not recorded in the fleet history: this asks a question and
/// changes nothing, and burying real runs under diagnostics would make the
/// history worse at the one job it has.
#[tauri::command]
pub async fn probe_reachability(
    state: State<'_, AppState>,
    targets: Vec<FleetTarget>,
    host: String,
    port: u16,
) -> Result<Vec<ReachabilityOutcome>, String> {
    reachability::validate_host(&host)?;
    if port == 0 {
        return Err("Indiquer un port entre 1 et 65535.".to_string());
    }
    if targets.is_empty() {
        return Err("Choisir au moins un hôte depuis lequel tester.".to_string());
    }

    let script = reachability::probe_script(host.trim(), port, PROBE_TIMEOUT_SECS);
    let commands = fleet::uniform_commands(&targets, &script);
    // Snapshot, like a fleet run: the probe sees a consistent workspace even if
    // the user edits a host while it is in flight.
    let workspace = Arc::new(state.workspace.lock_recover().clone());

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    tokio::spawn(fleet::run_on_hosts(
        workspace,
        commands,
        fleet::DEFAULT_CONCURRENCY,
        tx,
    ));

    let mut outcomes = Vec::new();
    while let Some(outcome) = rx.recv().await {
        // A target that couldn't be reached *at all* never ran the probe —
        // that's a failure of this app's own connection, not an answer about
        // the destination, and passing it off as one would be a lie about
        // which link is broken.
        let verdict = match &outcome.error {
            Some(error) => Verdict::Failed {
                message: format!("Connexion à la source impossible : {error}"),
            },
            None => reachability::parse_verdict(&outcome.stdout, &outcome.stderr),
        };
        outcomes.push(ReachabilityOutcome {
            target: outcome.target,
            duration_ms: outcome.duration_ms,
            verdict,
        });
    }
    Ok(outcomes)
}
