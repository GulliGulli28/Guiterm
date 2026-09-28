//! Les réglages de l'agent, propres à cette machine (`ssh_agent.json` dans le
//! dossier de configuration) : allumé ou non, et quelles clés du trousseau il
//! propose. Pas synchronisés : prêter ses clés aux programmes d'un poste est
//! une décision de ce poste.
use crate::model::KeyId;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSettings {
    /// Éteint par défaut : l'agent n'écoute que si on le demande.
    #[serde(default)]
    pub enabled: bool,
    /// Les clés proposées, cochées une à une (aucune par défaut).
    #[serde(default)]
    pub keys: Vec<KeyId>,
}

fn path() -> anyhow::Result<PathBuf> {
    let dirs = directories::ProjectDirs::from("dev", "gui-termius", "gui-termius")
        .ok_or_else(|| anyhow::anyhow!("impossible de déterminer le dossier de configuration"))?;
    Ok(dirs.config_dir().join("ssh_agent.json"))
}

/// Un fichier absent ou illisible vaut « éteint, aucune clé » : dans le
/// doute, l'agent ne prête rien.
pub fn load_at(p: &Path) -> AgentSettings {
    std::fs::read_to_string(p).ok().and_then(|raw| serde_json::from_str(&raw).ok()).unwrap_or_default()
}

pub fn save_at(p: &Path, settings: &AgentSettings) -> anyhow::Result<()> {
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent)?;
    }
    crate::secure_file::write_private(p, serde_json::to_string_pretty(settings)?.as_bytes())?;
    Ok(())
}

pub fn load() -> AgentSettings {
    path().map(|p| load_at(&p)).unwrap_or_default()
}

pub fn save(settings: &AgentSettings) -> anyhow::Result<()> {
    save_at(&path()?, settings)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_or_corrupt_means_off() {
        let dir = std::env::temp_dir().join(format!("guiterm-agent-settings-{}", uuid::Uuid::new_v4()));
        let p = dir.join("ssh_agent.json");
        assert_eq!(load_at(&p), AgentSettings::default());
        let s = AgentSettings { enabled: true, keys: vec![uuid::Uuid::new_v4()] };
        save_at(&p, &s).unwrap();
        assert_eq!(load_at(&p), s);
        std::fs::write(&p, "{pas du json").unwrap();
        assert!(!load_at(&p).enabled);
        let _ = std::fs::remove_dir_all(dir);
    }
}
