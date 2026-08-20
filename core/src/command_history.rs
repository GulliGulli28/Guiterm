//! Persistence of command-history files. One file per source (local terminal,
//! SSH terminals, requêtes SQL) — kept separate since commands relevant on the
//! local machine rarely apply to a remote host and vice versa, et une requête
//! SQL n'a rien à faire dans les suggestions d'un shell.
//!
//! Rien ici ne suppose un shell : c'est ce qui a permis à l'historique SQL de
//! réutiliser ce module sans y toucher, déduplication comprise — rejouer une
//! requête la remonte au lieu d'en écrire une deuxième copie. Separate from
//! `workspace.json` too: this is behavioral/derived data, not part of the
//! user's configured workspace.
//!
//! **Two readers, one file, and that is the design.** Ghost-text wants a plain
//! list of commands, most-recent-last, deduplicated — that is what this was
//! built for and it is why [`record`] moves a repeat to the end rather than
//! appending a second copy. [`crate::activity`] wants *events*: when, and on
//! which host. Those two needs disagree (an event log would keep every repeat,
//! with its own timestamp), and the deduplicated list is the one already on
//! users' disks. So an entry carries the timestamp and host of its **most
//! recent** use, and the activity view says so rather than implying it lists
//! every invocation. Keeping both would mean writing every command twice.
//!
//! **The old shape was a bare `["ls -la", …]`**, with no timestamp and no
//! host. Those files exist on real disks and are read by [`legacy`] rather
//! than discarded — but a migrated entry has *no truthful date*, so its
//! `at_ms` stays `None` and the UI shows "date inconnue". Inventing a
//! timestamp (the migration's own clock, say) would make an audit log wrong in
//! exactly the place people read it.
use directories::ProjectDirs;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

const MAX_ENTRIES: usize = 1000;

/// One command, with what is known about the last time it was run.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandEntry {
    pub command: String,
    /// Unix epoch milliseconds of the most recent run — `None` for entries
    /// migrated from the pre-timestamp format, which genuinely have no date.
    #[serde(default)]
    pub at_ms: Option<u64>,
    /// Where this ran, as a **label** and jamais un id : le libellé de l'hôte
    /// pour l'historique SSH, celui de la connexion pour l'historique SQL
    /// (ajouté le 2026-08-18, qui réutilise ce module tel quel). `None` pour le
    /// terminal local — dont « l'hôte » est cette machine — et pour les entrées
    /// migrées de l'ancien format.
    #[serde(default)]
    pub host: Option<String>,
}

impl CommandEntry {
    pub fn new(command: impl Into<String>, at_ms: Option<u64>, host: Option<String>) -> Self {
        Self { command: command.into(), at_ms, host }
    }
}

/// The pre-timestamp on-disk shape: a bare array of strings. Read only to
/// migrate in place on load, never written again — same approach as
/// [`crate::fleet_history`]'s own `legacy` module.
mod legacy {
    use super::CommandEntry;

    /// Recognises the old shape and converts it, or reports that this isn't
    /// one. Tried *after* the current shape, so a current file is never
    /// reinterpreted.
    pub fn parse(raw: &str) -> Option<Vec<CommandEntry>> {
        let commands: Vec<String> = serde_json::from_str(raw).ok()?;
        Some(commands.into_iter().map(|c| CommandEntry::new(c, None, None)).collect())
    }
}

fn project_dirs() -> anyhow::Result<ProjectDirs> {
    ProjectDirs::from("dev", "gui-termius", "gui-termius")
        .ok_or_else(|| anyhow::anyhow!("impossible de déterminer le dossier de configuration"))
}

fn history_path(filename: &str) -> anyhow::Result<PathBuf> {
    let dirs = project_dirs()?;
    Ok(dirs.config_dir().join(filename))
}

pub fn load(filename: &str) -> anyhow::Result<Vec<CommandEntry>> {
    load_from(&history_path(filename)?)
}

pub fn save(filename: &str, history: &[CommandEntry]) -> anyhow::Result<()> {
    save_to(&history_path(filename)?, history)
}

/// Just the commands, oldest first — the shape ghost-text consumes.
///
/// Exists so the Tauri commands behind ghost-text keep returning exactly what
/// they always did: the suggestion engine never learns that entries grew
/// fields, and its tests keep testing the thing users see.
pub fn commands(history: &[CommandEntry]) -> Vec<String> {
    history.iter().map(|e| e.command.clone()).collect()
}

fn load_from(path: &Path) -> anyhow::Result<Vec<CommandEntry>> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let raw = std::fs::read_to_string(path)?;
    // Current shape first: an entry object never parses as a string, so
    // there is no ambiguity in this order — only in the other one.
    if let Ok(entries) = serde_json::from_str::<Vec<CommandEntry>>(&raw) {
        return Ok(entries);
    }
    if let Some(migrated) = legacy::parse(&raw) {
        return Ok(migrated);
    }
    // Deliberately an error rather than an empty history: silently starting
    // over would delete the user's suggestions on the next save.
    Err(anyhow::anyhow!("historique de commandes illisible : {}", path.display()))
}

fn save_to(path: &Path, history: &[CommandEntry]) -> anyhow::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let raw = serde_json::to_string_pretty(history)?;
    crate::secure_file::write_private(path, raw.as_bytes())?;
    Ok(())
}

/// Records a submitted command: trims it, drops it if empty, moves any
/// existing identical entry to the end (so the most recent use wins, and its
/// timestamp/host are refreshed to *this* run), and caps the list at
/// `MAX_ENTRIES` by dropping the oldest entries.
pub fn record(history: &mut Vec<CommandEntry>, command: &str, at_ms: u64, host: Option<String>) {
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return;
    }
    history.retain(|entry| entry.command != trimmed);
    history.push(CommandEntry::new(trimmed, Some(at_ms), host));
    if history.len() > MAX_ENTRIES {
        let overflow = history.len() - MAX_ENTRIES;
        history.drain(0..overflow);
    }
}

/// Milliseconds since the Unix epoch, for callers recording *now*.
pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn load_missing_file_returns_empty_history() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("history.json");

        let history = load_from(&path).unwrap();

        assert!(history.is_empty());
    }

    #[test]
    fn save_then_load_roundtrips_history() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("history.json");
        let original = vec![
            CommandEntry::new("ls -la", Some(1_700_000_000_000), None),
            CommandEntry::new("git status", Some(1_700_000_001_000), Some("web-01".to_string())),
        ];

        save_to(&path, &original).unwrap();
        let reloaded = load_from(&path).unwrap();

        assert_eq!(reloaded, original);
    }

    /// The migration, against the literal bytes a released version wrote. A
    /// Rust roundtrip would prove nothing about the shape actually on disk —
    /// and getting this wrong loses every ghost-text suggestion the user has
    /// accumulated.
    #[test]
    fn reads_the_pre_timestamp_bare_string_array() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("history.json");
        std::fs::write(&path, r#"["ls -la", "git status", "docker ps"]"#).unwrap();

        let history = load_from(&path).unwrap();

        assert_eq!(commands(&history), vec!["ls -la", "git status", "docker ps"]);
        assert!(
            history.iter().all(|e| e.at_ms.is_none() && e.host.is_none()),
            "a migrated entry has no truthful date or host — inventing one would make the journal lie"
        );
    }

    /// The order the two shapes are tried in. A current file must never be
    /// reinterpreted as legacy (it wouldn't parse, but the assertion pins the
    /// intent), and a migrated file must survive a save/load cycle.
    #[test]
    fn migrated_history_survives_being_saved_back() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("history.json");
        std::fs::write(&path, r#"["ls -la"]"#).unwrap();

        let mut history = load_from(&path).unwrap();
        record(&mut history, "git status", 1_700_000_000_000, Some("web-01".to_string()));
        save_to(&path, &history).unwrap();
        let reloaded = load_from(&path).unwrap();

        assert_eq!(commands(&reloaded), vec!["ls -la", "git status"]);
        assert_eq!(reloaded[0].at_ms, None, "the migrated entry stays dateless");
        assert_eq!(reloaded[1].at_ms, Some(1_700_000_000_000));
        assert_eq!(reloaded[1].host.as_deref(), Some("web-01"));
    }

    /// A file that is neither shape must fail loudly. Returning an empty
    /// history would look like a fresh install and be overwritten on the next
    /// save — the user's whole history gone, silently.
    #[test]
    fn an_unreadable_file_is_an_error_not_an_empty_history() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("history.json");
        std::fs::write(&path, "{ this is not json").unwrap();

        assert!(load_from(&path).is_err());
    }

    #[test]
    fn save_creates_missing_parent_directories() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested").join("dir").join("history.json");

        save_to(&path, &[]).unwrap();

        assert!(path.exists());
    }

    #[test]
    fn record_ignores_blank_commands() {
        let mut history = Vec::new();
        record(&mut history, "   ", 1, None);
        assert!(history.is_empty());
    }

    #[test]
    fn record_trims_whitespace() {
        let mut history = Vec::new();
        record(&mut history, "  ls -la  ", 1, None);
        assert_eq!(commands(&history), vec!["ls -la"]);
    }

    #[test]
    fn record_moves_duplicate_to_end_and_refreshes_its_metadata() {
        let mut history = vec![CommandEntry::new("a", Some(1), Some("old-host".to_string())), CommandEntry::new("b", Some(2), None)];
        record(&mut history, "a", 3, Some("new-host".to_string()));

        assert_eq!(commands(&history), vec!["b", "a"]);
        // The entry stands for the *most recent* use, so re-running it on
        // another host moves the host with it — see this module's docs.
        assert_eq!(history[1].at_ms, Some(3));
        assert_eq!(history[1].host.as_deref(), Some("new-host"));
    }

    #[test]
    fn record_caps_at_max_entries() {
        let mut history: Vec<CommandEntry> = (0..MAX_ENTRIES).map(|i| CommandEntry::new(i.to_string(), Some(i as u64), None)).collect();
        record(&mut history, "new", 9_999, None);
        assert_eq!(history.len(), MAX_ENTRIES);
        assert_eq!(history.first().unwrap().command, "1");
        assert_eq!(history.last().unwrap().command, "new");
    }
}
