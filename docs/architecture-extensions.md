# Noyau + extensions — analyse et feuille de route

Écrit le 2026-08-13, en réponse à la question : « est-ce qu'on pourrait avoir un
noyau et des extensions par-dessus, pour tenir plus tard un marketplace, et
choisir à l'installation les features à télécharger ? »

**Rien n'est décidé ni commencé.** Ce document existe pour que la réflexion ne
soit pas refaite de zéro. Les chiffres ci-dessous ont été mesurés dans le dépôt
le 2026-08-13 — les revérifier avant de s'engager sur une taille (c'est la
leçon récurrente de `backlog.md`).

`backlog.md` dit quoi construire et dans quel ordre ; `dev-history.md` pourquoi
l'existant est comme il est ; ce fichier-ci tient une décision d'architecture
pas encore prise.

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

**Verdict : mauvais rapport.** Éventuellement *deux* variantes figées (Lite
SSH-only / Full), jamais N².

### B. Choisir à l'exécution (tout est compilé, l'utilisateur active ce qu'il veut)

**Coût faible, gain UX réel** : écran de premier lancement, sidebar non
surchargée. Du point de vue de l'utilisateur, ça *ressemble* à « choisir ses
features à l'installation ». C'est ce que fait VS Code pour ses extensions
intégrées. **C'est la réponse pragmatique à la demande initiale.**

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

Chaque étape a de la valeur seule.

1. **Registre de modules first-party** — aucune promesse publique. Détail en
   section 6.
2. **Activation/désactivation à l'exécution** + écran de premier lancement.
   `enabledModules` dans les préférences. Garde-fou : le noyau (SSH, vault,
   known_hosts) n'est jamais désactivable. Répond à la demande « choisir mes
   features » sans matrice de builds.
3. **Extraire un vrai module en sidecar** (candidat : Mongo ou Redis) pour
   éprouver la frontière sous contrainte réelle, en réutilisant le patron
   `rdp-ipc`. C'est là qu'on mesure les Mo réellement gagnés.
4. **Marketplace** — seulement si 3 tient : manifeste, permissions, signature,
   distribution, mises à jour.

**L'étape 1 vaut le coup même si le marketplace ne voit jamais le jour.**

---

## 6. Plan détaillé de l'étape 1 (validé le 2026-08-13, non démarré)

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

**L'étape 1 est donc presque entièrement un chantier frontend**, nettement plus
petit que la question ne le laissait craindre.

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

1. **Exhaustivité à la compilation.** Le registre expose
   `Record<TabMeta["kind"], TabContribution>` : ajouter un `kind` sans renderer
   devient une **erreur `tsc`**. Strictement plus fort que l'`assertNever`
   actuel, qui n'attrape que ce qui traverse le dispatch existant.
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

Chaque commit : `npm run verify`, `cargo clippy -D warnings`, puis build et
lancement du binaire Windows release pour un test manuel réel.

**Porte de sortie** : si le commit 2 coince, s'arrêter après le commit 1 et
garder `terminal`/`transfer`/`rdp` en dispatch manuel. Le registre reste utile
pour tout le reste.

### Hors périmètre de l'étape 1

Pas d'activation/désactivation à l'exécution (étape 2), pas de feature Cargo ni
de sidecar (étape 3), aucun changement de format `workspace.json`, aucun
renommage de commande Tauri.

**Zéro changement visible pour l'utilisateur** — volontaire : si un comportement
change, c'est une régression, pas une feature. Il n'y a donc probablement
**pas d'entrée CHANGELOG** pour ce chantier.
