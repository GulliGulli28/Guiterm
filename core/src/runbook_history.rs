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

use crate::fleet::FleetTarget;
use crate::model::RunbookId;
use crate::runbook::{failed, RunStatus, StepRecord};
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

// ─── Le rapport, sur papier ─────────────────────────────────────────────────

/// Une cellule de tableau markdown : le `|` d'un nom de conteneur casserait la
/// ligne en deux colonnes de plus.
fn cell(text: &str) -> String {
    text.replace('|', r"\|")
}

/// L'horodatage, en UTC.
///
/// UTC et pas l'heure locale, et c'est un choix : `time` refuse de lire le
/// décalage local dans un processus multithread (c'est unsound, et Guiterm en
/// est un), donc l'alternative honnête serait de faire formater la date par le
/// frontend et de la passer ici — de la présentation qui traverserait la
/// frontière. Un rapport collé dans un ticket a plus besoin d'être non ambigu
/// que d'être à l'heure du lecteur, d'où le suffixe `Z` bien visible.
fn timestamp(ms: u64) -> String {
    time::OffsetDateTime::from_unix_timestamp_nanos(i128::from(ms) * 1_000_000)
        .ok()
        .and_then(|t| t.format(&time::format_description::well_known::Rfc3339).ok())
        .unwrap_or_else(|| format!("{ms} ms depuis l'époque Unix"))
}

fn status_label(status: RunStatus) -> &'static str {
    match status {
        RunStatus::Completed => "terminée",
        RunStatus::Stopped => "arrêtée",
        RunStatus::Cancelled => "annulée",
    }
}

/// Le rapport d'une exécution, en markdown.
///
/// **Les sorties des machines qui ont réussi ne sont pas incluses**, seulement
/// celles qui ont échoué. Un rapport qui recopie le stdout de cinquante
/// machines n'est pas lu, et c'est le pire résultat possible pour un document
/// dont l'intérêt est d'être collé dans un ticket ou une revue d'incident. Le
/// document le dit lui-même plutôt que de laisser croire qu'il n'y avait rien
/// à montrer.
///
/// `label_of` vient de l'appelant parce que nommer une cible demande
/// l'espace de travail (et le listing Docker en direct), que ce module n'a pas
/// — et qu'un rapport doit rester lisible même pour une machine supprimée
/// depuis.
pub fn report_markdown(run: &RunbookRun, label_of: &dyn Fn(&FleetTarget) -> String) -> String {
    let mut out = String::new();
    out.push_str(&format!("# {}\n\n", run.name));
    out.push_str(&format!("- **Lancée le** {} (UTC)\n", timestamp(run.started_at_ms)));
    out.push_str(&format!("- **Durée** {:.1} s\n", run.duration_ms as f64 / 1000.0));
    out.push_str(&format!("- **Statut** {}\n", status_label(run.status)));
    out.push_str(&format!("- **Étapes exécutées** {}\n", run.steps.len()));

    if run.status != RunStatus::Completed {
        // Ce que le nombre d'étapes ne dit pas tout seul : la procédure ne
        // s'est pas déroulée entière, donc ce qui suit n'est pas la liste de ce
        // qui devait être fait.
        out.push_str(
            "\n> La procédure ne s'est pas déroulée jusqu'au bout : les étapes suivantes n'ont pas été lancées.\n",
        );
    }

    for (index, step) in run.steps.iter().enumerate() {
        out.push_str(&format!("\n## {}. {}\n\n", index + 1, step.title));
        out.push_str("```\n");
        out.push_str(step.summary.trim_end());
        out.push_str("\n```\n");

        if step.outcomes.is_empty() {
            out.push_str("\nAucune machine n'a exécuté cette étape.\n");
        } else {
            out.push_str("\n| Machine | Résultat | Durée |\n| --- | --- | --- |\n");
            for outcome in &step.outcomes {
                let verdict = match (&outcome.error, outcome.exit_code) {
                    (Some(e), _) => format!("non exécutée — {}", cell(e)),
                    (None, Some(0)) => "réussite".to_string(),
                    (None, Some(code)) => format!("échec (code {code})"),
                    (None, None) => "échec (code inconnu)".to_string(),
                };
                out.push_str(&format!(
                    "| {} | {} | {} ms |\n",
                    cell(&label_of(&outcome.target)),
                    verdict,
                    outcome.duration_ms
                ));
            }
        }

        if !step.skipped.is_empty() {
            out.push_str("\nNon visées :\n\n");
            for skipped in &step.skipped {
                out.push_str(&format!("- {} — {}\n", label_of(&skipped.target), skipped.reason));
            }
        }

        let failures: Vec<_> = step.outcomes.iter().filter(|o| failed(o)).collect();
        if !failures.is_empty() {
            out.push_str("\n<details><summary>Sorties des machines en échec</summary>\n\n");
            for outcome in failures {
                let body = outcome
                    .error
                    .clone()
                    .unwrap_or_else(|| format!("{}\n{}", outcome.stdout, outcome.stderr));
                out.push_str(&format!("**{}**\n\n```\n{}\n```\n\n", label_of(&outcome.target), body.trim()));
            }
            out.push_str("</details>\n");
        }

        if let Some(reason) = &step.stop_reason {
            out.push_str(&format!("\n**La procédure s'est arrêtée ici : {reason}.**\n"));
        }
    }
    out
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

    // ─── Le rapport en markdown ─────────────────────────────────────────

    use crate::fleet::HostOutcome;
    use crate::runbook::SkippedTarget;

    fn target(n: u8) -> FleetTarget {
        FleetTarget::Ssh { host_id: Uuid::from_u128(u128::from(n)) }
    }

    fn labeller(t: &FleetTarget) -> String {
        match t {
            FleetTarget::Ssh { host_id } => format!("hôte-{}", host_id.as_u128()),
            FleetTarget::Local => "Terminal local".to_string(),
            _ => "autre".to_string(),
        }
    }

    fn outcome(t: FleetTarget, exit_code: Option<i32>, stdout: &str, stderr: &str) -> HostOutcome {
        HostOutcome {
            target: t,
            exit_code,
            stdout: stdout.to_string(),
            stderr: stderr.to_string(),
            duration_ms: 42,
            error: None,
        }
    }

    fn run_with(steps: Vec<StepRecord>, status: RunStatus) -> RunbookRun {
        RunbookRun {
            id: Uuid::new_v4(),
            runbook_id: Uuid::new_v4(),
            name: "Mise à jour nginx".into(),
            // 2026-08-31T13:04:12Z — écrite en clair juste au-dessus de
            // l'assertion qui la relit, pour qu'une constante fausse se voie.
            started_at_ms: 1_788_181_452_000,
            duration_ms: 12_340,
            status,
            steps,
        }
    }

    fn step_record(title: &str, summary: &str, outcomes: Vec<HostOutcome>) -> StepRecord {
        StepRecord {
            step_id: Uuid::new_v4(),
            title: title.to_string(),
            summary: summary.to_string(),
            outcomes,
            skipped: Vec::new(),
            stop_reason: None,
        }
    }

    #[test]
    fn a_report_names_the_run_its_date_and_its_steps() {
        let run = run_with(
            vec![step_record("Installer", "install-package nginx", vec![outcome(target(1), Some(0), "", "")])],
            RunStatus::Completed,
        );
        let md = report_markdown(&run, &labeller);
        assert!(md.starts_with("# Mise à jour nginx\n"), "{md}");
        assert!(md.contains("2026-08-31T13:04:12Z"), "la date doit être lisible : {md}");
        assert!(md.contains("(UTC)"), "le fuseau doit être dit, sinon la date est ambiguë");
        assert!(md.contains("12.3 s"));
        assert!(md.contains("## 1. Installer"));
        assert!(md.contains("install-package nginx"));
        assert!(md.contains("| hôte-1 | réussite | 42 ms |"), "{md}");
    }

    /// La décision de tri du rapport : les sorties qui ont réussi ne sont pas
    /// recopiées. Un document qui déverse le stdout de cinquante machines
    /// n'est pas lu, et ne pas être lu est le pire résultat pour un rapport.
    #[test]
    fn only_failed_targets_get_their_output_in_the_report() {
        let run = run_with(
            vec![step_record(
                "Installer",
                "install-package nginx",
                vec![
                    outcome(target(1), Some(0), "TOUT-VA-BIEN", ""),
                    outcome(target(2), Some(1), "", "PAQUET-INTROUVABLE"),
                ],
            )],
            RunStatus::Completed,
        );
        let md = report_markdown(&run, &labeller);
        assert!(md.contains("PAQUET-INTROUVABLE"), "la sortie d un échec doit être là : {md}");
        assert!(!md.contains("TOUT-VA-BIEN"), "la sortie d une réussite ne doit pas l être : {md}");
        assert!(md.contains("Sorties des machines en échec"));
    }

    /// Le nombre d'étapes ne dit pas tout seul que la procédure s'est arrêtée
    /// en route — sans cette phrase, un rapport de deux étapes sur cinq se lit
    /// comme une procédure de deux étapes.
    #[test]
    fn a_run_that_stopped_says_the_rest_never_ran() {
        let mut stopped = step_record("Supprimer", "remove-user bob", Vec::new());
        stopped.stop_reason = Some("l'approbation a été refusée".into());
        let md = report_markdown(&run_with(vec![stopped], RunStatus::Stopped), &labeller);
        assert!(md.contains("Statut** arrêtée"));
        assert!(md.contains("n'ont pas été lancées"), "{md}");
        assert!(md.contains("l'approbation a été refusée"));
        assert!(md.contains("Aucune machine n'a exécuté cette étape."));
    }

    #[test]
    fn skipped_targets_are_listed_with_their_reason() {
        let mut step = step_record("Installer", "install-package nginx", vec![outcome(target(1), Some(0), "", "")]);
        step.skipped = vec![SkippedTarget {
            target: FleetTarget::Local,
            reason: "le langage adaptatif ne s'applique qu'aux hôtes SSH".into(),
        }];
        let md = report_markdown(&run_with(vec![step], RunStatus::Completed), &labeller);
        assert!(md.contains("Non visées :"));
        assert!(md.contains("Terminal local — le langage adaptatif"), "{md}");
    }

    /// Un `|` dans un nom de conteneur couperait la ligne en colonnes
    /// supplémentaires et décalerait tout le tableau.
    #[test]
    fn a_pipe_in_a_label_does_not_break_the_table() {
        let run = run_with(
            vec![step_record("Installer", "uptime", vec![outcome(FleetTarget::Local, Some(0), "", "")])],
            RunStatus::Completed,
        );
        let md = report_markdown(&run, &|_| "web|1".to_string());
        assert!(md.contains(r"| web\|1 | réussite |"), "{md}");
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
