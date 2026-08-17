# Noyau + extensions — analyse et feuille de route

Écrit le 2026-08-13, en réponse à la question : « est-ce qu'on pourrait avoir un
noyau et des extensions par-dessus, pour tenir plus tard un marketplace, et
choisir à l'installation les features à télécharger ? »

Révisé le 2026-08-17 : le masquage des boutons passe devant le registre et ne
passe plus par un écran de premier lancement (section 5, où il est livré) ;
l'installeur allégé est abandonné pour de bon (section 2, choix A).

**Seule l'étape 1 est faite** ; les étapes 2 à 4 restent analysées et non
commencées. Ce document existe pour que la réflexion ne soit pas refaite de
zéro. Les chiffres ci-dessous ont été mesurés dans le dépôt le 2026-08-13 —
les revérifier avant de s'engager sur une taille (c'est la leçon récurrente de
`backlog.md`).

`backlog.md` dit quoi construire et dans quel ordre ; `dev-history.md` pourquoi
l'existant est comme il est ; ce fichier-ci tient une décision d'architecture
en cours de découverte.

---

## 1. État des lieux mesuré (2026-08-13)

| Mesure | Valeur |
|---|---|
| `core/` | 58 modules, zéro dépendance Tauri |
| `src-tauri/src/commands/` | 29 domaines, un fichier chacun |
| `main.rs` | ~169 commandes listées à la main dans `generate_handler![]` |
| `src/components/` | 65 composants |
| `App.tsx` | 986 lignes, dont une cascade de `if (tab.kind === …)` |
| `dist/` | 1,9 Mo, **déjà** découpé en chunks lazy |
| `guiterm.exe` (release) | **53 Mo** — 27 Mo en juillet, doublé avec SQL/Redis/Mongo/K8s |
| `rdp-sidecar.exe` | 13 Mo |

Deux conclusions de ces chiffres :

- **Le découpage horizontal existe déjà et il est bon.** `core/` sans Tauri,
  une commande par domaine, un chunk JS par gros panneau. Ce qui manque n'est
  pas un noyau — c'est un **registre**.
- **Le poids est dans les crates Rust, pas dans le frontend.** Un `dist/` de
  1,9 Mo déjà code-splitté ne se « télécharge pas à la carte » utilement. Les
  vrais Mo sont dans `kube`, `sqlx` (postgres+mysql+sqlite bundled), `mongodb`,
  `redis`, `bollard`. Les features cloud, elles, ne pèsent presque rien :
  `cloud_cli.rs` shelle vers les CLI de l'utilisateur, aucun SDK embarqué.

Aujourd'hui, ajouter une feature veut dire éditer **quatre listes centrales à la
main** : `generate_handler!`, `api.ts`, `TabMeta`, et le dispatch d'`App.tsx`.
C'est exactement le mécanisme qui avait laissé MongoDB inatteignable.

## 2. La question en contient trois

### A. Choisir à la compilation (features Cargo + flags Vite, N installeurs)

Le sens littéral de « choisir ce que je télécharge ».

**Coût** : matrice de builds combinatoire, N installeurs à signer, CI ×N, et la
classe de bugs « ne se reproduit qu'avec la feature X désactivée ».
**Gain** : ~20 Mo sur 67.

**Verdict : mauvais rapport.** Deux variantes figées (Lite SSH-only / Full)
restaient envisageables — **abandonné le 2026-08-17**, y compris sous cette
forme réduite : voir « Ce que cette étape ne résout pas » en section 5. Le
chemin vers un binaire plus léger, si le besoin revient, est l'étape 3.

### B. Choisir à l'exécution (tout est compilé, l'utilisateur active ce qu'il veut)

**Coût faible, gain UX réel** : une barre latérale non surchargée, réglable par
celui que ça gêne. **C'est la réponse pragmatique**, à condition d'assumer ce
qu'elle n'est pas : elle ne retire rien du binaire, donc elle ne répond pas
littéralement à « choisir ce que je télécharge » (détail en section 5).

### C. Vraies extensions tierces (le marketplace)

Le précédent existe déjà dans ce dépôt : **`rdp-sidecar`** — processus séparé
piloté par un protocole IPC (`rdp-ipc`). C'est le seul modèle qui tienne :

- **Pas de dylib Rust** : aucune ABI stable, il faudrait recompiler toutes les
  extensions à chaque bump de rustc.
- **Pas de WASM** (wasmtime/extism) : nos features veulent des sockets TCP, du
  filesystem, des process — précisément ce que WASM interdit et que WASI ne
  couvre pas proprement aujourd'hui.
- **Côté UI**, React ne charge pas de code tiers à chaud sans module federation
  ni `eval`. Deux voies : contributions **déclaratives** (l'extension décrit son
  onglet/formulaire/tableau, l'app le rend avec ses propres composants — sûr et
  visuellement cohérent), ou **iframe sandboxée** + `postMessage` (plus libre,
  plus risqué).
- **Sécurité** : c'est un client SSH avec un coffre de secrets. Une extension
  tierce capable d'appeler `vault::load`, c'est terminé. Il faut un manifeste de
  permissions (`hosts:read`, `terminal:write`, `network:outbound`…), affiché à
  l'installation, plus une signature. Chantier à part entière, pas un refactor.

## 3. Ce qui doit rester noyau, non extensible

`model`/`store` (compat ascendante de `workspace.json`), `vault`, `ssh_pool`,
`known_hosts`, `activity`/`logging`, `secure_file`, et le shell d'onglets.
Tout ce qui est transversal ou porteur de secrets.

## 4. Le risque principal

**Figer l'API d'extension trop tôt.** Dès qu'il existe un marketplace, l'API est
un contrat qu'on ne peut plus casser — or les types bougent encore
(`EngineConfig` vient d'être refactoré).

Et cette frontière est **aussi la frontière open-core** (voir la stratégie
décidée le 2026-07-16) : là où elle est tracée, on décide ce qui est gratuit et
ce qui est payant. Raison de plus pour la découvrir en interne d'abord plutôt
que de la décréter.

## 5. Feuille de route en 4 étapes

Chaque étape a de la valeur seule. **Renumérotée le 2026-08-17** : le masquage
passe devant le registre. Il n'en dépendait pas — `Sidebar.tsx` portait déjà
une table `TABS`, seul point d'accroche nécessaire — et rien ne justifiait
qu'une amélioration d'une demi-journée attende un refactor taille M dont le
bénéfice est interne.

1. **Masquer les boutons de la barre latérale**, réglable dans les préférences
   — **fait le 2026-08-17**, pas d'écran de premier lancement (voir juste en
   dessous). `hiddenSidebarButtons` dans les préférences, tout visible par
   défaut, `hosts` jamais masquable.
2. **Registre de modules first-party** — aucune promesse publique. Détail en
   section 6. `lib/sidebarButtons.ts`, écrit à l'étape 1, en est la graine :
   c'est déjà « une liste de contributions déclarée hors du composant », mais
   sur le seul axe des boutons de barre.
3. **Extraire un vrai module en sidecar** (candidat : Mongo ou Redis) pour
   éprouver la frontière sous contrainte réelle, en réutilisant le patron
   `rdp-ipc`. C'est là qu'on mesure les Mo réellement gagnés.
4. **Marketplace** — seulement si 3 tient : manifeste, permissions, signature,
   distribution, mises à jour.

**Le registre vaut le coup même si le marketplace ne voit jamais le jour.**

### Pourquoi pas d'écran de premier lancement (révisé le 2026-08-17)

La première version de cette étape proposait un écran d'onboarding où
l'utilisateur cochait ses modules, façon VS Code. Écarté après discussion, pour
trois raisons — la troisième étant la vraie :

- **On demande au moment où l'utilisateur en sait le moins.** Il vient
  d'installer un client SSH ; il ne peut pas savoir s'il aura besoin de Redis ou
  du diagnostic réseau. Il coche tout (l'écran n'a servi à rien) ou coche au
  hasard et perd des fonctionnalités dont il ignorera l'existence.
- **Ça met de la friction avant la première valeur.** Le premier lancement doit
  mener à « je me connecte à un serveur », pas à un formulaire.
- **Le gain est nul tant que l'étape 3 n'existe pas.** Tout reste compilé dans
  le binaire de toute façon : désactiver un module ne fait que cacher une icône.
  Ce serait du rangement d'UI présenté comme un choix d'installation — et ça
  **arme volontairement** la classe de bugs « la fonctionnalité existe mais
  l'utilisateur ne la trouve pas », c'est-à-dire le mode d'échec de MongoDB.

Ce qui reste, et qui suffit : **un réglage dans les préférences existantes**.
Celui que ça encombre range ; les autres ne voient jamais la question. C'est une
petite fraction du travail initialement prévu, et l'essentiel de sa valeur.

Le périmètre réel est d'ailleurs plus étroit que « 14 modules » : les onglets
n'apparaissent que si on les ouvre. Ce qui encombre visuellement, c'est la barre
verticale de gauche. Un réglage « quels boutons afficher » couvre la plainte
concrète sans introduire une notion de « module » visible par l'utilisateur —
notion qu'il vaut mieux ne pas exposer avant que l'étape 3 lui donne un sens.

**Contrainte à ne pas rater** : les préférences vivent dans le `localStorage` de
la webview, donc une installation déjà utilisée n'hérite jamais d'un défaut
modifié (piège documenté dans `CLAUDE.md`). Le réglage est donc une liste de
**masqués** et non d'affichés — absente, elle vaut « rien de masqué ». Une
liste d'affichés ferait disparaître tous les boutons chez les utilisateurs
actuels à la première mise à jour.

### Ce qui a été livré le 2026-08-17

`src/lib/sidebarButtons.ts` — catalogue (ordre, libellés, infobulles),
`ALWAYS_VISIBLE_SIDEBAR_BUTTONS` (`hosts` seul) et `resolveVisiblePanel`.
`hiddenSidebarButtons` dans `AppPreferences`, section « Boutons de la barre
latérale » dans l'onglet Apparence des paramètres.

Trois décisions prises en cours de route :

- **Flotte et Diagnostic réseau rejoignent la même liste.** Ils étaient codés
  en dur hors de `TABS` parce qu'ils ouvrent un onglet au lieu de changer de
  panneau — mais du point de vue du réglage, c'est un bouton comme un autre.
  Le dispatch `panel`/`onglet` tient en trois lignes dans `Sidebar.tsx`.
- **Le repli est calculé au rendu**, pas dans un effet au changement de
  réglage : `App.tsx` passe `resolveVisiblePanel(sidebarPanel, …)` plutôt que
  `sidebarPanel`. Un panneau masqué dans une session précédente ne peut donc
  pas survivre à un rechargement, et masquer le panneau ouvert retombe sur
  « Hôtes » immédiatement.
- **Masquer ne désactive rien** : onglets ouverts conservés, palette de
  commandes complète, backend inchangé. C'est écrit dans l'UI même du réglage.
  C'est ce qui rend l'étape sûre — et ce qui la distingue de l'étape 3.

Garde-fous (`src/lib/sidebarButtons.test.ts`), chacun vérifié en le cassant
volontairement une fois : un `Record<SidebarButtonId, …>` côté icônes rend
l'ajout d'un bouton sans icône impossible à compiler ; deux `Record` dans le
test font échouer `tsc` si un bouton ou un panneau n'y est pas déclaré, et les
assertions attrapent alors l'oubli symétrique dans le catalogue ; `hosts` reste
visible même listé comme masqué ; `settings` ne retombe jamais sur « Hôtes ».
Plus un plancher anti-vacuité.

### Ce que cette étape ne résout pas

Elle ne répond **pas** à « choisir les features à télécharger à
l'installation », malgré l'apparence. Rien n'est retiré du binaire, qui reste à
53 Mo et continuera de grossir.

**Tranché le 2026-08-17 : c'est assumé, l'installeur allégé est abandonné.** Le
masquage était jugé préférable, le choix A de la section 2 (variantes figées)
trop gros pour ce qu'il rapporte. Abandonner A ne coûte aucune option : si le
poids devient un vrai problème, la réponse est l'étape 3 (sidecars), meilleure
sur tous les axes — module par module, pas de matrice de builds, et un patron
qui tourne déjà dans ce dépôt. On ne renonce pas à un binaire plus léger, on
renonce à la mauvaise façon de l'obtenir.

---

## 6. Plan détaillé du registre de modules (validé le 2026-08-13, non démarré)

Étape 2 depuis la renumérotation du 2026-08-17 — le plan lui-même n'a pas
bougé.

### Ce qu'il ne faut PAS toucher, et pourquoi

- **Le côté Rust est déjà couvert.** `src/lib/tauriCommands.test.ts` vérifie
  déjà les deux sens : aucune commande invoquée qui n'existe pas, **et** aucune
  commande Rust qu'aucun binding n'atteint. Le garde-fou qui manquait à MongoDB
  est en place — rien à ré-inventer côté backend à cette étape.
- **`generate_handler![]` reste une liste littérale.** C'est une macro : elle ne
  peut pas être alimentée dynamiquement sans gymnastique `macro_rules!` (TT
  muncher) qui coûterait plus cher qu'elle ne rapporte. On la **regroupe par
  module avec des en-têtes de commentaire**, cosmétique, zéro risque. Le vrai
  découpage Rust, c'est l'étape 3.
- **`core/` ne bouge pas** — déjà la meilleure frontière du dépôt.
- **`api.ts` reste le point de passage unique** — invariant testé, ne pas le
  casser.

**Le registre est donc presque entièrement un chantier frontend**, nettement
plus petit que la question ne le laissait craindre.

### L'obstacle réel, nommé d'avance

`HostsPanel` reçoit **~18 callbacks** depuis `App.tsx`. `SqlConnectionTab`,
`NetDiagTab`, `FleetTab`, `TerminalTab` ont chacun une signature complètement
différente. **Un registre qui exigerait une signature uniforme est une
fiction** — c'est là que ce genre de refactor échoue d'habitude.

Solution, celle de VS Code/Theia : une contribution n'est pas un composant, mais
**une fonction de rendu recevant un contexte typé**, qui se referme sur ce dont
elle a besoin. Les composants eux-mêmes ne changent pas ; on déplace seulement
*où* ils sont invoqués.

```ts
// src/modules/types.ts
export interface AppContext {
  workspace: Workspace;
  preferences: AppPreferences;
  reportError: (e: unknown) => void;
  pushNotification: (tone: "success" | "error", msg: string) => void;
  refreshWorkspace: () => Promise<void>;
  closeTab: (id: string, reason?: string) => void;
  registerTerminalHandle: (id: string, h: TerminalTabHandle | null) => void;
  notifyLongCommand: …; mirrorInput: …;
}

export interface ModuleDef {
  id: ModuleId;
  label: string;
  tabs?: { kind: TabMeta["kind"]; render(tab, ctx: AppContext, isActive: boolean): ReactNode }[];
  panels?: { key: SidebarPanelKind; label: string; Icon: …; render(ctx: AppContext): ReactNode }[];
  paletteCommands?(ctx: AppContext): PaletteCommand[];
  tauriCommands: readonly string[];  // ← ce qui rend le module testable
}
```

### Fichiers touchés

**Nouveaux**

| Fichier | Rôle |
|---|---|
| `src/modules/types.ts` | `ModuleDef`, `AppContext`, contributions |
| `src/modules/registry.ts` | la liste `MODULES` + les lookups |
| `src/modules/registry.test.ts` | les garde-fous ci-dessous |
| `src/modules/*.tsx` | un par module : `terminal`, `transfer`, `rdp`, `fleet`, `activity`, `netdiag`, `database`, `hosts`, `sftp`, `snippets`, `tunnels`, `keychain`, `aws`, `knownHosts` |

**Modifiés**

| Fichier | Changement |
|---|---|
| `src/App.tsx` (986 l.) | cascade `if (tab.kind === …)` (L.755-870 au 2026-08-13) → lookup registre ; construit `AppContext` ; devrait retomber vers ~400 lignes |
| `src/components/Sidebar.tsx` (270 l.) | `TABS` (L.87-96) et la cascade `panel === …` (L.170+) → dérivés du registre |
| `src/lib/types.ts` | inchangé — `TabMeta` reste la source de vérité |
| `src-tauri/src/main.rs` | regroupement de `generate_handler!` par module (commentaires seuls) |
| `src/lib/tauriCommands.test.ts` | +1 assertion (ci-dessous) |

### Garde-fous — « quel test échouerait si je m'étais trompé ? »

1. **Exhaustivité à la compilation.** Ajouter un `kind` sans renderer doit être
   une **erreur `tsc`**. Strictement plus fort que l'`assertNever` d'avant, qui
   n'attrapait que ce qui traversait le dispatch existant. **En place depuis le
   commit 3** — sous la forme `_EveryTabKindHasAModule` plutôt que du
   `Record<TabMeta["kind"], TabContribution>` prévu ici : un `Record` littéral
   dupliquerait la liste des modules, et le construire par `Object.fromEntries`
   perd justement l'exhaustivité qu'on cherche. Un `Exclude<…>` contraint à
   `never` la retrouve sans duplication.

   Point non anticipé : un registre consulté à l'exécution est **invisible pour
   `tsc`**, donc pendant la migration ce garde-fou devait couvrir aussi les
   `kind` restés dans `App.tsx`, sous peine d'être plus faible que la cascade
   qu'il remplaçait. D'où la liste transitoire `TABS_STILL_IN_APP`, vidée et
   supprimée au commit 3.
2. **Complétude module ↔ commandes.** Nouvelle assertion : l'union des
   `tauriCommands` de tous les modules **est exactement** l'ensemble de
   `generate_handler!`. Une commande Rust n'appartenant à aucun module devient
   une erreur — c'est ce qui rendra l'étape 3 mécanique.
3. **Anti-vacuité**, comme dans le test existant : un plancher sur la taille des
   ensembles, sinon une regex qui cesse de matcher rend tout vert.

Chaque garde-fou doit être **cassé une fois volontairement** pour vérifier qu'il
échoue vraiment.

### Découpage en commits (tranches verticales)

1. **Mécanisme + 3 modules simples** — `src/modules/`, `AppContext` extrait
   d'`App.tsx`, migration d'`activity`/`netdiag`/`fleet` (onglets seuls, peu de
   props). Le mécanisme est prouvé sur du réel avant de toucher au délicat.
2. **Modules liés à un hôte** — `terminal`/`transfer`/`rdp`. **Le seul commit
   vraiment risqué** : `terminalRefs`, split pane et broadcast traversent
   `App.tsx` de part en part. À isoler seul pour rester relisible.
3. **Modules bases de données** — `sql`/`redis`/`mongo` + panneau `database`.
4. **Panneaux sidebar restants** — `hosts` (le gros, ~18 callbacks), `sftp`,
   `snippets`, `tunnels`, `keychain`, `aws`, `knownHosts`.
5. **Complétude Rust** — regroupement de `main.rs` + assertion 2.

**Découpage réellement suivi** (2026-08-17). Les commits 1 et 2 sont partis
comme prévu. Le commit 3 a été redécoupé sur un axe plutôt que sur un domaine :

- `sql` couvre déjà `redis` et `mongo` — les trois partagent un seul `kind`
  d'onglet, `SqlConnectionTab` faisant le tri par moteur. Il n'y avait donc pas
  trois modules à écrire, mais un.
- `local-terminal`, que le découpage n'assignait à aucun commit, y a été
  ajouté. Sans lui l'axe « onglets » restait incomplet pour un seul cas
  trivial, et c'est sa complétude qui débloque le vrai garde-fou : un
  `Record<TabMeta["kind"], …>` exhaustif à la place de la liste transitoire
  `TABS_STILL_IN_APP`.
- Le **panneau** `database` a été renvoyé au commit 4. C'est un autre axe de
  contribution (panneaux de barre latérale, pas onglets) et le traiter seul
  aurait demandé d'inventer cet axe pour un panneau sur huit.

Le commit 3 livre donc « l'axe onglets est complet », et le 4 ouvrira l'axe
panneaux avec les huit d'un coup.

Chaque commit : `npm run verify`, `cargo clippy -D warnings`, puis build et
lancement du binaire Windows release pour un test manuel réel.

**Porte de sortie** : si le commit 2 coince, s'arrêter après le commit 1 et
garder `terminal`/`transfer`/`rdp` en dispatch manuel. Le registre reste utile
pour tout le reste.

### Hors périmètre du registre

Pas de feature Cargo ni de sidecar (étape 3), aucun changement de format
`workspace.json`, aucun renommage de commande Tauri. Le masquage des boutons
est déjà livré et lui est antérieur — le registre devra reprendre
`lib/sidebarButtons.ts` comme contribution parmi d'autres, pas le contourner.

**Zéro changement visible pour l'utilisateur** — volontaire : si un comportement
change, c'est une régression, pas une feature. Il n'y a donc probablement
**pas d'entrée CHANGELOG** pour ce chantier.
