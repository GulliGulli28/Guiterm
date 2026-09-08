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
use crate::model::{Approval, GroupId, HostId, OnFailure, Runbook, RunbookAction, RunbookStep, RunbookStepId, RunbookStepScope, Workspace};
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
    /// Renseigné pour une étape playbook seulement — voir [`PlaybookRun`].
    pub playbook: Option<PlaybookRun>,
}

/// Ce qu'une étape playbook a résolu : où la commande part, et à qui rattacher
/// ce qu'elle rapportera.
///
/// Une étape playbook lance **une** commande, sur le relais — donc `commands`
/// n'a qu'une entrée. Sans ce complément, le rapport dirait « le playbook a
/// réussi » au lieu de dire ce qu'il a fait machine par machine, et la
/// politique d'échec s'appliquerait au relais plutôt qu'aux cibles : « continuer
/// sans les machines en échec » n'aurait plus aucun sens.
#[derive(Debug, Clone)]
pub struct PlaybookRun {
    /// L'hôte d'où `ansible-playbook` est lancé.
    pub relay: FleetTarget,
    /// Chaque cible retenue, avec son nom Ansible — la clé de lecture du
    /// `PLAY RECAP`, que l'appelant utilise pour fabriquer un résultat par
    /// machine.
    pub targets: Vec<(FleetTarget, String)>,
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
            playbook: None,
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
            Ok(StepPlan { commands, skipped, playbook: None })
        }

        RunbookAction::Playbook { relay_tag, playbook, inventory } => {
            // Le relais se résout parmi **tous** les hôtes enregistrés, pas
            // parmi les cibles : le nœud de contrôle n'est presque jamais une
            // des machines que le playbook configure.
            let mut relays = workspace.hosts.iter().filter(|h| {
                h.kind == crate::model::HostKind::Ssh
                    && h.tags.iter().any(|t| t.eq_ignore_ascii_case(relay_tag))
            });
            let relay = relays.next().ok_or_else(|| {
                format!("aucun hôte SSH ne porte le tag « {relay_tag} » : il désigne la machine d'où le playbook est joué")
            })?;
            if relays.next().is_some() {
                return Err(format!(
                    "plusieurs hôtes portent le tag « {relay_tag} » : impossible de savoir d'où jouer le playbook"
                ));
            }

            // Chaque cible doit avoir un nom Ansible pour entrer dans
            // `--limit`. Celles qui n'en ont pas sont écartées **nommément**
            // plutôt que silencieusement : un playbook qui s'appliquerait à
            // moins de machines que prévu sans le dire est pire qu'une étape
            // qui refuse.
            let mut limit = Vec::new();
            let mut pairs = Vec::new();
            let mut skipped = Vec::new();
            for target in targets {
                let FleetTarget::Ssh { host_id } = target else {
                    skipped.push(SkippedTarget {
                        target: target.clone(),
                        reason: "Ansible ne s'applique qu'aux hôtes SSH".to_string(),
                    });
                    continue;
                };
                let name = workspace.host(*host_id).and_then(crate::ansible_playbook::ansible_name);
                match name {
                    Some(name) => {
                        limit.push(name.to_string());
                        pairs.push((target.clone(), name.to_string()));
                    }
                    None => skipped.push(SkippedTarget {
                        target: target.clone(),
                        reason: "pas de nom Ansible : cet hôte n'a pas été importé depuis un inventaire".to_string(),
                    }),
                }
            }

            let inventory = (!inventory.trim().is_empty()).then_some(inventory.trim());
            let command = crate::ansible_playbook::build_command(playbook, inventory, &limit)?;
            let relay_target = FleetTarget::Ssh { host_id: relay.id };
            Ok(StepPlan {
                commands: HashMap::from([(relay_target.clone(), command)]),
                skipped,
                playbook: Some(PlaybookRun { relay: relay_target, targets: pairs }),
            })
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


// ─── La pause d'approbation ──────────────────────────────────────────────────

/// Une opération de l'étape qui ne pourra pas être défaite, et pourquoi.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IrreversibleOperation {
    /// La ligne du langage, telle que l'utilisateur l'écrirait
    /// ([`adaptive::render_operation`]) — pas le shell qu'elle produira, qui
    /// change d'une plateforme à l'autre et se lit beaucoup moins bien au
    /// moment de décider.
    pub operation: String,
    pub reason: String,
}

/// Les opérations de `action` que le langage adaptatif déclare irréversibles.
///
/// **Rien n'est jugé ici.** La table est [`adaptive::inverse`], un `match`
/// total sur la liste fermée des opérations du langage : ajouter une fonction
/// au DSL sans décider ce que veut dire l'annuler ne compile pas. C'est ce qui
/// permet à cette pause de ne pas avoir de liste de mots-clés à maintenir, et
/// c'est pour ça que la raison affichée est celle d'`inverse`, verbatim.
///
/// Une commande shell libre rend toujours une liste vide, et ce n'est pas un
/// trou qu'on comblerait avec de l'heuristique : décider si un `rm -rf` caché
/// dans un `sh -c` est destructeur, c'est interpréter du shell arbitraire.
/// L'étape le dit — la case « toujours demander » est là pour ça.
///
/// **Une étape playbook est dans le même cas**, et pour une raison plus forte
/// encore : le playbook n'est même pas ici, il vit sur le relais. Prétendre
/// juger ce qu'il fait demanderait de le lire à distance et d'interpréter
/// Ansible. Le réglage honnête pour ce type d'étape est « toujours demander ».
pub fn irreversible_operations(action: &RunbookAction) -> Vec<IrreversibleOperation> {
    let RunbookAction::Program { program_text } = action else { return Vec::new() };
    let Ok(program) = adaptive::parse_program(program_text) else { return Vec::new() };
    program
        .iter()
        .filter_map(|stmt| match adaptive::inverse(&stmt.operation, None) {
            adaptive::Reversibility::Irreversible { reason } => Some(IrreversibleOperation {
                operation: adaptive::render_operation(&stmt.operation),
                reason: reason.to_string(),
            }),
            _ => None,
        })
        .collect()
}

/// Pourquoi cette étape s'arrête pour demander.
///
/// Deux cas et pas un booléen : « ceci va supprimer un compte, voici pourquoi
/// c'est définitif » et « tu as demandé un point de contrôle ici » n'appellent
/// pas la même phrase, et les confondre apprendrait à cliquer « Approuver »
/// sans lire — ce qui viderait la pause de son seul intérêt.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ApprovalReason {
    /// L'étape porte des opérations sans retour.
    Irreversible { operations: Vec<IrreversibleOperation> },
    /// L'étape est réglée sur « toujours demander ».
    Requested,
}

/// Faut-il demander avant de lancer cette étape, et pour quelle raison.
///
/// `None` aussi quand l'étape ne lancera rien : demander l'accord pour une
/// étape qui ne vise personne apprend à approuver sans regarder.
pub fn approval_for(step: &RunbookStep, will_run: bool) -> Option<ApprovalReason> {
    if !will_run {
        return None;
    }
    let operations = irreversible_operations(&step.action);
    match step.approval {
        Approval::Never => None,
        // « Toujours » demande même quand tout est réversible — mais quand il
        // y a bien des opérations sans retour, c'est *elles* qu'il faut
        // montrer, pas un « vous avez demandé un point de contrôle » qui
        // tairait le vrai motif.
        Approval::Always => Some(if operations.is_empty() {
            ApprovalReason::Requested
        } else {
            ApprovalReason::Irreversible { operations }
        }),
        Approval::BeforeIrreversible => {
            if operations.is_empty() {
                None
            } else {
                Some(ApprovalReason::Irreversible { operations })
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
    /// Quand c'est `Some`, **rien ne doit partir** avant que l'utilisateur ait
    /// répondu : l'appelant demande, puis appelle [`RunbookDriver::finish_step`]
    /// s'il approuve, ou [`RunbookDriver::refuse_step`] sinon.
    pub approval: Option<ApprovalReason>,
    /// Renseigné pour une étape playbook : `commands` n'a alors qu'une entrée,
    /// celle du relais, et c'est ici que l'appelant trouve de quoi rattacher le
    /// `PLAY RECAP` à chaque machine.
    pub playbook: Option<PlaybookRun>,
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
        // L'ordre compte : une procédure déjà arrêtée (échec, ou étape
        // refusée) garde son statut. L'inverse ferait rapporter « annulée » une
        // exécution qui s'était arrêtée toute seule, en effaçant le pourquoi.
        if self.status != RunStatus::Completed {
            return None;
        }
        if self.cancelled {
            self.status = RunStatus::Cancelled;
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
        let playbook = plan.playbook;
        // « Va-t-elle lancer quelque chose » se lit sur les commandes, pas sur
        // les cibles : une étape en langage dont aucun hôte ne couvre la
        // plateforme a des cibles et zéro commande.
        let approval = approval_for(&step, !commands.is_empty());
        self.current = Some(CurrentStep { step: step.clone(), targets: targets.len(), skipped: skipped.clone() });
        Some(NextStep { index, title: step.title, commands, skipped, approval, playbook })
    }

    /// L'étape courante n'a pas été approuvée : elle n'a rien lancé, et la
    /// procédure s'arrête là.
    ///
    /// **S'arrêter, et non passer à la suivante** : une étape qu'on vient de
    /// refuser est une étape qui n'a pas eu lieu, or la suivante suppose
    /// qu'elle a eu lieu — c'est toute la raison d'être d'un ordre. Enchaîner
    /// serait le pire des deux mondes : avoir demandé, et continuer quand même.
    ///
    /// Panique si aucune étape n'est en cours, comme
    /// [`finish_step`](Self::finish_step) : c'est une erreur de séquence de
    /// l'appelant, pas un état que des données pourraient produire.
    pub fn refuse_step(&mut self, reason: String) {
        let current = self.current.take().expect("refuse_step sans next_step");
        self.records.push(StepRecord {
            step_id: current.step.id,
            title: current.step.title,
            summary: summary_of(&current.step.action),
            outcomes: Vec::new(),
            skipped: current.skipped,
            stop_reason: Some(reason),
        });
        self.status = RunStatus::Stopped;
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
        RunbookAction::Playbook { relay_tag, playbook, inventory } => {
            let mut summary = format!("ansible-playbook {playbook} (depuis un hôte « {relay_tag} »)");
            if !inventory.trim().is_empty() {
                summary.push_str(&format!(" avec l'inventaire {inventory}"));
            }
            summary
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Group, Host, HostFacts, Runbook, RunbookStep, Workspace};
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
        // Seul web-1 porte un état collecté, et c'est voulu : `adaptive` ne
        // compose une commande que pour une plateforme connue, donc un hôte
        // sans état est le cas « le programme ne sait pas quoi lancer ici ».
        // Avoir les deux dans la même fixture évite d'écrire des tests qui
        // passent parce que rien ne s'exécute.
        web.last_facts = Some(HostFacts { os_id: Some("debian".into()), ..Default::default() });
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
        // web-1 est connu comme Debian, donc il reçoit bien une commande : sans
        // cette moitié, le test passerait aussi si le plan était vide — c'est
        // à dire si le langage n'avait rien composé du tout.
        assert!(plan.commands[&ssh(web)].contains("nginx"), "{:?}", plan.commands);
    }

    /// L'autre moitié : un hôte sans état collecté est écarté avec la note du
    /// moteur adaptatif, jamais avec une commande inventée pour une plateforme
    /// qu'on ne connaît pas.
    #[test]
    fn a_program_step_skips_a_host_whose_platform_is_unknown() {
        let (ws, _, db, _) = workspace_with_hosts();
        let action = RunbookAction::Program { program_text: "install-package nginx".into() };
        let plan = plan_step(&ws, &[ssh(db)], &action).unwrap();
        assert!(plan.commands.is_empty());
        assert_eq!(plan.skipped.len(), 1);
        assert_eq!(plan.skipped[0].target, ssh(db));
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
            // Les tests de déroulé portent sur l'ordre et la politique
            // d'échec : une pause d'approbation y ajouterait un aller-retour
            // qui n'est pas leur sujet (il a le sien, plus bas).
            approval: Approval::Never,
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

    // ─── La pause d'approbation ─────────────────────────────────────────

    fn program_step(title: &str, program: &str, approval: Approval) -> RunbookStep {
        RunbookStep {
            id: Uuid::new_v4(),
            title: title.to_string(),
            notes: String::new(),
            action: RunbookAction::Program { program_text: program.to_string() },
            scope: RunbookStepScope::default(),
            on_failure: OnFailure::Stop,
            approval,
        }
    }

    /// La table d'irréversibilité n'est pas recopiée ici : elle vient
    /// d'`adaptive::inverse`, et sa raison est relayée verbatim.
    #[test]
    fn an_irreversible_operation_is_named_with_the_reason_from_the_dsl() {
        let ops = irreversible_operations(&RunbookAction::Program {
            program_text: "remove-user bob".into(),
        });
        assert_eq!(ops.len(), 1);
        assert_eq!(ops[0].operation, "remove-user bob");
        assert!(ops[0].reason.contains("dossier personnel"), "raison inattendue : {}", ops[0].reason);
    }

    #[test]
    fn a_reversible_program_has_nothing_irreversible() {
        let ops = irreversible_operations(&RunbookAction::Program {
            program_text: "install-package nginx".into(),
        });
        assert!(ops.is_empty());
    }

    /// Le trou assumé, écrit noir sur blanc : du shell arbitraire est
    /// indécidable, et deviner avec des mots-clés donnerait une fausse
    /// assurance — pire que pas d'assurance du tout.
    #[test]
    fn a_free_command_is_never_judged_however_destructive_it_looks() {
        let ops = irreversible_operations(&RunbookAction::Command {
            command: "rm -rf /var/lib/postgresql".into(),
        });
        assert!(ops.is_empty());
    }

    #[test]
    fn the_default_asks_before_an_irreversible_step_and_stays_quiet_otherwise() {
        let destructive = program_step("supprimer", "remove-user bob", Approval::default());
        assert!(matches!(
            approval_for(&destructive, true),
            Some(ApprovalReason::Irreversible { .. })
        ));

        let harmless = program_step("installer", "install-package nginx", Approval::default());
        assert_eq!(approval_for(&harmless, true), None);
    }

    #[test]
    fn never_asks_nothing_even_when_the_step_is_irreversible() {
        let step = program_step("supprimer", "remove-user bob", Approval::Never);
        assert_eq!(approval_for(&step, true), None);
    }

    /// « Toujours » demande sur une étape réversible — mais quand il y a bien
    /// des opérations sans retour, ce sont elles qu'on montre : taire le vrai
    /// motif derrière « vous avez demandé un point de contrôle » serait pire
    /// que ne rien demander.
    #[test]
    fn always_asks_and_still_names_the_irreversible_operations() {
        let harmless = program_step("bascule", "install-package nginx", Approval::Always);
        assert_eq!(approval_for(&harmless, true), Some(ApprovalReason::Requested));

        let destructive = program_step("bascule", "remove-user bob", Approval::Always);
        assert!(matches!(
            approval_for(&destructive, true),
            Some(ApprovalReason::Irreversible { .. })
        ));
    }

    /// Demander l'accord pour une étape qui ne lancera rien apprend à cliquer
    /// « Approuver » sans regarder — exactement ce que cette pause doit éviter.
    #[test]
    fn a_step_that_will_run_nothing_never_asks() {
        let step = program_step("supprimer", "remove-user bob", Approval::Always);
        assert_eq!(approval_for(&step, false), None);
    }

    /// L'assertion qui compte : refuser n'exécute rien **et** n'enchaîne pas.
    /// Enchaîner serait le pire des deux mondes — avoir demandé, et continuer
    /// quand même.
    #[test]
    fn refusing_a_step_runs_nothing_and_stops_the_procedure() {
        let (ws, web, _, _) = workspace_with_hosts();
        let book = book(vec![
            program_step("supprimer bob", "remove-user bob", Approval::default()),
            step("suite", "true", OnFailure::Stop),
        ]);
        let mut driver = RunbookDriver::new(&book, vec![ssh(web)]);

        let first = driver.next_step(&ws).unwrap();
        assert!(first.approval.is_some(), "l étape destructrice doit demander");
        driver.refuse_step("l approbation a été refusée".to_string());

        assert!(driver.next_step(&ws).is_none(), "la suite ne doit pas partir après un refus");
        let out = driver.finish();
        assert_eq!(out.status, RunStatus::Stopped);
        assert_eq!(out.steps.len(), 1);
        assert!(out.steps[0].outcomes.is_empty(), "une étape refusée n a rien lancé");
        assert_eq!(out.steps[0].stop_reason.as_deref(), Some("l approbation a été refusée"));
    }

    #[test]
    fn approving_a_step_lets_the_procedure_continue() {
        let (ws, web, _, _) = workspace_with_hosts();
        let book = book(vec![
            program_step("supprimer bob", "remove-user bob", Approval::default()),
            step("suite", "true", OnFailure::Stop),
        ]);
        let mut driver = RunbookDriver::new(&book, vec![ssh(web)]);

        let first = driver.next_step(&ws).unwrap();
        // Approuver, c'est simplement exécuter puis `finish_step` — le pilote
        // n'a pas de troisième état à retenir entre les deux.
        driver.finish_step(first.commands.keys().map(|t| outcome(t.clone(), Some(0), None)).collect());
        assert!(driver.next_step(&ws).is_some(), "l étape suivante doit pouvoir partir");
        assert_eq!(driver.finish().status, RunStatus::Completed);
    }

    #[test]
    fn a_step_defaults_to_asking_before_something_irreversible() {
        let step: RunbookStep = serde_json::from_str(
            r#"{"id":"11111111-1111-1111-1111-111111111111","title":"Redémarrer",
                "action":{"kind":"command","command":"systemctl restart nginx"}}"#,
        )
        .unwrap();
        assert_eq!(step.approval, Approval::BeforeIrreversible);
    }

    /// Le frontend lit `kind`/`operations` : un aller-retour Rust → Rust
    /// resterait vert même si les champs partaient en snake_case.
    #[test]
    fn the_approval_reason_serializes_in_camel_case() {
        let reason = ApprovalReason::Irreversible {
            operations: vec![IrreversibleOperation {
                operation: "remove-user bob".into(),
                reason: "le compte est perdu".into(),
            }],
        };
        let json = serde_json::to_string(&reason).unwrap();
        assert!(json.contains("\"kind\":\"irreversible\""), "attendu le tag irreversible dans {json}");
        assert!(json.contains("\"operations\""), "attendu operations dans {json}");

        let requested = serde_json::to_string(&ApprovalReason::Requested).unwrap();
        assert!(requested.contains("\"kind\":\"requested\""), "attendu le tag requested dans {requested}");
    }

    /// Un refus pendant qu'une annulation est aussi demandée reste rapporté
    /// comme un arrêt, pas comme une annulation : le rapport doit dire
    /// *pourquoi* la procédure s'est arrêtée, et « annulée » effacerait la
    /// raison portée par l'étape.
    #[test]
    fn a_refusal_keeps_its_status_even_if_a_cancel_arrives_after() {
        let (ws, web, _, _) = workspace_with_hosts();
        let book = book(vec![
            program_step("supprimer bob", "remove-user bob", Approval::default()),
            step("suite", "true", OnFailure::Stop),
        ]);
        let mut driver = RunbookDriver::new(&book, vec![ssh(web)]);
        driver.next_step(&ws).unwrap();
        driver.refuse_step("l approbation a été refusée".to_string());
        driver.cancel();
        assert!(driver.next_step(&ws).is_none());
        assert_eq!(driver.finish().status, RunStatus::Stopped);
    }

    // ─── Étape playbook ──────────────────────────────────────────────────

    fn playbook_step(relay_tag: &str) -> RunbookStep {
        RunbookStep {
            id: Uuid::new_v4(),
            title: "jouer le playbook".into(),
            notes: String::new(),
            action: RunbookAction::Playbook {
                relay_tag: relay_tag.into(),
                playbook: "/opt/infra/site.yml".into(),
                inventory: String::new(),
            },
            scope: RunbookStepScope::default(),
            on_failure: OnFailure::Stop,
            approval: Approval::Never,
        }
    }

    /// Un workspace avec un nœud de contrôle taggué et deux cibles, dont une
    /// seule vient d'un inventaire Ansible.
    fn workspace_ansible() -> (Workspace, HostId, HostId, HostId) {
        let mut ws = Workspace::default();
        let mut relay = Host::new("control", "10.0.0.10", "root");
        relay.tags = vec!["ansible-control".into()];
        let mut importe = Host::new("Serveur web de prod", "10.0.0.1", "root");
        importe.source = Some(crate::model::HostSource::ansible("web-1"));
        let a_la_main = Host::new("bricolé", "10.0.0.2", "root");
        let (r, i, m) = (relay.id, importe.id, a_la_main.id);
        ws.hosts = vec![relay, importe, a_la_main];
        (ws, r, i, m)
    }

    #[test]
    fn le_playbook_part_du_relais_et_ne_vise_que_les_hotes_connus_d_ansible() {
        let (ws, relay, importe, a_la_main) = workspace_ansible();
        let action = playbook_step("ansible-control").action;
        let plan = plan_step(&ws, &[ssh(importe), ssh(a_la_main)], &action).unwrap();

        // Une seule commande, sur le relais — pas sur les cibles.
        assert_eq!(plan.commands.len(), 1);
        let commande = &plan.commands[&ssh(relay)];
        assert!(commande.contains("--limit 'web-1'"), "{commande}");
        assert!(commande.contains("'/opt/infra/site.yml'"), "{commande}");

        // Et le rattachement du futur PLAY RECAP est prêt.
        let run = plan.playbook.expect("une étape playbook doit porter son rattachement");
        assert_eq!(run.relay, ssh(relay));
        assert_eq!(run.targets, vec![(ssh(importe), "web-1".to_string())]);

        // L'hôte sans nom Ansible est écarté nommément.
        assert_eq!(plan.skipped.len(), 1);
        assert_eq!(plan.skipped[0].target, ssh(a_la_main));
        assert!(plan.skipped[0].reason.contains("nom Ansible"), "{}", plan.skipped[0].reason);
    }

    /// Le tag ne désigne rien : refuser plutôt que jouer depuis on ne sait où.
    #[test]
    fn un_tag_de_relais_qui_ne_correspond_a_rien_est_refuse() {
        let (ws, _, importe, _) = workspace_ansible();
        let action = playbook_step("inexistant").action;
        let err = plan_step(&ws, &[ssh(importe)], &action).unwrap_err();
        assert!(err.contains("inexistant"), "{err}");
    }

    /// Deux relais possibles : refuser aussi, parce que choisir au hasard
    /// jouerait le playbook depuis une machine que personne n'a désignée.
    #[test]
    fn un_tag_de_relais_ambigu_est_refuse() {
        let (mut ws, _, importe, _) = workspace_ansible();
        let mut second = Host::new("control-2", "10.0.0.11", "root");
        second.tags = vec!["ansible-control".into()];
        ws.hosts.push(second);
        let action = playbook_step("ansible-control").action;
        let err = plan_step(&ws, &[ssh(importe)], &action).unwrap_err();
        assert!(err.contains("plusieurs"), "{err}");
    }

    /// Aucune cible ne porte de nom Ansible : sans `--limit`, le playbook
    /// s'appliquerait à tout l'inventaire du relais. L'étape doit refuser.
    #[test]
    fn aucune_cible_connue_d_ansible_refuse_l_etape() {
        let (ws, _, _, a_la_main) = workspace_ansible();
        let action = playbook_step("ansible-control").action;
        let err = plan_step(&ws, &[ssh(a_la_main)], &action).unwrap_err();
        assert!(err.contains("tout l'inventaire"), "{err}");
    }

    /// Le playbook vit sur le relais et l'application ne le lit pas : elle ne
    /// peut donc rien dire de ce qu'il détruit. Comme une commande shell libre.
    #[test]
    fn une_etape_playbook_ne_pretend_pas_juger_ce_qu_elle_fait() {
        let action = playbook_step("ansible-control").action;
        assert!(irreversible_operations(&action).is_empty());

        let mut toujours = playbook_step("ansible-control");
        toujours.approval = Approval::Always;
        assert_eq!(approval_for(&toujours, true), Some(ApprovalReason::Requested));
    }

    #[test]
    fn le_resume_d_une_etape_playbook_dit_le_playbook_et_le_relais() {
        let action = playbook_step("ansible-control").action;
        let resume = summary_of(&action);
        assert!(resume.contains("/opt/infra/site.yml"), "{resume}");
        assert!(resume.contains("ansible-control"), "{resume}");
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
                approval: Approval::Always,
            }],
        };
        let raw = serde_json::to_string(&book).unwrap();
        let back: Runbook = serde_json::from_str(&raw).unwrap();
        assert_eq!(back.steps[0].scope.tags, vec!["web".to_string()]);
        assert_eq!(back.steps[0].on_failure, OnFailure::DropFailed);
    }
}
