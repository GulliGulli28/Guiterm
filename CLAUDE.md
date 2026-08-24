## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).

## Le projet en bref

**Guiterm** (anciennement `gui-termius`, renommé le 2026-07-16) est un
client SSH/SFTP de bureau (Tauri 2 + Rust + React/TypeScript), en licence
MIT (stratégie open-core). Voir `README.md` pour la présentation complète
des fonctionnalités et de la structure du dépôt.

Le dépôt garde volontairement `gui-termius`/`termius` à plusieurs endroits
internes non visibles de l'utilisateur (crate `termius-core`, nom de
service du trousseau OS, dossier de config `%APPDATA%\gui-termius\...`, clés
`localStorage`) — les renommer casserait silencieusement la config/les
secrets déjà enregistrés sur les machines des utilisateurs. Détail complet
dans `docs/dev-history.md` (« Renommage »).

Découpage du code Rust :
- `core/` — logique métier pure (SSH via `russh`, SFTP/Docker/K8s exec,
  vault, known_hosts, parsing `~/.ssh/config`, persistance du workspace,
  moteur de flotte/snippets adaptatifs). Ne dépend pas de Tauri.
- `src-tauri/src/commands/` — une commande Tauri par domaine, fine couche
  au-dessus de `core/`. C'est là qu'ajouter une nouvelle commande invocable
  depuis le frontend.
- `src/lib/api.ts` — unique point de passage frontend → Tauri (`invoke(...)`).
  Toute nouvelle commande Rust doit avoir son entrée ici, typée.
- `rdp-sidecar/` — process séparé pour le rendu RDP intégré, avec son propre
  workspace Cargo (voir plus bas pourquoi).

Pour l'historique détaillé des décisions, des bugs déjà corrigés et des
spécifications fines de chaque fonctionnalité (protocoles, grammaires,
bugs par date), voir `docs/dev-history.md` — non chargé automatiquement en
contexte, à consulter à la demande. Ce fichier-ci se limite à ce qu'il faut
savoir pour travailler efficacement dans ce dépôt au quotidien.

## Environnement de dev (important)

Le dépôt est monté depuis WSL (`\\wsl.localhost\Ubuntu-24.04\...`). Pour de la
vérification rapide (`cargo check`, `cargo test`, `tsc`, `npm run build`),
passer par WSL explicitement — c'est l'environnement Rust "par défaut" de ce
projet (`termius-core` y tourne ses tests d'intégration, qui ont besoin d'un
vrai `sshd` Unix) :

```bash
wsl.exe -e bash -lc "cd ~/gui-termius/src-tauri && cargo check"
```

**Rust existe aussi nativement sur Windows sur cette machine** (rustup, MSVC
Build Tools, WebView2 Runtime — tous déjà installés), mais `cargo`/`rustc`/
`tauri-driver` ne sont **pas sur le PATH d'une session PowerShell fraîche** :
soit invoquer par chemin complet (`$env:USERPROFILE\.cargo\bin\cargo.exe`),
soit ajouter au PATH de la session
(`$env:PATH += ";$env:USERPROFILE\.cargo\bin"`) — ne pas conclure « cargo
n'est pas installé côté Windows » juste parce que `Get-Command cargo` échoue.
C'est nécessaire pour le pipeline E2E WebView2 (section suivante), qui doit
tourner nativement sous Windows (WebView2 n'existe pas sous Linux).

Le frontend (`npm`, `npx tsc`, `vite build`) peut tourner indifféremment côté
Windows natif ou via WSL — mais **jamais mélanger les deux pour le même
`node_modules`** : `npm install` choisit des binaires natifs par plateforme
(`esbuild`, `rollup`...) au moment de l'install, donc un `node_modules`
installé sous WSL ne fait pas tourner Vite nativement sous Windows (et
inversement). Ce dépôt n'a qu'un seul `node_modules`, installé côté WSL —
rester cohérent là-dessus pour un même enchaînement de commandes évite les
surprises de cache dupliqué ou d'échecs de résolution de binaire natif.

**Accès écran réel : oui, via WSLg.** Ce WSL a un vrai serveur X actif
(`DISPLAY=:0`, `xdpyinfo`/`xrandr` répondent, résolution réelle détectée).

## `npm run verify` — tout vérifier en une commande

Les contrôles vivent dans deux chaînes d'outils (Node et Cargo) et six
commandes. `npm run verify` (`scripts/verify.mjs`) les enchaîne dans l'ordre
du CI, continue même quand une étape échoue, et affiche un récapitulatif —
une étape oubliée devient visible au lieu de passer inaperçue jusqu'au push.

```bash
wsl.exe -e bash -lc "cd ~/gui-termius && npm run verify"           # ~2-4 min
wsl.exe -e bash -lc "cd ~/gui-termius && npm run verify -- --fast" # types + lint seuls
wsl.exe -e bash -lc "cd ~/gui-termius && npm run verify -- --e2e"  # + vraie fenêtre WebDriver
```

Ça ne remplace pas le lancement manuel du binaire Windows (section plus bas) :
`verify` prouve que le code est correct, pas qu'une fonctionnalité est agréable
à utiliser.

**Node vient de nvm, pas d'apt** (depuis le 2026-07-27). `/usr/bin/node` est
toujours le 18.19 installé par apt, mais `~/.nvm` fournit un Node 20 (alias
`default`), activé par un snippet ajouté à **`~/.profile` *et* `~/.bashrc`** —
les deux sont nécessaires : `~/.bashrc` sort immédiatement pour un shell non
interactif (« If not running interactively, don't do anything »), or c'est
exactement ce qu'utilise l'outillage (`wsl.exe -e bash -lc ...`). Si `node -v`
répond 18 dans un contexte donné, c'est que ce snippet n'a pas été chargé.

Ça a levé les deux contournements que Node 18 imposait : le script `lint` est
revenu au formateur par défaut d'ESLint (`stylish` appelle `util.styleText`,
absent avant Node 20.12), et vitest est passé du pin `^2` à `^3`. **Pas à
`^4`** : vitest 4 exige vite ≥ 6 et ce dépôt est en vite 5 — un chantier de
mise à jour à part entière, pas un simple bump.

## Vérification Rust : `clippy -D warnings` est un gate CI bloquant

Le workflow GitHub (job **`windows-workspace`**) lance
`cargo clippy --workspace --all-targets -- -D warnings` : **le moindre warning
clippy fait échouer le push**. `cargo check` / `cargo test` ne déclenchent PAS
les lints clippy — il faut donc lancer clippy explicitement avant de considérer
une tâche Rust terminée, sinon le CI casse. En local, via WSL :

```bash
wsl.exe -e bash -lc "cd ~/gui-termius && cargo clippy --workspace --all-targets -- -D warnings"
```

Piège : clippy interrompt la compilation d'une crate dès sa première erreur,
donc tant que `termius-core` échoue ses lints, ceux de `gui-termius` restent
invisibles — corriger, relancer, itérer jusqu'à zéro. `rdp-sidecar` est un
workspace Cargo séparé (voir plus bas) : `cargo clippy` à la racine ne le
couvre pas, le lancer séparément dedans.

## Tests E2E réels — OBLIGATOIRE avant de clore une tâche UI/terminal

`cargo check` / `tsc --noEmit` / `npm run build` prouvent que le code
compile, pas qu'une fonctionnalité marche. Pour toute tâche qui touche à un
composant React, un terminal (`TerminalTab`/`LocalTerminalTab`), une
interaction clavier/souris, ou tout chemin passant par `invoke(...)`, il ne
suffit **pas** de s'arrêter à la compilation : lancer
**`npm run test:e2e`** (voir `scripts/e2e-run.mjs`) fait partie intégrante de
la vérification, au même titre que `cargo check`/`tsc` — pas une étape
optionnelle réservée à « si j'ai le temps ». Si la commande échoue ou que le
setup manque, le dire explicitement plutôt que de conclure sur la seule
compilation.

Ce que fait `npm run test:e2e` : il démarre `tauri-driver` (et Vite si
besoin), pilote le **vrai binaire compilé** via le protocole WebDriver,
vérifie que la fenêtre s'ouvre, que React a bien monté (`#root`), prend une
vraie capture d'écran (`scripts/.output/e2e-smoke.png`, gitignored) puis
nettoie tous les processus qu'il a lancés. Contrairement à Puppeteer/
Playwright pointé sur `http://localhost:1420` (qui ne voit jamais
`window.__TAURI__` — un vrai navigateur n'est pas une webview Tauri), ceci
exécute du vrai code `invoke(...)`. Le script est **cross-platform** et
détecte l'environnement d'exécution :

|                    | Linux (WSLg)                    | Windows natif                          |
|--------------------|----------------------------------|-----------------------------------------|
| Rendu               | WebKitGTK                       | **WebView2** (ce que les utilisateurs lancent réellement) |
| Pilote natif        | `WebKitWebDriver`               | `msedgedriver.exe`                      |
| Build testé         | debug (`cargo build`)           | release (`cargo build --release --features tauri/custom-protocol`) |
| Sert le frontend via| Vite dev server (`devUrl`)      | `dist/` embarqué dans le binaire (`frontendDist`) |

Setup one-time (tauri-driver, msedgedriver, NASM…) déjà fait sur cette
machine pour les deux plateformes — si à refaire, voir `docs/dev-history.md`
pour les commandes et les pièges déjà rencontrés (NASM manquant, lock file
sur chemin UNC, `npm run` sur cwd UNC, feature `custom-protocol`
manquante...).

**Avant de lancer `npm run test:e2e`**, s'assurer que le binaire correspondant
à la plateforme existe et est à jour. Depuis Windows, définir
`$env:CARGO_TARGET_DIR` avant de lancer le script (même valeur qu'au build)
pour qu'il retrouve le bon binaire, et invoquer `node scripts\e2e-run.mjs`
directement plutôt que `npm run test:e2e` (piège `npm`/UNC, voir
« Pièges déjà rencontrés » plus bas).

Pour étendre la couverture E2E : ajouter des scénarios dans la fonction
`runScenarios()` de `scripts/e2e-run.mjs` plutôt que d'écrire un nouveau
script séparé à chaque fois — le même scénario tourne sur les deux
plateformes sans modification.

**Techniques plus légères, en complément (pas en remplacement)** : tests
unitaires purs (`npm run test`, vitest — piège Node : vitest ≥ 4 exige Node
≥ 20, ce WSL est en 18.19, utiliser `vitest@^2`) pour la logique découplée
de React/xterm/Tauri ; rendu DOM réel dans un Chromium headless (Playwright,
sans Tauri) pour ce qui dépend de la **géométrie** ou d'un **geste**, que ni
`tsc` ni vitest ne peuvent voir faute de moteur de rendu — voir
`scripts/visual-check-ghost-text.*` (positionnement sur la grille xterm) et
`npm run check:transfer` (`visual-check-transfer-{columns,dnd}.*` : alignement
des colonnes du panneau de transfert à plusieurs tailles de police, et vrai
glisser-déposer à la souris entre deux panneaux). Un composant peut y être
monté seul s'il ne parle à Tauri que par ses callbacks — c'est pour ça que
`PaneView` est exporté. Aucune de ces techniques ne couvre ce qui passe
par `invoke(...)` (`window.__TAURI__` n'existe que dans la vraie webview
Tauri) — c'est exactement ce que `npm run test:e2e` couvre.

## Lancer l'app Windows en conditions réelles — OBLIGATOIRE après un changement

Demande explicite de l'utilisateur : les vérifications automatisées prouvent
que le code compile et que la fenêtre s'ouvre sans crasher, mais aucune ne
remplace un humain qui clique réellement dans l'app. **Après un changement
qui touche le comportement de l'app (UI, commande Tauri, logique métier —
pas seulement des tests/docs/scripts), construire et lancer le vrai binaire
natif Windows (WebView2, ce que l'utilisateur lance réellement) pour qu'il
puisse tester lui-même**, en plus des vérifications automatisées
habituelles, jamais à leur place.

Séquence (mêmes pièges que « Tests E2E réels » ci-dessus — NASM/PATH,
`CARGO_TARGET_DIR` sur un chemin NTFS natif jamais UNC, feature
`custom-protocol` obligatoire pour embarquer `dist/`, tuer un
`guiterm.exe`/`rdp-sidecar.exe` resté ouvert avant de rebuilder sous peine de
`PermissionDenied` sur la copie du binaire) :

```bash
# 1. Frontend — seulement si des fichiers de src/ ont changé (inutile pour
#    un changement 100% Rust) :
wsl.exe -e bash -lc "cd ~/gui-termius && npm run build"
```
```powershell
# 2. Binaire Windows natif release (embarque le dist/ de l'étape 1) :
$env:PATH += ";$env:USERPROFILE\.cargo\bin;C:\Program Files\NASM"
$env:CARGO_TARGET_DIR = "$env:USERPROFILE\gui-termius-target-windows"
Get-Process guiterm,rdp-sidecar -ErrorAction SilentlyContinue | Stop-Process -Force
Set-Location "\\wsl.localhost\Ubuntu-24.04\home\glorin\gui-termius\src-tauri"
& "$env:USERPROFILE\.cargo\bin\cargo.exe" build --release --features tauri/custom-protocol

# 3. Lancer, détaché (ne doit jamais bloquer la session) :
Start-Process "$env:CARGO_TARGET_DIR\release\guiterm.exe"
```

Prévenir l'utilisateur une fois la fenêtre lancée plutôt que de simplement
dire « c'est vérifié » — c'est lui qui teste, pas l'agent. Le binaire de dev
(`cargo build` sans `--release --features tauri/custom-protocol`, celui que
`npm run test:e2e` pilote sous WSL/WebKitGTK) ne compte pas pour cette étape :
il charge `devUrl` (Vite), pas `dist/`, et tourne sous WebKitGTK, pas
WebView2 — l'un ne remplace pas l'autre, voir le tableau de la section E2E
ci-dessus. Inutile de reconstruire pour un changement qui ne touche que des
fichiers de test, de documentation, ou des scripts (`scripts/*.mjs`) sans
effet sur `src/`/`src-tauri/`/`core/`.

## Définition de « fini » : atteignable, pas seulement compilable

Tous les gates ci-dessus répondent à « est-ce que le code marche ». Aucun ne
répond à « est-ce que l'utilisateur peut y accéder ». C'est par là que MongoDB
est parti en release annoncé comme livré alors qu'il était **inatteignable** :
backend complet, commandes Tauri enregistrées, bindings `api.ts`, types, smoke
test — mais l'onglet React jamais écrit, et un ternaire dans `App.tsx` qui
envoyait silencieusement les connexions MongoDB dans le `SqlTab`. `cargo
check`, clippy `-D warnings`, 218 tests Rust, `tsc`, les tests frontend et
l'E2E étaient tous verts (détail dans `docs/dev-history.md`).

Trois règles qui en découlent :

- **Une fonctionnalité n'est finie que si le chemin complet a été parcouru** :
  formulaire → onglet → donnée réelle affichée. Qu'une commande Tauri réponde
  ne prouve rien sur son accessibilité. Si un morceau du chemin manque, le
  dire explicitement plutôt que de conclure sur la compilation.
- **Écrire l'entrée CHANGELOG en dernier**, après le test manuel — jamais en
  même temps que le code. Écrite d'avance, elle transforme une fonctionnalité
  à moitié faite en fonctionnalité officiellement livrée.
- **Un `if`/ternaire sur une union discriminée est un trou pour tous les
  outils.** Fermer ces dispatches avec `assertNever` (`src/lib/exhaustive.ts`) :
  ajouter une variante sans décider de son rendu devient une erreur `tsc`.

Trois filets existent maintenant, à étendre plutôt qu'à contourner :
`src/lib/exhaustive.ts` (exhaustivité à la compilation),
`src/components/SqlConnectionTab.test.ts` (quel composant rend quel moteur),
et `src/lib/tauriCommands.test.ts` (les noms de commandes invoqués existent
côté Rust, aucune commande Rust n'est inatteignable, et `api.ts` reste le
point de passage unique).

## Stockage des secrets : trousseau OS ou coffre chiffré (opt-in)

`core/src/vault.rs` est le point de passage unique pour les mots de passe et
passphrases, avec un état à 3 modes (`Keychain` / `Locked` / `Unlocked`) — mais
`store`/`load`/`delete` gardent la même signature quel que soit le backend, donc
`ssh::authenticate` et `commands/hosts.rs` n'ont pas à s'en soucier.

- **Par défaut** : trousseau OS (`keyring`), fallback mémoire quand il n'existe
  pas (WSL/headless), perdu au redémarrage.
- **Coffre chiffré (opt-in)** : dès qu'un mot de passe maître est défini, un
  fichier `secrets.enc` (Argon2id + XChaCha20-Poly1305, schéma à enveloppe
  DEK/KEK — `core/src/{crypto,master_vault}.rs`) remplace le trousseau. Portable/
  syncable, marche sans trousseau OS, verrouillé au lancement.

**Cas particulier des clés privées** : leur contenu PEM reste dans
`workspace.json` (0600) en mode trousseau, mais bascule dans le coffre chiffré
quand il est déverrouillé — via `vault::{load,store,delete}_key_content` +
`is_unlocked`, PAS via le trousseau OS (taille limitée sous Windows, et le
fallback WSL le perdrait). `ssh::authenticate` lit le PEM dans l'ordre
**coffre → workspace.json → fichier d'origine**.

Ne pas tester le flux complet activer→migrer→se-connecter en E2E automatique :
il faut un vrai `sshd` ET ça muterait le `secrets.enc` réel du profil. Le crypto
est couvert par tests unitaires (`crypto.rs`, `master_vault.rs`).

## RDP intégré (rendu réel) : architecture sidecar

Le rendu RDP intégré (`RdpTab.tsx`, onglet « Aperçu intégré ») ne tourne
**pas** dans le binaire principal `guiterm` : c'est un processus séparé,
`rdp-sidecar`, lancé par `commands/rdp_view.rs` et piloté par un protocole
maison sur stdin/stdout (`rdp-ipc`). C'est l'unique mode de connexion RDP de
l'app (un lanceur système historique vers `mstsc.exe`/`xfreerdp` a existé un
temps puis a été retiré, voir `docs/dev-history.md`).

### Pourquoi un processus RDP séparé

`ironrdp-connector` (client RDP) dépend transitivement de `picky`, qui pin
une version *exacte* de `ecdsa`. `russh` — déjà utilisé partout dans `core/`
pour SSH — pin lui aussi une version exacte, mais différente. Deux pins
exacts différents de la même crate dans un seul graphe de dépendances Cargo
ne peuvent **jamais** être résolus (vérifié aussi bien sur la dernière
version publiée de `picky` que sur sa branche `master`) — pas un problème
qu'un `cargo update` réglerait. Toute tentative d'ajouter `ironrdp-connector`
comme dépendance directe ou transitive de `core/` (donc de `src-tauri`
aussi) échoue la résolution Cargo dès `cargo check`.

**Un membre de workspace n'isole rien** — Cargo résout un seul graphe de
dépendances unifié pour tous les membres d'un même workspace, qu'ils
dépendent les uns des autres ou non. La seule vraie isolation est un
`[workspace]` **séparé** (son propre `Cargo.lock`), relié au reste du dépôt
uniquement par une dépendance `path = "..."` vers un crate sans dépendance à
risque :

```
Cargo.toml (workspace racine : core, src-tauri, rdp-ipc)
  └─ src-tauri dépend de rdp-ipc (path) — jamais de rdp-sidecar
rdp-sidecar/Cargo.toml ([workspace] séparé, members = ["."])
  └─ dépend de rdp-ipc (path) + ironrdp — jamais de core/russh
```

`rdp-ipc` (protocole de communication) ne dépend que de
`tokio`/`serde`/`serde_json` — sûr à partager entre les deux workspaces.

### Build : commandes et piège à connaître

```bash
# WSL/Linux
wsl.exe -e bash -lc "cd ~/gui-termius/rdp-sidecar && cargo build --release"
```
```powershell
# Windows natif (mêmes pièges de PATH/NASM que la section E2E)
$env:PATH += ";$env:USERPROFILE\.cargo\bin;C:\Program Files\NASM"
Set-Location "\\wsl.localhost\Ubuntu-24.04\home\glorin\gui-termius\rdp-sidecar"
& "$env:USERPROFILE\.cargo\bin\cargo.exe" build --release
```

`tauri.conf.json` déclare `bundle.externalBin: ["binaries/rdp-sidecar"]`.
**Le seul geste manuel nécessaire** : copier le binaire compilé vers
`src-tauri/binaries/rdp-sidecar-<triple-hôte>[.exe]` (suffixe de triple
obligatoire). `src-tauri/binaries/` est gitignored — après un `git clone`
frais ou un changement de plateforme de build, ce binaire doit être
reconstruit et recopié, **sinon même `cargo check` sur `gui-termius` échoue**
(`tauri-build`'s `build.rs` vérifie que le chemin existe avant de compiler
quoi que ce soit d'autre) :

```bash
wsl.exe -e bash -lc "cd ~/gui-termius/rdp-sidecar && cargo build && \
  cp target/debug/rdp-sidecar ../src-tauri/binaries/rdp-sidecar-x86_64-unknown-linux-gnu"
```

Une fois ce fichier en place, n'importe quel `cargo build`/`run`/`tauri dev`
sur `gui-termius` qui redéclenche `build.rs` copie automatiquement la bonne
version à côté de l'exécutable principal (sans suffixe de triple) — pas
besoin de le refaire à la main à chaque changement.

Pour le protocole `rdp-ipc`, les bugs déjà corrigés (CryptoProvider,
redimensionnement/Deactivation-Reactivation, presse-papiers CLIPRDR,
glisser-déposer de fichiers) et le détail de ce qui fonctionne/reste
limité (pas de curseur rendu, molette approximative), voir
`docs/dev-history.md`.

## Pièges déjà rencontrés (pour ne pas les redécouvrir)

- **Choisir un hôte passe par `HostTreePicker`, jamais par un `<select>`.**
  Les douze champs de sélection d'hôte de l'app affichent l'arborescence de
  dossiers et les tags, comme la barre latérale
  (`src/components/HostTreePicker.tsx` : bouton déroulant, boîte de dialogue,
  ou liste nue ; `TargetTreeList` + `lib/targetTree.ts` pour les listes à
  cocher de la flotte et du diagnostic réseau, qui mélangent hôtes,
  conteneurs Docker et pods K8s). Un `<option>` natif ne peut porter ni
  pastille ni indentation, et `<optgroup>` ne s'imbrique pas — d'où le
  composant maison. `src/lib/hostPickers.test.ts` fait échouer tout retour à
  une liste plate et tient l'inventaire des fichiers concernés ;
  `npm run check:hosts` vérifie le rendu réel (indentation, pastilles,
  recherche par tag) dans un vrai navigateur.

- **Drag-and-drop natif vs Tauri.** Sur Windows, le drag-and-drop OS-level de
  Tauri (nécessaire pour déposer des fichiers depuis l'Explorateur, cf.
  `dragDropEnabled` / `onDragDropEvent`) désactive le drag-and-drop HTML5 natif
  du navigateur pour toute la fenêtre. Un `draggable`/`onDragStart` classique
  ne fonctionne donc pas pour un drag *interne* à l'app tant que ce mécanisme
  OS reste actif — implémenter le drag interne à la souris
  (`mousedown`/`mousemove`/`mouseup`) plutôt qu'avec l'API HTML5 Drag and Drop.

- **Un shell distant est neuf à chaque connexion — sauf en session
  persistante.** `ssh::open_shell` demande un pty puis un shell, donc la
  reconnexion automatique rétablit *un* terminal, pas *le* terminal. Un hôte
  réglé sur `persistentShell: "tmux"` (`PersistentShellMode`, désactivé par
  défaut) exécute à la place `tmux new-session -A -s <clé>`
  (`core/src/persistent_shell.rs`), sur une clé portée par l'onglet et
  persistée avec lui. **Conséquence à ne pas rater** : les commandes de
  démarrage (env + snippets) sont *tapées dans le shell*, donc
  `register_shell_session` ne les rejoue pas sur un rattachement — sinon elles
  repartiraient au milieu de la session vivante. Tout y est au conditionnel :
  hôte sans tmux, sondage en échec ou clé invalide retombent sur le shell
  ordinaire, jamais sur une erreur de connexion. Le menu d'un hôte SSH ouvre
  le gestionnaire (« Sessions ») : lister, reprendre, terminer. Terminer une
  session dont le nom ne porte pas le préfixe `guiterm-` est refusé dans
  `core`, avant tout aller sur le réseau — sinon un `tmux kill-session` sur un
  nom venu du frontend détruirait la session personnelle de l'utilisateur.
  À la coupure, un onglet persistant repasse en **vignette** (`detachTab`) au
  lieu de se fermer — le fermer emporterait sa clé. La décision vit dans
  `lib/terminalClosure.ts`, pas dans `TerminalTab`.

- **xterm.js avale les raccourcis clavier.** xterm.js appelle
  `stopPropagation()` sur toute touche qu'il traite lui-même (dès que
  `attachCustomKeyEventHandler` ne renvoie pas explicitement `false`). Un
  raccourci global écouté en bulle sur `window` ne se déclenche donc **jamais**
  tant qu'un terminal a le focus. Chaque `TerminalTab`/`LocalTerminalTab`
  laisse explicitement passer (renvoie `false` pour) les combinaisons qui
  correspondent à un raccourci app connu (`shouldBubbleToShortcut` dans
  `lib/shortcuts.ts`).

- **Collisions raccourcis app ↔ shell.** Plusieurs combinaisons Ctrl+lettre
  « naturelles » sont déjà prises par readline/le shell : Ctrl+W, Ctrl+K,
  Ctrl+U, Ctrl+\, Ctrl+R. Avant de proposer une combinaison par défaut pour
  une nouvelle action, vérifier `shellBindingWarning` dans `lib/shortcuts.ts`
  (et l'étendre si la collision n'y est pas déjà répertoriée).

- **Préférences = `localStorage` de la webview, pas un fichier.** Changer une
  valeur par défaut dans `DEFAULT_PREFERENCES` (`lib/preferences.ts`) n'a aucun
  effet rétroactif sur une installation déjà utilisée : la valeur précédente
  reste persistée.

- **Compat ascendante du `workspace.json`.** Toute nouvelle propriété ajoutée à
  un struct Rust sérialisé dans le workspace (`Host`, `Group`, `Snippet`, …)
  doit être `#[serde(default)]` (ou `Option<T>` avec default) pour rester
  compatible avec les fichiers déjà sauvegardés par les utilisateurs existants.

- **`#[serde(rename_all = "camelCase")]` sur un enum à tag interne ne renomme
  que les valeurs de variantes, jamais les champs des variantes struct.**
  Rencontré 6 fois dans ce projet (`rdp_ipc::ClientMessage::MouseWheel.delta_y`,
  `PaneSource::Docker.container_id`, `FleetTarget::{Docker,K8s}`...) — chaque
  fois invisible côté compilation (aucune erreur d'aucun côté), silencieux
  côté runtime (le champ vaut juste `undefined`/`missing field` selon le
  sens). Pour un enum à tag interne dont les variantes struct ont des champs
  `snake_case`, utiliser `rename_all_fields = "camelCase"` (serde ≥ 1.0.145)
  plutôt que `rename_all`, ou vérifier explicitement par un test qui
  désérialise un JSON écrit à la main (un roundtrip Rust→Rust ne prouve rien
  sur la casse réelle du JSON).

- **`sudo` dans ce WSL n'a pas d'accès non-interactif.** Toute commande qui
  invoque `sudo` (directement, ou en cascade via `npx playwright install
  --with-deps`) reste bloquée indéfiniment sur un prompt de mot de passe qui
  n'arrivera jamais — silence total, 0% CPU, aucune sortie. Tuer le processus
  bloqué (`kill -9`, pas `sudo pkill`) et demander à l'utilisateur de lancer
  la commande `sudo` lui-même via le préfixe `!`.

- **Un process lancé en arrière-plan via `wsl.exe -e bash -lc "cmd &"` meurt
  dès que cet appel `wsl.exe` se termine** (même avec `nohup`) — ce n'est PAS
  un process persistant. Pour un serveur de longue durée (Vite, tauri-driver),
  utiliser le paramètre `run_in_background: true` de l'outil Bash lui-même sur
  la commande *au premier plan* (sans `&` interne).

- **`$(commande)`/`$?` dans une commande `wsl.exe -e bash -lc "..."` lancée
  depuis Git Bash sont expansés par le shell EXTERNE avant d'atteindre WSL,
  si la chaîne est en double guillemets.** `wsl.exe -e bash -lc "... ; echo
  EXIT=$?"` affiche toujours le `$?` périmé de l'outer shell, jamais celui de
  la commande interne. Fix : guillemets **simples**
  (`wsl.exe -e bash -lc '... ; echo EXIT=$?'`).

- **Corollaire, sur les messages de commit : ne jamais les passer en ligne.**
  Un message contenant des backticks (`` `npm run lint` ``) part en
  substitution de commande dans le shell externe avant d'atteindre WSL — la
  commande s'exécute réellement et **sa sortie remplace le texte dans le
  message**. Déjà arrivé : un message s'est retrouvé avec
  « `> guiterm@2.3.0 lint` » incrusté au milieu d'une phrase, et le commit
  passe sans rien signaler. Un heredoc `<<'EOF'` ne protège pas, parce que
  l'interprétation a lieu un niveau au-dessus. Fix : écrire le message dans
  un fichier (via l'outil Write, jamais via `echo`/`cat`) puis
  `git commit -F <fichier>`.

- **GTK sous WSLg rend en Wayland natif par défaut, invisible pour les outils
  X11** (`scrot`, `xwininfo`, `WebKitWebDriver`). Forcer `GDK_BACKEND=x11`
  (en plus de `DISPLAY=:0`) pour que la fenêtre soit pilotable —
  `scripts/e2e-run.mjs` le fait déjà pour Vite et `tauri-driver`.

- **Le binaire Tauri charge `build.devUrl` par défaut, y compris en
  `--release`** — seul le feature flag Cargo `tauri/custom-protocol` (activé
  automatiquement par la CLI `tauri build`, jamais par un `cargo build`
  direct) fait basculer sur `frontendDist` embarqué. Sans serveur Vite qui
  tourne en parallèle et sans ce feature, la fenêtre affiche juste « Could
  not connect to localhost ».

- **Écritures des fichiers de config = atomiques, obligatoirement.** Tout ce qui
  écrit un fichier de config/secret passe par `secure_file::write_private`, qui
  écrit un temp 0600 puis `rename` (atomique) — jamais une troncature-écriture
  sur place. Les lectures sont fail-closed (un fichier tronqué par un crash en
  cours d'écriture serait refusé) et les tests d'intégration `core/tests/`
  partagent le vrai `known_hosts.json` en parallèle — une écriture non atomique
  laisse un autre thread lire un fichier à moitié écrit. Ne pas revenir à un
  `std::fs::write` direct pour ces fichiers.

- **`$env:CARGO_TARGET_DIR` (comme le reste de `$env:PATH`/`Set-Location`) ne
  survit pas d'un appel PowerShell à l'autre.** Chaque invocation démarre un
  état frais — oublier de le reposer fait retomber silencieusement sur le
  target dir par défaut (chemin UNC) et reproduit le piège du lock file
  incrémental.

- **Un process `rdp-sidecar.exe`/`guiterm.exe` resté ouvert après un test
  précédent verrouille le binaire que le build suivant essaie d'écrire.**
  Symptôme trompeur : `cargo build` compile sans erreur, mais la copie
  automatique du sidecar panique avec `PermissionDenied`. `Get-Process
  rdp-sidecar,guiterm -ErrorAction SilentlyContinue | Stop-Process -Force`
  avant de relancer le build.

## Fonctionnalités et roadmap

L'app est déjà très complète côté client SSH classique — palette de
commandes, broadcast/diffusion de commandes, split panes, recherche
terminal, reconnexion auto, thèmes de terminal, restauration d'onglets.
**Avant de proposer une feature « évidente », vérifier `src/components/` :
elle existe probablement déjà.**

État des chantiers majeurs (roadmap complète et historique des décisions
dans la mémoire long-terme `infra-control-plane-pivot.md` et dans
`docs/dev-history.md`) :
- **Coffre chiffré** (mot de passe maître) — fait.
- **Tunnel SOCKS dynamique (`-D`)** — fait (`core/src/port_forward.rs`).
- **Génération + déploiement de clés SSH** — fait (`core/src/keygen.rs`,
  `commands/keys.rs`).
- **Accès multi-protocole** (Docker exec / K8s exec / RDP) — `HostKind` dans
  `core/src/model.rs` généralise `Host`. Docker exec et K8s exec sont des
  backends réels (terminal, navigation de fichiers, cible de flotte,
  snippets adaptatifs). RDP a un aperçu intégré (rendu, forward souris/
  clavier, presse-papiers texte+fichiers, redimensionnement dynamique — pas
  de rendu de curseur, pas d'audio) via `rdp-sidecar` (voir plus haut).
- **Opérations de flotte + moteur de snippets adaptatifs** — fait
  (`core/src/fleet.rs`, `core/src/adaptive.rs`, `FleetTab.tsx`). Petit DSL
  textuel (grammaire documentée en tête d'`adaptive.rs`) pour cibler une
  flotte hétérogène par conditions (OS/nom/tag/RAM/CPU/charge/uptime) ;
  l'IA rédige du texte dans cette grammaire à partir d'une instruction en
  français — elle n'écrit jamais de shell directement, le texte généré est
  validé par le même parseur que la saisie manuelle avant d'être montré à
  l'utilisateur. Cibles : hôtes SSH, conteneurs Docker exec, pods K8s,
  terminal local (Windows/POSIX).
- **Client SQL (MySQL/PostgreSQL)** — fait (`core/src/sql.rs`,
  `commands/sql.rs`, `SqlConnectionsPanel.tsx`, `SqlTab.tsx`). Entité à part
  (`SqlConnection`), pas un `HostKind` de plus — pas de shell, pas de cible
  de flotte, référence juste un `Host` SSH existant en option pour un tunnel
  local éphémère jamais persisté. Connexion directe ou tunnelée au choix par
  connexion ; arborescence bases/schémas → tables → colonnes ; panneau de
  requêtes (zone de texte simple, pas d'éditeur de code). Voir
  `docs/dev-history.md` pour l'architecture complète.
  **Les réglages par moteur vivent dans `EngineConfig`** (`core/src/model.rs`),
  un enum à tag interne sur `engine` aplati dans `SqlConnection` — et son
  miroir TypeScript `SqlEngineConfig`, une union discriminée. Ajouter un
  moteur = ajouter une variante, pas des champs optionnels à un struct plat
  (ce qu'était la version précédente, qui obligeait `sql.rs` à porter six
  `unreachable!()` pour des combinaisons que le type autorisait). Le JSON sur
  disque est inchangé, et les tests de `model.rs` désérialisent l'ancienne
  forme à plat écrite à la main — les garder verts, un `workspace.json`
  illisible fait disparaître les connexions de l'utilisateur.
- **Mutualisation des connexions SSH** — fait (`core/src/ssh_pool.rs`).
  **Ne plus appeler `ssh::connect` directement** : passer par
  `ssh_pool::acquire`, qui rend un `SshLease` partagé entre onglets, panneaux
  de transfert, tunnels et sessions SQL/Redis/Mongo tunnelées du même hôte
  (avant : une connexion complète — TCP + handshake + auth — par usage).
  Débordement automatique sur une 2ᵉ connexion au-delà de 8 baux, pour ne pas
  buter sur `MaxSessions` de sshd. Le bail doit vivre aussi longtemps que ce
  qu'il a ouvert : le stocker dans la structure de session, jamais le laisser
  tomber en gardant seulement l'`Arc<Connection>`. Deux exceptions
  documentées : `docker::connect_for_host` (le modèle « un bail ≈ un canal »
  ne s'applique pas, voir son doc comment) et les tests d'intégration.
- **Auth keyboard-interactive (MFA/OTP)** — fait
  (`core/src/interactive_auth.rs`, `commands/interactive_auth.rs`,
  `SshAuthPromptModal.tsx`). Le serveur pose ses questions pendant la poignée
  de main : `core` décrit la conversation (trait `Prompter`), `src-tauri`
  installe une implémentation qui émet `ssh-auth-prompt` et attend la réponse
  sur un oneshot. Le pool SSH en était le prérequis — sinon un code serait
  redemandé à chaque onglet. Le mot de passe enregistré répond
  automatiquement à la **première invite masquée du premier tour uniquement**
  (`autofilled_answers`, testé) : auto-répondre plus tard enverrait un mot de
  passe périmé à la place de l'OTP et brûlerait une tentative serveur.
  Jamais testé contre un vrai serveur MFA (le sshd des tests d'intégration
  demanderait une configuration PAM dédiée).

Chaque fonctionnalité ci-dessus a son lot de décisions de conception et de
bugs déjà corrigés en conditions réelles — voir `docs/dev-history.md` avant
de retoucher une zone déjà bien rodée, pour ne pas repasser par un chemin
déjà exploré (ex. pourquoi le DSL adaptatif plutôt que du tool-use IA direct,
pourquoi Docker/K8s exec partagent `RemoteFileClient`, etc.).

## Habitudes de collaboration sur ce projet

- Committer directement une fois des changements validés, sans redemander la
  permission à chaque fois (changé le 2026-07-21 — l'ancienne consigne
  « ne jamais committer sans demande explicite » ne s'applique plus). Rester
  sur des commits ciblés et cohérents plutôt qu'un unique gros commit
  fourre-tout ; continuer à ne jamais force-push/amend un commit déjà poussé
  sans demande explicite.
- **Découper par tranche verticale, pas par couche.** Un commit devrait porter
  quelque chose que l'utilisateur peut atteindre : backend + UI + test. Le
  commit `6bc0b49` regroupait pool SSH + `EngineConfig` + journalisation +
  backend MongoDB — regroupement honnêtement justifié (ils se recouvraient
  dans `state.rs`), mais c'est ce qui a permis au frontend MongoDB manquant de
  passer inaperçu : le commit s'est relu comme « refacto structurelle », pas
  comme « est-ce que MongoDB marche de bout en bout ». Quand des changements
  se recouvrent vraiment au point de ne pas compiler séparément, le dire dans
  le message *et* vérifier chaque tranche indépendamment.
- **En fin de tâche, se poser explicitement : « quel test échouerait si je
  m'étais trompé ? »** Si la réponse est « aucun », la tâche n'est pas finie —
  c'est exactement la question qui manquait sur MongoDB. Et quand un garde-fou
  est ajouté, vérifier qu'il échoue pour de vrai en réintroduisant
  temporairement le bug qu'il est censé attraper : un test qui ne casse jamais
  ne prouve rien (cf. le contrôle anti-vacuité dans `tauriCommands.test.ts`).
- Sur une fonctionnalité un peu grosse, demander le plan avant le code, avec la
  liste explicite des fichiers frontend **et** backend touchés. Un plan qui ne
  mentionne aucun composant React pour une fonctionnalité visible est un
  signal.
- L'utilisateur écrit et pense en français ; les réponses, les libellés UI, les
  messages de commit et la documentation du projet suivent cette convention.
  **Cela inclut les messages d'erreur de `core/`** : il n'existe aucune couche
  de traduction, et `commands/` les relaie verbatim, donc un `anyhow!` écrit en
  anglais s'affiche tel quel dans l'interface. Vérifié par
  `core/tests/error_messages_are_french.rs`. Deux exceptions volontaires : les
  chaînes comparées à la **sortie d'une CLI externe** (`aws_inventory`,
  `cloud_cli`, `netdiag` cherchent « command not found » dans ce que le binaire
  a imprimé) et les fixtures des modules `#[cfg(test)]`.
- Avant une fonctionnalité un peu ambiguë (ex. « menu contextuel » vs « action
  instantanée » pour un clic droit), une question courte à choix (2-3 options)
  vaut mieux qu'une supposition — surtout quand les deux implémentations sont
  d'ampleur comparable mais donnent une UX très différente.
- Sur les demandes larges (« qu'est-ce que tu améliorerais ? »), il vaut mieux
  proposer une liste concrète et ancrée dans le code réel (pas des idées
  génériques de client SSH) puis laisser l'utilisateur choisir ce qui vaut le
  coup d'être implémenté, plutôt que de tout construire d'un coup.
