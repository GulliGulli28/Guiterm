# Backlog — plan d'implémentation

Écrit le 2026-08-04, après la livraison de l'onglet Identités AWS ; vidé de ses
items le 2026-08-10, les trois vagues étant terminées. Chaque levier cité a été
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

## État

Les trois vagues prévues le 2026-08-04 sont terminées, et l'onglet de diagnostic
réseau demandé après elles l'est aussi — ses deux tranches (2026-08-10).
**Ce fichier ne contient donc plus d'item à prendre** ; la section « Écarté
volontairement » en bas reste ce qu'il ne faut pas reproposer sans raison neuve.

Trois dettes connues, à traiter au premier usage réel plutôt qu'à planifier :
l'import Azure/GCP, le tunnel SSM et le diagnostic réseau n'ont jamais tourné
contre une vraie infrastructure distante (détail sous chaque item).

**Et une leçon, vérifiée six fois de suite : les « leviers » de ce fichier
sont optimistes.** Le rollback ne dépendait pas de la vue d'activité ; la
dérive n'avait aucune de ses deux « moitiés déjà là » ; la vue d'activité ne
fusionne pas trois silos comparables ; le tunnel SSM ne pouvait rien réutiliser
de `proxy_command::spawn`, qui rend un flux d'octets là où il fallait un port.
Chaque fois, la surprise était du même côté — plus de travail qu'annoncé, ou un
prérequis inexistant. **Rouvrir le code avant de s'engager sur une taille.**

Le corollaire, découvert sur le tunnel SSM : la surprise peut aussi être du
travail **déjà fait et non listé**. Le bloc de tunnel SSH existait en trois
copies, ce que le backlog ne disait nulle part — le trouver a changé la forme
de l'item (un module partagé plutôt qu'un quatrième site de dial). Lire les
appelants, pas seulement le module cité comme levier.

Et une troisième forme, découverte sur Azure/GCP : le levier peut être exact
**et le module donné en modèle avoir précisément la pièce non réutilisable**.
`aws_inventory` était le bon modèle sur toute la ligne sauf son lanceur de CLI,
qui ne marche que parce qu'`aws` est un `.exe`. La question à poser n'est pas
« ce module est-il un bon modèle » mais « laquelle de ses pièces repose sur une
propriété que ma source n'a pas ».

---

## En cours — Trois suites de l'inventaire (2026-08-11)

Choisies après la livraison du diagnostic réseau. Les trois sont des manques
**créés ou révélés par le travail d'inventaire récent**, pas des idées
génériques : vérifié dans le code le 2026-08-11, aucune n'existe déjà.

### A. « Quels hôtes utilisent cette clé ? » — **S**

**Valeur, et c'est une correction de sûreté.** `delete_private_key`
(`commands/hosts.rs`) retire la clé du trousseau sans rien vérifier : tout hôte
dont l'auth est `PrivateKey { key_id: Some(…) }` casse silencieusement.

**Levier — réel et exact.** `aws_inventory::hosts_by_profile` répond déjà à la
même question pour les profils AWS, et son doc comment dit pourquoi : « ce qui
casse si ceci cesse de marcher », consulté avant d'offrir une suppression.
`hosts_by_key` en est la transposition littérale.

**À écrire.** `model.rs` (requête pure sur le workspace), une commande, l'usage
dans `KeychainPanel.tsx` : le compte à côté de chaque clé, et une confirmation
nommant les hôtes avant suppression.

### B. Édition en lot des hôtes — **M**

**Valeur.** L'import cloud crée 50 hôtes d'un coup ; les modifier ensuite se
fait un par un. Le formulaire d'identifiants des panneaux d'import ne s'applique
qu'à la **création**, jamais après — c'est le manque que l'import a créé.

**Levier — à moitié seulement.** `HostsPanel` n'a aucune sélection multiple, il
faut l'ajouter. En revanche `cloud_inventory::apply_import` montre déjà quoi
écrire et quoi ne pas écraser, et `commands/hosts.rs::save_host` est le seul
point d'écriture d'un hôte.

**Piège.** Une écriture sur N hôtes est difficile à annuler : ne modifier que
les champs explicitement cochés, jamais « tout le formulaire », et confirmer en
disant combien d'hôtes et quels champs.

### C. Inventaire périmé — **M/L**

**Valeur.** `Host::source` sait d'où vient un hôte et `apply_import` rafraîchit
ce qui existe encore, mais **rien ne dit ce qui a disparu** : une VM détruite
reste dans la liste pour toujours, une VM créée depuis n'y est jamais entrée.
C'est `drift.rs` appliqué à l'inventaire au lieu de la configuration.

**Levier — inégal selon la source, et c'est le vrai sujet.** Azure et GCP
portent `source = {kind, id}`, donc le diff est direct. **AWS n'a pas de
`source` du tout** (documenté dans `ansible_inventory` : les hôtes EC2
antérieurs à ce champ n'en portent pas), il faut apparier sur l'adresse, qui
*est* l'id d'instance — et retrouver profil et région dans la commande proxy
(`profile_in_command` existe ; l'équivalent pour la région, non). **Ansible est
le cas le plus faible** : `HostSource` stocke le nom d'inventaire, pas le
chemin du fichier, donc un recontrôle exige de redemander le fichier.

**Périmètre retenu.** Azure et GCP d'abord, AWS ensuite si l'appariement par
adresse tient. Ansible explicitement hors périmètre tant que le chemin du
fichier n'est pas conservé.

---

## Livré — Onglet de diagnostic réseau — **L**

Demandé le 2026-08-10. Un onglet qui lance des diagnostics réseau (TCP, DNS,
HTTP, ping, traceroute) sur une sélection d'hôtes, avec un résultat par hôte.
Décisions déjà prises avec l'utilisateur : **les deux sens** (depuis les hôtes
vers une cible saisie, et depuis cette machine vers chaque hôte) par un
sélecteur ; le panneau de joignabilité existant est **absorbé** plutôt que
gardé en parallèle ; les quatre familles d'outils sont voulues.

**Levier — réel cette fois, et vérifié le 2026-08-10.** `probe_reachability`
prend déjà un `Vec<FleetTarget>`, exécute en parallèle et rend un résultat par
hôte ; `fleet::run_on_hosts` accepte une `HashMap<FleetTarget, String>`, donc
une commande par cible ; `FleetTarget` couvre SSH, Docker, K8s et le local ;
`reachability::validate_host` est la liste blanche anti-injection, obligatoire
puisqu'on interpole une adresse saisie dans un script lancé sur une flotte.

**Trois découvertes qui changent la forme de l'item :**

- **Les deux sens ne partagent pas le chemin d'exécution.** `run_on_hosts` est
  clé par `FleetTarget` ; en mode « vers les hôtes » tout tourne sur `Local`,
  donc dix hôtes donneraient dix fois la même clé et une seule entrée. Ce sens
  est N exécutions locales avec son propre runner. Scripts et parseurs communs,
  exécution non.
- **Le batch de `probe_reachability` ne se transpose pas.** Il est en batch
  parce que la sonde est bornée à 5 s, ce que son doc comment dit explicitement.
  Un `traceroute` prend des dizaines de secondes : il faut du streaming par
  évènement, comme un run de flotte.
- **Windows n'est pas reportable à la tranche 2.** `default_local_shell()` rend
  `powershell.exe`, donc dès que « Terminal local » est une *source* — le cas
  « est-ce que moi je joins ça », que la palette expose déjà — le script POSIX
  ne s'exécute pas. Corollaire : la sonde de joignabilité actuelle est
  probablement déjà cassée sur ce chemin sous Windows. `is_windows_native_shell`
  existe déjà pour faire la distinction.

### Tranche 1 — **livrée le 2026-08-10**

Sens « depuis les hôtes », outils TCP + DNS + HTTP, en POSIX **et** en
PowerShell pour la cible locale. `ReachabilityPanel` supprimé, absorbé par
l'onglet ; ses deux points d'entrée (menu d'un hôte, palette) ouvrent l'onglet
avec la bonne source présélectionnée — le menu d'un hôte a toujours voulu dire
« sonder *depuis* cet hôte », la palette « est-ce que *moi* je joins ça ».

Livré comme prévu, plus le raccourci `netdiag.open` (`Ctrl+Shift+D`).
`useFleetTargets` est bien une extraction de `FleetTab`, pas une copie.
**Prouvé** : 25 tests de parsage sur sorties réelles (`getent`, `dig`,
`nslookup`, `curl`, dont le séparateur décimal virgule d'un curl français, qui
rendrait sinon toute requête instantanée), tentatives d'injection refusées sur
l'adresse **et** sur le chemin HTTP, et un scénario E2E qui diagnostique
127.0.0.1 depuis la machine locale — il a rendu « connexion refusée » et
« 127.0.0.1 », donc les deux parseurs ont tourné contre de vrais outils. Sous
WSL il exerce la saveur POSIX, sous Windows la saveur PowerShell.
**Non prouvé** : aucun diagnostic contre une vraie flotte distante.

### Tranche 2 — **livrée le 2026-08-10**

Ping et traceroute, décochés par défaut (une grille qui les activerait
accueillerait l'utilisateur avec une colonne d'« outil absent »), et le sens
« vers les hôtes ».

Confirmé en l'écrivant : ce sens **n'est pas** le moteur de flotte, pour la
raison notée d'avance — `run_on_hosts` est clé par `FleetTarget`, dix sondes
locales s'effondreraient en une entrée. C'est son propre runner borné.
L'évènement a gagné une union `DiagRow` : une ligne de la grille est une source
dans un sens, un hôte diagnostiqué dans l'autre.

Deux pièges de lecture, fixés par des tests : un `ping` sort en code 1 sur une
perte **partielle** comme totale, donc le verdict se lit sur la ligne de
statistiques et pas sur le code — un lien qui marche mal est exactement ce
qu'on cherche avec ping ; et un traceroute qui finit en étoiles n'est jamais
arrivé, alors qu'annoncer « 12 sauts » se lirait comme un succès (seuil à deux
sauts muets consécutifs, un seul au milieu étant normal). Sorties réelles
couvertes en anglais **et** en français, dont le `ping.exe` francophone de
Windows dont aucun marqueur anglais ne correspond.

**Non prouvé** : aucun diagnostic contre une vraie flotte distante.

**Pièges.** L'adresse saisie passe par `validate_host`, jamais autre chose. Un
diagnostic ne s'enregistre pas dans `fleet_history` : il pose une question et ne
change rien, et noyer les vrais runs sous des diagnostics abîmerait le seul
travail de l'historique (c'est déjà la règle de `probe_reachability`).

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
- **Tunnel SSM sans bastion** — `core/src/ssm_tunnel.rs`, `core/src/db_tunnel.rs`,
  `DbTunnelPicker.tsx` (2026-08-07). **Le levier annoncé était à moitié faux** :
  `proxy_command::spawn` rend un transport stdio pour `connect_stream`, pas un
  port TCP local — rien de réutilisable côté cycle de vie, seulement le fix PATH
  du plugin, le drainage stderr borné et la table de `hint_for`. En revanche
  **du travail non prévu était déjà là** : le bloc de tunnel SSH existait en
  trois copies (`sql`/`redis_client`/`mongo_client`), donc ajouter un mode en
  aurait fait six — d'où `db_tunnel::open`/`close`. `tunnel_host_id` est devenu
  l'union `DbTunnel`, avec migration ascendante par `ServerConfigWire`/
  `MongoConfigWire` et double écriture pour rendre un downgrade sûr. Le tunnel
  reste éphémère par connexion, jamais dans le panneau Tunnels. **Non prouvé
  contre un vrai couple EC2-SSM + base managée** — couvert par le parsing, une
  machine à états pilotée par un faux helper, et la migration du format.
- **Vue d'activité unifiée** — `core/src/activity.rs`, `core/src/session_index.rs`,
  `ActivityTab.tsx` (2026-08-07). **Le levier annoncé était le plus mince des
  cinq** : un seul des trois silos portait des évènements datés, donc l'item a
  commencé par horodater `command_history` (migration ascendante : les entrées
  d'avant n'ont pas de date véridique, `atMs` reste `null` et l'interface écrit
  « date inconnue » plutôt que d'inventer celle de la migration) et par indexer
  les enregistrements, référencés nulle part. Fusion **à la lecture seulement** :
  chaque source garde son format, son plafond et son écrivain, donc pas de
  quatrième fichier à migrer le jour où l'une bouge. Deux défauts trouvés en
  route, hors périmètre : l'écriture de l'historique était derrière le réglage
  « suggestions » du ghost-text, et `openFleet`/`openSql`/`openActivity`
  appelaient `setActiveTabId` dans l'updater de `setTabs` (effet de bord dans
  une fonction que React rejoue en StrictMode — invisible en release, sorti par
  le scénario E2E).
- **Inventaire Azure / GCP** — `core/src/{cloud_cli,cloud_inventory,azure_inventory,
  gcp_inventory,azure_auth}.rs`, `AzureImportPanel.tsx`, `GcpImportPanel.tsx`,
  `CloudProviderPicker.tsx` (2026-08-10). **Le levier annoncé était réel** pour
  une fois — `HostSource` était déjà un `{kind, id}` en chaînes libres — mais
  **le module cité comme modèle avait justement la pièce non copiable** :
  `aws_inventory::run_aws` fait `Command::new("aws")`, ce qui marche parce
  qu'`aws.exe` existe. `az` et `gcloud` sont des shims `.cmd` sur Windows, donc
  le même appel échoue en `NotFound` chez quelqu'un dont la CLI est
  parfaitement installée. Vérifié empiriquement avant d'écrire : `az.cmd`
  marche, `az` non, et Rust gère lui-même l'invocation batch — d'où
  `candidate_programs`, testé, cassé une fois pour vérifier qu'il échoue. Idem
  pour le cwd : `az.cmd` lancé depuis ce dépôt en UNC fait écrire à `cmd.exe`
  « chemins UNC non pris en charge » sur stderr, ce que `proxy_command::
  helper_working_dir` résolvait déjà. `apply_import` **est** mutualisé entre
  Azure et GCP (contrairement à AWS/Ansible) : aucun hôte ne porte encore
  `kind: "azure"`/`"gcp"`, donc rien à ne pas casser, et les deux apparient
  vraiment sur un identifiant de ressource immuable. `HostSource` a été déplacé
  d'`ansible_inventory` vers `model.rs`, où sa doc le situait déjà à tort.
  **Trois bugs de casse serde attrapés par les tests en cours d'écriture**,
  dont `networkIP`/`natIP` chez GCP (l'API capitalise l'acronyme, donc
  `rename_all = "camelCase"` rendait toutes les instances sans adresse, sans
  la moindre erreur). Connexion Azure depuis l'app en prime, sur le modèle
  d'`aws_sso::login` — une session expirée renvoyait vers un `az login` à
  taper ailleurs.

  **Prouvé** : parsing sur sorties réelles, non-doublonnage au réimport,
  commandes enregistrées et erreurs typées en E2E (`list_azure_subscriptions`
  a répondu, `list_gcp_projects` a échoué en `cliMissing`), clippy Windows.
  **Non prouvé** : aucun import contre une vraie flotte — la session Azure de
  la machine de dev avait expiré et `gcloud` n'y est pas installé — et la
  connexion Azure interactive, qui demande une vraie authentification
  navigateur. À reprendre au premier import réel.

---

## Écarté volontairement — ne pas reproposer sans raison neuve

- **Tableaux de bord / métriques temps réel** — dérive vers Grafana avec un
  dixième des moyens. Les facts à la demande suffisent.
- **Sessions partagées / collaboration** — impose un serveur, ce qui casse le
  modèle « tout est local » sur lequel repose le coffre chiffré.
- **Éditeur de code intégré** — l'édition distante livrée le 2026-07-27 acte
  l'inverse : déléguer au vrai éditeur de l'utilisateur.
