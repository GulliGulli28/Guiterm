//! An index of the session recordings this app has made.
//!
//! **Why an index at all.** A recording is an asciicast file written wherever
//! the user pointed the save dialog ([`crate::session_record`]) — which makes
//! it portable and playable by `asciinema`, and completely invisible to the
//! app the moment the dialog closes. So "I recorded that session last Tuesday"
//! had no answer: nothing knew a recording had ever been made, let alone on
//! which host. That gap is what makes this file exist, and it is the only
//! thing it does — the recordings themselves stay exactly where they are, in
//! their standard format, owned by the user.
//!
//! **Deliberately not a copy of the recording.** Only where it is, when it
//! started, and what it was recording. A recording can be gigabytes; the point
//! of the format is that it lives outside this app. An entry whose file the
//! user has since moved or deleted is kept and flagged rather than dropped:
//! "there was a recording here and it is gone" is a fact an audit trail should
//! state, not hide.

use directories::ProjectDirs;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

const INDEX_FILE: &str = "session_recordings.json";

/// How many recordings to remember. Each entry is a few hundred bytes, and
/// unlike a fleet run it carries no captured output — so this can be far more
/// generous than `fleet_history`'s cap of 50 without the file growing large.
const MAX_ENTRIES: usize = 500;

/// One recording that was started.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingEntry {
    /// Where the asciicast was written. Kept verbatim, including on a path
    /// the user has since moved: see [`Self::exists`].
    pub path: String,
    /// Unix epoch milliseconds when recording started.
    pub started_at_ms: u64,
    /// Unix epoch milliseconds when it was stopped cleanly — `None` for a
    /// recording still running, or one the app never got to close (a crash,
    /// a window closed mid-session). Both are worth telling apart from a
    /// completed one.
    #[serde(default)]
    pub stopped_at_ms: Option<u64>,
    /// The host label being recorded, or `None` for the local terminal.
    #[serde(default)]
    pub host: Option<String>,
}

impl RecordingEntry {
    /// Whether the recording is still where it was written. Checked at read
    /// time rather than stored: the user can move or delete the file at any
    /// point, and a flag written once would be a lie the next day.
    pub fn exists(&self) -> bool {
        Path::new(&self.path).exists()
    }
}

fn index_path() -> anyhow::Result<PathBuf> {
    let dirs = ProjectDirs::from("dev", "gui-termius", "gui-termius")
        .ok_or_else(|| anyhow::anyhow!("could not determine config directory"))?;
    Ok(dirs.config_dir().join(INDEX_FILE))
}

pub fn load() -> anyhow::Result<Vec<RecordingEntry>> {
    load_from(&index_path()?)
}

/// Appends a started recording. Returns nothing useful on purpose: failing to
/// index must never prevent the recording itself, so callers log and continue.
pub fn record_started(path: &str, started_at_ms: u64, host: Option<String>) -> anyhow::Result<()> {
    let file = index_path()?;
    let mut entries = load_from(&file).unwrap_or_default();
    entries.push(RecordingEntry { path: path.to_string(), started_at_ms, stopped_at_ms: None, host });
    if entries.len() > MAX_ENTRIES {
        let overflow = entries.len() - MAX_ENTRIES;
        entries.drain(0..overflow);
    }
    save_to(&file, &entries)
}

/// Marks the most recent unfinished recording of `path` as stopped.
///
/// Matched on the path rather than on an id: the recorder is keyed by terminal
/// session id, which is regenerated every run and would index nothing across
/// restarts. Most recent *unfinished*, so re-recording to the same path twice
/// closes the right one instead of reopening the older.
pub fn record_stopped(path: &str, stopped_at_ms: u64) -> anyhow::Result<()> {
    let file = index_path()?;
    let mut entries = load_from(&file).unwrap_or_default();
    if let Some(entry) = entries
        .iter_mut()
        .rev()
        .find(|e| e.path == path && e.stopped_at_ms.is_none())
    {
        entry.stopped_at_ms = Some(stopped_at_ms);
    }
    save_to(&file, &entries)
}

fn load_from(path: &Path) -> anyhow::Result<Vec<RecordingEntry>> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let raw = std::fs::read_to_string(path)?;
    Ok(serde_json::from_str(&raw)?)
}

fn save_to(path: &Path, entries: &[RecordingEntry]) -> anyhow::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let raw = serde_json::to_string_pretty(entries)?;
    crate::secure_file::write_private(path, raw.as_bytes())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(path: &str, started: u64) -> RecordingEntry {
        RecordingEntry { path: path.to_string(), started_at_ms: started, stopped_at_ms: None, host: None }
    }

    #[test]
    fn load_missing_index_returns_empty() {
        let dir = tempfile::tempdir().unwrap();
        assert!(load_from(&dir.path().join("absent.json")).unwrap().is_empty());
    }

    #[test]
    fn save_then_load_roundtrips() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("index.json");
        let original = vec![RecordingEntry {
            path: "/home/u/session.cast".to_string(),
            started_at_ms: 1_700_000_000_000,
            stopped_at_ms: Some(1_700_000_060_000),
            host: Some("web-01".to_string()),
        }];

        save_to(&file, &original).unwrap();

        assert_eq!(load_from(&file).unwrap(), original);
    }

    /// Stopping closes the *most recent unfinished* entry for that path.
    /// Recording twice to the same file is ordinary (an overwrite), and
    /// closing the older one would leave the live recording looking
    /// interrupted forever.
    #[test]
    fn stopping_closes_the_most_recent_unfinished_recording() {
        let mut entries = [entry("/tmp/a.cast", 100), entry("/tmp/a.cast", 200)];
        entries[0].stopped_at_ms = Some(150);

        if let Some(e) = entries.iter_mut().rev().find(|e| e.path == "/tmp/a.cast" && e.stopped_at_ms.is_none()) {
            e.stopped_at_ms = Some(300);
        }

        assert_eq!(entries[0].stopped_at_ms, Some(150), "the already-closed one is untouched");
        assert_eq!(entries[1].stopped_at_ms, Some(300));
    }

    /// A recording whose file has gone is reported as missing, not dropped —
    /// "there was a recording here and it is gone" is the fact an audit trail
    /// exists to state.
    #[test]
    fn a_moved_or_deleted_recording_is_flagged_rather_than_forgotten() {
        let dir = tempfile::tempdir().unwrap();
        let present = dir.path().join("kept.cast");
        std::fs::write(&present, "{}").unwrap();

        let kept = RecordingEntry { path: present.to_string_lossy().into_owned(), started_at_ms: 1, stopped_at_ms: None, host: None };
        let gone = entry(&dir.path().join("deleted.cast").to_string_lossy(), 2);

        assert!(kept.exists());
        assert!(!gone.exists());
    }
}
