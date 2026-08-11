//! Le dernier « id de compte → nom » connu, gardé sur disque.
//!
//! Résoudre ces noms demande un appel `aws sso list-accounts` par session SSO,
//! donc un sous-processus CLI par session — plusieurs secondes, à chaque
//! ouverture d'un panneau AWS, pour une information qui ne bouge quasiment
//! jamais (un compte est renommé une fois dans sa vie, s'il l'est). Les trois
//! panneaux qui l'affichent attendaient ce cycle à chaque montage.
//!
//! Ce fichier existe pour que la réponse soit immédiate au montage suivant, y
//! compris hors ligne ou session expirée. L'appel réel n'est pas supprimé pour
//! autant : il repart en arrière-plan et remplace ce qui est affiché quand il
//! aboutit — voir `commands::aws_sso::{list_aws_account_names,
//! refresh_aws_account_names}`.
//!
//! **Lecture tolérante, contrairement aux fichiers de config.**
//! `store`/`known_hosts` refusent un fichier illisible (fail-closed) parce
//! qu'écrire par-dessus détruirait des données que l'utilisateur ne peut pas
//! recréer. Ici l'inverse : un cache corrompu ne coûte qu'un rafraîchissement,
//! alors que refuser de démarrer sur un cache abîmé casserait un panneau pour
//! une donnée purement cosmétique. On repart donc d'une table vide.
use directories::ProjectDirs;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

const FILE_NAME: &str = "aws_account_names.json";

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedAccountNames {
    /// Id de compte à douze chiffres → nom lisible.
    #[serde(default)]
    pub names: HashMap<String, String>,
    /// Epoch Unix en millisecondes du dernier rafraîchissement réussi.
    /// `None` pour un fichier écrit avant que ce champ existe.
    #[serde(default)]
    pub fetched_at_ms: Option<u64>,
}

fn cache_path() -> Option<PathBuf> {
    ProjectDirs::from("dev", "gui-termius", "gui-termius")
        .map(|dirs| dirs.config_dir().join(FILE_NAME))
}

/// Ce que le dernier rafraîchissement avait trouvé — table vide si le cache
/// n'existe pas encore, est illisible, ou si le dossier de config est
/// introuvable.
pub fn load() -> CachedAccountNames {
    let Some(path) = cache_path() else {
        return CachedAccountNames::default();
    };
    load_from(&path)
}

fn load_from(path: &Path) -> CachedAccountNames {
    let Ok(raw) = std::fs::read_to_string(path) else {
        return CachedAccountNames::default();
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

/// Remplace le cache. Une écriture qui échoue n'est jamais fatale : la seule
/// conséquence est que le prochain démarrage remettra quelques secondes à
/// afficher les noms.
pub fn save(names: &HashMap<String, String>) {
    let Some(path) = cache_path() else { return };
    let _ = save_to(&path, names, now_ms());
}

fn save_to(path: &Path, names: &HashMap<String, String>, at_ms: u64) -> anyhow::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let cached = CachedAccountNames {
        names: names.clone(),
        fetched_at_ms: Some(at_ms),
    };
    let raw = serde_json::to_string_pretty(&cached)?;
    // Même écriture atomique que le reste des fichiers de ce dossier : une
    // troncature interrompue laisserait un JSON à moitié écrit, que la lecture
    // tolérante ci-dessus effacerait silencieusement au lieu de le signaler.
    crate::secure_file::write_private(path, raw.as_bytes())?;
    Ok(())
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_file(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("guiterm-acct-cache-{name}-{}.json", std::process::id()))
    }

    #[test]
    fn missing_file_yields_empty_names() {
        let path = temp_file("missing");
        let _ = std::fs::remove_file(&path);
        assert_eq!(load_from(&path), CachedAccountNames::default());
    }

    #[test]
    fn save_then_load_roundtrips() {
        let path = temp_file("roundtrip");
        let mut names = HashMap::new();
        names.insert("123456789012".to_string(), "prod".to_string());
        names.insert("210987654321".to_string(), "staging".to_string());
        save_to(&path, &names, 1_700_000_000_000).unwrap();

        let loaded = load_from(&path);
        assert_eq!(loaded.names, names);
        assert_eq!(loaded.fetched_at_ms, Some(1_700_000_000_000));
        let _ = std::fs::remove_file(&path);
    }

    /// Un cache abîmé repart à vide au lieu de faire échouer l'appel — c'est
    /// tout l'écart assumé avec les lectures fail-closed de `store`.
    #[test]
    fn unreadable_cache_yields_empty_names_rather_than_failing() {
        let path = temp_file("corrupt");
        std::fs::write(&path, b"{ ceci n'est pas du json").unwrap();
        assert_eq!(load_from(&path), CachedAccountNames::default());
        let _ = std::fs::remove_file(&path);
    }

    /// Un fichier écrit avant l'ajout de `fetchedAtMs` doit rester lisible :
    /// sinon une mise à jour de l'app repartirait sur un cache vide.
    #[test]
    fn reads_a_file_written_without_the_timestamp_field() {
        let path = temp_file("legacy");
        std::fs::write(&path, br#"{"names":{"123456789012":"prod"}}"#).unwrap();
        let loaded = load_from(&path);
        assert_eq!(loaded.names.get("123456789012").map(String::as_str), Some("prod"));
        assert_eq!(loaded.fetched_at_ms, None);
        let _ = std::fs::remove_file(&path);
    }
}
