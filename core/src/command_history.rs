//! Persistence of command-history files used by ghost-text suggestions.
//! One file per source (local terminal, SSH terminals) — kept separate
//! since commands relevant on the local machine rarely apply to a remote
//! host and vice versa. Separate from `workspace.json` too: this is
//! behavioral/derived data, not part of the user's configured workspace.
use directories::ProjectDirs;
use std::path::{Path, PathBuf};

const MAX_ENTRIES: usize = 1000;

fn project_dirs() -> anyhow::Result<ProjectDirs> {
    ProjectDirs::from("dev", "gui-termius", "gui-termius")
        .ok_or_else(|| anyhow::anyhow!("could not determine config directory"))
}

fn history_path(filename: &str) -> anyhow::Result<PathBuf> {
    let dirs = project_dirs()?;
    Ok(dirs.config_dir().join(filename))
}

pub fn load(filename: &str) -> anyhow::Result<Vec<String>> {
    load_from(&history_path(filename)?)
}

pub fn save(filename: &str, history: &[String]) -> anyhow::Result<()> {
    save_to(&history_path(filename)?, history)
}

fn load_from(path: &Path) -> anyhow::Result<Vec<String>> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let raw = std::fs::read_to_string(path)?;
    Ok(serde_json::from_str(&raw)?)
}

fn save_to(path: &Path, history: &[String]) -> anyhow::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let raw = serde_json::to_string_pretty(history)?;
    crate::secure_file::write_private(path, raw.as_bytes())?;
    Ok(())
}

/// Records a submitted command: trims it, drops it if empty, moves any
/// existing identical entry to the end (so the most recent use wins), and
/// caps the list at `MAX_ENTRIES` by dropping the oldest entries.
pub fn record(history: &mut Vec<String>, command: &str) {
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return;
    }
    history.retain(|entry| entry != trimmed);
    history.push(trimmed.to_string());
    if history.len() > MAX_ENTRIES {
        let overflow = history.len() - MAX_ENTRIES;
        history.drain(0..overflow);
    }
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
        let original = vec!["ls -la".to_string(), "git status".to_string()];

        save_to(&path, &original).unwrap();
        let reloaded = load_from(&path).unwrap();

        assert_eq!(reloaded, original);
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
        record(&mut history, "   ");
        assert!(history.is_empty());
    }

    #[test]
    fn record_trims_whitespace() {
        let mut history = Vec::new();
        record(&mut history, "  ls -la  ");
        assert_eq!(history, vec!["ls -la".to_string()]);
    }

    #[test]
    fn record_moves_duplicate_to_end() {
        let mut history = vec!["a".to_string(), "b".to_string()];
        record(&mut history, "a");
        assert_eq!(history, vec!["b".to_string(), "a".to_string()]);
    }

    #[test]
    fn record_caps_at_max_entries() {
        let mut history: Vec<String> = (0..MAX_ENTRIES).map(|i| i.to_string()).collect();
        record(&mut history, "new");
        assert_eq!(history.len(), MAX_ENTRIES);
        assert_eq!(history.first().unwrap(), "1");
        assert_eq!(history.last().unwrap(), "new");
    }
}
