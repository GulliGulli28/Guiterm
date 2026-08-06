# Backlog — plan d'implémentation

Écrit le 2026-08-04, après la livraison de l'onglet Identités AWS ; vague 1
retirée le 2026-08-05, une fois ses cinq items livrés. Chaque levier cité a été
vérifié dans le code à sa date d'écriture, pas retrouvé de mémoire — c'est le
seul contenu de ce fichier qui vieillit mal, donc **revérifier un levier avant
de démarrer l'item**.

Ce fichier dit *quoi construire et dans quel ordre*. `CLAUDE.md` dit comment
travailler dans ce dépôt, `docs/dev-history.md` pourquoi les choses existantes
sont comme elles sont. Un item terminé quitte ce fichier et va dans le
CHANGELOG.

## Ce qui vaut pour chaque item, sans le répéter à chaque fois

- **Une tranche verticale, pas une couche.** Un item n'est fini que si le
  chemin complet a été parcouru : formulaire → onglet → donnée réelle. Un plan
  d'item qui ne mentionne aucun composant React pour une fonctionnalité visible
  est un signal (voir MongoDB dans `docs/dev-history.md`).
- **Persistance ascendante.** Toute propriété ajoutée à un struct sérialisé
  dans `workspace.json` est `#[serde(default)]`, sinon les fichiers déjà écrits
  chez les utilisateurs deviennent illisibles — et leurs hôtes disparaissent.
- **Enum à tag interne** : `rename_all_fields = "camelCase"`, jamais
  `rename_all` seul, plus un test qui désérialise un JSON écrit à la main. Ce
  piège s'est produit six fois dans ce dépôt.
- **Toute commande Rust a son entrée dans `src/lib/api.ts`.**
  `src/lib/tauriCommands.test.ts` le vérifie dans les deux sens : une commande
  qu'aucun binding n'appelle est du backend inatteignable.
- **Tout dispatch sur une union discriminée se ferme sur `assertNever`**
  (`src/lib/exhaustive.ts`).
- **Un scénario ajouté à `runScenarios()`** dans `scripts/e2e-run.mjs` — pas un
  script séparé ; le même scénario tourne alors sur les deux plateformes.
- **`npm run verify` complet**, clippy `-D warnings` compris, puis le binaire
  Windows lancé pour un test manuel réel. **Le CHANGELOG s'écrit après ce
  test**, jamais en même temps que le code.
- **« Quel test échouerait si je m'étais trompé ? »** Si la réponse est
  « aucun », l'item n'est pas fini. Et le garde-fou ajouté doit être cassé une
  fois pour vérifier qu'il échoue vraiment.

## Ordre proposé, et pourquoi

Trois vagues à l'origine. La première (items courts sur des zones déjà chaudes)
et l'essentiel de la troisième — le pivot « plan de contrôle » — sont
terminées ; voir « Déjà livré ». Il reste deux items de la vague 2 et le
journal d'activité.

Rien n'oblige à suivre cet ordre : les items sont indépendants sauf mention
explicite de dépendance.

**Et une leçon, vérifiée quatre fois de suite : les « leviers » de ce fichier
sont optimistes.** Le rollback ne dépendait pas de la vue d'activité ; la
dérive n'avait aucune de ses deux « moitiés déjà là » ; la vue d'activité ne
fusionne pas trois silos comparables. Chaque fois, la surprise était du même
côté — plus de travail qu'annoncé, ou un prérequis inexistant. **Rouvrir le
code avant de s'engager sur une taille.**

---

## Déjà livré

Retiré de ce fichier au fur et à mesure, comme annoncé en tête. Gardé ici en
une ligne chacun pour ne pas reproposer par distraction ce qui existe déjà —
le détail est dans le CHANGELOG et dans l'historique git.

- **Diagnostic de joignabilité depuis un hôte** — `core/src/reachability.rs`,
  `ReachabilityPanel.tsx`.
- **Recherche de fichiers distants** — `core/src/remote_search.rs`,
  `RemoteSearchPanel.tsx`.
- **Variables d'environnement secrètes** — au coffre, plus en clair dans
  `workspace.json`.
- **Alerte avant l'expiration d'une session SSO** — `aws_sso::alerts`,
  pastille sur l'onglet Identités AWS (2026-08-05).
- **Cible de flotte par compte / profil AWS** — condition `target profile:`
  du DSL, pastilles « Compte » dans `FleetTab.tsx` (2026-08-05).
- **Auth par certificat SSH** — `core/src/ssh_cert.rs`, champ sous « Clé
  privée », prouvé contre un vrai sshd avec CA locale (2026-08-06).
- **Rollback scopé** — `adaptive::inverse` (match total sur `Operation`),
  `preview_rollback`, bouton « Annuler » dans l'historique de flotte
  (2026-08-06). **Sa dépendance annoncée envers la vue d'activité n'existait
  pas** : `fleet_history` portait déjà le run à annuler. Ce qui manquait
  vraiment était le texte du programme DSL, désormais enregistré sur le run.
- **Dérive de configuration** — `core/src/drift.rs`, bouton « Vérifier
  l'écart » en mode Langage (2026-08-06). **Ses deux « moitiés déjà là »
  n'existaient pas non plus** : la sonde de `facts.rs` ne relève rien de ce que
  le DSL modifie, et les conditions du DSL sont des sélecteurs d'hôtes, pas un
  état voulu. Il a fallu écrire `adaptive::check_command`, troisième `match`
  total sur `Operation` à côté du rendu shell et de la table d'inverses.
- **Import d'inventaire Ansible** — `core/src/ansible_inventory.rs`,
  `AnsibleImportPanel.tsx` (2026-08-06). Apparie sur le **nom d'inventaire**
  via le nouveau `Host::source`, pas sur l'adresse (que l'inventaire édite
  justement quand une machine bouge). `aws_inventory::apply_import` n'a
  **pas** été factorisé avec : les hôtes EC2 existants ne portent pas de
  provenance, les faire apparier dessus les dupliquerait tous.

---

## Vague 2 — tranches moyennes, une vraie décision de conception chacune

### 1. Tunnel SSM sans bastion — **M/L**

**Valeur.** Aujourd'hui une base RDS/ElastiCache importée doit pointer vers un
hôte SSH existant (`tunnel_host_id`) pour être jointe : il faut donc entretenir
un bastion. `AWS-StartPortForwardingSession` ouvre le port directement.

**Levier.** `proxy_command::spawn` sait déjà lancer et surveiller un helper (y
compris le PATH du plugin Session Manager, corrigé le 2026-08-04) ;
`core/src/port_forward.rs` et le tunnel SQL savent déjà consommer un port
local.

**À écrire.** Backend : un module de cycle de vie du process SSM (démarrage,
attente du port réellement ouvert, arrêt, mort inattendue) et un
`SqlConnection` qui puisse référencer « tunnel SSM vers l'instance i-… » au
lieu d'un hôte SSH. Frontend : `SqlConnectionForm`, et le panneau d'import de
bases qui propose ce mode quand la base n'est pas publiquement joignable.

**Pièges.** Le vrai travail est le cycle de vie, pas l'appel : un process qui
meurt en silence laisse une connexion SQL qui pend. Prévoir la détection et un
message qui distingue « le tunnel est tombé » de « la base refuse ».
`EngineConfig` est une union discriminée — ajouter un mode de tunnel se fait
par variante, pas par champ optionnel de plus (voir `docs/dev-history.md`).

**Preuve.** Difficile sans compte AWS : viser des tests unitaires sur le
parsing de la sortie du plugin (« Port 5432 opened ») et une machine à états du
tunnel testable sans réseau.

### 2. Inventaire Azure / GCP — **S/M**

**Valeur.** Reste des sources d'inventaire ce qui n'a pas été fait avec Ansible
le 2026-08-06 : les VM Azure et GCP, par leur CLI, sur le modèle
d'`aws_inventory.rs`.

**Levier — le vrai travail est fait.** `Host::source` et
`ansible_inventory::apply_import` posent le motif : un réimport apparie sur
`(kind, id)` et ne rafraîchit que ce que la source possède. Une source de plus
= un parseur de sortie CLI + une variante de `kind`, pas une refonte.

**À écrire.** Backend : `az vm list` / `gcloud compute instances list --format
json`, chacun vers les mêmes sélections. Frontend : un panneau par source, sur
le modèle d'`AnsibleImportPanel.tsx` (**ne pas** généraliser `AwsImportPanel`,
qui porte profil/région/SSM — voir ce panneau-là pour le raisonnement).

**Pièges.** L'appariement, encore : pour Azure/GCP l'identifiant de ressource
est immuable et globalement unique, donc c'est lui — pas le nom, pas l'adresse.
Et comme pour AWS, ces CLI sont déjà authentifiées chez l'utilisateur : ne
jamais demander ni stocker d'identifiant cloud.

**Preuve.** Tests de parsing sur des sorties réelles ; le non-doublonnage est
déjà couvert par les tests d'`apply_import`.

---

## Vague 3 — le pivot « plan de contrôle » (structurantes)

**La boucle est fermée depuis le 2026-08-06** : exécuter sur une flotte,
voir ce qui s'en écarte, revenir en arrière. Il ne reste que le journal qui
permettrait de lire tout ça dans le temps.

### 3. Vue d'activité unifiée — **L**

**Valeur.** `core/src/fleet_history.rs`, `core/src/command_history.rs` et
`core/src/session_record.rs` sont trois silos. Un journal « qui a fait quoi, où,
quand », filtrable et exportable, est la brique d'audit qui manque au
positionnement infra.

**Levier — revérifié le 2026-08-06, et bien plus mince qu'annoncé.** Un seul
des trois silos porte des événements datés : `fleet_history` (`FleetRun` avec
`startedAtMs`, cibles, résultats). `command_history` est un `Vec<String>` dans
deux fichiers globaux, **sans horodatage ni hôte** — c'est la donnée de
l'autocomplétion ghost-text, que le module qualifie lui-même de « behavioral/
derived ». Les enregistrements de session sont des fichiers asciicast écrits là
où l'utilisateur a choisi, **indexés nulle part**.

Cet item ne commence donc pas par une vue : il commence par **donner un
horodatage et un hôte à `command_history`** (dont le format est déjà sur les
disques des utilisateurs — migration ascendante obligatoire) et par **indexer
les enregistrements**. À chiffrer en conséquence.

**À écrire.** Backend : un modèle d'événement commun et un lecteur qui fusionne
les trois sources sans les fusionner sur disque (les formats existants restent
compatibles). Frontend : un onglet avec filtres (hôte, période, type) et export.

**Pièges.** Ne pas transformer ça en base de données. Le cap à 50 runs existe
pour une raison ; une fusion qui charge tout en mémoire vieillira mal.
Décider tôt de la rétention.

---

## Écarté volontairement — ne pas reproposer sans raison neuve

- **Tableaux de bord / métriques temps réel** — dérive vers Grafana avec un
  dixième des moyens. Les facts à la demande suffisent.
- **Sessions partagées / collaboration** — impose un serveur, ce qui casse le
  modèle « tout est local » sur lequel repose le coffre chiffré.
- **Éditeur de code intégré** — l'édition distante livrée le 2026-07-27 acte
  l'inverse : déléguer au vrai éditeur de l'utilisateur.
