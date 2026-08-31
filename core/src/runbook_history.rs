//! Les exécutions passées de runbooks — le pendant de [`crate::fleet_history`]
//! pour une procédure.
//!
//! **Un fichier à part, et c'est une décision, pas de la symétrie.** Une étape
//! est un run de flotte, donc tout enregistrer dans `fleet_history.json`
//! aurait « marché » — mais ce fichier plafonne à 50 runs : un runbook de huit
//! étapes lancé trois fois aurait chassé l'historique des vraies opérations de
//! flotte. Et une exécution de runbook n'est pas N runs indépendants : elle a
//! un ordre, un endroit où elle s'est arrêtée, et des cibles retirées en
//! route — trois choses qu'une liste plate de runs perd.

use crate::model::RunbookId;
use crate::runbook::{RunStatus, StepRecord};
use directories::ProjectDirs;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use uuid::Uuid;

const HISTORY_FILE: &str = "runbook_history.json";

/// Combien d'exécutions garder. Plus bas que les 50 runs de flotte : une
/// exécution porte *toutes* ses étapes, donc une entrée pèse ici ce que
/// plusieurs pèsent là-bas.
const MAX_RUNS: usize = 20;

/// Une exécution complète.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunbookRun {
    pub id: Uuid,
    /// Le runbook dont ça vient. Il peut avoir été supprimé ou modifié depuis :
    /// c'est pour ça que `name` et chaque `StepRecord::title` sont copiés ici
    /// plutôt que relus au moment de l'affichage — un rapport doit dire ce qui
    /// s'est passé, pas ce que la procédure dit aujourd'hui.
    pub runbook_id: RunbookId,
    pub name: String,
    pub started_at_ms: u64,
    pub duration_ms: u64,
    pub status: RunStatus,
    pub steps: Vec<StepRecord>,
}

fn history_path() -> anyhow::Result<PathBuf> {
    let dirs = ProjectDirs::from("dev", "gui-termius", "gui-termius")
        .ok_or_else(|| anyhow::anyhow!("impossible de déterminer le dossier de configuration"))?;
    Ok(dirs.config_dir().join(HISTORY_FILE))
}

pub fn load() -> anyhow::Result<Vec<RunbookRun>> {
    load_from(&history_path()?)
}

pub fn save(history: &[RunbookRun]) -> anyhow::Result<()> {
    save_to(&history_path()?, history)
}

fn load_from(path: &Path) -> anyhow::Result<Vec<RunbookRun>> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let raw = std::fs::read_to_string(path)?;
    Ok(serde_json::from_str(&raw)?)
}

fn save_to(path: &Path, history: &[RunbookRun]) -> anyhow::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let raw = serde_json::to_string_pretty(history)?;
    // Écriture atomique obligatoire : un fichier tronqué par un crash en cours
    // d'écriture serait refusé à la lecture suivante (fail-closed).
    crate::secure_file::write_private(path, raw.as_bytes())?;
    Ok(())
}

/// Ajoute `run` en tête (la liste est du plus récent au plus ancien) et
/// plafonne à [`MAX_RUNS`].
pub fn record(history: &mut Vec<RunbookRun>, run: RunbookRun) {
    history.insert(0, run);
    history.truncate(MAX_RUNS);
}

#[cfg(test)]
mod tests {
    use super::*;
use uuid::Uuid;

    fn sample(name: &str) -> RunbookRun {
        RunbookRun {
            id: Uuid::new_v4(),
            runbook_id: Uuid::new_v4(),
            name: name.to_string(),
            started_at_ms: 1_700_000_000_000,
            duration_ms: 1234,
            status: RunStatus::Completed,
            steps: Vec::new(),
        }
    }

    #[test]
    fn record_prepends_newest_first() {
        let mut history = Vec::new();
        record(&mut history, sample("premier"));
        record(&mut history, sample("second"));
        assert_eq!(history[0].name, "second");
    }

    #[test]
    fn record_caps_at_max_runs() {
        let mut history: Vec<RunbookRun> = (0..MAX_RUNS).map(|i| sample(&i.to_string())).collect();
        record(&mut history, sample("dernier"));
        assert_eq!(history.len(), MAX_RUNS);
        assert_eq!(history[0].name, "dernier");
    }

    #[test]
    fn save_then_load_roundtrips() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("runbook_history.json");
        let original = vec![sample("mise à jour")];
        save_to(&path, &original).unwrap();
        let back = load_from(&path).unwrap();
        assert_eq!(back.len(), 1);
        assert_eq!(back[0].name, "mise à jour");
        assert_eq!(back[0].status, RunStatus::Completed);
    }

    #[test]
    fn loading_a_missing_file_is_an_empty_history() {
        let dir = tempfile::tempdir().unwrap();
        assert!(load_from(&dir.path().join("absent.json")).unwrap().is_empty());
    }

}
