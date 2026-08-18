//! Persistence of past fleet runs — the audit trail that makes a run a
//! first-class, reviewable, re-runnable object rather than a fire-and-forget
//! action. Kept in its own `fleet_history.json` (config dir), separate from
//! `workspace.json`: this is a record of what happened, not configured state —
//! same reasoning as [`crate::command_history`].

use crate::fleet::{FleetTarget, HostOutcome};
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

/// One recorded fleet run: the command, its targets, and every target's result.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FleetRun {
    pub id: Uuid,
    /// Wall-clock start time, Unix epoch milliseconds (formatted by the UI).
    pub started_at_ms: u64,
    /// The literal command for a classic run; the natural-language intent
    /// for an adaptive run (see `per_host_commands` for what actually ran).
    pub command: String,
    pub targets: Vec<FleetTarget>,
    pub outcomes: Vec<HostOutcome>,
    /// Set only for an adaptive run: the actual per-host command dispatched
    /// (different hosts can run different commands, grouped by platform —
    /// see `crate::adaptive`, SSH-only, hence still keyed by `HostId` rather
    /// than `FleetTarget`). `None` for a classic run, where every target
    /// already ran the same `command`.
    #[serde(default)]
    pub per_host_commands: Option<HashMap<HostId, String>>,
    /// The DSL program this run came from, verbatim — what makes the run
    /// undoable.
    ///
    /// Neither of the fields above can stand in for it: `command` is the
    /// user's French intent and `per_host_commands` is rendered shell, and
    /// shell cannot be inverted — turning `apt-get install -y nginx` back into
    /// an *operation* means parsing every platform's package manager, which is
    /// exactly the job the DSL exists to avoid.
    ///
    /// `None` for a classic (free-command) run and for every run recorded
    /// before this field existed. Both are un-undoable, and the UI says so
    /// rather than offering a button that would do nothing.
    #[serde(default)]
    pub program_text: Option<String>,
    /// Each target's hostname as collected *before* the run, for the one
    /// operation whose inverse can't be derived from the operation alone
    /// (`set-hostname` — see `adaptive::inverse`).
    ///
    /// Deliberately not a general before-state snapshot: capturing file
    /// contents or package versions is a different machine, and a rollback
    /// that pretends to restore more than it can is worse than one that is
    /// honest about its scope.
    #[serde(default)]
    pub previous_hostnames: Option<HashMap<HostId, String>>,
}

/// Pre-`FleetTarget` on-disk shape (every run was SSH-only) — kept only to
/// migrate an existing `fleet_history.json` in place when loading; never
/// written again. `host_ids`/`host_id` were bare host UUIDs.
mod legacy {
    use super::*;

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct FleetRun {
        pub id: Uuid,
        pub started_at_ms: u64,
        pub command: String,
        pub host_ids: Vec<HostId>,
        pub outcomes: Vec<HostOutcome>,
        #[serde(default)]
        pub per_host_commands: Option<HashMap<HostId, String>>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct HostOutcome {
        pub host_id: HostId,
        pub exit_code: Option<i32>,
        pub stdout: String,
        pub stderr: String,
        pub duration_ms: u64,
        pub error: Option<String>,
    }

    impl From<HostOutcome> for super::HostOutcome {
        fn from(o: HostOutcome) -> Self {
            super::HostOutcome {
                target: FleetTarget::Ssh { host_id: o.host_id },
                exit_code: o.exit_code,
                stdout: o.stdout,
                stderr: o.stderr,
                duration_ms: o.duration_ms,
                error: o.error,
            }
        }
    }

    impl From<FleetRun> for super::FleetRun {
        fn from(r: FleetRun) -> Self {
            super::FleetRun {
                id: r.id,
                started_at_ms: r.started_at_ms,
                command: r.command,
                targets: r.host_ids.into_iter().map(|host_id| FleetTarget::Ssh { host_id }).collect(),
                outcomes: r.outcomes.into_iter().map(Into::into).collect(),
                per_host_commands: r.per_host_commands,
                // A run recorded before rollback existed: nothing said which
                // operations it performed, and guessing from the rendered
                // shell is exactly what the DSL exists to make unnecessary.
                program_text: None,
                previous_hostnames: None,
            }
        }
    }
}

/// On-disk shape written between `FleetTarget` being introduced and its
/// `rename_all_fields` fix (see `crate::fleet::FleetTarget`'s doc comment):
/// `targets`/`outcomes[].target` already had the right `"kind"` tag, but
/// `host_id`/`container_id` inside each variant were still snake_case on
/// the wire — `rename_all` on an internally-tagged enum only renames the
/// tag's *values*, never struct-variant field names. Kept only to migrate
/// an existing `fleet_history.json` written during that window; never
/// written again.
mod legacy_snake_case_target {
    use super::*;

    #[derive(Deserialize)]
    #[serde(tag = "kind", rename_all = "camelCase")]
    pub enum FleetTarget {
        Ssh { host_id: HostId },
        Docker { host_id: HostId, container_id: String },
        Local,
    }

    impl From<FleetTarget> for super::FleetTarget {
        fn from(t: FleetTarget) -> Self {
            match t {
                FleetTarget::Ssh { host_id } => super::FleetTarget::Ssh { host_id },
                FleetTarget::Docker { host_id, container_id } => super::FleetTarget::Docker { host_id, container_id },
                FleetTarget::Local => super::FleetTarget::Local,
            }
        }
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct HostOutcome {
        pub target: FleetTarget,
        pub exit_code: Option<i32>,
        pub stdout: String,
        pub stderr: String,
        pub duration_ms: u64,
        pub error: Option<String>,
    }

    impl From<HostOutcome> for super::HostOutcome {
        fn from(o: HostOutcome) -> Self {
            super::HostOutcome {
                target: o.target.into(),
                exit_code: o.exit_code,
                stdout: o.stdout,
                stderr: o.stderr,
                duration_ms: o.duration_ms,
                error: o.error,
            }
        }
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct FleetRun {
        pub id: Uuid,
        pub started_at_ms: u64,
        pub command: String,
        pub targets: Vec<FleetTarget>,
        pub outcomes: Vec<HostOutcome>,
        #[serde(default)]
        pub per_host_commands: Option<HashMap<HostId, String>>,
    }

    impl From<FleetRun> for super::FleetRun {
        fn from(r: FleetRun) -> Self {
            super::FleetRun {
                id: r.id,
                started_at_ms: r.started_at_ms,
                command: r.command,
                targets: r.targets.into_iter().map(Into::into).collect(),
                outcomes: r.outcomes.into_iter().map(Into::into).collect(),
                per_host_commands: r.per_host_commands,
                // Same as the older shape above: pre-dates rollback, so there
                // is nothing to undo it from.
                program_text: None,
                previous_hostnames: None,
            }
        }
    }
}

fn history_path() -> anyhow::Result<PathBuf> {
    let dirs = ProjectDirs::from("dev", "gui-termius", "gui-termius")
        .ok_or_else(|| anyhow::anyhow!("impossible de déterminer le dossier de configuration"))?;
    Ok(dirs.config_dir().join(HISTORY_FILE))
}

pub fn load() -> anyhow::Result<Vec<FleetRun>> {
    load_from(&history_path()?)
}

pub fn save(history: &[FleetRun]) -> anyhow::Result<()> {
    save_to(&history_path()?, history)
}

/// Tries the current shape first, then each progressively older on-disk
/// shape in turn — [`legacy_snake_case_target::FleetRun`] (`FleetTarget`
/// existed but its fields were still snake_case on the wire), then
/// [`legacy::FleetRun`] (before `FleetTarget` existed at all, bare
/// `hostIds`/`hostId` UUIDs). Each failure is a missing-field error, not
/// data corruption, so falling through is safe. The file itself is only
/// rewritten in the current shape the next time a run is recorded — same
/// one-way, load-time migration pattern as `store::resilient_load`.
fn load_from(path: &Path) -> anyhow::Result<Vec<FleetRun>> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let raw = std::fs::read_to_string(path)?;
    if let Ok(runs) = serde_json::from_str::<Vec<FleetRun>>(&raw) {
        return Ok(runs);
    }
    if let Ok(runs) = serde_json::from_str::<Vec<legacy_snake_case_target::FleetRun>>(&raw) {
        return Ok(runs.into_iter().map(Into::into).collect());
    }
    let legacy_runs: Vec<legacy::FleetRun> = serde_json::from_str(&raw)?;
    Ok(legacy_runs.into_iter().map(Into::into).collect())
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
            targets: vec![FleetTarget::Ssh { host_id: Uuid::new_v4() }],
            outcomes: Vec::new(),
            per_host_commands: None,
            program_text: None,
            previous_hostnames: None,
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

    #[test]
    fn load_migrates_a_snake_case_target_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("fleet_history.json");
        let host_id = Uuid::new_v4();
        let snake_case_json = format!(
            r#"[{{"id":"{}","startedAtMs":1700000000000,"command":"uptime","targets":[{{"kind":"ssh","host_id":"{host_id}"}}],"outcomes":[{{"target":{{"kind":"ssh","host_id":"{host_id}"}},"exitCode":0,"stdout":"up 1 day","stderr":"","durationMs":42,"error":null}}]}}]"#,
            Uuid::new_v4(),
        );
        std::fs::write(&path, snake_case_json).unwrap();

        let history = load_from(&path).unwrap();
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].targets, vec![FleetTarget::Ssh { host_id }]);
        assert_eq!(history[0].outcomes[0].target, FleetTarget::Ssh { host_id });
        assert_eq!(history[0].outcomes[0].stdout, "up 1 day");
    }

    #[test]
    fn load_migrates_a_pre_targets_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("fleet_history.json");
        let host_id = Uuid::new_v4();
        let legacy_json = format!(
            r#"[{{"id":"{}","startedAtMs":1700000000000,"command":"uptime","hostIds":["{host_id}"],"outcomes":[{{"hostId":"{host_id}","exitCode":0,"stdout":"up 1 day","stderr":"","durationMs":42,"error":null}}]}}]"#,
            Uuid::new_v4(),
        );
        std::fs::write(&path, legacy_json).unwrap();

        let history = load_from(&path).unwrap();
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].targets, vec![FleetTarget::Ssh { host_id }]);
        assert_eq!(history[0].outcomes.len(), 1);
        assert_eq!(history[0].outcomes[0].target, FleetTarget::Ssh { host_id });
        assert_eq!(history[0].outcomes[0].stdout, "up 1 day");
    }

    /// A history file written before rollback existed has to keep loading —
    /// this file holds the user's audit trail, and refusing it would empty the
    /// history panel on upgrade. The runs come back un-undoable, which is the
    /// honest answer: nothing recorded what operations they performed.
    #[test]
    fn a_history_written_before_rollback_still_loads_as_un_undoable() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("fleet_history.json");
        let host_id = Uuid::new_v4();
        let json = format!(
            r#"[{{"id":"{}","startedAtMs":1700000000000,"command":"installer nginx","targets":[{{"kind":"ssh","hostId":"{host_id}"}}],"outcomes":[],"perHostCommands":{{"{host_id}":"apt-get install -y nginx"}}}}]"#,
            Uuid::new_v4(),
        );
        std::fs::write(&path, json).unwrap();

        let history = load_from(&path).unwrap();
        assert_eq!(history.len(), 1, "l'historique existant ne doit pas disparaître");
        assert_eq!(history[0].program_text, None);
        assert_eq!(history[0].previous_hostnames, None);
        // The rendered shell survives — it is still worth showing, just not
        // enough to invert.
        assert!(history[0].per_host_commands.is_some());
    }

    /// And a run recorded now carries what a rollback needs.
    #[test]
    fn a_recorded_program_survives_a_save_and_reload() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("fleet_history.json");
        let host_id = Uuid::new_v4();
        let mut run = sample_run("installer nginx");
        run.targets = vec![FleetTarget::Ssh { host_id }];
        run.program_text = Some("install-package nginx".to_string());
        run.previous_hostnames = Some(HashMap::from([(host_id, "web-01".to_string())]));
        save_to(&path, &[run]).unwrap();

        let history = load_from(&path).unwrap();
        assert_eq!(history[0].program_text.as_deref(), Some("install-package nginx"));
        assert_eq!(
            history[0].previous_hostnames.as_ref().and_then(|m| m.get(&host_id)).map(String::as_str),
            Some("web-01")
        );
    }
}
