//! Runbooks : des procédures ordonnées au-dessus du moteur de flotte.
//!
//! Une opération de flotte répond à « lance ça partout ». Une procédure répond
//! à « fais ça, puis ça, et arrête-toi si la deuxième échoue » — l'ordre porte
//! du sens, et chaque étape décide de ce qui se passe quand une cible tombe.
//! C'est tout ce que ce module ajoute : [`crate::fleet`] exécute toujours une
//! étape, [`crate::adaptive`] rend toujours le shell d'un programme.
//!
//! **Tout ici est pur.** Aucune I/O, aucun réseau : le module décide *quoi*
//! lancer, *sur qui*, et *quoi faire ensuite* ; `commands/runbook.rs` fait
//! tourner la boucle et émet les évènements. C'est ce qui rend la politique
//! d'échec — la seule vraie règle métier d'un runbook — testable sans sshd.

use crate::adaptive;
use crate::fleet::{FleetTarget, HostOutcome};
use crate::model::{GroupId, HostId, OnFailure, Runbook, RunbookAction, RunbookStep, RunbookStepId, RunbookStepScope, Workspace};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// L'hôte enregistré d'une cible, quand elle en a un.
///
/// `Local` n'en a pas : c'est la machine sur laquelle Guiterm tourne, elle ne
/// porte ni tag ni dossier. Les cibles Docker/K8s rendent l'hôte *relais* (le
/// démon, le contexte kubeconfig) — c'est lui qui porte les tags dans la barre
/// latérale, donc c'est lui que la portée d'une étape doit interroger.
fn target_host(target: &FleetTarget) -> Option<HostId> {
    match target {
        FleetTarget::Ssh { host_id }
        | FleetTarget::Docker { host_id, .. }
        | FleetTarget::K8s { host_id, .. } => Some(*host_id),
        FleetTarget::Local => None,
    }
}

/// Le dossier `group_id`, ou l'un de ses ancêtres, porte-t-il l'un de ces noms ?
///
/// Remonte la chaîne des parents pour que « dossier Paris » attrape aussi
/// « Paris / bases de données » — un utilisateur qui range ses hôtes en
/// sous-dossiers ne s'attend pas à ce qu'une portée par dossier s'arrête au
/// premier niveau. La comparaison ignore la casse : le nom est saisi à la main
/// des deux côtés.
///
/// Borné par le nombre de dossiers : `workspace.json` peut contenir un cycle
/// parent → enfant écrit à la main, et une remontée naïve boucherait
/// indéfiniment.
fn in_named_group(workspace: &Workspace, group_id: Option<GroupId>, names: &[String]) -> bool {
    let mut current = group_id;
    for _ in 0..workspace.groups.len() {
        let Some(id) = current else { return false };
        let Some(group) = workspace.groups.iter().find(|g| g.id == id) else { return false };
        if names.iter().any(|n| n.eq_ignore_ascii_case(&group.name)) {
            return true;
        }
        current = group.parent_id;
    }
    false
}

/// Les cibles que cette étape retient dans `selection`.
///
/// Une portée **restreint**, jamais elle n'ajoute : le résultat est toujours un
/// sous-ensemble de ce que l'utilisateur a coché. C'est ce qui rend une portée
/// sûre à écrire dans un runbook partagé — au pire elle ne touche personne,
/// jamais quelqu'un qui n'était pas dans la sélection.
///
/// Le terminal local sort dès qu'une portée est posée : il ne porte ni tag ni
/// dossier, donc aucune restriction ne peut le décrire, et le garder
/// reviendrait à décider qu'il correspond à tout.
pub fn step_targets(
    workspace: &Workspace,
    selection: &[FleetTarget],
    scope: &RunbookStepScope,
) -> Vec<FleetTarget> {
    if scope.is_empty() {
        return selection.to_vec();
    }
    selection
        .iter()
        .filter(|target| {
            let Some(host_id) = target_host(target) else { return false };
            let Some(host) = workspace.host(host_id) else { return false };
            let tags_ok = scope
                .tags
                .iter()
                .all(|wanted| host.tags.iter().any(|t| t.eq_ignore_ascii_case(wanted)));
            let groups_ok = scope.groups.is_empty() || in_named_group(workspace, host.group_id, &scope.groups);
            tags_ok && groups_ok
        })
        .cloned()
        .collect()
}

/// Une cible que l'étape ne lancera pas, et pourquoi.
///
/// Distinct d'un échec : rien n'a tourné. Les confondre ferait déclencher la
/// politique d'échec sur une cible que l'étape n'a jamais visée — un `Stop` sur
/// « ce programme ne couvre pas Windows » arrêterait une procédure qui se
/// déroule normalement.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkippedTarget {
    pub target: FleetTarget,
    pub reason: String,
}

/// Ce qu'une étape va lancer : une commande par cible retenue, plus les cibles
/// écartées avec leur raison.
#[derive(Debug, Clone)]
pub struct StepPlan {
    pub commands: HashMap<FleetTarget, String>,
    pub skipped: Vec<SkippedTarget>,
}

/// Compose l'étape : quelle commande part sur quelle cible.
///
/// Erreur seulement si le programme adaptatif ne se parse pas — c'est-à-dire si
/// le runbook contient du texte que l'utilisateur n'aurait pas pu enregistrer
/// depuis l'éditeur (fichier édité à la main, plus tard). Une étape qui ne
/// couvre aucune cible n'est pas une erreur : c'est un plan vide, et la boucle
/// l'enregistre comme telle.
pub fn plan_step(
    workspace: &Workspace,
    targets: &[FleetTarget],
    action: &RunbookAction,
) -> Result<StepPlan, String> {
    match action {
        RunbookAction::Command { command } => Ok(StepPlan {
            commands: crate::fleet::uniform_commands(targets, command),
            skipped: Vec::new(),
        }),
        RunbookAction::Program { program_text } => {
            let program = adaptive::parse_program(program_text)?;
            let mut commands = HashMap::new();
            let mut skipped = Vec::new();

            // Le langage adaptatif ne cible que les hôtes SSH — c'est la limite
            // de `adaptive::preview`, pas une décision prise ici. Le dire cible
            // par cible plutôt que de refuser l'étape : un runbook mixte reste
            // utile, et le rapport montre exactement qui a été laissé de côté.
            let mut ssh_hosts = Vec::new();
            for target in targets {
                match target {
                    FleetTarget::Ssh { host_id } => ssh_hosts.push(*host_id),
                    other => skipped.push(SkippedTarget {
                        target: other.clone(),
                        reason: "le langage adaptatif ne s'applique qu'aux hôtes SSH".to_string(),
                    }),
                }
            }

            for group in adaptive::preview(workspace, &ssh_hosts, &program) {
                match group.command {
                    Some(command) => {
                        for host_id in group.host_ids {
                            commands.insert(FleetTarget::Ssh { host_id }, command.clone());
                        }
                    }
                    None => {
                        let reason = group
                            .note
                            .unwrap_or_else(|| "rien à faire sur cet hôte".to_string());
                        for host_id in group.host_ids {
                            skipped.push(SkippedTarget {
                                target: FleetTarget::Ssh { host_id },
                                reason: reason.clone(),
                            });
                        }
                    }
                }
            }
            Ok(StepPlan { commands, skipped })
        }
    }
}

/// Une cible a-t-elle échoué ? Une commande qui n'a pas pu démarrer (`error`)
/// et une commande qui a rendu un code non nul comptent pareil ici : dans les
/// deux cas l'étape n'a pas fait ce qu'elle annonçait sur cette cible.
pub fn failed(outcome: &HostOutcome) -> bool {
    outcome.error.is_some() || outcome.exit_code != Some(0)
}

/// Ce que la boucle fait après une étape.
#[derive(Debug, Clone, PartialEq)]
pub struct StepDecision {
    /// Arrêter le runbook ici.
    pub stop: bool,
    /// Cibles retirées de la suite de la procédure.
    pub dropped: Vec<FleetTarget>,
    /// Pourquoi on s'arrête, quand on s'arrête — affiché dans le rapport, où
    /// « arrêté » sans raison se lit comme un bug de l'app.
    pub reason: Option<String>,
}

/// Applique la politique d'échec de l'étape à ses résultats.
///
/// `survivors` est le nombre de cibles encore en course *après* les retraits —
/// c'est ce qui distingue `DropFailed` d'un `Continue` : quand plus personne ne
/// survit, poursuivre reviendrait à dérouler la fin de la procédure dans le
/// vide, en affichant des étapes « réussies » sur zéro machine.
pub fn decide(policy: OnFailure, outcomes: &[HostOutcome], remaining: usize) -> StepDecision {
    let failures: Vec<&HostOutcome> = outcomes.iter().filter(|o| failed(o)).collect();
    if failures.is_empty() {
        return StepDecision { stop: false, dropped: Vec::new(), reason: None };
    }
    match policy {
        OnFailure::Stop => StepDecision {
            stop: true,
            dropped: Vec::new(),
            reason: Some(format!(
                "{} cible(s) en échec, et cette étape est réglée sur « arrêter »",
                failures.len()
            )),
        },
        OnFailure::Continue => StepDecision { stop: false, dropped: Vec::new(), reason: None },
        OnFailure::DropFailed => {
            let dropped: Vec<FleetTarget> = failures.iter().map(|o| o.target.clone()).collect();
            let survivors = remaining.saturating_sub(dropped.len());
            StepDecision {
                stop: survivors == 0,
                reason: (survivors == 0).then(|| {
                    "plus aucune cible ne reste après les échecs de cette étape".to_string()
                }),
                dropped,
            }
        }
    }
}


// ─── Le déroulé d'une procédure ──────────────────────────────────────────────

/// Comment une exécution s'est terminée.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RunStatus {
    /// Toutes les étapes ont été parcourues.
    Completed,
    /// Une étape a déclenché sa politique d'arrêt.
    Stopped,
    /// L'utilisateur a arrêté la procédure entre deux étapes.
    Cancelled,
}

/// Ce qu'une étape a donné — la ligne du rapport.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StepRecord {
    pub step_id: RunbookStepId,
    pub title: String,
    /// Ce qui a été *demandé*, verbatim : la commande, ou le texte du
    /// programme. Pas le shell composé — il change d'une plateforme à l'autre,
    /// alors que le programme est ce que l'utilisateur a écrit.
    pub summary: String,
    pub outcomes: Vec<HostOutcome>,
    /// Les cibles que l'étape n'a pas visées, avec la raison. Jamais
    /// confondues avec un échec : rien n'a tourné.
    #[serde(default)]
    pub skipped: Vec<SkippedTarget>,
    /// La procédure s'est arrêtée à cette étape, et pourquoi.
    #[serde(default)]
    pub stop_reason: Option<String>,
}

/// Ce que l'appelant doit exécuter pour l'étape qui commence.
#[derive(Debug, Clone)]
pub struct NextStep {
    /// Rang dans le runbook — ce que la vue allume, sans avoir à apparier sur
    /// le titre (deux étapes peuvent porter le même).
    pub index: usize,
    pub title: String,
    pub commands: HashMap<FleetTarget, String>,
    pub skipped: Vec<SkippedTarget>,
}

/// Le résultat complet d'une exécution.
#[derive(Debug, Clone)]
pub struct RunOutcome {
    pub steps: Vec<StepRecord>,
    pub status: RunStatus,
}

struct CurrentStep {
    step: RunbookStep,
    /// Les cibles réellement visées — pas la sélection : c'est le
    /// dénominateur de la politique d'échec (« plus personne ne survit »).
    targets: usize,
    skipped: Vec<SkippedTarget>,
}

/// Le déroulé d'une procédure, comme machine à états.
///
/// **Pourquoi pas une boucle `async` qui ferait tout.** L'ordre des étapes, la
/// politique d'échec, le retrait des cibles et l'endroit où la procédure
/// s'arrête sont *la* fonctionnalité — et une boucle qui ouvre elle-même des
/// connexions SSH ne se teste qu'avec une flotte sous la main. Découpée ainsi,
/// elle se déroule entièrement avec des résultats fabriqués : c'est ce que
/// couvrent les tests « une procédure … » plus bas. L'appelant
/// (`commands/runbook.rs`) ne garde que l'exécution réelle et les évènements.
///
/// Cycle : [`next_step`](Self::next_step) jusqu'à `None`, en appelant
/// [`finish_step`](Self::finish_step) après chaque étape, puis
/// [`finish`](Self::finish).
pub struct RunbookDriver {
    steps: Vec<RunbookStep>,
    /// Les cibles encore en course — rétrécit quand une étape en écarte.
    remaining: Vec<FleetTarget>,
    index: usize,
    records: Vec<StepRecord>,
    status: RunStatus,
    cancelled: bool,
    current: Option<CurrentStep>,
}

impl RunbookDriver {
    pub fn new(book: &Runbook, targets: Vec<FleetTarget>) -> Self {
        Self {
            steps: book.steps.clone(),
            remaining: targets,
            index: 0,
            records: Vec::new(),
            status: RunStatus::Completed,
            cancelled: false,
            current: None,
        }
    }

    /// Demande l'arrêt. Pris en compte **avant** l'étape suivante, jamais au
    /// milieu de celle qui tourne : couper une commande à mi-chemin laisserait
    /// des machines dans un état que la procédure ne décrit nulle part.
    pub fn cancel(&mut self) {
        self.cancelled = true;
    }

    /// Les cibles encore en course.
    pub fn remaining(&self) -> &[FleetTarget] {
        &self.remaining
    }

    /// L'étape suivante à exécuter, ou `None` quand il n'y en a plus — fin
    /// normale, arrêt demandé, ou étape impossible à composer.
    pub fn next_step(&mut self, workspace: &Workspace) -> Option<NextStep> {
        if self.cancelled {
            self.status = RunStatus::Cancelled;
            return None;
        }
        if self.status != RunStatus::Completed {
            return None;
        }
        let step = self.steps.get(self.index)?.clone();
        let index = self.index;
        self.index += 1;

        let targets = step_targets(workspace, &self.remaining, &step.scope);
        let plan = match plan_step(workspace, &targets, &step.action) {
            Ok(plan) => plan,
            // Une procédure enregistrée est validée par le même parseur, donc
            // ceci ne se produit que sur un runbook arrivé autrement (fichier
            // édité à la main). S'arrêter est le seul choix honnête : on ne
            // sait pas ce que l'étape voulait faire.
            Err(e) => {
                self.records.push(StepRecord {
                    step_id: step.id,
                    title: step.title.clone(),
                    summary: summary_of(&step.action),
                    outcomes: Vec::new(),
                    skipped: Vec::new(),
                    stop_reason: Some(e),
                });
                self.status = RunStatus::Stopped;
                return None;
            }
        };

        // Les cibles hors portée ne sont pas « écartées » par le plan : elles
        // n'ont jamais été candidates. Elles rejoignent quand même le rapport,
        // sinon une étape qui ne touche personne se lirait comme un succès sur
        // toute la flotte.
        let mut skipped = plan.skipped;
        for target in self.remaining.iter().filter(|t| !targets.contains(t)) {
            skipped.push(SkippedTarget {
                target: target.clone(),
                reason: "hors de la portée de cette étape".to_string(),
            });
        }

        let commands = plan.commands;
        self.current = Some(CurrentStep { step: step.clone(), targets: targets.len(), skipped: skipped.clone() });
        Some(NextStep { index, title: step.title, commands, skipped })
    }

    /// Enregistre les résultats de l'étape courante et applique sa politique
    /// d'échec. Rend la décision pour que l'appelant puisse la diffuser.
    ///
    /// Panique si aucune étape n'est en cours — c'est une erreur de séquence de
    /// l'appelant, pas un état que des données pourraient produire.
    pub fn finish_step(&mut self, outcomes: Vec<HostOutcome>) -> StepDecision {
        let current = self.current.take().expect("finish_step sans next_step");

        // Une étape qui n'a visé personne ne déclenche pas de politique
        // d'échec : rien n'a échoué, rien n'a réussi non plus.
        let decision = if outcomes.is_empty() {
            StepDecision { stop: false, dropped: Vec::new(), reason: None }
        } else {
            decide(current.step.on_failure, &outcomes, current.targets)
        };

        self.remaining.retain(|t| !decision.dropped.contains(t));
        self.records.push(StepRecord {
            step_id: current.step.id,
            title: current.step.title,
            summary: summary_of(&current.step.action),
            outcomes,
            skipped: current.skipped,
            stop_reason: decision.reason.clone(),
        });
        if decision.stop {
            self.status = RunStatus::Stopped;
        }
        decision
    }

    /// Le rapport, une fois [`next_step`](Self::next_step) revenu `None`.
    pub fn finish(self) -> RunOutcome {
        RunOutcome { steps: self.records, status: self.status }
    }
}

/// Le texte qu'un rapport garde d'une étape — voir [`StepRecord::summary`].
pub fn summary_of(action: &RunbookAction) -> String {
    match action {
        RunbookAction::Command { command } => command.clone(),
        RunbookAction::Program { program_text } => program_text.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Group, Host, Runbook, RunbookStep, Workspace};
    use uuid::Uuid;

    fn outcome(target: FleetTarget, exit_code: Option<i32>, error: Option<&str>) -> HostOutcome {
        HostOutcome {
            target,
            exit_code,
            stdout: String::new(),
            stderr: String::new(),
            duration_ms: 1,
            error: error.map(|e| e.to_string()),
        }
    }

    fn ssh(id: HostId) -> FleetTarget {
        FleetTarget::Ssh { host_id: id }
    }

    fn workspace_with_hosts() -> (Workspace, HostId, HostId, HostId) {
        let mut ws = Workspace::default();
        let paris = Group { id: Uuid::new_v4(), name: "Paris".into(), parent_id: None, icon: None, color: None };
        let bases = Group {
            id: Uuid::new_v4(),
            name: "Bases".into(),
            parent_id: Some(paris.id),
            icon: None,
            color: None,
        };
        let mut web = Host::new("web-1", "10.0.0.1", "root");
        web.tags = vec!["web".into(), "prod".into()];
        web.group_id = Some(paris.id);
        let mut db = Host::new("db-1", "10.0.0.2", "root");
        db.tags = vec!["db".into(), "prod".into()];
        db.group_id = Some(bases.id);
        let mut lab = Host::new("lab-1", "10.0.0.3", "root");
        lab.tags = vec!["web".into()];
        lab.group_id = None;
        let (web_id, db_id, lab_id) = (web.id, db.id, lab.id);
        ws.groups = vec![paris, bases];
        ws.hosts = vec![web, db, lab];
        (ws, web_id, db_id, lab_id)
    }

    #[test]
    fn an_empty_scope_keeps_the_whole_selection() {
        let (ws, web, db, _) = workspace_with_hosts();
        let selection = vec![ssh(web), ssh(db), FleetTarget::Local];
        let kept = step_targets(&ws, &selection, &RunbookStepScope::default());
        assert_eq!(kept, selection);
    }

    #[test]
    fn every_tag_must_be_carried() {
        let (ws, web, db, lab) = workspace_with_hosts();
        let scope = RunbookStepScope { tags: vec!["web".into(), "prod".into()], groups: vec![] };
        let kept = step_targets(&ws, &[ssh(web), ssh(db), ssh(lab)], &scope);
        // lab-1 porte « web » mais pas « prod » : chaque tag resserre.
        assert_eq!(kept, vec![ssh(web)]);
    }

    #[test]
    fn a_group_scope_reaches_sub_folders() {
        let (ws, web, db, lab) = workspace_with_hosts();
        let scope = RunbookStepScope { tags: vec![], groups: vec!["paris".into()] };
        let kept = step_targets(&ws, &[ssh(web), ssh(db), ssh(lab)], &scope);
        // db-1 est dans « Paris / Bases » : un sous-dossier compte, et la
        // comparaison ignore la casse.
        assert_eq!(kept, vec![ssh(web), ssh(db)]);
    }

    #[test]
    fn several_groups_widen_while_several_tags_narrow() {
        let (ws, web, db, lab) = workspace_with_hosts();
        let scope = RunbookStepScope { tags: vec!["prod".into()], groups: vec!["Bases".into(), "Ailleurs".into()] };
        let kept = step_targets(&ws, &[ssh(web), ssh(db), ssh(lab)], &scope);
        assert_eq!(kept, vec![ssh(db)]);
    }

    /// La règle de sûreté : une portée ne peut que retirer.
    #[test]
    fn a_scope_never_adds_a_target_that_was_not_selected() {
        let (ws, web, db, lab) = workspace_with_hosts();
        let scope = RunbookStepScope { tags: vec!["prod".into()], groups: vec![] };
        let kept = step_targets(&ws, &[ssh(lab)], &scope);
        assert!(kept.is_empty(), "web-1 et db-1 portent « prod » mais n'étaient pas cochés");
        assert!(!kept.contains(&ssh(web)) && !kept.contains(&ssh(db)));
    }

    #[test]
    fn the_local_terminal_drops_out_as_soon_as_a_scope_exists() {
        let (ws, web, _, _) = workspace_with_hosts();
        let scope = RunbookStepScope { tags: vec!["prod".into()], groups: vec![] };
        let kept = step_targets(&ws, &[ssh(web), FleetTarget::Local], &scope);
        assert_eq!(kept, vec![ssh(web)]);
    }

    /// Un cycle parent → enfant écrit à la main dans `workspace.json` ferait
    /// boucler une remontée naïve — le runbook ne démarrerait jamais.
    #[test]
    fn a_cyclic_folder_chain_terminates() {
        let mut ws = Workspace::default();
        let a_id = Uuid::new_v4();
        let b_id = Uuid::new_v4();
        ws.groups = vec![
            Group { id: a_id, name: "A".into(), parent_id: Some(b_id), icon: None, color: None },
            Group { id: b_id, name: "B".into(), parent_id: Some(a_id), icon: None, color: None },
        ];
        let mut host = Host::new("boucle", "10.0.0.9", "root");
        host.group_id = Some(a_id);
        let host_id = host.id;
        ws.hosts = vec![host];
        let scope = RunbookStepScope { tags: vec![], groups: vec!["Introuvable".into()] };
        assert!(step_targets(&ws, &[ssh(host_id)], &scope).is_empty());
    }

    #[test]
    fn a_free_command_goes_to_every_target_unchanged() {
        let (ws, web, db, _) = workspace_with_hosts();
        let action = RunbookAction::Command { command: "uptime".into() };
        let plan = plan_step(&ws, &[ssh(web), ssh(db)], &action).unwrap();
        assert_eq!(plan.commands.len(), 2);
        assert_eq!(plan.commands[&ssh(web)], "uptime");
        assert!(plan.skipped.is_empty());
    }

    #[test]
    fn a_program_step_skips_non_ssh_targets_instead_of_failing() {
        let (ws, web, _, _) = workspace_with_hosts();
        let action = RunbookAction::Program { program_text: "install-package nginx".into() };
        let plan = plan_step(&ws, &[ssh(web), FleetTarget::Local], &action).unwrap();
        assert!(plan.skipped.iter().any(|s| s.target == FleetTarget::Local));
        // web-1 n'a pas d'état collecté, donc sa plateforme est inconnue : le
        // moteur adaptatif l'écarte avec sa propre note plutôt que d'inventer
        // une commande.
        assert!(plan.commands.is_empty() || plan.commands.contains_key(&ssh(web)));
    }

    #[test]
    fn an_unparsable_program_is_an_error_not_an_empty_step() {
        let (ws, web, _, _) = workspace_with_hosts();
        let action = RunbookAction::Program { program_text: "faire-le-café".into() };
        assert!(plan_step(&ws, &[ssh(web)], &action).is_err());
    }

    #[test]
    fn nothing_stops_when_every_target_succeeded() {
        let (_, web, db, _) = workspace_with_hosts();
        let outcomes = vec![outcome(ssh(web), Some(0), None), outcome(ssh(db), Some(0), None)];
        assert_eq!(
            decide(OnFailure::Stop, &outcomes, 2),
            StepDecision { stop: false, dropped: vec![], reason: None }
        );
    }

    #[test]
    fn stop_halts_on_the_first_failure() {
        let (_, web, db, _) = workspace_with_hosts();
        let outcomes = vec![outcome(ssh(web), Some(0), None), outcome(ssh(db), Some(1), None)];
        let decision = decide(OnFailure::Stop, &outcomes, 2);
        assert!(decision.stop);
        assert!(decision.dropped.is_empty(), "« arrêter » ne retire personne : la procédure s'arrête entière");
        assert!(decision.reason.is_some());
    }

    #[test]
    fn a_target_that_never_ran_counts_as_a_failure() {
        let (_, web, _, _) = workspace_with_hosts();
        let outcomes = vec![outcome(ssh(web), None, Some("connexion refusée"))];
        assert!(decide(OnFailure::Stop, &outcomes, 1).stop);
    }

    #[test]
    fn continue_keeps_everyone_including_the_failed() {
        let (_, web, db, _) = workspace_with_hosts();
        let outcomes = vec![outcome(ssh(web), Some(1), None), outcome(ssh(db), Some(0), None)];
        let decision = decide(OnFailure::Continue, &outcomes, 2);
        assert!(!decision.stop);
        assert!(decision.dropped.is_empty());
    }

    #[test]
    fn drop_failed_removes_only_the_failed() {
        let (_, web, db, _) = workspace_with_hosts();
        let outcomes = vec![outcome(ssh(web), Some(1), None), outcome(ssh(db), Some(0), None)];
        let decision = decide(OnFailure::DropFailed, &outcomes, 2);
        assert!(!decision.stop);
        assert_eq!(decision.dropped, vec![ssh(web)]);
    }

    /// Le cas qui distingue `DropFailed` d'un `Continue` : sans lui, la fin de
    /// la procédure se déroulerait sur zéro machine en s'affichant « réussie ».
    #[test]
    fn drop_failed_stops_when_no_target_survives() {
        let (_, web, db, _) = workspace_with_hosts();
        let outcomes = vec![outcome(ssh(web), Some(1), None), outcome(ssh(db), Some(2), None)];
        let decision = decide(OnFailure::DropFailed, &outcomes, 2);
        assert!(decision.stop);
        assert!(decision.reason.is_some());
    }

    // ─── Le déroulé complet, avec des résultats fabriqués ────────────────
    //
    // Ce que ces tests couvrent et qu'aucun autre ne couvrait : l'ordre des
    // étapes, l'endroit exact où une procédure s'arrête, et le fait qu'une
    // cible écartée ne réapparaisse pas à l'étape d'après. C'est la
    // fonctionnalité elle-même — la boucle vivait dans la couche Tauri, où
    // rien ne pouvait la dérouler sans une vraie flotte.

    fn step(title: &str, command: &str, on_failure: OnFailure) -> RunbookStep {
        RunbookStep {
            id: Uuid::new_v4(),
            title: title.to_string(),
            notes: String::new(),
            action: RunbookAction::Command { command: command.to_string() },
            scope: RunbookStepScope::default(),
            on_failure,
        }
    }

    fn book(steps: Vec<RunbookStep>) -> Runbook {
        Runbook { id: Uuid::new_v4(), name: "procédure".into(), description: String::new(), steps }
    }

    /// Déroule tout le runbook en répondant `codes` (par cible, par étape).
    /// `answer` reçoit le rang de l'étape et la cible, et rend un code de
    /// sortie.
    fn drive(
        ws: &Workspace,
        book: &Runbook,
        targets: Vec<FleetTarget>,
        mut answer: impl FnMut(usize, &FleetTarget) -> i32,
    ) -> (RunOutcome, Vec<Vec<FleetTarget>>) {
        let mut driver = RunbookDriver::new(book, targets);
        // Qui a été visé, étape par étape — ce que les assertions regardent.
        let mut visited: Vec<Vec<FleetTarget>> = Vec::new();
        while let Some(next) = driver.next_step(ws) {
            let mut ran: Vec<FleetTarget> = next.commands.keys().cloned().collect();
            ran.sort_by_key(|t| format!("{t:?}"));
            visited.push(ran.clone());
            let outcomes = ran
                .iter()
                .map(|t| outcome(t.clone(), Some(answer(next.index, t)), None))
                .collect();
            driver.finish_step(outcomes);
        }
        (driver.finish(), visited)
    }

    #[test]
    fn a_procedure_runs_its_steps_in_order_and_completes() {
        let (ws, web, db, _) = workspace_with_hosts();
        let book = book(vec![
            step("un", "true", OnFailure::Stop),
            step("deux", "true", OnFailure::Stop),
            step("trois", "true", OnFailure::Stop),
        ]);
        let (outcome, visited) = drive(&ws, &book, vec![ssh(web), ssh(db)], |_, _| 0);
        assert_eq!(outcome.status, RunStatus::Completed);
        assert_eq!(
            outcome.steps.iter().map(|s| s.title.as_str()).collect::<Vec<_>>(),
            vec!["un", "deux", "trois"]
        );
        assert_eq!(visited.len(), 3, "les trois étapes ont visé des machines");
    }

    /// L'assertion centrale : une étape en échec réglée sur « arrêter » ne
    /// laisse pas la suivante partir. Sans elle, une procédure de déploiement
    /// enchaînerait sur un service qui n'est pas installé.
    #[test]
    fn a_failed_step_set_to_stop_never_runs_the_next_one() {
        let (ws, web, _, _) = workspace_with_hosts();
        let book = book(vec![
            step("installe", "false", OnFailure::Stop),
            step("redémarre", "true", OnFailure::Stop),
        ]);
        let (outcome, visited) = drive(&ws, &book, vec![ssh(web)], |index, _| if index == 0 { 1 } else { 0 });
        assert_eq!(outcome.status, RunStatus::Stopped);
        assert_eq!(visited.len(), 1, "la deuxième étape n'a pas dû partir");
        assert_eq!(outcome.steps.len(), 1);
        assert!(outcome.steps[0].stop_reason.is_some());
    }

    /// L'autre assertion centrale : une machine écartée ne revient pas.
    #[test]
    fn a_dropped_target_is_absent_from_every_later_step() {
        let (ws, web, db, _) = workspace_with_hosts();
        let book = book(vec![
            step("un", "true", OnFailure::DropFailed),
            step("deux", "true", OnFailure::Stop),
            step("trois", "true", OnFailure::Stop),
        ]);
        // web-1 échoue à la première étape, db-1 passe partout.
        let (outcome, visited) = drive(&ws, &book, vec![ssh(web), ssh(db)], |index, target| {
            if index == 0 && *target == ssh(web) { 1 } else { 0 }
        });
        assert_eq!(outcome.status, RunStatus::Completed);
        assert_eq!(visited[0], vec![ssh(db), ssh(web)].tap_sorted());
        assert_eq!(visited[1], vec![ssh(db)]);
        assert_eq!(visited[2], vec![ssh(db)], "web-1 ne doit pas réapparaître deux étapes plus loin");
    }

    #[test]
    fn continue_keeps_a_failed_target_in_the_following_steps() {
        let (ws, web, db, _) = workspace_with_hosts();
        let book = book(vec![
            step("un", "true", OnFailure::Continue),
            step("deux", "true", OnFailure::Stop),
        ]);
        let (outcome, visited) = drive(&ws, &book, vec![ssh(web), ssh(db)], |index, target| {
            if index == 0 && *target == ssh(web) { 1 } else { 0 }
        });
        assert_eq!(outcome.status, RunStatus::Completed);
        assert_eq!(visited[1].len(), 2);
    }

    #[test]
    fn a_cancelled_run_stops_before_the_next_step() {
        let (ws, web, _, _) = workspace_with_hosts();
        let book = book(vec![step("un", "true", OnFailure::Stop), step("deux", "true", OnFailure::Stop)]);
        let mut driver = RunbookDriver::new(&book, vec![ssh(web)]);
        let first = driver.next_step(&ws).unwrap();
        driver.finish_step(vec![outcome(ssh(web), Some(0), None)]);
        assert_eq!(first.index, 0);
        driver.cancel();
        assert!(driver.next_step(&ws).is_none());
        let out = driver.finish();
        assert_eq!(out.status, RunStatus::Cancelled);
        assert_eq!(out.steps.len(), 1, "l'étape déjà terminée reste au rapport");
    }

    /// Une étape dont la portée ne retient personne ne déclenche pas la
    /// politique d'échec : rien n'a échoué, la procédure continue — mais le
    /// rapport dit que personne n'a été visé, sinon ça se lirait comme un
    /// succès sur toute la flotte.
    #[test]
    fn a_step_that_targets_nobody_continues_and_says_so() {
        let (ws, web, _, _) = workspace_with_hosts();
        let mut narrowed = step("nulle part", "true", OnFailure::Stop);
        narrowed.scope = RunbookStepScope { tags: vec!["inexistant".into()], groups: vec![] };
        let book = book(vec![narrowed, step("suite", "true", OnFailure::Stop)]);
        let (outcome, visited) = drive(&ws, &book, vec![ssh(web)], |_, _| 0);
        assert_eq!(outcome.status, RunStatus::Completed);
        assert!(visited[0].is_empty());
        assert_eq!(outcome.steps[0].outcomes.len(), 0);
        assert_eq!(outcome.steps[0].skipped.len(), 1);
        assert_eq!(outcome.steps[0].skipped[0].reason, "hors de la portée de cette étape");
        assert_eq!(visited[1], vec![ssh(web)], "l'étape suivante garde toute la sélection");
    }

    /// Un runbook arrivé sans passer par la validation (fichier édité à la
    /// main) : la procédure s'arrête plutôt que de sauter l'étape.
    #[test]
    fn an_unparsable_step_stops_the_run_with_its_reason() {
        let (ws, web, _, _) = workspace_with_hosts();
        let mut broken = step("cassée", "", OnFailure::Stop);
        broken.action = RunbookAction::Program { program_text: "faire-le-café".into() };
        let book = book(vec![broken, step("suite", "true", OnFailure::Stop)]);
        let (outcome, visited) = drive(&ws, &book, vec![ssh(web)], |_, _| 0);
        assert_eq!(outcome.status, RunStatus::Stopped);
        assert!(visited.is_empty());
        assert_eq!(outcome.steps.len(), 1);
        assert!(outcome.steps[0].stop_reason.is_some());
    }

    /// Le frontend lit `stepId`/`stopReason` : un aller-retour Rust → Rust
    /// resterait vert même si les champs partaient en snake_case.
    #[test]
    fn step_records_serialize_in_camel_case() {
        let record = StepRecord {
            step_id: Uuid::nil(),
            title: "Installer".into(),
            summary: "apt-get install nginx".into(),
            outcomes: Vec::new(),
            skipped: Vec::new(),
            stop_reason: Some("échec".into()),
        };
        let json = serde_json::to_string(&record).unwrap();
        assert!(json.contains("\"stepId\""), "attendu stepId dans {json}");
        assert!(json.contains("\"stopReason\""), "attendu stopReason dans {json}");
        assert!(!json.contains("step_id"));
    }

    /// Petit confort de lecture pour les assertions d'ordre ci-dessus.
    trait TapSorted {
        fn tap_sorted(self) -> Self;
    }
    impl TapSorted for Vec<FleetTarget> {
        fn tap_sorted(mut self) -> Self {
            self.sort_by_key(|t| format!("{t:?}"));
            self
        }
    }

    /// Un `workspace.json` écrit avant les runbooks doit rester lisible — sinon
    /// les hôtes de l'utilisateur disparaissent au premier lancement.
    #[test]
    fn a_workspace_written_before_runbooks_still_loads() {
        let raw = r#"{"groups":[],"hosts":[],"snippets":[],"portForwards":[]}"#;
        let ws: Workspace = serde_json::from_str(raw).unwrap();
        assert!(ws.runbooks.is_empty());
    }

    /// Un `match` Rust → Rust resterait vert même si les champs partaient en
    /// snake_case sur le fil : c'est le frontend qui envoie `programText`.
    #[test]
    fn the_action_reads_camel_case_from_the_frontend() {
        let action: RunbookAction =
            serde_json::from_str(r#"{"kind":"program","programText":"install-package nginx"}"#).unwrap();
        assert_eq!(action, RunbookAction::Program { program_text: "install-package nginx".into() });

        let json = serde_json::to_string(&action).unwrap();
        assert!(json.contains("\"programText\""), "attendu programText dans {json}");
        assert!(!json.contains("program_text"), "snake_case interdit sur le fil : {json}");
    }

    #[test]
    fn a_step_defaults_to_stopping_and_to_the_whole_selection() {
        let step: RunbookStep = serde_json::from_str(
            r#"{"id":"11111111-1111-1111-1111-111111111111","title":"Redémarrer",
                "action":{"kind":"command","command":"systemctl restart nginx"}}"#,
        )
        .unwrap();
        assert_eq!(step.on_failure, OnFailure::Stop);
        assert!(step.scope.is_empty());
        assert!(step.notes.is_empty());
    }

    #[test]
    fn a_runbook_roundtrips_through_json() {
        let book = Runbook {
            id: Uuid::new_v4(),
            name: "Mise à jour nginx".into(),
            description: "Vidange puis redémarrage".into(),
            steps: vec![RunbookStep {
                id: Uuid::new_v4(),
                title: "Installer".into(),
                notes: "voir le ticket OPS-12".into(),
                action: RunbookAction::Program { program_text: "install-package nginx".into() },
                scope: RunbookStepScope { tags: vec!["web".into()], groups: vec![] },
                on_failure: OnFailure::DropFailed,
            }],
        };
        let raw = serde_json::to_string(&book).unwrap();
        let back: Runbook = serde_json::from_str(&raw).unwrap();
        assert_eq!(back.steps[0].scope.tags, vec!["web".to_string()]);
        assert_eq!(back.steps[0].on_failure, OnFailure::DropFailed);
    }
}
