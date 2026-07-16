use crate::state::AppState;
use serde::Serialize;
use std::sync::Arc;
use tauri::State;
use termius_core::facts::{self, FactsOutcome};
use termius_core::fleet;
use termius_core::model::{HostId, Workspace};
use termius_core::store;
use termius_core::sync_ext::MutexExt;

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectFactsResult {
    pub outcomes: Vec<FactsOutcome>,
    pub workspace: Workspace,
}

/// Collects live state (OS, kernel, CPU, load, memory) for every host in
/// `host_ids` concurrently (SSH only — see [`termius_core::facts`]). Batch:
/// resolves once every host has reported. Successful outcomes are persisted
/// onto their host as `last_facts`/`last_facts_at_ms` (a failed probe leaves
/// whatever was already recorded there untouched, rather than wiping it out
/// over one transient failure) — the returned, saved [`Workspace`] is the
/// source of truth the frontend renders from; `outcomes` additionally carries
/// per-host error messages for hosts the probe couldn't reach at all.
#[tauri::command]
pub async fn collect_facts(
    state: State<'_, AppState>,
    host_ids: Vec<HostId>,
) -> Result<CollectFactsResult, String> {
    let snapshot = Arc::new(state.workspace.lock_recover().clone());
    let outcomes = facts::collect(snapshot, host_ids, fleet::DEFAULT_CONCURRENCY).await;

    let workspace = {
        let mut workspace = state.workspace.lock_recover();
        let collected_at = now_ms();
        for outcome in &outcomes {
            if let Some(facts) = &outcome.facts
                && let Some(host) = workspace.hosts.iter_mut().find(|h| h.id == outcome.host_id)
            {
                host.last_facts = Some(facts.clone());
                host.last_facts_at_ms = Some(collected_at);
            }
        }
        store::save(&workspace).map_err(|e| e.to_string())?;
        workspace.clone()
    };

    Ok(CollectFactsResult { outcomes, workspace })
}
