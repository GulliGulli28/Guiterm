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

## En cours — Bus d'objets (trois tranches, planifié le 2026-09-08)

Choisi le 2026-09-08 après une revue « qu'est-ce qui ferait évoluer l'app »
d'où l'alerting et les runbooks étaient écartés d'avance. Le sujet n'est pas
une verticale de plus : c'est **ce qui relie celles qui existent**, et donc la
philosophie « couteau suisse à fonctionnalités interconnectées » rendue
mécanique au lieu d'être payée lien par lien.

### Le problème, tel qu'il est écrit dans le code

`modules/types.ts` documente `openTerminalIn` comme « le pendant, côté fichiers,
du lien hôte ↔ base de données ajouté en 3.1.0 ». Et douze lignes plus haut, il
interdit d'en ajouter beaucoup : « N'ajouter un champ ici que quand un deuxième
module en a besoin. Un contexte qui grossit à chaque migration redevient la
liste centrale que ce découpage doit supprimer. »

Les deux phrases sont justes et elles se contredisent. Résultat mesuré :
**17 modules, deux liens transversaux.** Chaque interconnexion coûte un champ
d'`AppContext`, donc il n'y en a presque pas. Le bus supprime ce coût unitaire :
un module *déclare* ce qu'il sait faire d'un objet, et gagne ses liens entrants
sans qu'aucun autre fichier ne bouge.

### Les leviers, rouverts le 2026-09-08 — et les trois qui étaient faux

Le fichier prévient que ses leviers sont optimistes. Vérification avant
engagement, et trois corrections :

- **Le terminal ne connaît pas son répertoire courant.** `panePath.ts` ne fait
  que de la manipulation de chaînes pour le panneau de transfert, et
  `cdCommand` *écrit* un `cd` dans un terminal neuf — rien ne lit jamais le cwd
  en retour. « Terminal → SFTP dans le dossier courant » demanderait OSC 7 côté
  `core`. **Hors périmètre, dit d'avance.**
- **Le clic droit du terminal est déjà pris** (`TerminalTab.tsx`, sous la
  préférence `terminalRightClickMenu`) : copier la sélection, sinon coller.
- **La palette ne s'ouvre pas depuis un terminal.** `palette.open` est `Ctrl+K`
  et n'a pas `bubblesThroughTerminal` — délibérément, `Ctrl+K` étant `kill-line`
  dans la table de collisions du fichier lui-même. La surface clavier du bus ne
  peut donc pas être la palette telle qu'elle s'ouvre aujourd'hui.

Ce qui était juste, en revanche, et non listé : **`useNetDiagSelection.seedSource`
est déjà « un acteur extérieur amorce la sélection de ce module »**. Le bus a un
précédent dans le dépôt, pas une invention.

### L'obstacle réel, nommé d'avance

`AppContext` (donné aux **onglets**) ne sait ouvrir aucun onglet. Tout le
pouvoir d'ouverture vit dans `SidebarActions` (donné aux **panneaux**
seulement) : `connect`, `openTransfer`, `connectSql`, `openNetDiag`,
`openFleet`, `quickSSH`… Un bus dont n'importe quel module peut être
destinataire en a besoin des deux côtés.

Recopier douze champs dans `AppContext` serait exactement le contexte qui
grossit. La sortie est d'**extraire** le bloc « Ouvrir un onglet » de
`SidebarActions` en `TabOpeners`, dont `SidebarActions` hérite ; `AppContext`
gagne **un** champ, `open: TabOpeners`. Et c'est une addition nette :
`openTerminalIn` **quitte** `AppContext` au même commit, remplacé par une
action du module terminal. Le bus doit absorber le lien codé à la main avant
d'en ajouter des neufs — sinon il n'a rien prouvé.

### La forme

```ts
// src/lib/appObject.ts — pur, testable sans DOM ni backend
export type AppObject =
  | { kind: "remotePath"; source: PaneSource; path: string; isDir: boolean }  // tranche 1
  | { kind: "endpoint";   address: string; port: number | null }              // tranche 2
  | { kind: "targets";    keys: string[] }                                    // tranche 3
  | { kind: "host";       hostId: HostId };                                   // tranche 3
```

**Écrites une par une, jamais toutes d'avance** : une variante sans
destinataire donnerait un menu vide qui compile, et c'est l'anti-vacuité qui
l'interdit (voir les garde-fous). `text` a été retiré du plan : l'échappatoire
prévue est un fourre-tout tant qu'aucun cas concret ne la réclame.

Aucune des cinq formes n'est inventée : `PaneSource` et `cwd` existent dans
`TransferTab`, les clés de cibles sont celles que `useFleetSelection` et
`useNetDiagSelection` manipulent déjà, `hostId` est partout. `text` est
l'échappatoire assumée — à ne pas laisser devenir le fourre-tout.

```ts
// src/modules/types.ts
export interface ObjectAction { id: string; label: string; run: () => void }
export interface ObjectContribution {
  actionsFor(obj: AppObject, ctx: AppContext, open: TabOpeners): ObjectAction[];
}
// src/modules/registry.ts
export function actionsForObject(obj, ctx, open): ObjectAction[]  // flatMap sur MODULES
```

Un module rend `[]` pour ce qui ne le concerne pas.

### Tranche 1 — le bus, prouvé sur `remotePath` (aucun Rust)

Chemin complet atteignable dès ce commit : un résultat de **recherche
distante** — qui aujourd'hui sait seulement « ouvrir dans l'éditeur » et
« copier le chemin » — gagne « Envoyer vers… » → *terminal dans ce dossier*,
*ouvrir un transfert ici*. Et le panneau de transfert remplace son bouton
« Terminal ici » codé en dur par le même menu.

Fichiers : `src/lib/appObject.ts` (neuf) et son test ;
`src/components/ObjectActionsMenu.tsx` (neuf, la popup réutilisée partout) ;
`src/modules/types.ts` (`TabOpeners` extrait, `ObjectContribution`,
`AppContext.open` +1, `openTerminalIn` −1) ; `src/modules/registry.ts`
(`actionsForObject` + preuves de type) ; `src/modules/objects.test.ts` (neuf) ;
`src/modules/{terminal,transfer,sftp}.tsx` ;
`src/components/{RemoteSearchPanel,TransferTab}.tsx` ; `src/App.tsx` ;
`src/lib/types.ts` (`initialPath?` sur le membre transfert de `TabMeta`).

**Le travail caché de cette tranche** : `TransferTab` initialise son état sur
`cwd: ""` et prend le cwd que le backend renvoie à l'ouverture du panneau.
Ouvrir *à un chemin donné* demande de lister ce chemin plutôt que le défaut,
et de retomber proprement sur le défaut si le dossier n'existe plus. Ce n'est
pas un passage de prop.

#### Écarts au plan, constatés en écrivant la tranche 1

Quatre, tous dans le sens « le code en savait plus que le plan » :

1. **`ObjectActionsMenu` n'a pas été écrit.** `TransferTab.tsx` contenait déjà
   un `ContextMenu` privé et complet (repli dans la fenêtre, fermeture au clic
   ailleurs / Échap / défilement) dont les entrées ont exactement la forme
   `{ label, run }`. Extrait dans `src/components/ContextMenu.tsx`, sans
   changement de comportement. En écrire un second aurait donné deux menus à
   garder d'accord.
2. **`AppContext` porte `objectActions`, pas `open: TabOpeners`.** La forme
   prévue faisait importer `registry.ts` par les modules que `registry.ts`
   importe. Le cycle tient en ESM tant que l'appel reste dans une fermeture —
   précisément le genre de propriété qu'un changement de bundler casse sans
   prévenir. `App.tsx` referme la boucle une fois, et le contexte ne donne
   toujours qu'un champ. Bénéfice non prévu : un module ne peut plus ouvrir
   les onglets des autres « quand ça l'arrange », seulement offrir des actions.
   `TabOpeners` reste extrait — c'est le type du paramètre d'`actionsFor`, et
   `SidebarActions` en hérite.
3. **`AppObject` naît avec *une* variante, pas cinq.** Déclarer `endpoint`,
   `targets` et `text` d'avance aurait fait échouer l'anti-vacuité dès le
   premier commit, ou obligé à une liste d'exemptions — le dépotoir que ce
   fichier interdit ailleurs. Chaque variante arrive avec son destinataire.
   C'est la règle `assertNever` appliquée au bus.
4. **Le module transfert n'offre rien sur un chemin local** : le panneau gauche
   de tout transfert *est* déjà cette machine. C'est au module de savoir ce
   qu'il ne sait pas faire, plutôt qu'à l'utilisateur de le découvrir en
   cliquant sur une entrée qui échoue.

Et une confirmation : le travail caché annoncé sur `TransferTab` en était bien
un. `open_pane` ne prend pas de dossier de départ, donc `initialPath` coûte un
second aller-retour (`list_pane`) après l'ouverture, plus le repli sur le
dossier par défaut quand le chemin a disparu.

### Tranche 2 — l'objet `endpoint`, depuis le terminal (aucun Rust)

Décidé avec l'utilisateur le 2026-09-08, deux choix qui réduisent la tranche :
**détection sur la sélection seulement** (pas de `registerLinkProvider`, donc
pas de soulignement permanent, pas de positionnement sur la grille xterm, pas
de passage par `bench:terminal`), et **surface clavier = la palette**.

La palette étant inatteignable depuis un terminal (voir les leviers), la
tranche ajoute une action dédiée et remontante `objects.sendSelection` —
« Envoyer la sélection vers… » — sur **`Ctrl+Shift+K`** (libre ; toute la
famille remontante du fichier est en `Ctrl+Shift+lettre`, et aucune de ces
combinaisons n'est dans `SHELL_BINDING_WARNINGS`). Elle ouvre la palette déjà
cadrée sur la sélection, sans toucher à `Ctrl+K`.

Les actions sont **aplaties en lignes de palette** (« Tester le port 5432 sur
10.0.3.12 »), pas un menu à deux étages : une frappe, cherchable au clavier
comme le reste. Sans sélection, l'action dit « Aucune sélection » plutôt que
d'ouvrir une palette vide.

Fichiers : `src/lib/appObject.ts` (`parseEndpoint` — IPv4/IPv6, `host:port`,
`user@host`) ; `src/components/{TerminalTab,LocalTerminalTab}.tsx`
(`getSelection()` ajouté à `TerminalTabHandle`) ; `src/lib/shortcuts.ts` ;
`src/components/CommandPalette.tsx` (**le vrai travail** — 84 lignes qui
reçoivent une liste statique, il faut des entrées construites depuis la
sélection vivante) ; `src/App.tsx` (capture la sélection **au déclenchement**,
pas au rendu : la palette prend le focus) ;
`src/modules/{netdiag,tunnels,sql,hosts}.tsx`.

`ObjectActionsMenu` reste nécessaire malgré la palette : le panneau de
transfert et les résultats de recherche sont des contextes souris. Deux
rendus, **un seul `actionsForObject`** — c'est ce qui prouve que c'est un bus
et pas un menu.

#### Écarts au plan, constatés en écrivant la tranche 2

- **`AppObject.endpoint` porte `via`**, l'hôte depuis lequel l'adresse a été
  lue (`null` pour un terminal local). Non prévu, et c'est ce qui fait la
  valeur de l'action : une IP privée vue dans un `ss` sur un bastion ne veut
  rien dire depuis cette machine-ci, et la question utile est « depuis ce
  bastion, est-ce que tu joins ça ? » — le second sens que
  `useNetDiagSelection` documente déjà. Conséquence : `parseEndpoint` rend un
  `ParsedEndpoint` (texte analysé) et non un `AppObject`, `via` venant du
  contexte d'appel.
- **`openFleet` et `openNetDiag` ont rejoint `TabOpeners`.** Ils étaient restés
  dans `SidebarActions`, sous une section intitulée « Boutons de la bande qui
  ouvrent un onglet plutôt qu'un panneau » — qui les décrivait déjà comme des
  ouvreurs. Leur place était de ce côté de la frontière depuis le début.
- **L'onglet de diagnostic est un singleton dont le remontage passe par sa
  `key`.** Envoyer une seconde adresse depuis un terminal ne change pas la
  source, donc n'aurait rien remonté : le champ serait resté sur l'adresse
  précédente, sous un onglet qu'on vient pourtant de viser. La destination
  entre donc dans la `key`.
- **`ObjectActionsMenu` n'existe toujours pas** : la palette réduite et le
  menu contextuel sont deux rendus d'un seul `actionsForObject`. La palette a
  gagné un `title` optionnel, rien de plus.
- **Un seul destinataire d'`endpoint` pour l'instant** — le diagnostic réseau.
  Le tunnel, la création d'hôte et la connexion SQL restent à faire : chacun
  demande sa propre amorce de formulaire, ce qui est du travail par
  destinataire et non du travail de bus. L'anti-vacuité est déjà satisfaite,
  donc ils peuvent arriver un par un.

**Le piège des préférences vaut aussi pour les raccourcis, et il a mordu.**
La combinaison par défaut a dû changer après coup (collision avec la palette
telle que l'utilisateur l'avait réassignée) — sans aucun effet : `AppPreferences`
vit dans le `localStorage`, donc la carte enregistrée au premier lancement fige
la valeur, et éditer `SHORTCUT_ACTIONS` ne la déplace pas. Deux conséquences
inscrites dans le code :

- **Le scénario e2e presse la combinaison *en vigueur*, lue dans le
  `localStorage`**, jamais celle écrite dans le catalogue. Il échouait sinon sur
  tout profil déjà utilisé, en accusant xterm à tort — ce qu'il a fait.
- **Les collisions entre actions sont désormais détectées** (`comboConflicts`),
  et signalées dans les réglages sur l'action *perdante*. Il n'existait qu'un
  contrôle des collisions avec le **shell** ; deux actions de l'app sur la même
  touche laissaient la seconde inerte, en silence, `useGlobalShortcuts`
  s'arrêtant au premier appariement. C'est ce trou qui a rendu la collision
  invisible jusqu'à ce qu'un utilisateur la signale.

Et un piège de scénario, à ne pas redécouvrir : **les onglets restent montés
quand ils sont masqués**, donc `browser.$(".xterm")` désigne un terminal caché
dès qu'il y a plusieurs onglets, et WebDriver refuse d'y cliquer (« element not
interactable »). Filtrer sur une largeur non nulle.

### Tranche 3 — l'objet `targets` (aucun Rust)

Amorcer la sélection d'un module depuis un autre : une colonne d'IPs d'un
résultat SQL → cibles de flotte ; la sélection de flotte → diagnostic réseau et
retour ; `hostAttachments` (aujourd'hui lu à **un seul endroit**,
`HostsPanel.tsx`) devient une source d'objets partout.

Fichiers : `src/modules/{fleet,netdiag,sql}.tsx` ;
`src/components/{SqlTab,ResultTable}.tsx` ;
`src/hooks/{useFleetSelection,useNetDiagSelection}.tsx` (exposer une amorce,
sur le modèle de `seedSource`).

### Garde-fous — « quel test échouerait si je m'étais trompé ? »

Le risque propre à un registre consulté à l'exécution, c'est **le menu toujours
vide** — la panne MongoDB sous une autre forme : tout compile, rien n'est
atteignable.

- `Record<AppObject["kind"], true>` énuméré à l'exécution → `tsc` échoue si un
  `kind` est ajouté sans venir au test (calqué sur `registry.test.ts`).
- **Anti-vacuité** : pour chaque `kind`, avec un workspace fabriqué,
  `actionsForObject` rend au moins une action. Un `kind` que personne n'accepte
  fait rouge. **À casser exprès** en retirant l'acceptation de `remotePath` du
  module terminal — sinon il ne prouve rien.
- Unicité des `id` d'actions (préfixés par module), comme le registre vérifie
  déjà l'unicité des `kind`.
- Tranche 2 : `shortcuts.test.ts` vérifie que `objects.sendSelection` remonte à
  travers le terminal **et** que sa combinaison n'est dans aucune des deux
  tables de collision. Rouge si on la repose sur un `Ctrl+lettre` nu.
- Un scénario ajouté à `runScenarios()` de `scripts/e2e-run.mjs` — ouvrir le
  menu, cliquer une action, vérifier que l'onglet visé s'ouvre ; sans
  gestionnaire de fenêtres, pour rester vert en CI.

### Hors périmètre, dit d'avance

Le cwd du terminal (OSC 7 — c'est du `core/`, une tranche à part) ; les
runbooks comme destinataires (suspendus par l'utilisateur le 2026-09-08) ;
toute extension d'`AppObject` au-delà des cinq formes.

## Livré — Runbooks exécutables (trois tranches, 2026-08-31)

Choisi le 2026-08-31 parmi les trois chantiers majeurs restants de
`roadmap-chantiers-majeurs` (les deux autres — surveillance continue, sync
chiffrée — restent ouverts). Les trois tranches sont livrées. Des procédures ordonnées au-dessus du moteur de
flotte : étapes, notes, sortie capturée par étape, politique d'échec, rapport.

**Deux décisions prises avec l'utilisateur avant d'écrire :** les cibles sont
**globales avec surcharge par étape** (une étape restreint par tag et par
dossier, jamais par `hostId` — un runbook qui porterait des identifiants
locaux ne voudrait plus rien dire une fois exporté) ; et les runbooks vivent
**dans `workspace.json`** d'abord, le fichier versionnable venant en tranche 3.

**Les leviers, revérifiés dans le code le 2026-08-31** — et pour une fois le
meilleur n'était pas listé :

- `adaptive::inverse` répond déjà « cette opération est destructrice, et voici
  pourquoi » (`Reversibility::Irreversible { reason }`, en français, sur un
  `match` total). La pause d'approbation de la tranche 2 n'aura donc pas de
  liste de mots-clés à maintenir. Limite : ça ne vaut que pour les étapes DSL,
  une commande libre est du shell arbitraire, indécidable.
- `fleet::run_on_hosts` et `commands::fleet::execute_and_record` étaient bien
  ce qu'annonçait le backlog : réutilisables tels quels pour *une* étape.

**Les quatre trous, eux, étaient tout le travail :**

1. `fleet_history.json` plafonne à 50 runs — une procédure de huit étapes
   lancée trois fois aurait chassé l'historique des vraies opérations de
   flotte. D'où `runbook_history.json`, et d'où le fait qu'une exécution y soit
   *un* objet et pas N runs indépendants.
2. Le moteur de flotte ne sait pas s'arrêter : aucune notion d'« échec ⇒ ne pas
   faire l'étape suivante » ni de retrait de cibles. C'est `core/src/runbook.rs`,
   écrit, pas réutilisé.
3. Aucun aller-retour d'approbation n'existe côté backend. `interactive_auth.rs`
   en est le seul précédent (évènement + oneshot) — un modèle, pas du code
   réutilisable. Reporté en tranche 2.
4. `preview_rollback` part d'un `run_id` de `fleet_history` : annuler un runbook
   entier demanderait de recoudre N runs. **Hors périmètre, dit d'avance.**

### Tranche 1 — **livrée le 2026-08-31**

Le moteur (`core/src/runbook.rs`, `runbook_history.rs`), les cinq commandes
(`commands/runbook.rs`), l'onglet et le panneau (`RunbookTab.tsx`,
`RunbookPanel.tsx`, `modules/runbook.tsx`).

**La leçon de conception du chantier** : la boucle d'exécution était d'abord
dans la couche Tauri, où *rien* ne pouvait la dérouler sans une vraie flotte —
alors que l'ordre des étapes, la politique d'échec et le retrait des cibles
*sont* la fonctionnalité. Redescendue en machine à états (`RunbookDriver`,
`next_step`/`finish_step`/`finish`), elle se déroule entièrement avec des
résultats fabriqués. Les deux assertions qui comptent — une étape en échec
réglée sur « arrêter » n'exécute pas la suivante, une cible écartée ne
réapparaît jamais — ont été **cassées exprès** et échouent bien toutes les deux.

**Prouvé** : 32 tests unitaires, et un scénario E2E qui crée la procédure depuis
la barre latérale, remplit une étape, la lance réellement sur le terminal local,
lit la sortie de la commande à l'écran et vérifie que le rapport est persisté —
puis supprime le runbook (le seul scénario qui écrit dans le vrai
`workspace.json` du profil, d'où la suppression en `finally`).
**Éprouvé** contre une vraie infrastructure par l'utilisateur le 2026-09-08.

**Deux limites assumées de la tranche 1**, à ne pas confondre avec des oublis :
les notes d'étape sont stockées verbatim mais **rendues en texte brut** (aucun
moteur markdown dans le dépôt, en ajouter un est une décision de dépendance à
part) ; et l'arrêt demandé prend effet **entre deux étapes**, jamais au milieu
de l'une — couper un `apt-get` à mi-chemin laisserait des machines dans un état
que la procédure ne décrit nulle part. L'interface le dit au lieu de le laisser
croire.

### Tranche 2 — **livrée le 2026-08-31**

Livrée comme annoncée, aux deux écarts près ci-dessous. `Approval` sur l'étape
(`beforeIrreversible` / `never` / `always`), `runbook::irreversible_operations`
au-dessus d'`adaptive::inverse`, aller-retour oneshot sur le modèle
d'`interactive_auth`, et `RunbookApprovalModal`.

**Le défaut demande** (`beforeIrreversible`), contrairement au reste des
réglages sérialisés de ce dépôt. Assumé : une étape qui supprime un compte
n'est pas rattrapable, et le défaut ne coûte rien aux autres — une commande
libre est indécidable, donc elle ne déclenche jamais ce mode.

**Écart 1 : le délai est de 10 minutes, pas les 3 de l'authentification
interactive.** Un OTP se lit sur un téléphone posé à côté ; approuver une étape
veut souvent dire relire la sortie de la précédente ou ouvrir un tableau de
bord. Il **refuse**, jamais il n'accorde : un délai qui finirait par laisser
passer l'étape retirerait toute sa valeur à la pause.

**Écart 2 : premier `createPortal` du dépôt.** Un onglet inactif reste monté
dans un conteneur `hidden` (`App.tsx`), donc une modale rendue à sa place est
invisible dès qu'on regarde ailleurs — et une demande qu'on ne voit pas finit
refusée au bout du délai, sur une procédure qu'on croyait en train de tourner.
Le portail la sort du conteneur masqué **sans** faire remonter les runbooks
dans `App.tsx`, ce que le registre de modules cherche à éviter. Elle passe par
`useModalSurface` comme les autres et est inscrite dans `MODALS`
(`accessibility.test.ts` l'a attrapée toute seule, ce qui est exactement son
travail).

**Deux points de conception à ne pas rouvrir sans raison neuve :** un refus
*arrête* au lieu d'enchaîner (une étape refusée n'a pas eu lieu, or la suivante
suppose qu'elle a eu lieu) ; et une étape qui ne lancera rien ne demande jamais
— demander l'accord pour une étape qui ne vise personne apprend à approuver
sans regarder.

**Prouvé** : 45 tests unitaires au total sur le pilote (11 de plus), et un
scénario E2E qui approuve la première étape, refuse la deuxième, et vérifie
dans le rapport persisté que la troisième n'a jamais démarré. Les trois
assertions centrales cassées exprès pour vérifier qu'elles échouent.
**Non prouvé** : le chemin du délai dépassé (10 minutes en fenêtre réelle), et
aucune approbation contre une vraie flotte distante.

### Tranche 3 — **livrée le 2026-08-31**

`ex::RunbookExport` (enveloppe `exportVersion` + `runbook`, à côté de
`WorkspaceExport`/`HostExport`), `export_runbook` / `import_runbook` /
`export_runbook_report`, et `runbook_history::report_markdown`.

**Trois décisions à ne pas rouvrir sans raison neuve :**

- **Un réimport remplace par id** plutôt que d'empiler, comme
  `export::import_host` : c'est ce qui rend « `git pull` puis importer »
  inoffensif. Les id étant des UUID, deux procédures différentes ne peuvent pas
  se télescoper. Cassé exprès (un `push` au lieu du remplacement) : l'E2E
  l'attrape.
- **Le rapport ne recopie pas la sortie des machines qui ont réussi**, et le
  dit. Un document qui déverse le stdout de cinquante machines n'est pas lu, et
  ne pas être lu est le pire résultat possible pour un rapport d'incident.
- **Les dates du rapport sont en UTC, suffixe `Z` visible.** `time` refuse de
  lire le décalage local dans un processus multithread (c'est unsound), donc
  l'alternative aurait été de faire formater la date par le frontend — de la
  présentation traversant la frontière pour un gain d'ambiguïté nul.

**Ce que l'export ne contient pas, et c'est la propriété centrale** : aucun
identifiant d'hôte. C'est ce que la décision « portée par tag et par dossier »
de la tranche 1 achète, et l'E2E l'assère directement (`/"hostId"/` sur le
fichier écrit).

**Prouvé** : 50 tests unitaires sur le moteur et le rapport, et un scénario E2E
qui exporte, relit le fichier **hors de l'app**, supprime la procédure,
réimporte, revérifie notes/portée/politique, réimporte une seconde fois sans
dupliquer, et écrit un rapport markdown.
**Non prouvé** : les deux sélecteurs de fichiers natifs (`save()`/`open()` du
frontend) — ce sont des fenêtres de l'OS, pas du DOM, donc WebDriver ne les
pilote pas ; les scénarios passent les chemins directement aux commandes.

---

## État

Les trois vagues prévues le 2026-08-04 sont terminées, l'onglet de diagnostic
réseau demandé après elles aussi (ses deux tranches, 2026-08-10), et le registre
de modules a été livré le 2026-08-17 en cinq commits. **Un item en cours** : le
bus d'objets, planifié le 2026-09-08, en haut de ce fichier — trois tranches,
aucune ligne de Rust. Il prolonge le registre de modules plutôt que d'ouvrir un
domaine de plus.

La prochaine étape de « noyau + extensions » (extraire un module en sidecar)
est analysée dans `docs/architecture-extensions.md` mais n'est pas planifiée :
elle ne vaut que si le poids du binaire devient un vrai problème. La section
« Écarté volontairement » en bas reste ce qu'il ne faut pas reproposer sans
raison neuve.

Dettes de preuve — **deux des trois sont levées** : le tunnel SSM et le
diagnostic réseau ont été éprouvés contre une vraie infrastructure par
l'utilisateur le 2026-09-08, comme les runbooks. **Reste l'import Azure/GCP**,
et lui seul : le test du 2026-09-08 portait sur l'import **AWS**, qui est un
autre chemin de code (`aws_inventory`, pas `azure_inventory`/`gcp_inventory`).
Solder l'un ne solde pas l'autre.

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

## Livré — Registre de modules + masquage des panneaux (2026-08-17)

Planifié le 2026-08-13, livré le 2026-08-17 en cinq commits. L'analyse
complète, les décisions et les écarts au plan vivent dans
**`docs/architecture-extensions.md`** — c'est une décision d'architecture, pas
une fonctionnalité, et elle est trop longue pour ce fichier.

**Ce qui est en place.** Un module (`src/modules/`) déclare son onglet, son
panneau de barre latérale et les domaines de commandes Tauri qu'il possède.
`App.tsx` (991 → 878 lignes) et `Sidebar.tsx` (272 → 122) ne gardent que leur
coquille : plus aucun dispatch par type d'onglet ni par panneau. Ajouter une
fonctionnalité, c'est un fichier de module et une ligne de registre.

**Ce que ça a rapporté en garde-fous.** Un onglet ou un panneau sans module ne
compile plus ; un domaine de commandes Rust sans propriétaire fait échouer les
tests ; et quatre scénarios e2e ont été ajoutés pour ce qui n'était monté nulle
part en fenêtre réelle (terminal SSH, base de données, flotte, les neuf
panneaux). C'est plus fort que ce qui existait avant le chantier, où seul
`assertNever` couvrait le dispatch d'onglets.

**Le seul vrai piège**, à retenir au-delà de ce chantier : rendre deux champs
optionnels a suffi à vider **les deux** preuves d'exhaustivité sans qu'aucun
test ne rougisse. Trouvé parce que casser le registre exprès faisait échouer
les tests d'exécution et pas `tsc` — la divergence entre les deux était le seul
signal. D'où la règle : **un garde-fou qui repose sur l'inférence doit être
doublé d'une assertion à l'exécution.**

**Seule sortie visible pour l'utilisateur** : le masquage des boutons de la
barre latérale (Paramètres → Apparence), livré en premier parce qu'il ne
dépendait pas du registre. Le reste est à comportement identique — d'où
l'unique entrée CHANGELOG.

**Suites possibles, volontairement laissées de côté** : rapatrier dans leur
module les écritures de `SidebarActions` qui ne sont qu'un
`api.X(...).then(refreshWorkspace)` (~14 membres en moins), et fusionner le
catalogue de boutons de `lib/sidebarButtons.ts` dans le registre — un module
déclare son panneau, mais son bouton vit encore ailleurs.

---

## Livré — Trois suites de l'inventaire (2026-08-11)

Choisies après la livraison du diagnostic réseau. Les trois sont des manques
**créés ou révélés par le travail d'inventaire récent**, pas des idées
génériques : vérifié dans le code le 2026-08-11, aucune n'existe déjà.

### A. « Quels hôtes utilisent cette clé ? » — **livrée**

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

### B. Édition en lot des hôtes — **livrée**

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

### C. Inventaire périmé — **livrée (Azure, GCP)**

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

**Livré pour Azure et GCP.** Le vrai sujet a été la *portée*, et l'annoncer
d'avance a servi : un id d'instance GCP est un nombre nu qui ne porte pas le
projet, donc sans attribution, vérifier le projet A aurait rapporté tous les
hôtes du projet B comme détruits — et invité à supprimer des machines vivantes.
D'où `HostSource::scope`, en `serde(default)` pour que les hôtes importés avant
restent lisibles (ils portent `None`, et le contrôle les laisse tranquilles).
La portée est une **provenance, pas une identité** : l'appariement d'un
réimport reste sur `kind` + `id`, sinon une machine déplacée entre abonnements
serait dupliquée au lieu d'être rattachée. Le bandeau **rapporte et n'agit
pas** : une instance absente peut relever d'une permission changée ou d'un
listing partiel, et un panneau qui rangerait tout seul finirait par supprimer
quelque chose de réel. **Restent à faire : AWS et Ansible**, pour les raisons
ci-dessus. **Non prouvé** contre une vraie flotte distante.

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
**Éprouvé** contre une vraie flotte par l'utilisateur le 2026-09-08.

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

**Éprouvé** contre une vraie flotte par l'utilisateur le 2026-09-08.

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
  reste éphémère par connexion, jamais dans le panneau Tunnels. **Éprouvé par
  l'utilisateur le 2026-09-08**, après avoir longtemps reposé sur le seul
  parsing, une machine à états pilotée par un faux helper, et la migration du
  format.
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
