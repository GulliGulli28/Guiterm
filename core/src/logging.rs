//! Where the app's diagnostic log goes, and how much of it is kept.
//!
//! **Why a file at all.** `tracing_subscriber::fmt::init()` writes to stdout,
//! and the shipped Windows binary is built with
//! `#![windows_subsystem = "windows"]` — it has no console attached, so every
//! `tracing::error!` the app emits (a failed connection, a corrupt
//! `workspace.json` moved aside at startup, a sidecar that wouldn't spawn) is
//! written to a handle nobody can read. That is precisely the information
//! needed to answer "it won't connect and I don't know why", so it has to
//! survive somewhere the user can actually retrieve it.
//!
//! **Where.** Next to the other derived-state files (`fleet_history.json`,
//! the command histories) under the same `ProjectDirs`, in a `logs/`
//! subdirectory — not in `workspace.json`'s neighbourhood by accident: it's
//! diagnostic output, not user configuration, and [`directory`] is exposed so
//! the UI can point the user straight at it.
//!
//! **Retention.** One file per day, keeping the most recent
//! [`MAX_LOG_FILES`]. An SSH client can run for weeks; without a cap this
//! grows without bound on a machine the user never thinks about.
use directories::ProjectDirs;
use std::path::PathBuf;

/// Daily files kept before the oldest is deleted — roughly a working week of
/// history, which is the useful window for "it broke, what happened?" without
/// letting the directory grow forever.
const MAX_LOG_FILES: usize = 7;

const LOG_FILE_PREFIX: &str = "guiterm";

fn project_dirs() -> anyhow::Result<ProjectDirs> {
    ProjectDirs::from("dev", "gui-termius", "gui-termius")
        .ok_or_else(|| anyhow::anyhow!("impossible de déterminer le dossier de configuration"))
}

/// The directory log files are written to, created if missing. Exposed as a
/// command (`diagnostics_directory`) so the settings UI can show it and open
/// it in the OS file manager.
pub fn directory() -> anyhow::Result<PathBuf> {
    let dir = project_dirs()?.config_dir().join("logs");
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// Installs the global tracing subscriber, writing to both the daily log file
/// and stdout (the latter is what a `cargo run`/CI session actually reads;
/// it's simply ignored when there's no console).
///
/// Returns a guard that **must be held for the lifetime of the process**:
/// dropping it flushes and stops the background writer thread, so binding it
/// to `_` instead of a named variable would silently discard every log line.
///
/// Falls back to stdout-only if the log directory can't be created (a
/// read-only or unwritable profile) rather than failing startup — losing logs
/// is not a reason to refuse to run.
pub fn init() -> Option<tracing_appender::non_blocking::WorkerGuard> {
    use tracing_subscriber::layer::SubscriberExt;
    use tracing_subscriber::util::SubscriberInitExt;

    // `RUST_LOG` when set, otherwise `info` — quiet enough to leave on
    // permanently, detailed enough to be worth reading.
    let filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"));

    let Ok(dir) = directory() else {
        tracing_subscriber::registry().with(filter).with(tracing_subscriber::fmt::layer()).init();
        return None;
    };

    prune_old_logs(&dir);

    let appender = tracing_appender::rolling::daily(&dir, LOG_FILE_PREFIX);
    let (writer, guard) = tracing_appender::non_blocking(appender);

    tracing_subscriber::registry()
        .with(filter)
        // No ANSI escapes in the file — they'd be literal garbage in a text
        // editor, which is how a user will open this.
        .with(tracing_subscriber::fmt::layer().with_ansi(false).with_writer(writer))
        .with(tracing_subscriber::fmt::layer())
        .init();

    Some(guard)
}

/// Deletes all but the [`MAX_LOG_FILES`] most recent log files.
///
/// `tracing-appender`'s `daily` rotation has a `max_log_files` option of its
/// own, but it only prunes when it rotates — i.e. never, for an app opened
/// and closed within the same day, which is the normal usage pattern here.
/// Running this at startup instead means retention holds regardless of how
/// long any one session lasts.
fn prune_old_logs(dir: &std::path::Path) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    // The rotating appender names files `<prefix>.<YYYY-MM-DD>`, so a plain
    // lexicographic sort on the name is chronological — no need to stat each
    // file for its mtime.
    let mut logs: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.is_file()
                && p.file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| n.starts_with(LOG_FILE_PREFIX))
        })
        .collect();
    if logs.len() <= MAX_LOG_FILES {
        return;
    }
    logs.sort();
    let excess = logs.len() - MAX_LOG_FILES;
    for stale in logs.into_iter().take(excess) {
        let _ = std::fs::remove_file(stale);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn touch(dir: &std::path::Path, name: &str) {
        std::fs::write(dir.join(name), b"x").unwrap();
    }

    #[test]
    fn prune_keeps_only_the_most_recent_files() {
        let dir = tempfile::tempdir().unwrap();
        // Deliberately created out of order, to prove the sort (not creation
        // order) is what decides.
        for day in ["2026-07-20", "2026-07-26", "2026-07-19", "2026-07-21", "2026-07-24",
                    "2026-07-18", "2026-07-25", "2026-07-22", "2026-07-23"] {
            touch(dir.path(), &format!("{LOG_FILE_PREFIX}.{day}"));
        }

        prune_old_logs(dir.path());

        let mut left: Vec<String> = std::fs::read_dir(dir.path())
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        left.sort();
        assert_eq!(left.len(), MAX_LOG_FILES);
        assert_eq!(left.first().unwrap(), &format!("{LOG_FILE_PREFIX}.2026-07-20"));
        assert_eq!(left.last().unwrap(), &format!("{LOG_FILE_PREFIX}.2026-07-26"));
    }

    #[test]
    fn prune_leaves_unrelated_files_alone() {
        let dir = tempfile::tempdir().unwrap();
        for day in ["2026-07-18", "2026-07-19", "2026-07-20", "2026-07-21",
                    "2026-07-22", "2026-07-23", "2026-07-24", "2026-07-25"] {
            touch(dir.path(), &format!("{LOG_FILE_PREFIX}.{day}"));
        }
        touch(dir.path(), "notes.txt");

        prune_old_logs(dir.path());

        assert!(dir.path().join("notes.txt").exists(), "a non-log file must never be deleted");
    }

    #[test]
    fn prune_is_a_no_op_below_the_cap() {
        let dir = tempfile::tempdir().unwrap();
        touch(dir.path(), &format!("{LOG_FILE_PREFIX}.2026-07-26"));

        prune_old_logs(dir.path());

        assert!(dir.path().join(format!("{LOG_FILE_PREFIX}.2026-07-26")).exists());
    }
}
