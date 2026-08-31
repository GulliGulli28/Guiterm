//! L'exécution d'un runbook : la boucle qui déroule les étapes.
//!
//! Tout ce qui *décide* vit dans `termius_core::runbook` (quelles cibles, quelle
//! commande, quoi faire après un échec) et se teste sans sshd. Ce module fait
//! tourner la boucle, émet les évènements et enregistre le rapport — la même
//! séparation que `commands::fleet` face à `core::fleet`.

use crate::state::AppState;
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};
use termius_core::fleet::{self, FleetTarget, HostOutcome};
use termius_core::model::{Runbook, RunbookAction, RunbookId, Workspace};
use termius_core::runbook::{RunStatus, RunbookDriver, SkippedTarget};
use termius_core::runbook_history::{self, RunbookRun};
use termius_core::store;
use termius_core::sync_ext::MutexExt;

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Ce qu'une cible va lancer — une paire, pas une map : un `FleetTarget` est
/// une structure, donc illégal comme clé d'objet JSON.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TargetCommand {
    target: FleetTarget,
    command: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct StepStartedEvent {
    run_id: String,
    /// Rang de l'étape dans le runbook, pour que la vue sache quelle ligne
    /// allumer sans avoir à apparier sur le titre.
    step_index: usize,
    title: String,
    commands: Vec<TargetCommand>,
    skipped: Vec<SkippedTarget>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct StepOutcomeEvent {
    run_id: String,
    step_index: usize,
    outcome: HostOutcome,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct StepDoneEvent {
    run_id: String,
    step_index: usize,
    stop: bool,
    dropped: Vec<FleetTarget>,
    reason: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct RunDoneEvent {
    run_id: String,
    status: RunStatus,
}

/// Valide un runbook avant de l'écrire.
///
/// Un programme adaptatif est parsé ici, à l'enregistrement, avec le **même**
/// parseur que l'exécution — la discipline que le composeur adaptatif applique
/// déjà à ce que l'IA rédige. Une procédure enregistrée qui ne peut pas tourner
/// est pire qu'un refus : on ne le découvrirait qu'au milieu d'un incident.
fn validate(runbook: &Runbook) -> Result<(), String> {
    if runbook.name.trim().is_empty() {
        return Err("un runbook doit avoir un nom".to_string());
    }
    for (index, step) in runbook.steps.iter().enumerate() {
        if step.title.trim().is_empty() {
            return Err(format!("l'étape {} n'a pas de titre", index + 1));
        }
        match &step.action {
            RunbookAction::Command { command } if command.trim().is_empty() => {
                return Err(format!("l'étape « {} » n'a pas de commande", step.title));
            }
            RunbookAction::Program { program_text } => {
                termius_core::adaptive::parse_program(program_text)
                    .map_err(|e| format!("l'étape « {} » : {e}", step.title))?;
            }
            _ => {}
        }
    }
    Ok(())
}

/// Crée ou remplace un runbook (par son id) et rend l'espace de travail écrit.
#[tauri::command]
pub fn save_runbook(state: State<'_, AppState>, runbook: Runbook) -> Result<Workspace, String> {
    validate(&runbook)?;
    let mut workspace = state.workspace.lock_recover();
    match workspace.runbooks.iter_mut().find(|r| r.id == runbook.id) {
        Some(existing) => *existing = runbook,
        None => workspace.runbooks.push(runbook),
    }
    store::save(&workspace).map_err(|e| e.to_string())?;
    Ok(workspace.clone())
}

#[tauri::command]
pub fn delete_runbook(state: State<'_, AppState>, runbook_id: RunbookId) -> Result<Workspace, String> {
    let mut workspace = state.workspace.lock_recover();
    workspace.runbooks.retain(|r| r.id != runbook_id);
    store::save(&workspace).map_err(|e| e.to_string())?;
    Ok(workspace.clone())
}

/// Les exécutions passées, la plus récente en tête.
#[tauri::command]
pub fn get_runbook_history(state: State<'_, AppState>) -> Vec<RunbookRun> {
    state.runbook_history.lock_recover().clone()
}

/// Demande l'arrêt d'une exécution en cours.
///
/// Prend effet **entre deux étapes**, jamais au milieu de l'une : couper un
/// `apt-get` en cours de route laisserait des machines dans un état que la
/// procédure ne décrit nulle part, et que son rapport ne saurait pas nommer.
/// L'interface le dit plutôt que de laisser croire à un arrêt immédiat.
#[tauri::command]
pub fn cancel_runbook(state: State<'_, AppState>, run_id: String) -> Result<(), String> {
    match state.runbook_cancels.lock_recover().get(&run_id) {
        Some(flag) => {
            flag.store(true, Ordering::SeqCst);
            Ok(())
        }
        None => Err("cette exécution n'est plus en cours".to_string()),
    }
}

/// Déroule `runbook_id` sur `targets`.
///
/// `run_id` est frappé par le frontend, comme pour un run de flotte : c'est ce
/// qui permet de distinguer deux exécutions sur le même canal d'évènements.
/// La commande ne rend la main qu'une fois la procédure terminée.
#[tauri::command]
pub async fn run_runbook(
    app: AppHandle,
    state: State<'_, AppState>,
    run_id: String,
    runbook_id: RunbookId,
    targets: Vec<FleetTarget>,
) -> Result<(), String> {
    if targets.is_empty() {
        return Err("aucune cible sélectionnée".to_string());
    }
    // Instantané : la procédure voit un espace de travail cohérent même si
    // l'utilisateur édite un hôte pendant qu'elle tourne — même raison que
    // `commands::fleet::execute_and_record`.
    let workspace = Arc::new(state.workspace.lock_recover().clone());
    let book = workspace
        .runbooks
        .iter()
        .find(|r| r.id == runbook_id)
        .cloned()
        .ok_or_else(|| "ce runbook n'existe plus".to_string())?;

    let cancel = Arc::new(AtomicBool::new(false));
    state.runbook_cancels.lock_recover().insert(run_id.clone(), cancel.clone());

    let started_at_ms = now_ms();
    let started = std::time::Instant::now();

    // Tout ce qui décide — ordre, portée, politique d'échec, retrait des
    // cibles — vit dans `core::runbook::RunbookDriver`, où il se déroule sans
    // flotte sous la main. Il ne reste ici que l'exécution réelle et les
    // évènements.
    let mut driver = RunbookDriver::new(&book, targets);
    loop {
        if cancel.load(Ordering::SeqCst) {
            driver.cancel();
        }
        let Some(next) = driver.next_step(&workspace) else { break };

        let commands: Vec<TargetCommand> = next
            .commands
            .iter()
            .map(|(target, command)| TargetCommand { target: target.clone(), command: command.clone() })
            .collect();
        let _ = app.emit(
            "runbook-step-started",
            StepStartedEvent {
                run_id: run_id.clone(),
                step_index: next.index,
                title: next.title.clone(),
                commands,
                skipped: next.skipped.clone(),
            },
        );

        let mut outcomes: Vec<HostOutcome> = Vec::new();
        if !next.commands.is_empty() {
            let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<HostOutcome>();
            tokio::spawn(fleet::run_on_hosts(
                workspace.clone(),
                next.commands,
                fleet::DEFAULT_CONCURRENCY,
                tx,
            ));
            while let Some(outcome) = rx.recv().await {
                // La vue reçoit la sortie entière, le rapport la reçoit
                // tronquée — même partage que pour un run de flotte.
                outcomes.push(super::fleet::for_history(&outcome));
                let _ = app.emit(
                    "runbook-step-outcome",
                    StepOutcomeEvent { run_id: run_id.clone(), step_index: next.index, outcome },
                );
            }
        }

        let decision = driver.finish_step(outcomes);
        let _ = app.emit(
            "runbook-step-done",
            StepDoneEvent {
                run_id: run_id.clone(),
                step_index: next.index,
                stop: decision.stop,
                dropped: decision.dropped,
                reason: decision.reason,
            },
        );
    }

    let report = driver.finish();
    state.runbook_cancels.lock_recover().remove(&run_id);

    let run = RunbookRun {
        id: uuid::Uuid::new_v4(),
        runbook_id,
        name: book.name.clone(),
        started_at_ms,
        duration_ms: started.elapsed().as_millis() as u64,
        status: report.status,
        steps: report.steps,
    };
    {
        let mut history = state.runbook_history.lock_recover();
        runbook_history::record(&mut history, run);
        if let Err(e) = runbook_history::save(&history) {
            tracing::warn!("échec de l'enregistrement de l'historique de runbooks : {e}");
        }
    }
    let _ = app.emit("runbook-done", RunDoneEvent { run_id, status: report.status });
    Ok(())
}
