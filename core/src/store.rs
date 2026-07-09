//! Persistence of the non-secret workspace (hosts, groups, snippets, tunnels) to disk.
use crate::model::Workspace;
use directories::ProjectDirs;
use std::path::{Path, PathBuf};

fn project_dirs() -> anyhow::Result<ProjectDirs> {
    ProjectDirs::from("dev", "gui-termius", "gui-termius")
        .ok_or_else(|| anyhow::anyhow!("could not determine config directory"))
}

pub fn workspace_path() -> anyhow::Result<PathBuf> {
    let dirs = project_dirs()?;
    Ok(dirs.config_dir().join("workspace.json"))
}

pub fn load() -> anyhow::Result<Workspace> {
    load_from(&workspace_path()?)
}

pub fn save(workspace: &Workspace) -> anyhow::Result<()> {
    save_to(&workspace_path()?, workspace)
}

/// Result of a resilient load: either a clean read, or a recovery where the
/// on-disk file was unusable and had to be moved aside.
pub enum LoadOutcome {
    /// Read cleanly (or a fresh default because no file existed yet).
    Loaded(Workspace),
    /// The file was unreadable/corrupt and has been renamed to `backup`; the app
    /// starts with an empty workspace but the old data is preserved for recovery.
    Recovered { workspace: Workspace, backup: PathBuf },
}

/// Loads the workspace without ever silently discarding the user's data. A
/// corrupt or unreadable `workspace.json` is moved aside to a timestamped backup
/// rather than treated as "empty" — otherwise the next [`save`] would overwrite
/// the real file and the user's hosts would be gone for good.
pub fn load_resilient() -> anyhow::Result<LoadOutcome> {
    load_resilient_from(&workspace_path()?)
}

fn load_resilient_from(path: &Path) -> anyhow::Result<LoadOutcome> {
    match load_from(path) {
        Ok(workspace) => Ok(LoadOutcome::Loaded(workspace)),
        Err(err) => {
            // The file exists but couldn't be read/parsed. Preserve it before the
            // app can clobber it with a fresh save.
            let backup = backup_path(path);
            std::fs::rename(path, &backup).map_err(|rename_err| {
                anyhow::anyhow!(
                    "workspace.json est illisible ({err}) et n'a pas pu être mis de côté ({rename_err}) — \
                     démarrage annulé pour ne pas risquer d'écraser vos données"
                )
            })?;
            Ok(LoadOutcome::Recovered {
                workspace: Workspace::default(),
                backup,
            })
        }
    }
}

/// `<name>.corrupt-<unix_ts>.bak` next to the original, so successive recoveries
/// don't overwrite each other.
fn backup_path(path: &Path) -> PathBuf {
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let mut name = path
        .file_name()
        .map(|n| n.to_os_string())
        .unwrap_or_else(|| "workspace.json".into());
    name.push(format!(".corrupt-{ts}.bak"));
    path.with_file_name(name)
}

fn load_from(path: &Path) -> anyhow::Result<Workspace> {
    if !path.exists() {
        return Ok(Workspace::default());
    }
    let raw = std::fs::read_to_string(path)?;
    Ok(serde_json::from_str(&raw)?)
}

fn save_to(path: &Path, workspace: &Workspace) -> anyhow::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let raw = serde_json::to_string_pretty(workspace)?;
    // 0600 on Unix: workspace.json can embed private-key PEM content, so it must
    // not be world-readable like a default `std::fs::write` would leave it.
    crate::secure_file::write_private(path, raw.as_bytes())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Group, Host, Workspace};

    fn sample_workspace() -> Workspace {
        let mut ws = Workspace::default();
        ws.groups.push(Group { id: uuid::Uuid::new_v4(), name: "prod".into(), parent_id: None, icon: None, color: None });
        ws.hosts.push(Host::new("box", "example.com", "root"));
        ws
    }

    #[test]
    fn load_missing_file_returns_default_workspace() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("workspace.json");

        let ws = load_from(&path).unwrap();

        assert!(ws.hosts.is_empty());
        assert!(ws.groups.is_empty());
    }

    #[test]
    fn save_then_load_roundtrips_workspace() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("workspace.json");
        let original = sample_workspace();

        save_to(&path, &original).unwrap();
        let reloaded = load_from(&path).unwrap();

        assert_eq!(reloaded.hosts.len(), 1);
        assert_eq!(reloaded.hosts[0].label, "box");
        assert_eq!(reloaded.groups.len(), 1);
        assert_eq!(reloaded.groups[0].name, "prod");
    }

    #[test]
    fn save_creates_missing_parent_directories() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested").join("dir").join("workspace.json");

        save_to(&path, &Workspace::default()).unwrap();

        assert!(path.exists());
    }

    #[test]
    fn load_rejects_corrupted_json() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("workspace.json");
        std::fs::write(&path, "{ not valid json").unwrap();

        assert!(load_from(&path).is_err());
    }

    #[test]
    fn load_tolerates_old_workspace_missing_new_fields() {
        // Old workspace.json files predate the `keychain`/`custom_icons` fields;
        // both are `#[serde(default)]` so loading them must not fail.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("workspace.json");
        std::fs::write(&path, r#"{"groups":[],"hosts":[],"snippets":[],"portForwards":[]}"#).unwrap();

        let ws = load_from(&path).unwrap();

        assert!(ws.keychain.is_empty());
        assert!(ws.custom_icons.is_empty());
    }

    #[test]
    fn resilient_load_returns_default_when_file_is_missing() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("workspace.json");
        match load_resilient_from(&path).unwrap() {
            LoadOutcome::Loaded(ws) => assert!(ws.hosts.is_empty()),
            LoadOutcome::Recovered { .. } => panic!("a missing file is not corruption"),
        }
    }

    #[test]
    fn resilient_load_reads_a_valid_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("workspace.json");
        save_to(&path, &sample_workspace()).unwrap();
        match load_resilient_from(&path).unwrap() {
            LoadOutcome::Loaded(ws) => assert_eq!(ws.hosts.len(), 1),
            LoadOutcome::Recovered { .. } => panic!("a valid file must load cleanly"),
        }
    }

    #[test]
    fn resilient_load_backs_up_corrupt_file_instead_of_clobbering() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("workspace.json");
        std::fs::write(&path, "{ not valid json").unwrap();

        let LoadOutcome::Recovered { workspace, backup } = load_resilient_from(&path).unwrap()
        else {
            panic!("a corrupt file must be recovered, not silently loaded as empty");
        };

        assert!(workspace.hosts.is_empty());
        // Original moved aside (so a later save writes a fresh file, not over the
        // user's data) and its bytes preserved for recovery.
        assert!(!path.exists(), "corrupt file must be moved out of the way");
        assert_eq!(std::fs::read_to_string(&backup).unwrap(), "{ not valid json");
    }
}
