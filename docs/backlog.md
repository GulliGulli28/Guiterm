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

Trois vagues. La première existait pour une raison précise : des items courts
touchant des zones déjà chaudes (AWS, flotte, exécution distante), qui se
livrent vite et rapportent tout de suite. **Elle est terminée** — voir
« Déjà livré » plus bas. La deuxième regroupe ce qui demande une vraie décision
de conception. La troisième est le pivot « plan de contrôle d'infra » — chaque
item y dépend des deux autres pour avoir du sens, et c'est là que le produit se
différencie vraiment.

Rien n'oblige à suivre cet ordre : les items sont indépendants sauf mention
explicite de dépendance.

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

---

## Vague 2 — tranches moyennes, une vraie décision de conception chacune

### 1. Auth par certificat SSH — **M**

**Valeur.** Lacune *protocole*, pas confort : les environnements à CA SSH
(certificats courts signés par une autorité) sont aujourd'hui inaccessibles,
comme l'étaient les serveurs MFA avant `interactive_auth.rs`.

**Levier.** **Vérifié le 2026-08-04** : `russh` 0.61.2 expose
`client::Handle::authenticate_openssh_cert` — ce n'est donc pas un chantier de
fork, contrairement à ce que le backlog supposait.

**À écrire.** Backend : une variante `AuthMethod::Certificate { key, cert }`
(`core/src/model.rs`), sa branche dans `ssh::authenticate`, et la lecture du
`.pub`/`-cert.pub` à côté de la clé — la convention OpenSSH est de le déduire
du nom, donc le proposer par défaut et le laisser modifiable. Frontend :
`HostForm.tsx`, et le trousseau (`KeychainPanel.tsx`) qui doit pouvoir stocker
un certificat à côté de sa clé.

**Pièges.** `AuthMethod` est une union discriminée côté TS : ajouter une
variante sans son rendu doit devenir une erreur `tsc` (`assertNever`). Et un
certificat expiré échoue avec un message serveur peu clair — prévoir la
remédiation, comme pour les sessions SSO (`proxy_command::hint_for`).

**Preuve.** Test d'intégration contre le `sshd` de `core/tests/`, configuré
avec une CA locale : c'est le seul moyen de prouver l'auth par certificat, et
`ssh_integration.rs` sait déjà démarrer un vrai sshd.

### 2. Tunnel SSM sans bastion — **M/L**

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

### 3. Inventaire dynamique au-delà d'AWS — **M**

**Valeur.** La moitié difficile est faite : `aws_inventory::apply_import`
(2026-08-04) sait créer-ou-rafraîchir sans dupliquer, en ne touchant qu'à ce
que la source possède. Reste à brancher d'autres sources : inventaire Ansible
(un fichier, aucune API), puis Azure/GCP par leur CLI, sur le modèle de
`aws_inventory.rs`.

**Levier.** `apply_import` (à généraliser : il est aujourd'hui typé sur
l'identifiant d'instance EC2), et `commands/known_hosts.rs:100`
(`import_ssh_config_hosts`) comme précédent d'import de fichier.

**À écrire.** Backend : un trait ou une fonction commune « source →
sélections », l'inventaire Ansible en premier (INI et YAML). Frontend : le
panneau d'import généralisé — il est aujourd'hui écrit pour EC2
(`AwsImportPanel.tsx`).

**Pièges.** L'appariement d'une machine dépend de la source : l'identifiant
d'instance pour EC2, quoi pour Ansible ? Le nom d'hôte de l'inventaire, qui
peut changer. Trancher explicitement plutôt que de reproduire la règle d'EC2
par réflexe — un mauvais appariement crée des doublons ou écrase le mauvais
hôte.

**Preuve.** Les tests de `apply_import` sont déjà là et couvrent le
non-doublonnage ; en ajouter pour chaque parseur de source.

---

## Vague 3 — le pivot « plan de contrôle » (structurantes)

Ces trois-là forment un ensemble : un journal pour voir ce qui s'est passé, une
dérive pour voir ce qui ne va plus, un rollback pour revenir. Livrées seules,
chacune vaut nettement moins.

### 4. Vue d'activité unifiée — **L**

**Valeur.** `core/src/fleet_history.rs`, `core/src/command_history.rs` et
`core/src/session_record.rs` sont trois silos. Un journal « qui a fait quoi, où,
quand », filtrable et exportable, est la brique d'audit qui manque au
positionnement infra.

**Levier.** Les trois existent et persistent déjà (`fleet_history.json` via
`secure_file`, cap 50 runs).

**À écrire.** Backend : un modèle d'événement commun et un lecteur qui fusionne
les trois sources sans les fusionner sur disque (les formats existants restent
compatibles). Frontend : un onglet avec filtres (hôte, période, type) et export.

**Pièges.** Ne pas transformer ça en base de données. Le cap à 50 runs existe
pour une raison ; une fusion qui charge tout en mémoire vieillira mal.
Décider tôt de la rétention.

### 5. Dérive de configuration — **L**

**Valeur.** Décrire un état voulu dans le DSL adaptatif, vérifier
périodiquement quels hôtes s'en écartent. C'est ce qui fait passer de
« exécuter sur une flotte » à « maintenir une flotte » — le vrai
différenciateur du pivot.

**Levier.** Les deux moitiés existent : le langage de conditions
(`core/src/adaptive.rs`) et la collecte de facts (`core/src/facts.rs`, avec
`Host::last_facts` persistées).

**À écrire.** Backend : un « état voulu » persisté, une comparaison
facts↔attendu qui rend un écart typé, et une planification (au lancement ? à la
demande ? périodique ?). Frontend : une vue d'écarts, et l'action « corriger »
qui réutilise le rendu shell existant du DSL.

**Pièges.** La planification est le piège : une app de bureau qui interroge
cinquante machines en tâche de fond devient une nuisance réseau. Commencer par
« à la demande, sur une sélection », mesurer, et ne rendre périodique que si ça
tient.

**Dépendance.** Se lit beaucoup mieux si (4) existe : une dérive détectée sans
historique ne dit pas depuis quand.

### 6. Rollback scopé — **L**

**Valeur.** La seule pièce identifiée du pivot jamais faite. **Scopé aux seules
opérations réversibles** (fichiers, paquets), pas un undo universel — c'est la
décision qui rend l'item réalisable.

**Levier.** Les huit fonctions du DSL (`install-package`, `start-service`…)
sont une liste fermée et testée : on peut décider pour chacune si elle a un
inverse, et lequel.

**À écrire.** Backend : l'inverse par fonction et par plateforme (table
déterministe, comme le rendu shell), et la capture de l'état d'avant pour ce
qui n'a pas d'inverse naturel (contenu de fichier). Frontend : dans
l'historique de flotte, un bouton « annuler ce run » qui montre **ce qu'il fera**
avant de le faire.

**Pièges.** Ce qui n'est pas réversible doit être dit comme tel dans l'UI,
pas silencieusement ignoré — un rollback partiel présenté comme complet est
pire que pas de rollback.

**Dépendance.** (4) pour retrouver le run à annuler.

---

## Écarté volontairement — ne pas reproposer sans raison neuve

- **Tableaux de bord / métriques temps réel** — dérive vers Grafana avec un
  dixième des moyens. Les facts à la demande suffisent.
- **Sessions partagées / collaboration** — impose un serveur, ce qui casse le
  modèle « tout est local » sur lequel repose le coffre chiffré.
- **Éditeur de code intégré** — l'édition distante livrée le 2026-07-27 acte
  l'inverse : déléguer au vrai éditeur de l'utilisateur.
