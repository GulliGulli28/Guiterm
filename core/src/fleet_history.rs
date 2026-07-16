//! Persistence of past fleet runs — the audit trail that makes a run a
//! first-class, reviewable, re-runnable object rather than a fire-and-forget
//! action. Kept in its own `fleet_history.json` (config dir), separate from
//! `workspace.json`: this is a record of what happened, not configured state —
//! same reasoning as [`crate::command_history`].

use crate::fleet::HostOutcome;
use crate::model::HostId;
use directories::ProjectDirs;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use uuid::Uuid;

const HISTORY_FILE: &str = "fleet_history.json";
/// How many past runs to keep. Runs can be large (stdout/stderr per host), so
/// this is much smaller than the command-history cap.
const MAX_RUNS: usize = 50;

/// One recorded fleet run: the command, its targets, and every host's result.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FleetRun {
    pub id: Uuid,
    /// Wall-clock start time, Unix epoch milliseconds (formatted by the UI).
    pub started_at_ms: u64,
    /// The literal command for a classic run; the natural-language intent
    /// for an adaptive run (see `per_host_commands` for what actually ran).
    pub command: String,
    pub host_ids: Vec<HostId>,
    pub outcomes: Vec<HostOutcome>,
    /// Set only for an adaptive run: the actual per-host command dispatched
    /// (different hosts can run different commands, grouped by platform —
    /// see `crate::adaptive`). `None` for a classic run, where every host
    /// already ran the same `command`.
    #[serde(default)]
    pub per_host_commands: Option<HashMap<HostId, String>>,
}

fn history_path() -> anyhow::Result<PathBuf> {
    let dirs = ProjectDirs::from("dev", "gui-termius", "gui-termius")
        .ok_or_else(|| anyhow::anyhow!("could not determine config directory"))?;
    Ok(dirs.config_dir().join(HISTORY_FILE))
}

pub fn load() -> anyhow::Result<Vec<FleetRun>> {
    load_from(&history_path()?)
}

pub fn save(history: &[FleetRun]) -> anyhow::Result<()> {
    save_to(&history_path()?, history)
}

fn load_from(path: &Path) -> anyhow::Result<Vec<FleetRun>> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let raw = std::fs::read_to_string(path)?;
    Ok(serde_json::from_str(&raw)?)
}

fn save_to(path: &Path, history: &[FleetRun]) -> anyhow::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let raw = serde_json::to_string_pretty(history)?;
    crate::secure_file::write_private(path, raw.as_bytes())?;
    Ok(())
}

/// Prepends `run` (history is newest-first) and caps at `MAX_RUNS` by dropping
/// the oldest runs.
pub fn record(history: &mut Vec<FleetRun>, run: FleetRun) {
    history.insert(0, run);
    history.truncate(MAX_RUNS);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_run(command: &str) -> FleetRun {
        FleetRun {
            id: Uuid::new_v4(),
            started_at_ms: 1_700_000_000_000,
            command: command.to_string(),
            host_ids: vec![Uuid::new_v4()],
            outcomes: Vec::new(),
            per_host_commands: None,
        }
    }

    #[test]
    fn record_prepends_newest_first() {
        let mut history = Vec::new();
        record(&mut history, sample_run("first"));
        record(&mut history, sample_run("second"));
        assert_eq!(history[0].command, "second");
        assert_eq!(history[1].command, "first");
    }

    #[test]
    fn record_caps_at_max_runs() {
        let mut history: Vec<FleetRun> = (0..MAX_RUNS).map(|i| sample_run(&i.to_string())).collect();
        record(&mut history, sample_run("newest"));
        assert_eq!(history.len(), MAX_RUNS);
        assert_eq!(history.first().unwrap().command, "newest");
    }

    #[test]
    fn save_then_load_roundtrips() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("fleet_history.json");
        let original = vec![sample_run("uptime"), sample_run("free -m")];

        save_to(&path, &original).unwrap();
        let reloaded = load_from(&path).unwrap();

        assert_eq!(reloaded.len(), 2);
        assert_eq!(reloaded[0].command, "uptime");
        assert_eq!(reloaded[1].command, "free -m");
    }

    #[test]
    fn load_missing_file_returns_empty() {
        let dir = tempfile::tempdir().unwrap();
        let history = load_from(&dir.path().join("nope.json")).unwrap();
        assert!(history.is_empty());
    }
}
