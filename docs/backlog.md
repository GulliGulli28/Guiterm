# Backlog — plan d'implémentation

Écrit le 2026-08-04, après la livraison de l'onglet Identités AWS. Chaque
levier cité a été vérifié dans le code à cette date, pas retrouvé de mémoire —
c'est le seul contenu de ce fichier qui vieillit mal, donc **revérifier un
levier avant de démarrer l'item**.

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

Trois vagues. La première existe pour une raison précise : ce sont des items
courts qui touchent des zones déjà chaudes (AWS, flotte, exécution distante),
donc ils se livrent vite et rapportent tout de suite. La deuxième regroupe ce
qui demande une vraie décision de conception. La troisième est le pivot
« plan de contrôle d'infra » — chaque item y dépend des deux autres pour avoir
du sens, et c'est là que le produit se différencie vraiment.

Rien n'oblige à suivre cet ordre : les items sont indépendants sauf mention
explicite de dépendance.

---

## Vague 1 — courtes, indépendantes

### 1. Alerte avant l'expiration d'une session SSO — **S**

**Valeur.** Le panneau connaît déjà l'échéance mais ne la dit que si on le
regarde. La panne typique est de découvrir la session morte au milieu d'un
transfert.

**Levier.** `SsoSessionState::{Valid, Renewable}` porte `seconds_left`
(`core/src/aws_sso.rs`) ; `describeState` (`src/lib/awsIdentities.ts`) sait
déjà la mettre en mots.

**À écrire.** Frontend seulement : un point coloré sur l'icône de l'onglet
`Sidebar.tsx` quand une session passe sous un seuil (30 min ?), et une ligne
dans le panneau. Attention à ne signaler que ce qui porte du travail : une
session sans profil ni hôte ouvert n'a pas à clignoter.

**Pièges.** Un état `Renewable` **n'est pas** une alerte — la CLI le renouvelle
seule. N'alerter que sur `Valid` proche de zéro et sur `Expired`.

**Preuve.** Test unitaire sur le sélecteur « quelles sessions méritent une
alerte » (`src/lib/awsIdentities.test.ts`), avec le cas `Renewable` explicite.

### 2. Diagnostic de joignabilité depuis un hôte — **S**

**Valeur.** « Est-ce que A atteint B:443 ? » est la question qu'on se pose en
permanence pendant un incident, et elle oblige aujourd'hui à ouvrir un terminal
et à se souvenir de la syntaxe de `nc`/`/dev/tcp`.

**Levier.** `ssh::run_command_capture` (`core/src/ssh.rs:705`) exécute hors-PTY
et capture stdout/stderr/code de sortie. `ssh_pool::acquire` évite une
connexion complète par test.

**À écrire.** Backend : une sonde qui essaie dans l'ordre `bash -c
'</dev/tcp/HOTE/PORT'`, `nc -z`, `timeout`+`curl`, et rend un verdict typé
(joignable / refusé / filtré / outil absent) — la distinction refusé/filtré est
tout l'intérêt, un timeout et un RST ne disent pas la même chose. Frontend :
un petit formulaire, atteignable depuis le menu contextuel d'un hôte et depuis
`FleetTab.tsx` pour tester depuis plusieurs hôtes à la fois.

**Pièges.** Ne pas interpoler l'hôte/port dans le shell sans validation — même
règle que la liste blanche d'arguments de `adaptive.rs`.

**Preuve.** Tests unitaires du classement des sorties (les vraies formes de
`nc`, `bash`, `curl`), plus un test d'intégration contre le `sshd` réel de
`core/tests/`.

### 3. Recherche de fichiers distants — **S/M**

**Valeur.** `find`/`grep` sur un hôte avec des résultats cliquables ouvrant le
fichier dans le panneau ou l'éditeur externe. Aujourd'hui il faut retaper la
commande et copier le chemin à la main.

**Levier.** `run_command_capture` pour l'exécution, `core/src/remote_edit.rs`
pour l'ouverture (déjà capable d'aller-retour éditeur externe), `SftpPanel` pour
le rendu d'une liste de chemins.

**À écrire.** Backend : construction sûre de la commande (chemins et motifs
échappés, profondeur et nombre de résultats bornés) et parsing en
`{chemin, ligne, extrait}`. Frontend : un panneau de résultats, chaque ligne
ouvrant `remote_edit`.

**Pièges.** Un `grep -r /` sur une machine chargée est une attaque contre soi-
même : borner par défaut (répertoire, `--max-count`, timeout) et le dire dans
l'UI plutôt que de laisser l'utilisateur le découvrir.

**Preuve.** Tests unitaires du parsing (`grep -n` avec des `:` dans le chemin,
c'est le cas qui casse les parseurs naïfs).

### 4. Cible de flotte par compte / profil AWS — **S**

**Valeur.** Cibler par tag EC2 **marche déjà** (les tags sont importés sur
l'hôte et `adaptive.rs` a une condition `tag`). Ce qui manque est « tous les
hôtes du compte X », qui est la découpe réelle quand on gère plusieurs comptes.

**Levier.** `aws_inventory::profile_in_command` (écrit le 2026-08-04) répond
déjà « quel profil cet hôte épingle ». La grammaire de `core/src/adaptive.rs`
est documentée en tête de fichier et testée.

**À écrire.** Backend : une condition `profile:` (ou `account:`) dans le DSL,
alimentée par `profile_in_command`, plus son entrée dans `HostContext`.
Frontend : le sélecteur de cibles de `FleetTab.tsx`.

**Pièges.** La grammaire du DSL est aussi produite par l'IA à partir d'une
instruction en français — étendre la documentation en tête d'`adaptive.rs` en
même temps que le parseur, sinon l'IA continue d'écrire l'ancienne grammaire.

**Preuve.** Tests du parseur (condition reconnue, condition inconnue rejetée
proprement) et un test de sélection sur un workspace fabriqué.

---

## Vague 2 — tranches moyennes, une vraie décision de conception chacune

### 5. Variables d'environnement secrètes — **M**

**Valeur.** `Host::env_vars` (`core/src/model.rs`) dort **en clair** dans
`workspace.json`. C'est aujourd'hui le seul endroit où l'app écrit une valeur
sensible sans passer par le coffre — un jeton d'API y atterrit naturellement.

**Levier.** `core/src/vault.rs` et son état à 3 modes ; il suffit d'un
`SecretKind` de plus (`SqlPassword` est le précédent exact, avec sa note sur
les identifiants qui ne peuvent pas entrer en collision).

**À écrire.** Backend : `EnvVar` gagne un drapeau « secret » ; la valeur part
au coffre sous `{host_id}:env:{clé}` et `workspace.json` ne garde que la clé.
`commands/terminal.rs` les relit au démarrage de session. Frontend :
`HostForm.tsx`, avec le même traitement visuel que les mots de passe.

**Pièges.** La **migration** est tout le sujet : les valeurs déjà écrites en
clair doivent continuer à marcher, et leur bascule vers le coffre ne peut se
faire que coffre déverrouillé. Prévoir le cas « coffre verrouillé au démarrage
de session » explicitement — refuser d'ouvrir la session est probablement plus
honnête que d'ouvrir un shell sans ses variables.

**Preuve.** Tests de round-trip sur un `workspace.json` de l'ancienne forme
(les tests de `model.rs` font déjà ça pour `EngineConfig`), et un test qui
vérifie qu'une valeur marquée secrète **n'apparaît pas** dans le JSON écrit.

### 6. Auth par certificat SSH — **M**

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

### 7. Tunnel SSM sans bastion — **M/L**

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

### 8. Inventaire dynamique au-delà d'AWS — **M**

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

### 9. Vue d'activité unifiée — **L**

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

### 10. Dérive de configuration — **L**

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

**Dépendance.** Se lit beaucoup mieux si (9) existe : une dérive détectée sans
historique ne dit pas depuis quand.

### 11. Rollback scopé — **L**

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

**Dépendance.** (9) pour retrouver le run à annuler.

---

## Écarté volontairement — ne pas reproposer sans raison neuve

- **Tableaux de bord / métriques temps réel** — dérive vers Grafana avec un
  dixième des moyens. Les facts à la demande suffisent.
- **Sessions partagées / collaboration** — impose un serveur, ce qui casse le
  modèle « tout est local » sur lequel repose le coffre chiffré.
- **Éditeur de code intégré** — l'édition distante livrée le 2026-07-27 acte
  l'inverse : déléguer au vrai éditeur de l'utilisateur.
