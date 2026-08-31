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
use termius_core::runbook::{ApprovalReason, RunStatus, RunbookDriver, SkippedTarget};
use termius_core::runbook_history::{self, RunbookRun};
use termius_core::store;
use termius_core::sync_ext::MutexExt;

/// Combien de temps une étape attend son approbation avant d'être **refusée**.
///
/// Refusée, jamais accordée : le sens du délai est la seule décision qui
/// compte ici. Une pause qui finirait par laisser passer l'étape parce que
/// personne ne regardait donnerait exactement la fausse assurance qu'elle est
/// censée retirer.
///
/// Plus long que les 180 s de l'authentification interactive, et pour une
/// raison précise : un OTP se lit sur un téléphone posé à côté, tandis
/// qu'approuver une étape veut souvent dire relire la sortie de la précédente,
/// ouvrir un tableau de bord, ou demander à quelqu'un.
const APPROVAL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(600);

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

/// Une étape attend l'accord de l'utilisateur avant de lancer quoi que ce soit.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ApprovalNeededEvent {
    run_id: String,
    /// Le rang de l'étape, qui sert aussi à apparier la réponse : une réponse
    /// tardive à l'étape précédente ne doit pas approuver celle-ci.
    step_index: usize,
    title: String,
    /// Le nom de la procédure — la demande peut s'afficher par-dessus un autre
    /// onglet, donc « approuver quoi, de quoi » doit tenir dans la boîte.
    runbook_name: String,
    reason: ApprovalReason,
    /// Ce qui partira si c'est approuvé, cible par cible.
    commands: Vec<TargetCommand>,
    /// Au bout de combien de secondes l'absence de réponse vaudra refus.
    timeout_secs: u64,
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
    let known = match state.runbook_cancels.lock_recover().get(&run_id) {
        Some(flag) => {
            flag.store(true, Ordering::SeqCst);
            true
        }
        None => false,
    };
    // Si l'exécution est justement arrêtée sur une demande d'approbation, le
    // drapeau seul ne la réveillerait pas : elle est parquée sur son canal, et
    // « Arrêter » resterait sans effet jusqu'au délai. On refuse à sa place.
    if let Some((_, sender)) = state.runbook_approvals.lock_recover().remove(&run_id) {
        let _ = sender.send(false);
    }
    if known { Ok(()) } else { Err("cette exécution n'est plus en cours".to_string()) }
}

/// Réponse de l'utilisateur à une demande d'approbation.
///
/// Une réponse qui ne correspond à aucune attente — ou qui vise une autre
/// étape que celle en cours — est ignorée sans rien dire, comme
/// `submit_ssh_auth_prompt` : elle appartient à une demande déjà expirée, et
/// il n'y a rien que l'utilisateur puisse y faire.
#[tauri::command]
pub fn answer_runbook_approval(
    state: State<'_, AppState>,
    run_id: String,
    step_index: usize,
    approved: bool,
) {
    let mut pending = state.runbook_approvals.lock_recover();
    let matches_step = pending.get(&run_id).is_some_and(|(index, _)| *index == step_index);
    if matches_step && let Some((_, sender)) = pending.remove(&run_id) {
        let _ = sender.send(approved);
    }
}

/// Attend l'accord pour cette étape. Rend `Err(raison)` sur un refus, un délai
/// dépassé, ou une fenêtre disparue — les trois se traitent pareil, et c'est
/// le point : tout ce qui n'est pas un « oui » explicite est un non.
async fn wait_for_approval(
    app: &AppHandle,
    state: &AppState,
    run_id: &str,
    cancel: &AtomicBool,
    event: ApprovalNeededEvent,
) -> Result<(), String> {
    let step_index = event.step_index;
    let (tx, rx) = tokio::sync::oneshot::channel::<bool>();
    state.runbook_approvals.lock_recover().insert(run_id.to_string(), (step_index, tx));

    if app.emit("runbook-approval-needed", event).is_err() {
        state.runbook_approvals.lock_recover().remove(run_id);
        return Err("impossible d'afficher la demande d'approbation".to_string());
    }

    match tokio::time::timeout(APPROVAL_TIMEOUT, rx).await {
        Ok(Ok(true)) => Ok(()),
        Ok(Ok(false)) => Err(if cancel.load(Ordering::SeqCst) {
            "exécution arrêtée pendant l'attente d'approbation".to_string()
        } else {
            "l'approbation a été refusée".to_string()
        }),
        // L'émetteur a été lâché : la fenêtre est partie, ou l'app s'arrête.
        Ok(Err(_)) => Err("la demande d'approbation a été abandonnée".to_string()),
        Err(_) => {
            // Plus personne ne répondra : libérer la place pour qu'une réponse
            // tardive ne débloque pas une étape déjà refusée.
            state.runbook_approvals.lock_recover().remove(run_id);
            Err(format!(
                "aucune réponse après {} minutes — refusée par défaut plutôt qu'accordée",
                APPROVAL_TIMEOUT.as_secs() / 60
            ))
        }
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
                commands: commands.clone(),
                skipped: next.skipped.clone(),
            },
        );

        // La pause d'approbation, **avant** que quoi que ce soit parte. Un
        // refus n'exécute rien et arrête la procédure : la suite suppose que
        // cette étape a eu lieu (voir `RunbookDriver::refuse_step`).
        if let Some(reason) = next.approval.clone()
            && let Err(refusal) = wait_for_approval(
                &app,
                &state,
                &run_id,
                &cancel,
                ApprovalNeededEvent {
                    run_id: run_id.clone(),
                    step_index: next.index,
                    title: next.title.clone(),
                    runbook_name: book.name.clone(),
                    reason,
                    commands,
                    timeout_secs: APPROVAL_TIMEOUT.as_secs(),
                },
            )
            .await
        {
            driver.refuse_step(refusal.clone());
            let _ = app.emit(
                "runbook-step-done",
                StepDoneEvent {
                    run_id: run_id.clone(),
                    step_index: next.index,
                    stop: true,
                    dropped: Vec::new(),
                    reason: Some(refusal),
                },
            );
            continue;
        }

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
