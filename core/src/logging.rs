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
//!
//! **Panics get their own file.** See [`install_panic_hook`]: a panic is the
//! one event this daily log could not record, and the one most worth having.
use directories::ProjectDirs;
use std::path::PathBuf;

/// Daily files kept before the oldest is deleted — roughly a working week of
/// history, which is the useful window for "it broke, what happened?" without
/// letting the directory grow forever.
const MAX_LOG_FILES: usize = 7;

const LOG_FILE_PREFIX: &str = "guiterm";

/// Où les paniques sont consignées. Volontairement hors du préfixe
/// `guiterm` : [`prune_old_logs`] ne doit pas l'emporter avec les journaux
/// quotidiens — c'est justement le fichier qu'on veut encore trouver une
/// semaine plus tard.
const PANIC_FILE: &str = "panics.log";

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

/// Installe un crochet de panique qui consigne la panique dans le dossier de
/// journaux avant de laisser le crochet précédent s'exécuter.
///
/// **Pourquoi.** Sans lui, une panique ne laisse strictement aucune trace sur
/// le binaire livré. Le crochet par défaut écrit sur stderr, or le binaire
/// Windows est en `windows_subsystem = "windows"` : il n'a pas de console. Et
/// une panique sur le thread principal déroule jusqu'à sortir de `main`, donc
/// le processus se termine avec le code 101 — pas d'exception Windows, donc ni
/// rapport d'erreur, ni entrée dans le journal d'événements. Le résultat est
/// une application qui « s'arrête toute seule » sans rien laisser derrière
/// elle. Observé pour de vrai le 2026-08-27 : journal quotidien coupé net au
/// milieu d'une session, sans la ligne « arrêt de Guiterm demandé » que
/// `main` écrit sur une fermeture propre, et rien nulle part ailleurs.
///
/// À appeler depuis `main`, après [`init`] — le crochet écrit dans les deux
/// destinations, et la seconde n'existe qu'une fois l'abonné en place.
pub fn install_panic_hook() {
    install_panic_hook_in(directory().ok());
}

fn install_panic_hook_in(dir: Option<PathBuf>) {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let thread = std::thread::current();
        let name = thread.name().unwrap_or("<sans nom>").to_owned();
        let backtrace = std::backtrace::Backtrace::force_capture().to_string();
        let report = format_panic_report(&name, &info.to_string(), &backtrace);
        if let Some(dir) = &dir {
            append_panic_report(dir, &report);
        }
        // Également dans le journal quotidien, pour le cas où le processus
        // survit : une panique sur un thread de travail ne tue que ce thread
        // (`panic = "abort"` est volontairement désactivé, voir la raison dans
        // `Cargo.toml`), et la panique a alors sa place dans la chronologie.
        tracing::error!("{report}");
        previous(info);
    }));
}

/// L'horodatage est en UTC comme le reste du journal, et le pid permet de
/// recoller la panique à sa ligne de démarrage (`main` l'écrit).
fn format_panic_report(thread: &str, info: &str, backtrace: &str) -> String {
    let at = time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| "date indisponible".to_owned());
    format!(
        "{at} PANIQUE (pid {}) — thread « {thread} »\n{info}\n{backtrace}\n\n",
        std::process::id(),
    )
}

/// Écriture bloquante et directe, jamais via `tracing` : le journal quotidien
/// passe par `tracing_appender::non_blocking`, dont le thread d'écriture n'est
/// pas garanti d'être ordonnancé à nouveau quand c'est le thread principal qui
/// panique — la ligne serait perdue exactement dans le cas qu'on cherche à
/// diagnostiquer. Tout échec est avalé : un crochet de panique qui panique à
/// son tour ferait perdre jusqu'au message d'origine.
fn append_panic_report(dir: &std::path::Path, report: &str) {
    use std::io::Write;
    let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(dir.join(PANIC_FILE)) else {
        return;
    };
    let _ = file.write_all(report.as_bytes());
    let _ = file.flush();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn touch(dir: &std::path::Path, name: &str) {
        std::fs::write(dir.join(name), b"x").unwrap();
    }

    #[test]
    fn le_crochet_de_panique_consigne_la_panique_dans_un_fichier() {
        let dir = tempfile::tempdir().unwrap();
        install_panic_hook_in(Some(dir.path().to_path_buf()));

        // `catch_unwind` laisse le crochet s'exécuter (il tourne *avant* le
        // déroulement) puis rattrape la panique, donc le test survit à ce
        // qu'il provoque.
        let caught = std::panic::catch_unwind(|| panic!("boum de test"));
        assert!(caught.is_err());

        let written = std::fs::read_to_string(dir.path().join(PANIC_FILE)).unwrap();
        assert!(written.contains("PANIQUE"), "{written}");
        assert!(written.contains("boum de test"), "{written}");
        // La localisation vient du crochet par défaut via `Display` sur
        // l'info de panique : c'est elle qui nomme le fichier fautif.
        assert!(written.contains("logging.rs"), "{written}");
    }

    #[test]
    fn le_fichier_de_paniques_survit_a_la_purge_des_journaux() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(PANIC_FILE), b"une panique d il y a longtemps").unwrap();
        for day in ["2026-07-18", "2026-07-19", "2026-07-20", "2026-07-21", "2026-07-22",
                    "2026-07-23", "2026-07-24", "2026-07-25", "2026-07-26"] {
            touch(dir.path(), &format!("{LOG_FILE_PREFIX}.{day}"));
        }

        prune_old_logs(dir.path());

        assert!(dir.path().join(PANIC_FILE).exists(), "la purge a emporté le fichier de paniques");
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
