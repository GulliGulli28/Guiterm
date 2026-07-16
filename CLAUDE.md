## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).

## Le projet en bref

**Guiterm** (anciennement `gui-termius` — renommé le 2026-07-16, voir la
section « Renommage » en fin de fichier) est un client SSH/SFTP de bureau
(Tauri 2 + Rust + React/TypeScript), en licence MIT (open-core — voir la
section « Stratégie open-core » en fin de fichier). Voir `README.md` pour la
présentation complète des fonctionnalités et de la structure du dépôt — ce
fichier-ci se concentre sur ce qui n'est pas évident en lisant juste le code.

Le dépôt (dossiers, chemins de fichiers, nom de crate `termius-core`,
identifiant de coffre OS, dossier de config `%APPDATA%\gui-termius\...`)
garde encore `gui-termius`/`termius` à de nombreux endroits internes,
volontairement — voir la section « Renommage » pour le détail de ce qui a
changé et ce qui est resté stable.

Découpage du code Rust :
- `core/` — logique métier pure (SSH via `russh`, SFTP, vault, known_hosts,
  parsing `~/.ssh/config`, persistance du workspace). Ne dépend pas de Tauri.
- `src-tauri/src/commands/` — une commande Tauri par domaine, fine couche
  au-dessus de `core/`. C'est là qu'ajouter une nouvelle commande invocable
  depuis le frontend.
- `src/lib/api.ts` — unique point de passage frontend → Tauri (`invoke(...)`).
  Toute nouvelle commande Rust doit avoir son entrée ici, typée.

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
Build Tools 2026, WebView2 Runtime — tous déjà installés), mais `cargo`/
`rustc`/`tauri-driver` ne sont **pas sur le PATH d'une session PowerShell
fraîche** : soit invoquer par chemin complet
(`$env:USERPROFILE\.cargo\bin\cargo.exe`), soit ajouter au PATH de la session
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
(`DISPLAY=:0`, `xdpyinfo`/`xrandr` répondent, résolution réelle détectée) —
voir la section suivante, ce n'est plus une limitation de cet environnement
depuis le 2026-07-07 (une session précédente l'affirmait à tort ; corrigé
après avoir effectivement lancé l'app et pris une vraie capture).

## Vérification Rust : `clippy -D warnings` est un gate CI bloquant

Le workflow GitHub (job **`windows-workspace`**) lance
`cargo clippy --workspace --all-targets -- -D warnings` : **le moindre warning
clippy fait échouer le push**. `cargo check` / `cargo test` ne déclenchent PAS
les lints clippy — il faut donc lancer clippy explicitement avant de considérer
une tâche Rust terminée, sinon le CI casse (déjà arrivé : `ptr_arg` sur
`&PathBuf` au lieu de `&Path`, `collapsible_if`). En local, via WSL :

```bash
wsl.exe -e bash -lc "cd ~/gui-termius && cargo clippy --workspace --all-targets -- -D warnings"
```

Piège : clippy interrompt la compilation d'une crate dès sa première erreur,
donc tant que `termius-core` échoue ses lints, ceux de `gui-termius` restent
invisibles — corriger, relancer, itérer jusqu'à zéro.

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

Ce que fait `npm run test:e2e` : il démarre `tauri-driver` (et Vite si besoin,
voir plus bas), pilote le **vrai binaire compilé** via le protocole WebDriver,
vérifie que la fenêtre s'ouvre, que React a bien monté (`#root`), prend une
vraie capture d'écran (`scripts/.output/e2e-smoke.png`, gitignored) puis
nettoie tous les processus qu'il a lancés. Contrairement à Puppeteer/
Playwright pointé sur `http://localhost:1420` (qui ne voit jamais
`window.__TAURI__` — un vrai navigateur n'est pas une webview Tauri), ceci
exécute du vrai code `invoke(...)`. Le script (`scripts/e2e-run.mjs`) est
**cross-platform** et détecte l'environnement d'exécution :

|                    | Linux (WSLg)                    | Windows natif                          |
|--------------------|----------------------------------|-----------------------------------------|
| Rendu               | WebKitGTK                       | **WebView2** (ce que les utilisateurs lancent réellement) |
| Pilote natif        | `WebKitWebDriver`               | `msedgedriver.exe`                      |
| Build testé         | debug (`cargo build`)           | release (`cargo build --release --features tauri/custom-protocol`) |
| Sert le frontend via| Vite dev server (`devUrl`)      | `dist/` embarqué dans le binaire (`frontendDist`) |

Les deux ont été validés avec succès le 2026-07-07 — voir les pièges
ci-dessous pour la mise en place, non triviale sur les deux plateformes.

**Setup one-time Linux/WSL (déjà fait sur cette machine)** :
```bash
wsl.exe -e bash -lc "sudo apt-get update && sudo apt-get install -y webkit2gtk-driver scrot"
wsl.exe -e bash -lc "cd ~/gui-termius && cargo install tauri-driver"
wsl.exe -e bash -lc "cd ~/gui-termius/src-tauri && cargo build"
```
`sudo` n'a pas d'accès non-interactif dans ce WSL (voir piège plus bas) — si
ce setup doit être refait, demander à l'utilisateur de lancer la commande
`apt-get` lui-même via le préfixe `!`.

**Setup one-time Windows (déjà fait sur cette machine)** — piloté depuis
PowerShell, jamais `wsl.exe` pour cette partie :
```powershell
# Rust : déjà installé sur cette machine (rustup), juste absent du PATH de
# session — toujours invoquer via le chemin complet ou ajouter au PATH :
$env:PATH += ";$env:USERPROFILE\.cargo\bin;C:\Program Files\NASM"

winget install --id NASM.NASM -e --accept-package-agreements --accept-source-agreements
& "$env:USERPROFILE\.cargo\bin\cargo.exe" install tauri-driver

# msedgedriver DOIT correspondre exactement à la version du WebView2 Runtime installé :
$wv2 = (Get-ItemProperty "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}").pv
curl.exe -sL "https://msedgedriver.microsoft.com/$wv2/edgedriver_win64.zip" -o "$env:TEMP\ed.zip"
Expand-Archive "$env:TEMP\ed.zip" "$env:USERPROFILE\edgedriver" -Force

# Build release, sur un chemin NTFS natif (pas le chemin UNC du dépôt WSL) :
$env:CARGO_TARGET_DIR = "$env:USERPROFILE\gui-termius-target-windows"
Set-Location "\\wsl.localhost\Ubuntu-24.04\home\glorin\gui-termius\src-tauri"
& "$env:USERPROFILE\.cargo\bin\cargo.exe" build --release --features tauri/custom-protocol
```
MSVC Build Tools et le WebView2 Runtime étaient déjà présents sur cette
machine (`vswhere.exe` pour vérifier, `winget` pour installer sinon).

**Avant de lancer `npm run test:e2e`**, s'assurer que le binaire correspondant
à la plateforme existe et est à jour (commandes ci-dessus). Depuis Windows,
définir `$env:CARGO_TARGET_DIR` avant de lancer le script (même valeur qu'au
build) pour qu'il retrouve le bon binaire, et invoquer `node scripts\e2e-run.mjs`
directement plutôt que `npm run test:e2e` (voir piège `npm`/UNC ci-dessous).

Pour étendre la couverture E2E : ajouter des scénarios dans la fonction
`runScenarios()` de `scripts/e2e-run.mjs` (ex. taper dans un terminal local et
vérifier qu'une suggestion apparaît) plutôt que d'écrire un nouveau script
séparé à chaque fois — le même scénario tourne sur les deux plateformes sans
modification.

**Pièges Windows rencontrés en mettant ça en place (dans l'ordre où ils
mordent)** :
- **`aws-lc-sys` a besoin de NASM** pour compiler ses routines assembleur sous
  MSVC — `cargo build` échoue avec `NASM command not found` sinon
  (`winget install NASM.NASM`, puis ajouter `C:\Program Files\NASM` au PATH
  de la session).
- **Lock file de compilation incrémentale impossible à créer sur un chemin
  UNC** (`\\wsl.localhost\...`) — `cargo build` échoue avec `could not create
  session directory lock file: Fonction incorrecte`. Fixé en pointant
  `CARGO_TARGET_DIR` vers un chemin NTFS natif (`$env:USERPROFILE\...`) ; le
  code source reste lu depuis le chemin UNC sans problème, seul le
  répertoire de build doit être natif.
- **`npm run ...` échoue sur un `cwd` UNC** : `npm` passe par `cmd.exe`, qui
  ne supporte pas les chemins UNC comme répertoire courant (retombe
  silencieusement sur `C:\Windows` et ne trouve plus rien). Contournement
  dans `scripts/e2e-run.mjs` : invoquer `node.exe` directement sur les
  fichiers `.js` (`node_modules/vite/bin/vite.js`, `scripts/e2e-run.mjs`
  lui-même) plutôt que passer par les shims `.cmd` (`npx`, `npm run`).
- **Un `node_modules` installé via WSL ne peut pas faire tourner Vite
  nativement sous Windows** : `esbuild` (et d'autres) livrent un binaire
  natif par plateforme, choisi à l'installation — seul le binaire Linux a été
  installé. Plutôt que dupliquer `node_modules` pour Windows, contourné en
  testant un **build release** côté Windows : `frontendDist` (le contenu de
  `dist/`, déjà construit via WSL) est purement statique donc portable, alors
  que la tooling de build (`node_modules`) ne l'est pas.
- **`cargo build --release` seul ne suffit PAS à embarquer `frontendDist`** —
  contre-intuitif : le binaire continue de charger `devUrl`
  (`http://localhost:1420`, échec silencieux si rien n'écoute dessus) même en
  release. Il manque le feature flag Cargo `custom-protocol` sur la
  dépendance `tauri`, que la CLI `tauri build` active automatiquement mais
  qu'un `cargo build` direct n'active jamais (`tauri = { features = [] }`
  dans `Cargo.toml`). Fix : `cargo build --release --features
  tauri/custom-protocol`. Diagnostiqué en interrogeant `getUrl()` via
  WebDriver pendant la session (montrait `http://localhost:1420/` malgré le
  build release) plutôt qu'en devinant.

### Techniques plus légères, sans lancer l'app entière

Pour itérer plus vite qu'un cycle `test:e2e` complet (qui recompile/relance
une vraie fenêtre), deux techniques plus légères, mises en place et
vérifiées avec succès le 2026-07-07 en développant les suggestions de
commandes (ghost-text) des terminaux locaux, restent utiles en complément
(pas en remplacement) du test E2E :

- **Tests unitaires (`npm run test`, vitest)** pour toute la logique pure
  découplée de React/xterm/Tauri — typiquement un état de type "buffer de
  ligne" ou toute fonction `(state, event) => state`. Voir
  `src/lib/lineBuffer.ts` + `src/lib/lineBuffer.test.ts` : la state machine
  qui ombre les frappes clavier pour reconstituer la ligne tapée est testée
  isolément (Ctrl+L, Ctrl+C, Ctrl+U/W, désynchronisation sur Tab/flèches,
  paquets `onData` qui mélangent plusieurs frappes). `vite.config.ts` expose
  déjà un bloc `test` (vitest lit la même config que Vite) — pas de setup
  séparé nécessaire pour de nouveaux fichiers `*.test.ts`.
  **Piège Node** : vitest ≥ 4 exige Node ≥ 20 ; le Node de ce WSL est en
  18.19 → utiliser `vitest@^2` (compatible Node 18), sinon échec immédiat au
  démarrage (`SyntaxError: … does not provide an export named 'styleText'`).

- **Rendu DOM réel dans un navigateur headless (Playwright), sans Tauri.**
  Pour tout ce qui dépend du DOM effectivement produit par xterm.js (mesures
  de cellules, positionnement d'un overlay, alignement visuel) — donc au-delà
  de ce qu'un test unitaire peut couvrir — on peut monter un vrai
  `@xterm/xterm` dans une page headless, lui écrire du texte directement via
  `term.write(...)` (ça ne passe pas par Tauri, donc `invoke()` n'est jamais
  sollicité), puis prendre un vrai screenshot et l'inspecter avec l'outil
  `Read`. Voir `scripts/visual-check-ghost-text.{html,client.mjs,mjs}` :
  `node scripts/visual-check-ghost-text.mjs` sert la page via le serveur Vite
  du projet (réutilise `vite.config.ts`), la charge dans Chromium headless
  (Playwright), vérifie que la géométrie de cellule calculée est plausible et
  que le curseur xterm tombe où attendu, écrit
  `scripts/.output/ghost-text-check.png` (gitignored) et sort en erreur si
  une des assertions échoue. Cette technique a permis de valider la
  transposition du sélecteur `.xterm-rows` (rendu DOM par défaut de xterm.js,
  utilisé quand aucun addon `webgl`/`canvas` n'est chargé) en géométrie
  pixel — l'hypothèse la plus risquée de l'implémentation du texte fantôme —
  sans jamais lancer l'app réelle.
  **Piège install** : `npx playwright install --with-deps chromium` invoque
  `sudo apt-get install …` pour les libs système ; dans cet environnement WSL
  `sudo` n'a pas d'accès non-interactif et la commande reste bloquée
  indéfiniment sur un prompt de mot de passe qui n'arrivera jamais (aucune
  sortie, CPU à 0%, silence total — symptôme caractéristique). Utiliser
  `npx playwright install chromium` (sans `--with-deps`) : le binaire
  Chromium seul suffit en mode headless et ne nécessite aucun privilège. Si
  un futur test échoue au lancement faute de bibliothèque système
  (`libnss3`, etc.), demander à l'utilisateur de lancer lui-même la commande
  `--with-deps` via le préfixe `!` plutôt que de rester bloqué dessus.

Ce que ces deux techniques ne couvrent toujours **pas** : tout ce qui passe
par `invoke(...)` (connexion SSH réelle, PTY local, trousseau, SFTP...) —
`window.__TAURI__` n'existe que dans la vraie webview Tauri, jamais dans un
Chromium/Playwright classique, headless ou non. C'est exactement ce que
`npm run test:e2e` (section précédente) couvre — l'utiliser dès qu'une
commande `invoke(...)` réelle doit être exercée, pas seulement son DOM.

## Lancer l'app Windows en conditions réelles — OBLIGATOIRE après un changement

Demande explicite de l'utilisateur (2026-07-16, après une session où seuls
`clippy`/`tsc`/`vitest`/le smoke test E2E automatisé avaient tourné) : ces
vérifications prouvent que le code compile et que la fenêtre s'ouvre sans
crasher, mais aucune ne remplace un humain qui clique réellement dans l'app.
**Après un changement qui touche le comportement de l'app (UI, commande
Tauri, logique métier — pas seulement des tests/docs/scripts), construire et
lancer le vrai binaire natif Windows (WebView2, ce que l'utilisateur lance
réellement) pour qu'il puisse tester lui-même**, en plus des vérifications
automatisées habituelles, jamais à leur place.

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
  syncable, marche sans trousseau OS, verrouillé au lancement (UI : modale de
  déverrouillage + Paramètres → Sécurité, auto-lock configurable).

**Cas particulier des clés privées** : leur contenu PEM reste dans
`workspace.json` (0600) en mode trousseau, mais bascule dans le coffre chiffré
quand il est déverrouillé — via `vault::{load,store,delete}_key_content` +
`is_unlocked`, PAS via le trousseau OS (taille limitée sous Windows, et le
fallback WSL le perdrait). `ssh::authenticate` lit le PEM dans l'ordre
**coffre → workspace.json → fichier d'origine** ; la migration dans les deux sens
(activer/désactiver) et l'export/import « avec clés » sont gérés dans
`commands/{vault,export}.rs`.

Ne pas tester le flux complet activer→migrer→se-connecter en E2E automatique :
il faut un vrai `sshd` ET ça mut­erait le `secrets.enc` réel du profil. Le crypto
est couvert par tests unitaires (`crypto.rs`, `master_vault.rs`).

## RDP intégré (rendu réel) : architecture sidecar

Le rendu RDP intégré (`RdpTab.tsx`, onglet « Aperçu intégré ») ne tourne
**pas** dans le binaire principal `gui-termius` : c'est un processus séparé,
`rdp-sidecar`, lancé par `commands/rdp_view.rs` et piloté par un protocole
maison sur stdin/stdout (`rdp-ipc`). Ce n'est pas un choix d'architecture
arbitraire — c'est la seule option qui compile, pour une raison précise
détaillée ci-dessous. Le mode « lanceur » historique (`core/src/rdp.rs`,
commande `connect_rdp`, shell-out vers `mstsc.exe`/`xfreerdp`) a existé
un temps en parallèle, accessible via le menu « … » sous « Client système »
— **retiré le 2026-07-12** à la demande de l'utilisateur (code jugé
redondant une fois l'aperçu intégré validé en conditions réelles ; voir la
section « Nettoyage » en fin de fichier pour le détail de la suppression).
L'aperçu intégré est désormais le seul mode de connexion RDP de l'app.

### Pourquoi un processus RDP séparé

`ironrdp-connector` (client RDP) dépend transitivement de `picky`
(`picky-asn1-x509`), qui pin une version *exacte* de `ecdsa`
(`=0.17.0-rc.22` au moment d'écrire ceci). `russh` — déjà utilisé partout
dans `core/` pour SSH — pin lui aussi une version exacte, mais différente
(`=0.17.0-rc.18`). Deux pins exacts différents de la même crate dans un seul
graphe de dépendances Cargo ne peuvent **jamais** être résolus : ce n'est pas
une histoire de version « pas encore assez récente » (vérifié aussi bien sur
la dernière version publiée de `picky` que sur sa branche `master` — toujours
désaligné avec `russh`), donc pas un problème qu'un `cargo update` ou
l'attente d'un futur release réglerait. Toute tentative d'ajouter
`ironrdp-connector` comme dépendance directe ou transitive de `core/` (ou de
tout crate qui dépend de `core/`, donc `src-tauri` inclus) échoue la
résolution Cargo dès `cargo check`.

**Un membre de workspace n'isole rien.** Première tentative : mettre
`rdp-sidecar` dans le workspace racine (`members = [...]`) sans le faire
dépendre de `core`/`russh`, en supposant que l'absence de dépendance directe
suffirait. Ça échoue avec exactement la même erreur `ecdsa` : Cargo résout
**un seul** graphe de dépendances unifié pour tous les membres d'un même
workspace, qu'ils dépendent les uns des autres ou non. La seule vraie
isolation est un `[workspace]` **séparé** — son propre `Cargo.lock` — relié
au reste du dépôt uniquement par une dépendance `path = "..."` ordinaire vers
un crate qui n'a lui-même aucune dépendance à risque. C'est exactement la
structure ici :

```
Cargo.toml (workspace racine : core, src-tauri, rdp-ipc)
  └─ src-tauri dépend de rdp-ipc (path) — jamais de rdp-sidecar
rdp-sidecar/Cargo.toml ([workspace] séparé, members = ["."])
  └─ dépend de rdp-ipc (path) + ironrdp — jamais de core/russh
```

`rdp-ipc` (protocole de communication, voir plus bas) ne dépend que de
`tokio`/`serde`/`serde_json` — sûr à partager tel quel entre les deux
workspaces sans jamais réintroduire le conflit.

### Build : ce qui est déjà vérifié, ce qui ne l'est pas

`rdp-sidecar` compile et passe `cargo clippy --all-targets -- -D warnings`
propre, à la fois sous WSL (`x86_64-unknown-linux-gnu`) et nativement sous
Windows (`x86_64-pc-windows-msvc`, testé le 2026-07-10 en conditions réelles
sur cette machine — `ironrdp-tokio`'s feature `reqwest-rustls-ring` utilise
`ring`, qui a lui aussi besoin de NASM pour ses routines assembleur sous
MSVC, déjà installé sur cette machine pour la même raison que `aws-lc-sys`
— voir la section E2E). Ce qui n'est **pas** vérifié : une vraie connexion
contre un serveur RDP réel (aucun accessible dans cet environnement — même
limitation que le mode lanceur). La logique de connexion/décodage a été
portée depuis `ironrdp-client/src/rdp.rs` (le client de référence du dépôt
`Devolutions/IronRDP`) en vérifiant chaque type/signature contre les sources
de la version réellement résolue par Cargo plutôt que par mémoire — un
premier essai basé sur une version plus récente de l'API que celle
effectivement résolue (`ActiveStageBuilder`, `AsyncReadWrite` exporté par
`ironrdp-tokio`) a échoué à la compilation et a dû être corrigé contre les
sources réelles (`ActiveStage::new(connection_result)` direct, trait
`AsyncReadWrite` local à définir soi-même — absent de `ironrdp-tokio`).

**Bug réel trouvé au premier test interactif** (2026-07-10, via `npx tauri
dev` + un vrai clic sur « Aperçu intégré » — exactement le genre de chose
qu'aucune compilation/clippy ne peut attraper) : le process `rdp-sidecar`
plantait immédiatement à la première tentative de connexion avec *"Could
not automatically determine the process-level CryptoProvider from Rustls
crate features"*. Cause : `ironrdp-tls`'s chemin rustls appelle
`ClientConfig::builder()` (le constructeur « process default »), qui panique
si aucun `CryptoProvider` n'a été installé — et rustls 0.23 refuse de choisir
implicitement dès que plus d'un provider (`ring` et `aws-lc-rs`) se retrouve
dans le graphe de dépendances, ce qui est le cas ici (`reqwest`/`ironrdp-tls`
ne s'accordent pas sur un défaut). Fix : dépendance directe sur `rustls`
(juste pour appeler l'API) + `rustls::crypto::ring::default_provider()
.install_default()` tout au début de `main()`, avant toute connexion — voir
`rdp-sidecar/src/main.rs`. Ce genre de panique runtime-only, invisible à
`cargo check`/`clippy`, est exactement pourquoi la mention « non testé contre
un vrai serveur » plus haut est prise au sérieux plutôt que traitée comme un
détail — le code compilait proprement et plantait quand même dès le premier
usage réel.

Pour builder `rdp-sidecar` (son propre workspace, donc `cd` dedans avant
toute commande `cargo`) :

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

### Où placer le binaire compilé

`tauri.conf.json` déclare `bundle.externalBin: ["binaries/rdp-sidecar"]`.
Deux emplacements différents comptent, pour deux étapes différentes :

- **Pour `tauri build`/`tauri-action`** (packaging, `release.yml`) : le
  binaire compilé doit être copié vers
  `src-tauri/binaries/rdp-sidecar-<triple-cible>[.exe]` (suffixe de triple
  obligatoire — c'est ainsi que `tauri build` sait choisir le bon binaire par
  plateforme). `release.yml` le fait déjà pour les deux plateformes du
  matrix, juste avant l'étape `tauri-action`.
- **Pour un `cargo build` direct côté `src-tauri`, ou `cargo run`/`tauri
  dev`** : `tauri_plugin_shell::Command::sidecar()` résout le binaire au
  runtime en le cherchant **à côté de l'exécutable principal en cours
  d'exécution, sans suffixe de triple**
  (`<dossier de gui-termius[.exe]>/rdp-sidecar[.exe]`, donc
  `target/debug/rdp-sidecar` en dev). Contrairement à ce qu'on pourrait
  supposer, ce n'est **pas** une copie faite par la CLI `tauri dev`/`tauri
  build` elle-même — c'est `tauri-build`'s `build.rs` (déclaré en
  `[build-dependencies]` de `src-tauri`, donc déclenché par **n'importe
  quel** `cargo build`/`cargo check`/`cargo run` sur `gui-termius`, CLI
  Tauri ou pas) qui copie automatiquement depuis
  `src-tauri/binaries/rdp-sidecar-<triple-hôte>[.exe]` vers cet emplacement
  sans suffixe. Vérifié le 2026-07-10 : supprimer
  `target/debug/rdp-sidecar` puis relancer un `cargo build -p gui-termius`
  ne le recrée pas tant que `build.rs` n'a pas de raison de re-tourner (il
  ne re-tourne que sur ses `rerun-if-changed`, notamment `tauri.conf.json`
  et `capabilities/`) ; forcer sa ré-exécution (`touch tauri.conf.json`)
  recrée bien la copie automatiquement, sans intervention manuelle. Donc :
  **la seule chose à placer à la main** est le binaire triple-suffixé dans
  `src-tauri/binaries/` (voir ci-dessous) — dès qu'il y est, n'importe quel
  `cargo build`/`cargo run`/`tauri dev` sur `gui-termius` qui redéclenche
  `build.rs` s'occupe de la copie finale. Exemple WSL (chemin utilisé pour
  le test E2E réel du 2026-07-10) :
  ```bash
  wsl.exe -e bash -lc "cd ~/gui-termius/rdp-sidecar && cargo build && \
    cp target/debug/rdp-sidecar ../src-tauri/binaries/rdp-sidecar-x86_64-unknown-linux-gnu"
  ```
  **Piège** : ce même `build.rs` vérifie que le chemin `bundle.externalBin`
  existe **même pour un simple `cargo check`** sur `gui-termius` — sans le
  fichier triple-suffixé ci-dessus déjà en place, même la compilation du
  crate principal échoue (`resource path "binaries/rdp-sidecar-<triple>"
  doesn't exist`), pas seulement le packaging. `src-tauri/binaries/` est
  gitignored (binaire par plateforme, jamais committé) — après un `git
  clone` frais ou un changement de plateforme de build, ce binaire doit
  être reconstruit et recopié avant que `cargo check`/`cargo build`/`tauri
  dev` sur `gui-termius` refonctionne.

  `npx tauri dev` fonctionne pour tester l'app avec ce sidecar déjà en
  place, lancé depuis WSL (vérifié le 2026-07-10 : `beforeDevCommand`
  démarre Vite, `cargo run` compile et lance une vraie fenêtre WebKitGTK,
  aucune erreur liée au sidecar). Deux limites à garder en tête : (a) ça
  reste le rendu **WebKitGTK** (voir le tableau de la section E2E), pas
  WebView2 — pour tester le rendu que les utilisateurs auront réellement il
  faut le binaire Windows (`rdp-sidecar-x86_64-pc-windows-msvc.exe`, même
  procédure de build que la section précédente) et lancer `npx tauri dev`
  **depuis PowerShell natif**, jamais testé sur cette machine ; vu le piège
  déjà documenté (`npm run ...` échoue sur un `cwd` UNC, section E2E), ça
  pourrait buter sur la même limitation — à vérifier avant de compter
  dessus. (b) `tauri dev` ne teste que le lancement du process sidecar et
  la connexion IPC/UI — **pas une vraie session RDP** : il faut un hôte de
  type RDP déjà configuré dans l'app (avec un mot de passe enregistré) et
  un serveur RDP réellement joignable, ce qu'aucun environnement de dev
  utilisé jusqu'ici ne fournit.

### CI : `rdp-sidecar` (2026-07-11 : corrigé — cassait tout `windows-workspace`)

Les commandes `cargo clippy --workspace`/`cargo build --workspace` du job
`windows-workspace` (`.github/workflows/ci.yml`) résolvent le workspace
racine (`core` + `src-tauri` + `rdp-ipc`) — **elles ne touchent jamais
`rdp-sidecar`**, exactement pour la raison qui a motivé sa séparation
(isolation de workspace). Longtemps noté ici comme simple lacune de
couverture (« un warning clippy dedans passerait inaperçu ») — en réalité
plus grave : `tauri-build`'s `build.rs` vérifie que
`src-tauri/binaries/rdp-sidecar-x86_64-pc-windows-msvc.exe` existe **avant
même de compiler `gui-termius`**, et ce fichier est gitignored (jamais
commité). Sur un checkout CI frais, il n'existe tout simplement pas — donc
`windows-workspace` **échouait à 100 % dès le premier `cargo clippy
--workspace`**, sans jamais avoir été détecté jusqu'à ce qu'un commit soit
réellement tenté après la RDP intégré. `release.yml` construisait déjà
`rdp-sidecar` et plaçait le binaire avant `tauri-action` (matrix Windows +
Linux) ; `ci.yml` ne répliquait pas cette étape. Fix : `ci.yml` construit
maintenant `rdp-sidecar` (debug, pour matcher le `cargo build --workspace`
du même job) et copie le binaire au bon endroit *avant* `Clippy (workspace)`
— sans quoi tout le reste du job échoue à ce même endroit, pas seulement le
lint de `rdp-sidecar`. Un job clippy dédié à `rdp-sidecar` a aussi été ajouté
(`core`, Linux, rapide ; `windows-workspace`, pour le chemin `WinClipboard`
réel) — l'ancienne lacune de couverture, elle, réellement comblée cette
fois.

**Piège NASM sur `windows-latest` — vérifié, pas supposé.** `release.yml`
construisait déjà `rdp-sidecar` sans installer NASM explicitement, en
s'appuyant implicitement sur le contenu de l'image du runner hébergé
(différent de cette machine de dev, où NASM a dû être installé à la main —
voir plus haut). Vérifié via le manifeste logiciel officiel
(`actions/runner-images`) : l'image Windows Server 2025/VS2026 vers laquelle
`windows-latest` a fini de migrer début juillet 2026 **ne liste pas NASM**.
Rien ne garantit que `release.yml` fonctionnait encore au moment d'écrire ces
lignes — pas testé en conditions réelles suite à ce changement d'image, la
lacune a juste été repérée en vérifiant la doc plutôt que découverte par un
échec. Fix : `ilammy/setup-nasm@v1` ajouté explicitement dans `ci.yml` *et*
`release.yml`, plutôt que de parier sur le contenu de l'image.

### Protocole `rdp-ipc`

`rdp-ipc/src/lib.rs` définit la trame entre les deux processus, dans les deux
sens, testée par 10 tests unitaires (`tokio::io::duplex`, aucun process réel
nécessaire) :
- **stdin du sidecar** : d'abord une unique ligne JSON `ConnectRequest {
  host, port, username, password }`, envoyée une fois au lancement, puis un
  flux continu de lignes JSON `ClientMessage` pour le reste de la vie du
  process — `MouseMove { x, y }`, `MouseButton { x, y, button, pressed }`
  (`button` = `MouseEvent.button` DOM brut), `MouseWheel { x, y, deltaY }`,
  `Key { code, pressed }` (`code` = `KeyboardEvent.code` DOM, indépendant du
  layout clavier), `ReleaseAll` (relâche tout côté serveur — envoyé par
  `RdpTab.tsx` sur perte de focus/visibilité, pour éviter une touche/bouton
  qui reste « collé »). **Piège vérifié empiriquement, pas juste supposé** :
  `#[serde(rename_all = "camelCase")]` sur un enum à tag interne ne renomme
  que les noms de variantes (la valeur de `"type"`), **pas** les champs des
  variantes struct — `delta_y` restait `delta_y` en JSON malgré l'attribut
  d'enum, nécessitant un `#[serde(rename = "deltaY")]` explicite sur ce
  champ précis. Un décalage de casse ici échoue silencieusement côté
  désérialisation Rust (aucune erreur de compilation d'aucun côté) ; couvert
  par un test dédié (`mouse_wheel_delta_y_field_is_camel_case_on_the_wire`)
  plutôt que seulement par le roundtrip Rust→Rust (qui ne prouve rien sur la
  casse réelle du JSON, seulement que l'écriture et la lecture Rust
  s'accordent entre elles).
- **stdout du sidecar** : une suite de `SidecarMessage` — `Image { canvas_width,
  canvas_height, x, y, width, height, pixels }` (RGBA8 brut), `Error(String)`,
  ou `Closed` — encodés en tag-byte + longueur préfixée (pas de framing
  texte, contrairement à `ConnectRequest`/`ClientMessage` : les pixels bruts
  pourraient contenir n'importe quel octet, y compris `\n`). **Optimisation
  perf (2026-07-11)** : `Image` ne renvoie plus la totalité du framebuffer à
  chaque mise à jour — seulement le rectangle `x`/`y`/`width`/`height`
  réellement modifié (l'info vient directement d'`ActiveStageOutput::GraphicsUpdate(region)`,
  auparavant tout simplement ignorée : `_region` dans `rdp-sidecar/src/main.rs`).
  `canvas_width`/`canvas_height` (taille pleine du bureau, répétée à
  l'identique sur la plupart des messages) permettent au frontend de
  distinguer « le bureau a changé de taille, redimensionne le `<canvas>` »
  (ce qui l'efface) de « simple retouche partielle à la même taille, laisse
  le canvas tel quel et peins juste ce rectangle ». Un frame *complet* reste
  forcé juste après la connexion et après chaque séquence de réactivation
  (resize) — sans ça, rien ne garantit que la toute première mise à jour
  après un changement de taille couvre effectivement tout l'écran, ce qui
  laisserait des zones noires jamais repeintes. Gain réel signalé par
  l'utilisateur après coup ("c'est déjà beaucoup mieux") : un écran 1280×800
  passait de ~4 Mo de pixels bruts (avant base64) par mise à jour à quelques
  centaines d'octets pour le cas courant (curseur, ligne de texte).

**Optimisation supplémentaire : `tauri::ipc::Channel` pour `Image` (2026-07-11
envisagée puis reportée, 2026-07-11 implémentée)** — `commands/rdp_view.rs`
réémettait chaque `SidecarMessage::Image` vers le frontend via un event Tauri
JSON classique (`app.emit("rdp-view-frame", ...)`, `RdpTab.tsx` en face avec
`listen(...)`), avec les pixels ré-encodés en base64 (`util::encode`) pour
tenir dans une string JSON — même convention que `terminal-data`. Ce chemin a
un coût fixe par message (sérialisation JSON côté Rust, parsing JSON +
décodage base64 côté JS) devenu proportionnellement plus visible une fois les
payloads réduits par le diffing par région ci-dessus. D'abord délibérément
pas fait (pas de preuve qu'un ralentissement résiduel existait réellement,
juste un raisonnement théorique) ; implémenté ensuite à la demande explicite
de l'utilisateur, sans nouveau signal d'usage entre-temps — donc à prendre
comme une optimisation préventive plutôt que la correction d'un problème
mesuré.

`connect_rdp_view` prend maintenant un paramètre `channel: tauri::ipc::Channel`
(créé côté `RdpTab.tsx`/`api.connectRdpView`, un par session — donc plus
besoin de filtrer par `id` comme sur les events globaux `rdp-view-error`/
`rdp-view-closed`, restés inchangés en JSON classique : ils ne tirent qu'une
fois par session, leur coût JSON est négligeable). Chaque `Image` est
sérialisée à la main en un en-tête binaire de 12 octets little-endian
(`canvas_width`/`canvas_height`/`x`/`y`/`width`/`height`, `u16` chacun) suivi
des pixels RGBA8 bruts, envoyée via `channel.send(InvokeResponseBody::Raw(...))`
— aucun `Serialize`/JSON pour ce type de message. Còté JS, `parseRdpFrame`
(`lib/api.ts`) relit cet en-tête avec un `DataView` puis expose `pixels`
comme une vue `Uint8Array` **zéro-copie** sur l'`ArrayBuffer` reçu (pas de
`base64ToBytes`) ; `RdpTab.tsx` construit directement un `Uint8ClampedArray`
sur ce même buffer pour `ImageData`/`putImageData`.

**Piège vérifié, pas juste supposé** : `tauri::ipc::Channel<TSend =
InvokeResponseBody>` (le paramètre par défaut) suffit sans avoir à
implémenter soi-même le trait `IpcResponse` — `InvokeResponseBody` s'auto-
implémente `IpcResponse` (retourne `Ok(self)`), et n'a délibérément *pas* de
`#[derive(Serialize)]` (vérifié dans les sources vendues de `tauri-2.11.5`,
`src/ipc/mod.rs`) pour éviter tout conflit avec le blanket impl `impl<T:
Serialize> IpcResponse for T` — sinon les deux impls se chevaucheraient et le
crate ne compilerait pas. Côté JS, un payload `InvokeResponseBody::Raw(bytes)`
arrive dans `Channel.onmessage` en tant qu'`ArrayBuffer` **quelle que soit sa
taille** : en dessous d'un seuil (1024 octets) il est `eval`é directement
(`new Uint8Array([...]).buffer`), au-dessus il repasse par le mécanisme de
`fetch` interne de l'IPC (`scripts/ipc-protocol.js`), qui résout lui aussi en
`response.arrayBuffer()` dès que le `content-type` n'est ni `application/json`
ni `text/plain` — vérifié dans les deux chemins plutôt que supposé identique.
Seule subtilité TypeScript rencontrée : `RdpFrame.pixels` doit être typé
`Uint8Array<ArrayBuffer>` (pas juste `Uint8Array`, qui s'infère
`Uint8Array<ArrayBufferLike>` avec ce TypeScript ≥ 5.7/6) sous peine de rejet
par le constructeur `ImageData` (qui exige spécifiquement `ArrayBuffer`, pas
`ArrayBufferLike`/`SharedArrayBuffer`).

**Vérifié** : `cargo clippy --workspace --all-targets -- -D warnings` et
`npx tsc --noEmit` propres, `node scripts/e2e-run.mjs` (smoke test WSL/
WebKitGTK) toujours au vert après ce changement. Comme pour l'implémentation
initiale, la session RDP réelle elle-même (peindre effectivement un
framebuffer distant à travers ce nouveau chemin binaire) n'a **pas** été
revalidée contre un vrai serveur dans cet environnement — même limitation
que d'habitude (aucun serveur RDP joignable ici) ; à confirmer par
l'utilisateur en conditions réelles avant de considérer le gain acquis.

Côté `rdp-sidecar`, `main.rs` garde `stdin` ouvert après avoir lu le
`ConnectRequest` et lance une tâche séparée qui boucle sur
`ClientMessage::read_from` jusqu'à fermeture/erreur, poussant chaque message
dans un `mpsc::unbounded_channel` — lu par `active_session`'s `tokio::select!`
en parallèle de `reader.read_pdu()`. Piège évité : un `mpsc::Receiver` fermé
renvoie `None` immédiatement à *chaque* poll, donc le sélectionner sans
précaution ferait tourner la boucle en boucle infinie CPU dès que stdin se
ferme — `recv_or_pending` bascule la branche sur un `std::future::pending()`
après le premier `None`, qui ne se résout plus jamais.

La conversion `ClientMessage` → PDU RDP passe par `ironrdp::input` (feature
`input` de la crate `ironrdp`, alias vers `ironrdp-input`) : son
`Database::apply(operations)`/`release_all()` porte déjà toute la machine à
états presser/relâcher et l'encodage en `FastPathInputEvent`, y compris
`MouseButton::from_web_button()` qui convertit directement la valeur DOM
`MouseEvent.button`. La seule pièce qu'il ne fournit pas : convertir
`KeyboardEvent.code` (ex. `"KeyA"`, `"ArrowLeft"`) en scancode PS/2 Set 1 —
table faite à la main dans `rdp-sidecar/src/input.rs::scancode_for`, capable
mais pas exhaustive (couvre lettres/chiffres/ponctuation/flèches/modifieurs/
F1-F12/pavé numérique ; touches média et impr-écran volontairement absentes).
Un code non reconnu est silencieusement ignoré plutôt que deviné.

Côté `commands/rdp_view.rs`, le sidecar est lancé via
`app.shell().sidecar("rdp-sidecar")` (`tauri_plugin_shell`) avec
`.set_raw_out(true)` — **obligatoire** : sans ce flag, le plugin découpe
stdout ligne par ligne pour le mode par défaut (pensé pour des logs texte),
ce qui corromprait silencieusement le framing binaire de `SidecarMessage` dès
qu'un octet `\n`/`\r` apparaît dans des pixels ou une longueur. Les
`CommandEvent::Stdout` bruts (chunks de taille arbitraire, pas alignés sur
les trames) sont réassemblés via un `tokio::io::duplex()` : un premier task
recopie les chunks dedans, un second relit des `SidecarMessage` complets avec
`rdp_ipc::SidecarMessage::read_from` — réutilisant le même parseur testé côté
`rdp-ipc`, plutôt que de dupliquer la logique de framing dans
`rdp_view.rs`. Chaque `SidecarMessage::Image` est réémis vers le frontend en
événement Tauri `rdp-view-frame` (pixels ré-encodés en base64, même
convention que `terminal-data`) ; `RdpTab.tsx` les peint directement sur un
`<canvas>` via `ImageData`/`putImageData` — pas de bibliothèque de rendu.

**Aucune entrée de capability n'est nécessaire** dans
`src-tauri/capabilities/default.json` pour `tauri-plugin-shell` : les
permissions de capacités ne gouvernent que les appels `invoke()` du
frontend vers les commandes *du plugin lui-même* (`plugin:shell|spawn`,
etc.) — jamais utilisées ici. `app.shell().sidecar(...)` est appelé
uniquement côté Rust, à l'intérieur de la commande `connect_rdp_view` (elle
déjà exposée au frontend via `invoke_handler`, comme toute commande maison
de ce projet) : c'est un appel Rust-vers-Rust qui ne passe jamais par le pont
IPC/capabilities.

### Portée phase 2 et limites connues

Le forward souris/clavier (`send_rdp_view_input`, `RdpTab.tsx`) est
implémenté et a été **validé pour de vrai contre un serveur RDP réel** le
2026-07-10 par l'utilisateur (voir plus haut : premier test réel avait
révélé le bug de `CryptoProvider`, corrigé, puis une connexion + interaction
réelles ont fonctionné, via `npx tauri dev` sous WSL). Côté frontend,
`RdpTab.tsx` :
- Coalesce `mousemove` à une frame d'animation max (`requestAnimationFrame`)
  plutôt que d'envoyer un événement IPC par pixel parcouru.
- Capture le relâchement de bouton au niveau `window`, pas juste sur le
  `<canvas>` : un drag qui sort du canvas avant le `mouseup` doit quand même
  être vu, sinon le bouton reste « collé » côté serveur RDP.
- Attache `wheel` manuellement via `addEventListener(..., { passive: false
  })` plutôt que la prop JSX `onWheel` — React délègue cet événement en mode
  passif par défaut (perf de scroll), ce qui rendrait `preventDefault()`
  silencieusement sans effet et laisserait la page défiler au lieu de la
  session distante.
- Réutilise `shouldBubbleToShortcut` (`lib/shortcuts.ts`, même mécanisme que
  `TerminalTab`) pour laisser passer les raccourcis de l'appli (changement
  d'onglet, etc.) plutôt que de tout intercepter aveuglément.
- Envoie `ReleaseAll` quand la vue perd le focus ou que l'onglet devient
  inactif, pour éviter qu'une touche modificatrice reste « enfoncée » côté
  serveur après un alt-tab ou un changement d'onglet.

**Presse-papiers (CLIPRDR) — synchronisation automatique bidirectionnelle,
Windows uniquement.** Option volontairement plus ambitieuse que le forward
souris/clavier : l'utilisateur a explicitement choisi cette voie plutôt
qu'une alternative plus simple (déclenchement manuel du côté local→distant)
après que je lui aie présenté les deux avec leurs coûts respectifs. Entièrement
contenu dans `rdp-sidecar` (`clipboard.rs`) — **aucun nouveau message
`rdp-ipc`, aucune nouvelle commande Tauri, aucun changement frontend** : le
sidecar parle directement au presse-papiers OS, une ressource partagée au
niveau du système donc déjà visible de n'importe quel process, pas besoin de
la faire transiter par l'app principale.

- `ironrdp-cliprdr-native`'s `WinClipboard` (Windows) fait tout le travail
  OS-spécifique (lecture/écriture réelle du presse-papiers, négociation de
  format) ; `StubClipboard` (toute autre plateforme) est un backend complet
  qui ne fait rien plutôt qu'une implémentation partielle — le canal CLIPRDR
  est quand même négocié avec le serveur, il ne produit/n'accepte simplement
  jamais de données. Aucune capacité fichier n'est annoncée par l'un ou
  l'autre (`client_capabilities()` renvoie `empty()`), donc pas de transfert
  de fichiers par presse-papiers — texte seulement.
- **Piège central, propre à ce choix** : `WinClipboard` s'appuie sur
  `WM_CLIPBOARDUPDATE` livré à une fenêtre cachée qu'elle possède — ce qui
  exige qu'un vrai thread Win32 tourne une boucle de messages
  (`GetMessageW`/`TranslateMessage`/`DispatchMessageW`) quelque part dans le
  process. `rdp-sidecar` est un process tokio pur, sans jamais aucune boucle
  de messages Win32 — contrairement à `ironrdp-client` (le client de
  référence) qui en a une gratuitement via sa propre fenêtre applicative
  (winit). Solution : un thread OS dédié (`std::thread::spawn`, jamais
  joint — tourne pour toute la durée du process), sur lequel `WinClipboard`
  est créée (elle est `!Send` : liée à la fenêtre/au thread qui l'a créée,
  ne peut pas être construite ailleurs puis déplacée) et où la boucle de
  messages tourne indéfiniment. Le `backend_factory()` qu'elle produit, lui,
  est `Send` et remonte vers le monde async via un `tokio::sync::oneshot`
  attendu avec un simple `.await` — pas de `blocking_recv()` ni d'autre
  primitive de blocage à l'intérieur du runtime tokio.
- Les messages sortants (`ClipboardMessage::SendInitiateCopy`/
  `SendFormatData`/`SendInitiatePaste`, émis par le backend quand le
  presse-papiers local change ou que le serveur demande des données)
  remontent via un `mpsc::UnboundedSender` — sûr à appeler depuis un thread
  non-tokio, `send()` n'est pas bloquant et ne requiert pas d'exécuteur.
  Troisième branche du `tokio::select!` de `active_session` (même piège
  « channel fermé = busy-loop » que pour `input_rx`, `recv_or_pending`
  généralisé pour servir les deux) : dépile ces messages et pilote
  `active_stage.get_svc_processor_mut::<CliprdrClient>()` (`initiate_copy`/
  `submit_format_data`/`initiate_paste`) pour produire la trame à envoyer.
- **Vérifié** : compilation + `clippy --all-targets -- -D warnings` propres
  à la fois sous WSL (chemin `StubClipboard`, aucun appel Win32) et
  nativement sous Windows (chemin `WinClipboard` réel, y compris les appels
  `unsafe` à `GetMessageW`/`DispatchMessageW` — leurs signatures exactes
  dans `windows` 0.62.2 n'étaient pas connues à l'avance, vérifiées par la
  compilation plutôt que par mémoire). **Validé pour de vrai le 2026-07-10**
  par l'utilisateur, copier-coller dans les deux sens, contre un vrai
  serveur RDP — nativement sous Windows (`gui-termius.exe` natif pointé sur
  le serveur Vite de WSL, port-forwarding WSL2 automatique confirmé
  fonctionnel plutôt que supposé). C'est la seule partie de l'aperçu intégré
  qui ne peut **pas** être exercée via `npx tauri dev` sous WSL seul (voir
  plus haut) : `StubClipboard` y tourne silencieusement à la place de
  `WinClipboard`, donc un test sous WSL seul ne prouverait rien sur le
  chemin réel — un lancement natif Windows est nécessaire (Vite peut rester
  côté WSL, joignable depuis Windows via le port-forwarding).

**Redimensionnement dynamique — résolution suit la taille de l'onglet.**
Ajouté après le forward souris/clavier, sur demande explicite de
l'utilisateur (« je peux redimensionner cette fenêtre, ça doit pouvoir
s'adapter »). Deux moments distincts partagent le même mécanisme serveur :

- **Taille initiale** : `ConnectRequest` transporte désormais `width`/
  `height`, mesurés par `RdpTab.tsx` sur son conteneur (toujours mis en page
  via flex, même avant que le canvas ne devienne visible — pas la peine
  d'attendre la première frame) au moment de `connect_rdp_view`, plutôt
  qu'une résolution fixe codée en dur. `build_config` les fait passer par
  `MonitorLayoutEntry::adjust_display_size` (`ironrdp_displaycontrol::pdu`)
  avant de les mettre dans `DesktopSize` : MS-RDPEDISP exige 200..=8192 et
  une largeur paire.
- **Redimensionnement en cours de session** : `RdpTab.tsx` observe son
  conteneur via `ResizeObserver`, débounce à 400 ms (chaque redimensionnement
  déclenche un aller-retour Display Control **et** une séquence de
  réactivation complète côté serveur — pas un simple redraw local, donc pas
  question d'en envoyer un par frame intermédiaire d'un drag de fenêtre) et
  envoie `ClientMessage::Resize { width, height }`. Côté `rdp-sidecar`,
  `active_stage.encode_resize(width, height, None, None)` (Display Control
  Virtual Channel, déjà attaché sans condition dans `build_connector` depuis
  la phase 1) encode la demande ; si le canal n'est pas disponible/pas encore
  connecté (`encode_resize` renvoie `None`), la demande est simplement
  ignorée — la session reste à la résolution courante plutôt que de tenter
  le fallback plus lourd du client de référence (reconnexion complète avec
  nouvelle taille, `RdpControlFlow::ReconnectWithNewSize` — non porté, coût
  jugé disproportionné pour un cas déjà rare avec les serveurs modernes).
- **Séquence de Désactivation-Réactivation** (MS-RDPBCGR §1.3.1.3) : la
  réponse du serveur à un resize accepté (et plus généralement à tout
  `ActiveStageOutput::DeactivateAll`, y compris ceux que le serveur
  déclenche de son propre chef). Longtemps traité comme fatal
  volontairement (« pas testable sans serveur réel ») — implémenté
  maintenant que le test réel contre un vrai serveur (voir plus haut,
  presse-papiers) a validé que l'architecture générale fonctionne.
  `handle_deactivate_all` (nouveau, `main.rs`) rejoue le mini
  échange capacités/finalisation en pilotant directement `reader`/`writer`
  (`ironrdp_tokio::single_sequence_step_read`, même primitive que celle
  utilisée par la connexion initiale) jusqu'à
  `ConnectionActivationState::Finalized`, puis reconstruit `image`
  (nouvelle résolution) et repointe `active_stage` dessus
  (`set_fastpath_processor`/`set_share_id`/`set_enable_server_pointer`).
  Porté depuis `ironrdp-client/src/rdp.rs`, mais adapté à l'API réellement
  résolue plutôt que copié tel quel — encore une fois deux signatures
  différentes de ce que la référence (une version plus récente) utilise :
  `ActiveStageOutput::DeactivateAll` transporte directement un
  `Box<ConnectionActivationSequence>` tout prêt (pas besoin d'un
  `activation_factory.create()` séparé comme dans la référence), et
  `ConnectionResult.connection_activation` (pas `activation_factory`) est le
  nom du champ correspondant en amont — vérifié en lisant les sources
  réelles de `ironrdp-connector` 0.9.0/`ironrdp-session` 0.10.0 avant
  d'écrire le code, pas supposé par analogie avec la référence.
- **Bug réel n°1 trouvé au premier test interactif** (2026-07-10,
  redimensionnement contre un vrai serveur RDP via l'app native Windows) :
  plantage immédiat au premier redimensionnement, `"traitement d'une trame :
  [Fast-Path ...] custom error"`. Cause : `handle_deactivate_all`
  reconstruisait le fast-path processor avec `bulk_decompressor: None`
  **sans condition** — alors que `build_config` négocie
  `compression_type: Some(CompressionType::K64)` et que la construction
  INITIALE (`ActiveStage::new`, code interne à `ironrdp-session`, non
  modifié) construit elle bien un décompresseur à partir de ce type négocié.
  Une fois la séquence de réactivation terminée, le serveur continue
  d'envoyer des mises à jour **compressées** (la compression se négocie une
  fois au niveau transport, pas rejouée à chaque réactivation) — sans
  décompresseur, la toute première mise à jour compressée échoue à se
  décoder. Fix initial (2026-07-10) : reconstruire un `BulkCompressor` frais
  à chaque réactivation via `build_bulk_decompressor` (nouveau, `main.rs`),
  qui reproduisait `to_bulk_compression_type` — une fonction **privée** de
  `ironrdp-session`, donc pas réutilisable telle quelle — en dépendance
  directe sur `ironrdp-bulk`.
- **Bug réel n°2 trouvé au retest** (2026-07-11, même scénario, une fois un
  environnement de test Windows natif à nouveau disponible) : le fix n°1
  arrêtait bien le plantage, mais l'affichage RDP restait **définitivement
  noir** après un redimensionnement — sans plus aucune erreur ni fermeture
  de session, donc rien à lire dans l'onglet. Diagnostiqué en lançant
  `gui-termius.exe` directement (pas `Start-Process`, qui ne capture rien)
  avec stdout/stderr redirigés vers un fichier, pour lire les logs `debug!`
  d'`ironrdp-session` (activés via `RUST_LOG`, voir l'infrastructure
  conservée plus bas) : les compteurs cumulés `total_compressed`/
  `total_uncompressed` loggués à chaque trame **repartaient de zéro** juste
  après chaque réactivation — un tout nouveau `BulkCompressor`, donc un
  historique glissant MPPC vide, était construit à chaque fois. Or cet
  historique doit rester continu avec celui du serveur, jamais réinitialisé
  de son côté : une Deactivation-Reactivation Sequence renégocie les
  capacités, elle ne relance pas la compression bulk au niveau transport. Un
  décompresseur frais et désynchronisé produit un flux dont la **longueur
  reste correcte** (elle dépend uniquement du bitstream compressé reçu, pas
  du contenu de l'historique local) mais dont le contenu est faux, et
  certaines trames finissent par échouer au décodage de structure en aval
  (`BitmapData::decode`, `"not enough bytes"`) — exactement le symptôme du
  bug n°1, simplement retardé de quelques trames au lieu d'immédiat, une
  fois le décompresseur *absent* remplacé par un décompresseur *présent mais
  désynchronisé*.
- **Fix final** : `handle_deactivate_all` n'appelle plus du tout
  `active_stage.set_fastpath_processor(...)` — le `fast_path::Processor`
  existant (avec son `bulk_decompressor`/`complete_data`/`pointer_cache`/
  `palette` intacts) reste en place tel quel à travers la réactivation ;
  seuls `image` (nouvelle taille), `share_id` et `enable_server_pointer`
  sont mis à jour via les setters dédiés d'`ActiveStage`
  (`set_share_id`/`set_enable_server_pointer`, déjà existants pour un autre
  usage). Contrepartie acceptée : le `share_id`/`io_channel_id`/
  `user_channel_id` internes au processor (utilisés uniquement pour encoder
  `FrameAcknowledgePdu`, un indice de pacing bande-passante, pas le rendu)
  restent ceux de la connexion initiale — `fast_path::Processor` n'expose
  aucun setter pour les corriger isolément, et c'était le seul compromis
  possible sans forker `ironrdp-session`. `build_bulk_decompressor`, la
  dépendance directe sur `ironrdp-bulk`, et le paramètre `compression_type`
  de `handle_deactivate_all` ont tous été supprimés (plus nécessaires, la
  fonction n'existe plus).
- **Vérifié** : compilation + `clippy --all-targets -- -D warnings` propres
  nativement sous Windows pour les deux bugs et leurs fixs (WSL indisponible
  pour la seconde vérification — panne réseau DNS temporaire sur cette
  machine ce jour-là, sans lien avec le code). **Le scénario complet
  (connexion RDP réelle + plusieurs redimensionnements de la fenêtre
  principale) a été validé pour de vrai par l'utilisateur le 2026-07-11**,
  sans erreur ni écran noir.
- **Infrastructure de diagnostic ajoutée en marge (conservée, pas
  temporaire)** :
  - `commands/rdp_view.rs` : la tâche qui relaie les événements du sidecar se
    contentait auparavant d'ignorer silencieusement `CommandEvent::Error`/
    `CommandEvent::Terminated` en cas de plantage réel (panique) du process
    — invisible pour l'utilisateur en release (`windows_subsystem =
    "windows"`, aucune console attachée). Elle capture maintenant les 4
    derniers Ko de stderr et, sur une sortie anormale (code ≠ 0) ou une
    erreur de pipe, émet un vrai `rdp-view-error` avec ce texte — visible
    directement dans l'onglet plutôt qu'un « Session RDP terminée »
    générique sans cause. Utile pour tout futur plantage du sidecar, pas
    seulement celui-ci ; et le fait que ce chemin ne se soit PAS déclenché
    pour le bug n°2 (le sidecar ne plantait pas, il continuait de tourner en
    boucle sur des trames désynchronisées) a aidé à orienter le diagnostic
    vers autre chose qu'un crash process.
  - `rdp-sidecar` : `tracing-subscriber` a maintenant la feature
    `env-filter`, et `main.rs` construit son subscriber via
    `EnvFilter::try_from_default_env()` (repli sur `"info"` si absent —
    même comportement qu'avant par défaut). Auparavant `fmt().init()`
    ignorait totalement `RUST_LOG` (feature absente de
    `tracing-subscriber`), rendant les `debug!`/`trace!` internes
    d'`ironrdp-session` impossibles à activer sans recompiler le tout. Pour
    un futur diagnostic similaire : ajouter
    `.env("RUST_LOG", "ironrdp_session=debug")` (ou toute autre cible de
    log) sur le `Command` du sidecar dans `connect_rdp_view`
    (`commands/rdp_view.rs`) avant `.spawn()`, provisoirement.

Limites connues restantes :
- **Pas de curseur rendu.** Les événements `PointerDefault`/`PointerHidden`/
  `PointerPosition`/`PointerBitmap` sont ignorés côté `rdp-sidecar`.
- **Molette approximative.** Chaque événement `wheel` du navigateur envoie
  un cran fixe (±120, la valeur RDP conventionnelle) dans le sens du signe
  de `deltaY`, pas la magnitude réelle — évite un piège de troncature côté
  encodage RDP (`MousePdu` tronque la rotation sur un octet signé ; relayer
  un `deltaY` de navigateur brut sur un gros geste de scroll risquerait un
  wraparound n'importe quoi).
- **Pas de fallback reconnexion si le Display Control Virtual Channel est
  indisponible.** Un redimensionnement demandé dans ce cas est simplement
  ignoré (voir plus haut) plutôt que de reconnecter avec la nouvelle taille
  — acceptable pour l'instant (rare avec des serveurs RDP modernes), mais à
  garder en tête si un serveur plus ancien est testé un jour.

## Harmonisation snippets/diffusion : Docker exec + RDP (2026-07-11)

Demande utilisateur : pouvoir exécuter ses snippets et utiliser la diffusion
de commandes (`BroadcastBar`) sur des onglets Docker exec et RDP, pas
seulement SSH. Investigation préalable (via un agent Explore) avant tout
code : le mécanisme d'exécution manuelle de snippets (`SnippetsPanel`/
`SnippetPicker` → `App.tsx::runSnippet` → `runOnTerminalHandle` →
`handle.runCommand`) et la diffusion (`BroadcastBar` → `broadcastCommand`,
même chemin) ne font **aucune** distinction par `HostKind` — ils passent par
`api.writeTerminal`, backend-agnostique côté Rust
(`state::TerminalSession`/`TerminalBackend` bridgent SSH et Docker exec sur
les mêmes canaux `mpsc`). **Conclusion : ça marchait déjà pour Docker exec
avant toute modification** — les onglets Docker exec utilisent `kind:
"terminal"` (comme SSH, juste avec `dockerContainerId` renseigné) et sont
donc déjà inclus dans `terminalRefs`/`broadcastTargets`. Le seul vrai trou
côté Docker exec était les **snippets au démarrage** (auto, à la connexion) :
absents à la fois côté backend (`connect_docker_exec` ignorait
`host.startup_snippets`/`env_vars`, contrairement à `connect_terminal`) et
côté UI (`HostForm.tsx`'s `sshOnlyExtras` masquait le champ pour tout kind
≠ `ssh`).

**Docker exec — fix du trou (petit, non ambigu, fait directement sans
demander)** : la construction des commandes de démarrage (`export` par
`env_vars` + une ligne par `startup_snippets`, dans l'ordre) a été extraite
de `connect_terminal` vers une fonction partagée
`pub(crate) fn startup_commands(workspace, host_id)` dans
`commands/terminal.rs`, réutilisée telle quelle par `connect_docker_exec`
(`commands/docker.rs`) — les deux ouvrent un shell POSIX-ish sur l'autre
bout, donc le même mécanisme s'applique verbatim. Côté `HostForm.tsx`,
`sshOnlyExtras` (qui gate aussi les bastions/keepalive/agent-forward,
des concepts propres au protocole SSH, sans équivalent Docker exec) a été
scindé : un nouveau `shellExtras = kind === "ssh" || kind === "dockerExec"`
gate spécifiquement les deux champs « Snippets au démarrage »/« Variables
d'environnement », désormais visibles et fonctionnels pour un hôte Docker
exec.

**RDP — décision de conception nécessaire, tranchée par l'utilisateur.**
Contrairement à Docker exec, RDP n'a structurellement **rien** : les onglets
RDP (`kind: "rdp-view"`) ne sont même pas enregistrés dans `terminalRefs`
(pas de `ref` du tout sur `<RdpTab>` avant ce chantier), et
`rdp_ipc::ClientMessage` n'avait aucun moyen d'injecter du texte — seulement
souris/clavier physique (scancode)/redimensionnement. Deux approches
possibles avec un vrai compromis UX, présentées à l'utilisateur via
`AskUserQuestion` plutôt que de trancher seul : (a) frappe clavier simulée
(texte tapé caractère par caractère, exécution immédiate, mais tape dans la
fenêtre qui a le focus côté distant sans garantie que ce soit le bon
endroit) vs (b) presse-papiers distant à la demande (plus prévisible, mais
casse l'exécution « immédiate » et Windows-only, CLIPRDR réel n'existe que
côté `WinClipboard`). **Choix utilisateur : (a) frappe clavier simulée.**

**Implémentation (a) — nouveau `ClientMessage::TypeText { text: String }`**
(`rdp-ipc/src/lib.rs`, testé par un roundtrip incluant des caractères non-ASCII
pour vérifier l'encodage Unicode, pas juste ASCII). Côté `rdp-sidecar`
(`main.rs::operations_for`), chaque caractère de `text` devient une paire
`ironrdp_input::Operation::UnicodeKeyPressed`/`UnicodeKeyReleased` — trouvée
en lisant les sources vendues de `ironrdp-input` 0.6.0 plutôt que supposée :
c'est une vraie primitive d'entrée Unicode (PDU `UnicodeKeyboardEvent`,
gère nativement les paires de substituts UTF-16 pour les caractères hors
BMP), distincte du chemin scancode existant (`input.rs::scancode_for`, table
figée de touches physiques, incapable d'exprimer du Unicode arbitraire).
**Piège évité** : `\n`/`\r` dans `text` ne sont **pas** tapés comme caractère
Unicode littéral — un retour à la ligne tapé comme texte n'est interprété
par la plupart des applications comme « valider cette ligne » (contrairement
à une vraie frappe physique de la touche Entrée) — donc traités à part comme
une vraie pression de touche Entrée via le chemin scancode existant
(`scancode_for("Enter")`). Ce choix unifié (un seul algorithme caractère par
caractère, `\n`/`\r` → Entrée réelle, sinon Unicode) permet à
`RdpTab.tsx::runCommand` de simplement faire `text: command + "\n"` — même
convention que SSH/Docker's `command + "\r"` — et aux snippets multi-lignes
de fonctionner "gratuitement" (chaque `\n` interne devient une vraie touche
Entrée entre les lignes), **sans jamais** passer par le trick
`echo '<b64>' | base64 -d | bash` que `runOnTerminalHandle` (`App.tsx`)
utilise pour SSH/Docker — rien ne garantit qu'un shell (encore moins bash)
a le focus côté bureau distant, donc un snippet multi-ligne RDP est tapé
ligne par ligne tel quel plutôt que compressé en un one-liner.

**`RdpTab.tsx` expose maintenant un handle `TerminalTabHandle`** (même forme
que `TerminalTab`/`LocalTerminalTab` : `runCommand`/`writeRaw`/
`getScrollbackText`/`dispose`), via `forwardRef`+`useImperativeHandle` —
converti depuis une simple fonction composant. `getScrollbackText` renvoie
`""` (pas de scrollback textuel, RDP est une image, pas un terminal).
`writeRaw` (utilisé par le mode diffusion « frappe synchronisée en direct »)
relaie fidèlement les caractères imprimables, mais une source terminal peut
aussi émettre des séquences d'échappement ANSI (flèches, touches de
fonction) qui seraient tapées littéralement comme texte — limitation connue
et acceptée, pas de parseur ANSI construit pour ce mode secondaire.
`App.tsx` enregistre désormais ce handle dans `terminalRefs` pour le branche
`tab.kind === "rdp-view"` (absent avant), et `broadcastTargets` inclut
`"rdp-view"` dans son filtre. `runOnTerminalHandle` prend un nouveau
paramètre `shellCapable` (calculé aux deux points d'appel,
`runSnippet`/`broadcastCommand`, via `tabs.find(...)?.kind !== "rdp-view"`)
pour ne jamais appliquer le wrapping bash/base64 à une cible RDP.

**Vérifié** : `cargo clippy` propre sur les deux workspaces (racine +
`rdp-sidecar`, séparé — voir la section sidecar plus haut pour pourquoi),
tests unitaires `rdp-ipc`/`rdp-sidecar`/`commands::terminal` verts,
`npx tsc --noEmit` propre, `node scripts/e2e-run.mjs` (smoke WSL/WebKitGTK)
au vert. **Non vérifié** : une vraie frappe de snippet contre un serveur RDP
réel — même limitation habituelle de cet environnement de dev (aucun
serveur RDP joignable ici). À valider par l'utilisateur en conditions
réelles, en particulier : est-ce que la fenêtre qui a effectivement le focus
côté distant reçoit bien le texte à l'endroit attendu (risque inhérent à
l'approche « frappe simulée » choisie, pas un bug potentiel de
l'implémentation).

## Docker exec via SSH (bastion) — `Host::docker_via_host_id` (2026-07-11)

Ajouté pour le même besoin que le tunnel SSH pour Docker évoqué à l'origine :
joindre le démon Docker d'un hôte distant sans jamais exposer son API Engine
en TCP (le risque déjà signalé pour le test WSL — accès root-équivalent sans
authentification). Quand `Host::docker_via_host_id` est renseigné sur un hôte
`dockerExec`, `docker::connect_via_ssh` (`core/src/docker.rs`) tunnelle
l'API Engine sur une connexion SSH déjà configurée dans l'app, au lieu de
`docker::connect`'s socket/tcp direct.

**Pourquoi pas la feature `ssh` de `bollard` elle-même** (vendored mais
jamais activée dans ce projet — vérifié dans `bollard-0.21.0/src/ssh.rs`,
présent en source même sans la feature) : elle shell-out vers le binaire
`ssh` du système via la crate `openssh` (ControlMaster), ce qui veut dire un
modèle d'authentification différent (config/agent SSH du système) que celui
de l'app (coffre/`known_hosts.json` propres à `russh`) — pas cohérent avec
la promesse de gui-termius de gérer les identifiants pour l'utilisateur.
`DialStdioConnector` (nouveau) reproduit le même principe — un canal *frais*
par connexion sous-jacente demandée par le client HTTP, exécutant `docker
system dial-stdio` sur l'hôte distant (le même pont qu'utilise `docker
context ... ssh://` en natif) — mais en s'appuyant sur une session `russh`
déjà authentifiée (`ssh::connect`, coffre + `known_hosts` + chaînage de
bastions existants réutilisés tels quels) plutôt qu'un nouveau processus
`ssh` externe. `DialStdioConnector` implémente `tower_service::Service<Uri>`
et se branche sur un vrai `hyper_util::client::legacy::Client` (comme le
fait `bollard` en interne pour ses transports `Http`/`Unix`/`Ssh`), passé à
`Docker::connect_with_custom_transport`.

**Piège vérifié : l'API bas niveau `hyper::client::conn::http1` ne pose
jamais de header `Host`.** Une première version pilotait directement
`hyper::client::conn::http1::handshake` + `send_request` à la main — chaque
requête partait sans header `Host`, que le démon Docker rejette
immédiatement (`400 Bad Request: missing required Host header`). Ce n'est
pas un défaut de configuration : cette API bas niveau n'a simplement aucun
mécanisme par défaut pour ça, contrairement à `hyper_util::client::legacy::Client`
(vérifié en lisant `bollard`'s propre `src/ssh.rs`/`connect_with_ssh`, qui
passe systématiquement par ce client haut niveau, jamais par l'API bas
niveau). Fix : construire un vrai `Client<DialStdioConnector, BodyType>` et
lui déléguer chaque requête, comme le fait `bollard` en interne.

**Fausse piste explorée puis abandonnée : `pool_max_idle_per_host(0)`.**
Ajouté d'abord par précaution (peur qu'un canal partagé bloque si deux
requêtes se chevauchent, ex. `resize_exec` pendant qu'un `exec` attaché
diffuse encore) — retiré ensuite en comparant avec `bollard::connect_with_ssh`
(qui ne le fait pas) : une connexion *upgradée* (hijackée, cas de `exec`
attach) sort de toute façon du pool une fois hijackée, donc une requête
concurrente obtient naturellement un nouveau canal sans jamais attendre —
la peur initiale de deadlock reposait sur un modèle mental erroné. Ce retrait
n'a PAS corrigé le bug utilisateur ci-dessous (juste rapproché le code de la
référence `bollard`) — la vraie cause était ailleurs, trouvée seulement après
avoir testé pour de vrai (voir le harnais de diagnostic plus bas).

**Bug réel trouvé par l'utilisateur, sans rapport avec le tunnel SSH lui-même :**
conteneurs bien listés, mais cliquer dessus pour ouvrir un exec donnait un
terminal vide avec juste un curseur clignotant — jamais de prompt, aucune
frappe n'avait d'effet. `docker::open_exec`'s commande codée en dur,
`sh -c "exec bash || exec sh"`, existait déjà avant ce chantier SSH (jamais
testée avant faute de démon Docker réellement joignable — voir plus bas dans
la roadmap) : sur une image sans `bash` (ex. `alpine`, testé pour de vrai),
le `/bin/sh` par défaut est BusyBox `ash`, dont le comportement sur un
`exec` ciblant une commande introuvable est de **quitter tout le script**
immédiatement (`sh: exec: line 0: bash: not found` puis fermeture du
canal en ~50 ms) plutôt que de renvoyer un code d'erreur non-nul que `||`
pourrait rattraper — contrairement à `bash`/`dash`. Le `|| exec sh` de
secours n'était donc **jamais atteint** sur ce type d'image. Fix : vérifier
l'existence de `bash` d'abord avec `command -v` (builtin POSIX, ne
déclenche jamais ce comportement) avant de l'`exec`er :
`command -v bash >/dev/null 2>&1 && exec bash || exec sh`.

**Harnais de diagnostic réutilisable** : `core/examples/docker_ssh_debug.rs`
(`cargo run --example docker_ssh_debug -- <uuid-hôte-docker>`, à lancer
nativement sous Windows si l'hôte SSH cible utilise le coffre OS — le
harnais lit le vrai `workspace.json`/trousseau de la machine, exactement le
chemin `connect_for_host` → `open_exec` emprunté par l'app réelle). Trouvé
l'UUID de l'hôte Docker en cherchant son `label` dans `workspace.json` (
`%APPDATA%\gui-termius\gui-termius\config\workspace.json` sous Windows).
Écrit spécifiquement pour ce bug — a permis de reproduire et corriger en
quelques secondes d'itération (`cargo run --example`) plutôt qu'un cycle
complet de rebuild+relance de toute l'app GUI à chaque essai (plusieurs
dizaines de secondes minimum, comptes rendus dans ce fichier plus haut).
Conservé pour tout futur bug Docker/SSH — pas un script jetable.

## Pièges déjà rencontrés (pour ne pas les redécouvrir)

- **Drag-and-drop natif vs Tauri.** Sur Windows, le drag-and-drop OS-level de
  Tauri (nécessaire pour déposer des fichiers depuis l'Explorateur, cf.
  `dragDropEnabled` / `onDragDropEvent`) désactive le drag-and-drop HTML5 natif
  du navigateur pour toute la fenêtre. Résultat : un `draggable`/`onDragStart`
  classique ne fonctionne pas pour un drag *interne* à l'app (ex. glisser un
  fichier entre deux panneaux SFTP) tant que ce mécanisme OS reste actif. La
  solution retenue ici (voir `TransferTab.tsx`, `TabBar.tsx`) : implémenter le
  drag interne à la souris (`mousedown`/`mousemove`/`mouseup`) plutôt qu'avec
  l'API HTML5 Drag and Drop.

- **xterm.js avale les raccourcis clavier.** xterm.js appelle
  `stopPropagation()` sur toute touche qu'il traite lui-même (dès que
  `attachCustomKeyEventHandler` ne renvoie pas explicitement `false`). Un
  raccourci global écouté en bulle sur `window` ne se déclenche donc **jamais**
  tant qu'un terminal a le focus — ce qui est presque tout le temps. Le
  correctif n'est pas de passer l'écoute globale en phase de capture (ça
  casserait des raccourcis shell essentiels, voir point suivant) : chaque
  `TerminalTab`/`LocalTerminalTab` laisse explicitement passer (renvoie `false`
  pour) les combinaisons qui correspondent à un raccourci app connu pour ne pas
  entrer en collision avec le shell (`shouldBubbleToShortcut` dans
  `lib/shortcuts.ts`).

- **Collisions raccourcis app ↔ shell.** Plusieurs combinaisons Ctrl+lettre
  « naturelles » sont déjà prises par readline/le shell : Ctrl+W (supprime le
  mot précédent), Ctrl+K (kill-line), Ctrl+U (kill jusqu'au début de ligne),
  Ctrl+\ (SIGQUIT), Ctrl+R (recherche d'historique). Avant de proposer une
  combinaison par défaut pour une nouvelle action, vérifier `shellBindingWarning`
  dans `lib/shortcuts.ts` (et l'étendre si la collision n'y est pas déjà
  répertoriée) plutôt que de la découvrir après coup.

- **Préférences = `localStorage` de la webview, pas un fichier.** Changer une
  valeur par défaut dans `DEFAULT_PREFERENCES` (`lib/preferences.ts`) n'a aucun
  effet rétroactif sur une installation déjà utilisée : la valeur précédente
  reste persistée. Utile à savoir avant de dire à l'utilisateur qu'un nouveau
  défaut « s'applique » — ça ne concerne que les prefs jamais modifiées/jamais
  sauvegardées.

- **Compat ascendante du `workspace.json`.** Toute nouvelle propriété ajoutée à
  un struct Rust sérialisé dans le workspace (`Host`, `Group`, `Snippet`, …)
  doit être `#[serde(default)]` (ou `Option<T>` avec default) pour rester
  compatible avec les fichiers déjà sauvegardés par les utilisateurs existants.

- **`sudo` dans ce WSL n'a pas d'accès non-interactif.** Toute commande qui
  invoque `sudo` (directement, ou en cascade via `npx playwright install
  --with-deps`) reste bloquée indéfiniment sur un prompt de mot de passe qui
  n'arrivera jamais — silence total, 0% CPU, aucune sortie : c'est le
  symptôme caractéristique, pas une commande lente. Ne pas attendre plus
  longtemps en espérant que ça débloque. Tuer le processus bloqué (`kill -9`,
  pas `sudo pkill` qui a le même problème) et demander à l'utilisateur de
  lancer la commande `sudo` lui-même via le préfixe `!`.

- **Un process lancé en arrière-plan via `wsl.exe -e bash -lc "cmd &"` meurt
  dès que cet appel `wsl.exe` se termine** (même avec `nohup`) — ce n'est PAS
  un process persistant. Pour un serveur de longue durée (Vite, tauri-driver,
  un serveur de test), utiliser le paramètre `run_in_background: true` de
  l'outil Bash lui-même sur la commande *au premier plan* (sans `&` interne)
  — c'est ce mécanisme, pas un `&` shell, qui garde le process vivant entre
  deux appels d'outil.

- **GTK sous WSLg rend en Wayland natif par défaut, invisible pour les outils
  X11** (`scrot`, `xwininfo`, et le pilote `WebKitWebDriver` utilisé pour les
  tests E2E). La fenêtre existe et le process tourne, mais n'apparaît dans
  aucun arbre de fenêtres X11 et un screenshot X11 classique donne un écran
  noir. Forcer `GDK_BACKEND=x11` (en plus de `DISPLAY=:0`) dans l'environnement
  du process pour que la fenêtre soit une vraie fenêtre XWayland pilotable —
  `scripts/e2e-run.mjs` le fait déjà pour Vite et `tauri-driver`.

- **Le binaire Tauri charge `build.devUrl` (`http://localhost:1420`) par
  défaut, y compris en `--release`** — seul le feature flag Cargo
  `tauri/custom-protocol` (activé automatiquement par la CLI `tauri build`,
  jamais par un `cargo build` direct) fait basculer sur `frontendDist`
  embarqué. Sans serveur Vite qui tourne en parallèle et sans ce feature, la
  fenêtre affiche juste « Could not connect to localhost » — ce n'est pas un
  bug de l'app. Détail complet et commande exacte dans la section « Tests E2E
  réels » ci-dessus (piège `custom-protocol`).

- **Écritures des fichiers de config = atomiques, obligatoirement.** Tout ce qui
  écrit un fichier de config/secret passe par `secure_file::write_private`, qui
  écrit un temp 0600 puis `rename` (atomique) — jamais une troncature-écriture
  sur place. Deux raisons : (a) les lectures sont désormais *fail-closed* (un
  `known_hosts.json`/`workspace.json` tronqué par un crash en cours d'écriture
  serait refusé, verrouillant l'utilisateur hors de tous ses hôtes) ; (b) les
  tests d'intégration `core/tests/` partagent le **vrai** `known_hosts.json`
  (`ProjectDirs`, aucune isolation de chemin) et tournent en parallèle — une
  écriture non atomique laisse un autre thread lire un fichier à moitié écrit.
  C'est exactement ce qui a fait échouer `ssh_integration::bastion_chain…` en CI
  (« Unknown server key ») une fois le fail-closed introduit. Ne pas revenir à un
  `std::fs::write` direct pour ces fichiers.

- **`$env:CARGO_TARGET_DIR` (comme le reste de `$env:PATH`/`Set-Location`) ne
  survit pas d'un appel PowerShell à l'autre.** Chaque invocation de l'outil
  PowerShell démarre un état frais — seul le répertoire de travail persiste,
  pas les variables d'environnement ni le `$env:PATH` étendu. Oublier de
  reposer `$env:CARGO_TARGET_DIR = "$env:USERPROFILE\..."` dans un appel
  `cargo build` séparé du précédent fait retomber silencieusement sur le
  target dir par défaut (relatif au `Cargo.toml`, donc sur le chemin UNC) et
  reproduit exactement le piège du lock file incrémental documenté plus haut
  (« Lock file de compilation incrémentale impossible à créer sur un chemin
  UNC ») — rencontré deux fois de suite pendant la même session de debug RDP
  avant d'y penser systématiquement à chaque nouvel appel `cargo`.

- **Un process `rdp-sidecar.exe`/`gui-termius.exe` resté ouvert après un test
  précédent verrouille le binaire que le build suivant essaie d'écrire.**
  Symptôme trompeur : `cargo build` compile sans erreur (« Finished... »),
  mais l'étape de copie automatique du sidecar dans le `build.rs` de
  `tauri-build` panique avec `Os { code: 5, kind: PermissionDenied, message:
  "Accès refusé." }` — rien à voir avec le code qui vient d'être modifié.
  `Get-Process rdp-sidecar,gui-termius -ErrorAction SilentlyContinue | Stop-Process
  -Force` avant de relancer le build ; particulièrement facile à oublier
  quand on itère vite sur plusieurs correctifs RDP d'affilée (voir plus haut).

## Harmonisation Docker exec / RDP avec SSH : clic hôte, split terminal, SFTP (2026-07-12)

Trois demandes successives de l'utilisateur pour rapprocher le comportement
des hôtes Docker exec et RDP de celui des hôtes SSH.

**Clic sur un hôte RDP → aperçu intégré par défaut.** Avant : clic principal
= lanceur système (`connect_rdp`, `mstsc.exe`/`xfreerdp`), aperçu intégré
uniquement accessible via le menu « … » → bouton dédié. Après
(`HostsPanel.tsx::handleConnect`) : clic principal = `onConnectRdpView`
(aperçu intégré), le lanceur système bascule dans le menu « … » sous
« Client système » (icône/tooltip mis à jour pour expliquer le compromis :
lecture-seule mais intégré vs. pleinement interactif mais externe). Choix de
l'utilisateur explicite, pas une supposition — cohérent avec le fait que
SSH/Docker exec ouvrent déjà directement au clic.

**Split terminal (panneau 2) : Docker exec et RDP.** `SplitPane.tsx` ne
gérait avant que `"local" | HostId` en supposant systématiquement un shell
SSH-shaped — sélectionner un hôte Docker exec ou RDP y tentait silencieusement
une connexion SSH sur un hôte qui n'en est pas un. Fix : le composant résout
maintenant `host.kind` et branche vers le bon rendu — `RdpTab` directement
pour `rdp`, un `ConnectionPickerModal` de conteneurs (même composant que
`HostsPanel.tsx`) avant `TerminalTab` avec `dockerContainerId` pour
`dockerExec`, un message explicite (pas de backend) pour `k8sExec`. Annuler
le picker Docker retombe sur « local ». Le menu déroulant affiche maintenant
le type d'hôte en suffixe (`Nom (Docker exec)`) pour les kinds ≠ ssh.

**Docker exec dans le mode SFTP (transfert de fichiers) — le morceau
substantiel.** Contrairement aux deux points ci-dessus (recâblage UI sur du
backend déjà existant), celui-ci demandait un vrai nouveau backend : Docker
n'a pas de sous-système SFTP.

- `core/src/sftp.rs` : nouveau trait `RemoteFileClient` (`async_trait`,
  `list`/`make_dir`/`remove_file`/`remove_dir`/`rename`/`set_permissions`/
  `read_to_string`/`write_string`/`download`/`upload`), implémenté pour
  `SftpClient` (délégation directe vers les méthodes inhérentes existantes,
  aucun changement de comportement) et pour le nouveau `DockerPaneClient`
  (`core/src/docker_pane.rs`). `download`/`upload` prennent
  `&mut (dyn FnMut(u64, u64) + Send)` plutôt que `impl FnMut` — un paramètre
  générique rendrait le trait non object-safe, et `PaneRef` a besoin de le
  stocker derrière `Arc<dyn RemoteFileClient>`. **Piège rencontré, pas
  supposé** : passer `&Arc<dyn RemoteFileClient>` là où `&dyn
  RemoteFileClient` est attendu échoue à la compilation (`the trait
  RemoteFileClient is not implemented for Arc<dyn RemoteFileClient>`) — la
  coercion de déréférencement implicite ne s'applique pas automatiquement à
  travers ce genre de double indirection en position d'argument ; fix :
  `.as_ref()` explicite à chaque site d'appel (`transfer.rs`).
- `core/src/transfer.rs` : `PaneRef::Remote(Arc<SftpClient>)` →
  `Arc<dyn RemoteFileClient>` — toute la logique de dispatch local/distant
  (list/mkdir/rename/chmod/read/write/remove/copy, y compris le cas
  distant-à-distant relayé par fichier temporaire) reste **inchangée**,
  elle fonctionne maintenant génériquement pour n'importe quel backend
  `RemoteFileClient`, pas seulement SFTP.
- `core/src/docker_pane.rs` (`DockerPaneClient`) — deux surfaces d'API Docker
  Engine différentes selon l'opération, aucune des deux déjà utilisée dans ce
  dépôt avant ce chantier :
  - **Opérations de métadonnées** (list/mkdir/rename/remove/chmod) : shell
    dans le conteneur via un nouvel `exec_capture` (`core/src/docker.rs`,
    `exec` non-TTY, capture stdout, échoue sur code de sortie non nul —
    même esprit de portabilité que `open_exec`'s `command -v bash` pour la
    détection BusyBox `ash` vs `bash`). Le listing (`ls -1a` + `stat -c`
    par entrée, une seule invocation `exec` avec une boucle shell interne,
    pas un aller-retour par fichier) parse une sortie délimitée par
    tabulations avec `splitn(6, '\t')` — un nom de fichier contenant une
    tabulation reste intact dans le dernier champ, un nom contenant un vrai
    retour à la ligne casse le parsing (limitation acceptée : c'est du texte
    shell, pas un protocole framé comme SFTP). Toutes les commandes passent
    les chemins en paramètres positionnels (`sh -c '<script>' sh "$1" "$2"`)
    plutôt que par interpolation dans le texte du script — aucun risque
    d'injection quel que soit le contenu du chemin.
  - **Contenu des fichiers** (read/write/upload/download) : les endpoints
    d'archive Docker Engine (`GET`/`PUT /containers/{id}/archive`, streams
    tar) — `bollard::Docker::download_from_container`/`upload_to_container`,
    jamais appelés ailleurs dans ce dépôt avant ce chantier (vérifié par
    lecture des sources vendues de `bollard-stubs` pour les builders
    `DownloadFromContainerOptionsBuilder`/`UploadToContainerOptionsBuilder`,
    introuvables par grep direct car générés). Nouvelle dépendance directe
    `tar = "0.4"` dans `core/Cargo.toml` pour construire/lire les archives à
    une seule entrée.
  - **Limitation connue, acceptée pour cette première version** :
    contrairement à SFTP qui transfère réellement par blocs, upload comme
    download bufferisent le fichier entier (dans un tar) en mémoire avant/
    après l'appel Engine API — sans risque pour des fichiers de config/code
    ordinaires, risqué pour du multi-gigaoctets. La progression est réelle
    pour `download` (le stream tar arrive par blocs) mais seulement
    approximative pour `upload` (rapportée pendant la lecture du fichier
    local en mémoire, pas pendant l'envoi réseau réel).
- `src-tauri/src/state.rs` (`Pane.client`) et `commands/sftp.rs`
  (`PaneSource::Docker { host_id, container_id }`, `open_pane`) suivent le
  même schéma que `RemoteFileClient` — `Pane.connection` reste `None` pour
  un pane Docker : le `bollard::Docker` du `DockerPaneClient` garde déjà tout
  vivant en interne (y compris, si `docker_via_host_id` est utilisé, la
  connexion SSH sous-jacente — voir la section « Docker exec via SSH »
  ci-dessous), pas besoin de dupliquer cette responsabilité.
- Frontend : `PaneSource` (`types.ts`) gagne le variant `docker`.
  `TransferTab.tsx`'s `PaneView` (sélecteur de source par panneau) et
  `SftpPanel.tsx` (clic direct sur un hôte pour ouvrir un onglet transfert)
  gagnent chacun le même picker de conteneur que `HostsPanel.tsx`/
  `SplitPane.tsx` — troisième réutilisation de ce pattern dans la session,
  devenu le mécanisme standard de ce projet pour « choisir une cible Docker
  vivante avant de connecter ». `SftpPanel.tsx` et le sélecteur de
  `TransferTab.tsx` filtrent la liste d'hôtes à `ssh`/`dockerExec`
  uniquement (`rdp`/`k8sExec` n'ont pas de backend de listing de fichiers).
  Ouvrir l'onglet transfert directement depuis `SftpPanel.tsx` sur un hôte
  Docker exec ouvre désormais le panneau droit déjà connecté au bon
  conteneur (`dockerContainerId` déjà propagé par `TabMeta`/`openTab` pour
  les autres kinds de tab, juste jamais branché jusqu'ici jusqu'à
  `TransferTab`).

**Vérifié** : `cargo clippy --workspace --all-targets -- -D warnings` propre,
`cargo test -p termius-core -p gui-termius` vert (58 + 3 tests unitaires,
4 tests d'intégration réels avec un vrai `sshd` dont `sftp_round_trip` —
confirme que le passage à `Arc<dyn RemoteFileClient>` n'a rien cassé côté
SFTP réel ; un des 4 tests d'intégration, `local_port_forward_reaches_a_local_service`,
a échoué une fois en exécution parallèle puis passé en isolation — flakiness
de bind de port pré-existante, sans rapport avec ce chantier, jamais touché
`port_forward.rs`), `npx tsc --noEmit` propre, `node scripts/e2e-run.mjs`
(smoke WSL/WebKitGTK) au vert. **Non vérifié** : le chemin Docker complet
(list/mkdir/rename/remove/chmod/upload/download réels) contre un vrai démon
Docker — aucun démon joignable dans cet environnement WSL (Docker Desktop
sans intégration WSL activée, même limitation déjà documentée pour le reste
du support Docker exec de ce projet). Le script shell de listing et le
roundtrip tar sont couverts par tests unitaires (`docker_pane::tests`), pas
par une exécution réelle dans un conteneur.

**Bug réel trouvé par l'utilisateur au premier essai contre un vrai
conteneur** : `open_pane` échouait immédiatement avec `invalid args source
for command open_pane: missing field container_id`. Cause : exactement le
piège déjà documenté ci-dessus pour `rdp_ipc::ClientMessage` (et donc
reproduit sans y penser) — `#[serde(rename_all = "camelCase")]` sur un enum
à tag interne ne renomme que les valeurs de `"kind"`, pas les champs des
variantes struct. `PaneSource::Docker` avait bien un `#[serde(rename =
"hostId")]` explicite sur `host_id` (copié depuis `Remote`) mais pas
l'équivalent sur `container_id`, qui restait donc attendu tel quel côté
Rust alors que le frontend envoie `containerId`. Fix : `#[serde(rename =
"containerId")]` explicite, plus un test de régression dédié
(`commands::sftp::tests::pane_source_docker_accepts_camel_case_field_names`,
désérialise un JSON écrit à la main avec les clés camelCase réelles) —
un roundtrip Rust→Rust n'aurait rien prouvé ici, comme noté la première
fois. Lien direct avec la note plus haut : documenter un piège une fois ne
suffit pas à ne pas le refaire soi-même sur un nouveau type ; le test de
régression est ce qui empêche une troisième occurrence de repasser inaperçue.

## Glisser-déposer vers le presse-papiers RDP (fichiers + dossiers) (2026-07-12)

Deuxième moitié du chantier d'harmonisation Docker/RDP démarré plus haut —
la partie protocolaire, jamais testable dans cet environnement de dev.
Décisions actées avec l'utilisateur avant tout code (`AskUserQuestion`,
puisque les deux points avaient un vrai risque de malentendu) :
1. **Sémantique** : glisser un fichier/dossier depuis le panneau de gauche
   sur la vue RDP à droite le rend disponible sur le presse-papiers distant
   — l'utilisateur doit ensuite coller (Ctrl+V) lui-même où il veut côté
   session distante. CLIPRDR n'a aucune notion de « dossier cible » ; pas
   de dépôt automatique à un endroit précis, techniquement impossible sans
   agent côté serveur distant.
2. **Portée** : fichiers *et* dossiers dès la première version (pas juste
   les fichiers simples).

**`TransferTab.tsx` gagne un mode RDP.** Quand `host.kind === "rdp"`, le
panneau droit n'est plus un `PaneView` (aucun backend de listing pour RDP)
mais directement `<RdpTab>` — pas de sélecteur de source, pas de
navigation, juste la vue live. Le panneau gauche reste un navigateur de
fichiers normal (local par défaut, sélectionnable vers ssh/dockerExec).
Déposer une sélection dessus (mécanisme de drag maison déjà en place,
souris pas HTML5 DnD — voir plus haut dans ce fichier) appelle
`pushToRdp` au lieu de `copy`. Point d'entrée : nouveau bouton
« Transférer des fichiers » dans le menu « … » d'un hôte RDP
(`HostsPanel.tsx`), réutilisant le prop `onOpenTransfer` déjà câblé pour
`SftpPanel.tsx` (même `openTab("transfer", host)`, `containerId`
simplement omis).

**Chaîne complète, de haut en bas :**
1. `commands/rdp_view.rs::push_rdp_view_clipboard_entries` (nouvelle
   commande Tauri) — résout le pane source (`sftp::pane_ref`, rendu
   `pub(crate)` pour l'occasion), aplatit récursivement chaque entrée
   sélectionnée (`collect_pushed_files`, marche un dossier en listant ses
   enfants via `transfer::list`, générique sur n'importe quel
   `RemoteFileClient` grâce au chantier précédent) en une liste plate de
   `rdp_ipc::PushedFile` — chemin relatif `\`-joint pour préserver
   l'arborescence, une entrée par dossier (jamais de contenu demandé pour
   elle) et une par fichier.
2. `core::transfer::resolve_local_path` (nouveau) — pour une entrée locale,
   son chemin réel tel quel (pas de copie) ; pour une entrée distante
   (SFTP/Docker), téléchargement immédiat vers un fichier temporaire privé
   (`secure_file::create_private`, même schéma que le relais existant
   remote-à-remote). Nécessaire, pas juste pratique : `on_file_contents_request`
   (côté sidecar) est un callback **synchrone**, sans `.await` possible —
   impossible d'aller chercher les octets à la demande depuis SFTP/Docker à
   ce moment-là, il faut déjà avoir un vrai fichier local avant même
   d'envoyer le message.
3. `rdp_ipc::ClientMessage::PushClipboardFiles { files: Vec<PushedFile> }`
   (nouveau message, testé en roundtrip) transporte cette liste jusqu'au
   sidecar via la même commande générique `send_rdp_view_input` déjà en
   place (aucune nouvelle plomberie IPC nécessaire côté Tauri pour
   l'envoi — seulement pour la collecte).
4. `rdp-sidecar/src/main.rs::push_clipboard_files` — construit un
   `Vec<FileDescriptor>` (`ironrdp_cliprdr::pdu`) dans le même ordre que
   `files`, enregistre les chemins locaux dans une `FileTable` partagée
   (`clipboard.rs`) à ces mêmes index, puis appelle
   `CliprdrClient::initiate_file_copy`. Erreurs traitées comme non-fatales
   (log + `continue`, contrairement à la branche `clip_msg` existante qui
   tue la session) — un push de fichier échoue pour des raisons
   parfaitement normales (serveur sans support fichier), pas une invariante
   protocolaire cassée.
5. `rdp-sidecar/src/clipboard.rs::FilePushBackend` — **la pièce
   architecturale centrale de ce chantier**. Un décorateur qui enveloppe le
   backend presse-papiers texte existant (`WinClipboard`/`StubClipboard`) :
   délègue toutes les méthodes texte telles quelles, n'implémente
   lui-même que `client_capabilities()` (OR avec `STREAM_FILECLIP_ENABLED`)
   et `on_file_contents_request` (répond en lisant l'octet range demandé
   directement dans le fichier local via la `FileTable`, I/O bloquant
   assumé — ce callback n'a de toute façon aucun moyen d'être asynchrone).
   Décision explicite de ne **pas** étendre `WinClipboard` lui-même :
   `ironrdp-cliprdr-native` 0.6.0 n'a aucun support fichier câblé sur aucune
   plateforme (`client_capabilities()` vide partout, vérifié en lisant les
   sources, pas supposé) — y ajouter le vrai rendu différé COM Windows
   (`CFSTR_FILEDESCRIPTORW`/`CFSTR_FILECONTENTS`) aurait été un chantier
   bien plus gros, Windows-only, et inutile pour ce cas d'usage précis (les
   octets viennent toujours d'un chemin que l'app connaît déjà, jamais
   d'une vraie lecture du presse-papiers OS). Ce découplage rend
   `FilePushBackend` cross-platform par construction — aucun `#[cfg(windows)]`
   dessus, contrairement à `WinClipboard`.

**Piège vérifié en lisant les sources vendues d'`ironrdp-cliprdr` 0.6.0,
pas supposé** : le moteur de protocole (`ironrdp-cliprdr`, distinct
d'`ironrdp-cliprdr-native`) supporte déjà intégralement le format liste de
fichiers — `FileContentsRequest`/`FileContentsResponse` (MS-RDPECLIP
2.2.5.3/2.2.5.4), `FileDescriptor`/`PackedFileList`,
`Cliprdr::initiate_file_copy`/`submit_file_contents`, validation/troncature
de noms de fichiers, verrouillage concurrent — bien plus complet que ce que
suggérait la note précédente sur « aucune capacité fichier annoncée »
(cette note-là décrivait le manque côté `-native`, pas côté moteur de
protocole ; les deux sont des crates différentes). `main.rs` matchait déjà
`ClipboardMessage::SendFileContentsResponse` (en l'ignorant) — juste besoin
de brancher l'appel réel (`cliprdr.submit_file_contents(response)`) plutôt
que d'ajouter quoi que ce soit de neuf à ce niveau.

**Vérifié** : `cargo clippy --all-targets -- -D warnings` propre sur les
deux workspaces (racine + `rdp-sidecar`, séparé), `cargo test` vert sur les
quatre crates concernées (74 tests dont 7 d'intégration réelles avec un
vrai `sshd`, aucune régression), `npx tsc --noEmit` propre,
`node scripts/e2e-run.mjs` (smoke WSL/WebKitGTK) au vert. **Non vérifié,
comme toujours pour cette partie du projet** : une vraie session de
glisser-déposer contre un serveur RDP réel — CLIPRDR file-list est un
protocole avec beaucoup de recoins (négociation de capacités des deux
côtés, format des noms de fichiers sur le fil, verrouillage) qu'aucune
lecture de code ni test unitaire ne peut garantir correct en pratique.
Point le plus incertain à surveiller en premier lors d'un test réel : est-ce
que le serveur/l'application distante (ex. Explorer Windows) négocie
effectivement `STREAM_FILECLIP_ENABLED` et affiche le fichier au collage,
ou reste silencieux malgré un `initiate_file_copy` qui n'a lui-même pas
échoué côté sidecar.

**Bugs réels trouvés au premier test utilisateur (2026-07-12), tous deux
côté frontend, pas dans le protocole CLIPRDR lui-même** : « le glisser-déposer
n'a pas l'air de marcher », et « le bouton flèche a l'air de copier mais le
collage côté RDP donne *unspecified error* ».
- **Bouton flèche/« Copier » du panneau local, en mode RDP** : câblé sur la
  fonction générique `copy()` (`TransferTab.tsx`), qui a besoin d'un
  `paneId` distant ouvert pour sa destination. Or en mode RDP le panneau
  droit n'est jamais ouvert comme pane — c'est `<RdpTab>` en direct, pas un
  `PaneView` (`openPaneFor("right", ...)` n'est appelé `if (!isRdpTarget)`).
  `copy()` fait donc `if (!sourceId || !destId || ...) return;` et ressort
  silencieusement, sans la moindre erreur — d'où l'impression que « ça
  copie bien » alors que rien n'a jamais été poussé sur le presse-papiers
  distant, expliquant à elle seule le « unspecified error » au collage (le
  clipboard RDP ne contenait jamais le fichier). Fix : nouveau
  `copyOrPushToRdp` dans `TransferTab.tsx`, qui redirige vers `pushToRdp`
  quand `isRdpTarget && side === "left"`, branché comme `onCopy` du panneau
  gauche à la place de `copy` directement. Libellés/tooltips des boutons
  « Copier »/flèche également adaptés (« Envoyer sur le presse-papiers
  RDP ») via un nouveau prop `isRdpPush` sur `PaneView`, pour ne plus laisser
  croire à une copie de fichier classique.
- **Aucune confirmation visuelle de succès sur `pushToRdp`** — vrai même
  pour le glisser-déposer, qui lui était pourtant déjà correctement câblé
  (`handleDropEntries` appelait bien `pushToRdp` pour une dépose sur le
  panneau droit en mode RDP) : un push réussi n'avait tout simplement aucun
  effet visible (rien n'apparaît dans un panneau, contrairement à une copie
  SFTP normale), ce qui se lit comme « ça n'a pas marché » même quand ça
  fonctionnait. Fix : nouveau prop `onPushed` sur `TransferTab`, appelé par
  `pushToRdp` après un `pushRdpViewClipboardEntries` réussi, branché dans
  `App.tsx` sur `pushNotification("success", ...)` (système de notifications
  existant, cloche en haut — jusque-là jamais utilisé avec le type
  `"success"` dans ce projet, uniquement `"error"`).
**Retest utilisateur (2026-07-12, même jour)** : la flèche/bouton fonctionne
désormais, mais deux points restaient à corriger.

- **Confusion initiale levée par une question de clarification de
  l'utilisateur** : il existe en fait *deux* mécanismes de glisser-déposer
  distincts dans `TransferTab.tsx`, faciles à confondre — (1) OS-level natif
  (`webview.onDragDropEvent`, glisser depuis l'Explorateur Windows droit sur
  la vue RDP) et (2) manuel-souris interne (`startManualDrag`/
  `handleDropEntries`, glisser une entrée du panneau de fichiers *de
  gauche*, dans l'app, vers la vue RDP). Le (1) marchait déjà après le fix
  précédent (branché via `pushRdpViewClipboardEntries`/`copyOrPushToRdp`) ;
  le (2), lui, ne marchait toujours pas.
- **Bug réel n°3 — glisser-déposer interne (méthode 2) jamais amorcé** :
  chaque ligne de fichier a un `onMouseDown` (au niveau de la `<div>` de la
  ligne) qui arme un drag potentiel via `startManualDrag` — mais le bouton
  Nom (icône + nom de fichier, `flex-1`, donc la zone la plus large et la
  plus naturelle à saisir pour glisser) avait son propre
  `onMouseDown={(e) => e.stopPropagation()}`, copié par analogie avec la
  checkbox voisine (qui, elle, en a réellement besoin pour éviter d'armer un
  drag accidentel sur un simple clic de case à cocher). Résultat : cliquer
  sur l'icône/le nom — le geste le plus naturel pour "attraper" un fichier —
  n'atteignait jamais le `onMouseDown` de la ligne, donc n'armait jamais de
  drag ; seules les colonnes Modifié/Type/Taille ou le padding restaient
  "attrapables", une zone étroite et peu intuitive. Explique à la fois « le
  glisser-déposer ne marche pas » et « aucun indicateur ne montre que
  j'arrive à glisser » (le drag n'ayant jamais démarré, aucune surbrillance
  de zone de dépôt ne pouvait apparaître). Fix : suppression du
  `stopPropagation` sur le bouton Nom — `onClick` (navigation dans un
  dossier) reste inchangé, `startManualDrag` armé sur un clic ne fait rien
  tant que la souris ne bouge pas de plus de 4px (voir son propre code), donc
  un simple clic-navigation n'est pas affecté.
- **Amélioration demandée : collage automatique.** L'utilisateur a
  explicitement demandé qu'un fichier glissé depuis l'Explorateur Windows
  soit directement collé dans la session distante, sans Ctrl+V manuel.
  Décision : appliqué uniformément aux **trois** méthodes (Explorateur,
  glisser interne, bouton flèche) plutôt qu'à une seule — elles convergent
  toutes vers le même message `ClientMessage::PushClipboardFiles`, donc le
  faire une fois côté `rdp-sidecar` (nouvelle fonction `paste_key_sequence`
  + branchement dans le bras `PushClipboardFiles` de la boucle
  `active_session`, `main.rs`) couvre les trois sans dupliquer de logique
  frontend. Simule un Ctrl+V (`ControlLeft`+`KeyV`, table `input.rs`) juste
  après l'annonce de la liste de formats, **sans attendre**
  `FormatListResponse` du serveur — jugé sûr car les deux PDUs (liste de
  formats, puis frappes clavier) partent sur le **même flux TCP ordonné**,
  écrits l'un après l'autre dans la même boucle (`active_session`'s
  `for out in outputs { writer.write_all(...) }`), et un serveur RDP traite
  les PDUs dans leur ordre de réception — pas de canal séparé ni
  d'attente du `on_format_list_response` nécessaire. Non testé contre un
  vrai serveur au moment d'écrire ceci (ni ce raisonnement d'ordonnancement,
  ni le résultat du collage lui-même) — à confirmer par l'utilisateur.
  Messages/tooltips frontend (`TransferTab.tsx`, `HostsPanel.tsx`, `api.ts`)
  mis à jour en conséquence (« envoyé et collé » plutôt que « Ctrl+V pour
  coller »).

## Roadmap / prochaines features (décidées avec l'utilisateur)

Features majeures retenues, dans l'ordre de priorité restant :

1. **Coffre chiffré (mot de passe maître)** — ✅ **fait** (secrets, passphrases
   et clés privées chiffrés au repos ; voir la section « Stockage des secrets »).
2. **Tunnel SOCKS dynamique (`-D`)** — ✅ **fait**. `PortForwardKind::Dynamic`
   dans `core/src/model.rs` ; serveur SOCKS5 local minimal (handshake sans
   auth, `CONNECT` uniquement, IPv4/domaine/IPv6 — les noms de domaine sont
   passés tels quels à `channel_open_direct_tcpip`, résolus côté serveur SSH)
   dans `core/src/port_forward.rs` (`start_dynamic` / `handle_socks_connection`).
   `commands/forward.rs` inchangé (générique sur `PortForwardKind`). UI dans
   `TunnelsPanel.tsx` : option « SOCKS dynamique (-D) », champs « destination »
   masqués pour ce type. Couvert par un test d'intégration réel (vrai `sshd`)
   dans `core/tests/sftp_and_forward_integration.rs`
   (`dynamic_port_forward_reaches_a_local_service`).
3. **Génération + déploiement de clés SSH** — ✅ **fait**. `core/src/keygen.rs` :
   `generate()` (ed25519 par défaut, RSA 4096 en option, passphrase optionnelle)
   via `russh::keys`/`ssh_key::PrivateKey::random` — la source d'aléa OS passe
   par `getrandom::SysRng` (nouvelle dépendance directe de `core/`), pas par
   `ssh_key::rand_core::OsRng` : ce type a disparu de la version de `rand_core`
   (0.10) que `ssh-key` résout réellement dans ce projet, malgré ce que
   suggèrent encore les doctests de la crate (RC, features `getrandom` non
   activée par `russh`). `public_key_line()` redérive la clé publique depuis le
   PEM stocké (vault → workspace.json → fichier d'origine, même ordre que
   `ssh::authenticate`) — pas de champ public persisté séparément.
   `deploy_public_key()` = équivalent `ssh-copy-id` (crée `~/.ssh` en 700,
   ajoute la clé publique à `authorized_keys` en 600 via SFTP, dédoublonnage
   par matériel de clé — pas par commentaire). Logique de fusion pure
   (`merge_authorized_keys`) extraite et testée unitairement plutôt qu'en
   intégration réelle : contrairement aux autres tests SFTP qui opèrent dans
   un sous-dossier jetable `gui-termius-test-{uuid}`, cette fonction cible le
   `~/.ssh/authorized_keys` réel et sensible du compte qui fait tourner les
   tests (le harnais `TestSshd` n'isole pas `$HOME`) — même logique que pour
   le coffre chiffré, voir plus haut. Commandes Tauri dans
   `commands/keys.rs` (nouveau fichier, pas `hosts.rs`) : `generate_private_key`,
   `get_public_key`, `deploy_public_key`. UI dans `KeychainPanel.tsx` : bascule
   Importer/Générer dans le formulaire existant, actions par clé « Copier la
   clé publique » (presse-papiers direct, pas de zone de texte) et « Déployer
   sur un hôte » (sélecteur d'hôte inline).
4. **Accès multi-protocole (Docker exec / K8s exec / RDP)** — 🚧 **en cours**.
   `HostKind` (`core/src/model.rs`, enum `Ssh` défaut / `DockerExec` / `K8sExec`
   / `Rdp`) généralise `Host` sans réécrire son schéma : chaque kind repurpose
   un sous-ensemble des champs existants au lieu d'en faire pousser de
   nouveaux (voir le doc-comment de `HostKind` pour le détail exact par
   kind — ex. `address` devient le socket/hôte Docker, ou un contexte
   kubeconfig). **Docker exec est réel** : `core/src/docker.rs` (crate
   `bollard`) expose `list_containers` et `open_exec`, ce dernier bridgé sur
   le même type `ssh::ShellSession` que les shells SSH pour être rejoué tel
   quel par `write_terminal`/`resize_terminal`/`close_terminal`
   (`state::TerminalBackend` généralise `TerminalSession` pour porter soit
   une `Connection` SSH soit rien de plus pour Docker). `TerminalTab.tsx`
   accepte un `dockerContainerId` optionnel qui bascule l'appel de
   connexion, sans dupliquer le composant. Deux façons de joindre le
   démon : en direct (`docker::connect`, socket unix/named pipe Windows/
   tcp-http) ou, si `Host::docker_via_host_id` est renseigné, tunnelé via
   une connexion SSH déjà configurée dans l'app (`docker::connect_via_ssh`)
   — voir la section dédiée juste en dessous pour le détail et les pièges
   rencontrés en la construisant. **RDP n'a plus qu'un seul mode : l'aperçu
   intégré.** Un mode « lanceur » historique a existé un temps en parallèle
   (`core/src/rdp.rs`, commande `connect_rdp`, shell-out vers
   `mstsc.exe`/`xfreerdp` — voir git history pour le détail, entièrement
   supprimé le 2026-07-12 à la demande de l'utilisateur une fois l'aperçu
   intégré jugé suffisant). L'aperçu intégré (`RdpTab.tsx`, action
   principale au clic sur un hôte RDP) rend le flux RDP directement dans
   l'appli, avec **forward souris/clavier, presse-papiers bidirectionnel
   (Windows) et redimensionnement dynamique** (toujours pas d'audio/
   lecteurs partagés/rendu de curseur), via un processus séparé
   (`rdp-sidecar`, IronRDP) communiquant par un protocole maison sur
   stdin/stdout (`rdp-ipc`) — voir la section « RDP intégré (rendu réel) :
   architecture sidecar » plus haut pour le pourquoi (conflit de version
   `ecdsa` insoluble entre `russh` et `ironrdp-connector`) et le comment.
   **K8s exec reste une maquette UI sans backend** (sélecteur de type,
   formulaire contexte+namespace, picker avec bandeau « aperçu »). Pas de
   daemon Docker joignable dans ce WSL pour tester l'exec réellement
   (intégration WSL non activée dans Docker Desktop) : couvert par tests
   unitaires (classification d'hôte Docker) + relecture attentive de l'API
   `bollard` vendue. Le mode « aperçu intégré » **a été validé
   contre un vrai serveur RDP par l'utilisateur le 2026-07-10**, en
   plusieurs passes : connexion + affichage réels (un premier essai avait
   crashé immédiatement sur `CryptoProvider` rustls non installé, voir plus
   haut, corrigé puis reconfirmé), puis forward souris/clavier confirmé
   fonctionnel, puis presse-papiers confirmé fonctionnel dans les deux sens
   (nativement sous Windows, Vite resté côté WSL via le port-forwarding
   WSL2). Le redimensionnement dynamique, ajouté juste après, a été retesté
   contre ce même serveur le 2026-07-11 : un second bug y a été trouvé
   (écran noir permanent après un resize, historique de décompression MPPC
   désynchronisé par la reconstruction du fast-path processor à chaque
   réactivation) et corrigé en ne reconstruisant plus ce processor du tout —
   voir la section dédiée plus haut pour le détail complet des deux bugs et
   du fix final ; limites restantes détaillées dans la même section.

5. **Opérations de flotte + moteur de snippets adaptatifs** — ✅ **fait**.
   Exécution d'une commande sur plusieurs hôtes à la fois (`core/src/fleet.rs`,
   onglet `FleetTab.tsx`, ouvrable via un bouton dédié dans la barre
   d'onglets), avec état système collecté et persisté par hôte (`HostFacts`
   sur `Host`) et filtres de sélection (RAM/CPU/charge/uptime/OS). Par-dessus :
   un petit langage textuel (conditions `target os:`/`target ram: > N`,
   option `sudo`, huit opérations d'infra courantes) qu'on peut écrire à la
   main ou faire rédiger/étendre par une IA à partir d'une instruction en
   français — l'IA n'écrit jamais de shell directement, seulement du texte
   dans cette grammaire, validé par le même parseur que la saisie manuelle
   avant d'être montré à l'utilisateur ; le rendu shell final par plateforme
   reste une table déterministe écrite à la main. Voir la section « Moteur
   de snippets adaptatifs » ci-dessous pour l'architecture complète et les
   deux itérations abandonnées le même jour.

**Avant de proposer une feature « évidente » de client SSH, vérifier
`src/components/` : elle existe probablement déjà.** L'app est déjà très complète
— palette de commandes (`CommandPalette`), broadcast/cluster (`BroadcastBar`),
split panes (`SplitPane`), recherche terminal (`TerminalSearchBar`), reconnexion
auto (pref `autoReconnect`), 8 thèmes de terminal, restauration d'onglets. Les
vraies lacunes restantes sont côté protocole/ops : auth keyboard-interactive
(MFA/OTP, absente de `AuthMethod`) et K8s exec (maquette UI sans backend) —
l'aperçu RDP intégré (voir le point 4 ci-dessus) a désormais l'affichage, le
forward souris/clavier, le presse-papiers (texte automatique + fichiers/
dossiers poussés à la demande depuis `TransferTab.tsx`) et le
redimensionnement dynamique — il ne lui manque plus que le rendu du curseur.

## Nettoyage : retrait du lanceur RDP système et du glisser-déposer interne (2026-07-12)

Après avoir testé le transfert de fichiers RDP en conditions réelles (voir
la section « Glisser-déposer vers le presse-papiers RDP » plus haut),
l'utilisateur a jugé l'ensemble trop fragile/complexe pour sa valeur et a
demandé de retirer deux morceaux plutôt que de continuer à les corriger :

- **Le lanceur RDP système** (`connect_rdp`, bouton « Client système » du
  menu « … » d'un hôte RDP — shell-out vers `mstsc.exe`/`xfreerdp`) —
  redondant une fois l'aperçu intégré validé comme fonctionnel. Supprimé
  entièrement : `core/src/rdp.rs` et `src-tauri/src/commands/rdp.rs`
  (fichiers supprimés), déclarations `pub mod rdp;` retirées de
  `core/src/lib.rs`/`src-tauri/src/commands/mod.rs`, entrée
  `commands::rdp::connect_rdp` retirée de l'`invoke_handler` (`main.rs`),
  binding `connectRdp` retiré de `api.ts`, bouton et import `IconMonitor`
  retirés de `HostsPanel.tsx` (l'icône elle-même reste utilisée ailleurs —
  `hostKinds.ts`/`TabBar.tsx` — pour représenter le type d'hôte RDP en
  général, pas seulement ce bouton). L'aperçu intégré est désormais l'unique
  mode de connexion RDP de l'app.
- **Le glisser-déposer *interne* entre panneaux** (`TransferTab.tsx` :
  glisser une entrée du panneau de gauche vers le panneau de droite, ou vers
  la vue RDP) — mécanisme souris manuel (`startManualDrag`/
  `handleDropEntries`/`manualDragRef`, contournant l'absence de HTML5
  drag-and-drop natif sous WebView2, voir « Pièges déjà rencontrés » plus
  bas) source d'un bug réel non trivial à diagnostiquer (bouton du nom de
  fichier interceptant le `mousedown` avant qu'il puisse armer le drag, voir
  plus haut) et jugé fragile dans l'ensemble. Supprimé entièrement :
  `dragPayload`, `handleDropEntries`, `manualDragRef`/`manualDragSide`/
  `manualDragOverSide`, `startManualDrag`, le `useEffect` de tracking
  souris global, les props `onEntryMouseDown`/`isDropTarget` de
  `PaneViewProps`, et le highlight de zone de dépôt associé. **Le
  glisser-déposer natif OS (Explorateur Windows → panneau ou vue RDP,
  `webview.onDragDropEvent`) reste intact** — explicitement demandé par
  l'utilisateur comme le seul mécanisme de dépôt à conserver, en plus du
  bouton flèche/« Copier » (qui reste aussi, y compris son
  `copyOrPushToRdp` pour la cible RDP — seul le *glisser* est retiré, pas le
  clic explicite). Après cette suppression, les deux façons de transférer
  un fichier vers une session RDP sont : glisser depuis l'Explorateur, ou
  sélectionner puis cliquer sur la flèche/bouton « Envoyer » dans le
  panneau de gauche.

**Vérifié** : `npx tsc --noEmit` propre, `cargo clippy --workspace
--all-targets -- -D warnings` propre sur les deux workspaces (racine +
`rdp-sidecar`, ce dernier non affecté mais revérifié par précaution),
`cargo test -p termius-core -p gui-termius` vert (58 + 4 + 3 tests, aucune
régression — le fichier de tests du lanceur a disparu avec `core/src/rdp.rs`
lui-même, pas de référence orpheline). `node scripts/e2e-run.mjs` non
relancé pour ce changement précis (retrait de code, pas de nouvelle
fonctionnalité UI à valider visuellement) — à faire si un doute survient sur
le rendu du panneau de fichiers après ce nettoyage.

## Nettoyage général + optimisations (2026-07-12)

Passe de nettoyage demandée par l'utilisateur (« voir s'il y a du code mort à
supprimer, des optimisations à faire »). `cargo clippy --workspace
--all-targets -- -D warnings`, `npx tsc --noEmit` et `npm audit` étaient déjà
propres avant d'y toucher. Trouvé et corrigé dans la foulée (tous vérifiés :
clippy + tsc + `cargo test -p termius-core -p gui-termius` + `npx vitest run`
+ `node scripts/e2e-run.mjs`, tous verts) :
- `vite.config.d.ts` (généré par `tsc -b`, projet composite) committé par
  erreur dès le premier commit — retiré du suivi, ajouté au `.gitignore`.
- `thiserror`/`rand` dans `core/Cargo.toml` déclarés mais jamais utilisés
  (le code utilise `anyhow` pour les erreurs, `getrandom`/
  `chacha20poly1305::aead::rand_core` pour l'aléatoire) — trouvés via
  `cargo-machete`, confirmés par grep avant suppression. `time = "=0.3.47"`
  dans `src-tauri/Cargo.toml`, lui aussi flaggé par `cargo-machete`, est un
  pin de version transitif volontaire (commentaire juste au-dessus) — pas
  touché.
- Commentaire de doc obsolète dans `rdp_view.rs` référençant `core::rdp`/
  `connect_rdp`, supprimés lors du nettoyage RDP du même jour (section
  précédente) — corrigé.
- `ActiveForward::config()` (`core/src/port_forward.rs`) : méthode publique
  jamais appelée nulle part, invisible à clippy (une lib ne warn pas sur du
  `pub` inutilisé) — trouvée par un agent Explore qui a cross-référencé les
  symboles `pub` de `core/` contre leurs call sites dans `core/` et
  `src-tauri/`. Supprimée.
- **Suppression multiple dans l'explorateur de fichiers, O(n²) → O(n)** :
  `pane_remove` (`commands/sftp.rs`) relistait tout le répertoire après
  *chaque* suppression individuelle, et `TransferTab.tsx`'s `remove()`
  l'appelait une fois par fichier sélectionné en boucle, jetant tous les
  résultats intermédiaires sauf le dernier. Sur un backend Docker exec,
  chaque listing relance un `exec` dans le conteneur — supprimer 100
  fichiers déclenchait ~100 listings inutiles. Fix : `pane_remove` prend
  maintenant `entries: Vec<Entry>`, supprime tout puis liste une seule fois
  à la fin ; `api.ts`/`TransferTab.tsx` mis à jour en conséquence (un seul
  appel au lieu d'une boucle).
- **Trois blocages du runtime tokio** (I/O synchrone dans du code async,
  sans `spawn_blocking`) : `known_hosts::check_and_trust` (I/O disque
  pendant le handshake SSH — fix : clone `identity`/`label`/`PublicKey`
  puis `spawn_blocking`), `transfer::list` côté `PaneRef::Local`
  (`local_fs::list` fait des appels `std::fs` synchrones — navigation
  locale et copie récursive), `write_local_terminal` (écriture PTY
  bloquante à chaque frappe dans un terminal local — la fonction est passée
  de `state: State<AppState>` à `app: AppHandle` pour pouvoir récupérer
  l'état via `app.state::<AppState>()` depuis l'intérieur du
  `spawn_blocking`, seule façon d'obtenir un handle `'static` puisque
  `AppState` n'est pas `Clone`).

**Trois optimisations plus lourdes identifiées mais volontairement pas
faites cette session** (effort/risque plus élevé, ou décision qui appartient
à l'utilisateur) — à reprendre plus tard :

1. **Sous-ensembles de polices.** `src/main.tsx` importe
   `@fontsource/{fira-code,jetbrains-mono,source-code-pro,ubuntu-mono}/{400,700}.css`
   en entier, ce qui embarque tous les charsets Unicode (latin, latin-ext,
   cyrillic, cyrillic-ext, greek, greek-ext) — ~1.2 Mo au total dans
   `dist/assets/*.woff*` après build. Remplacer par les imports par
   sous-ensemble (`.../latin-400.css`) réduirait probablement ça de
   40-50 %. Risque quasi nul (un caractère hors charset retenu retombe sur
   une police système, pas de crash) mais nécessite de savoir si
   l'utilisateur a besoin du cyrillique/grec dans un terminal (sortie ou
   noms de fichiers distants dans ces charsets) — décision utilisateur, pas
   une déduction depuis le code.
2. **Découpage du bundle JS.** Un seul chunk de 809 Ko (non compressé) après
   `vite build`, sans code-splitting — Vite avertit au-delà de 500 Ko.
   `React.lazy` sur des panneaux peu utilisés (RDP, K8s) est possible.
   Gain incertain : app desktop servie en local (pas de coût réseau), le
   coût réel est le parse/compile JS au démarrage — pas mesuré, donc pas
   priorisé sans preuve d'un démarrage perçu comme lent.
3. **Canal binaire pour `terminal-data`** (au lieu de JSON+base64 par
   chunk). `spawn_output_bridge`/`open_local_terminal`
   (`commands/terminal.rs`) émettent chaque chunk de sortie SSH/Docker/PTY
   local en base64 dans un event Tauri JSON classique — exactement le
   pattern déjà abandonné pour les frames RDP au profit d'un
   `tauri::ipc::Channel` binaire zéro-copie (voir la section RDP plus haut,
   « Optimisation supplémentaire : `tauri::ipc::Channel` pour `Image` »),
   pour la même raison de coût fixe par message. C'est probablement
   l'évènement le plus fréquent de toute l'app (chaque octet de sortie
   terminal, potentiellement plusieurs fois par seconde sous sortie
   verbeuse), donc le gain le plus tangible des trois — mais aussi le
   chantier le plus invasif : touche le chemin le plus exercé de l'app
   (SSH, Docker exec, terminal local, potentiellement le mode diffusion
   multi-terminaux), donc plus de surface à casser et plus de test réel
   nécessaire avant de le considérer fiable.

## Relicenciement MIT + renommage en Guiterm (2026-07-16)

Décision utilisateur : viser une stratégie open-core pour la visibilité du
projet (voir la mémoire long-terme de Claude, fichier
`gui-termius-open-core-strategy.md`, pour l'historique complet de la
discussion). Deux chantiers effectués le même jour :

**Relicenciement PolyForm Noncommercial → MIT.** Choix fait par Claude sans
repasser par l'utilisateur (jugé à faible risque : rien n'était encore
distribué publiquement sous l'ancienne licence). Fichiers modifiés :
`LICENSE` (texte MIT standard), `package.json`, `Cargo.toml` racine
(`workspace.package.license`), `rdp-ipc/Cargo.toml`, `rdp-sidecar/Cargo.toml`
(workspace séparé, licence dupliquée à la main — ne suit pas
`workspace.package`).

**Renommage `gui-termius` → `Guiterm`.** Motivé par un vrai risque de marque :
l'ancien nom référençait directement Termius, un produit commercial existant.
L'utilisateur voulait garder le "G"/"gui" ; "Guiterm" retenu après un tour de
propositions (Gantry, Garrison, Gulliver, Ganglion, Guiterm... — voir la
mémoire long-terme pour la liste complète).

**Ce qui a été renommé** (tout ce qui est visible de l'extérieur ou tourné
vers la marque) : `package.json`/`Cargo.toml` (nom du package + binaire
`src-tauri`, désormais `guiterm`), `tauri.conf.json` (`productName`, titre de
fenêtre — **pas** `identifier`, voir plus bas), `index.html`, le texte affiché
dans `TitleBar.tsx`, le nom de release CI (`release.yml`), le nom de fichier
par défaut à l'export (`SettingsPanel.tsx`), le `client_name` envoyé au
serveur RDP (`rdp-sidecar/src/main.rs`), plusieurs chaînes cosmétiques
(messages de panique, préfixes de fichiers temporaires, commentaires), et
toute la prose de `README.md`/`CONTRIBUTING.md`/`docs/blog/*.md`.

**Ce qui n'a délibérément PAS été renommé, et ne doit pas l'être sans y
réfléchir à deux fois** :
- **`core/src/vault.rs`** : `const SERVICE: &str = "gui-termius";` — nom de
  service utilisé pour *chaque* secret stocké dans le trousseau OS
  (Credential Manager Windows). Le renommer orphelinerait silencieusement
  tous les mots de passe/passphrases déjà enregistrés par l'utilisateur sur
  sa machine réelle.
- **`core/src/{known_hosts,store,command_history,fleet_history}.rs`** :
  `ProjectDirs::from("dev", "gui-termius", "gui-termius")` (5 occurrences) —
  détermine le dossier de config réel
  (`%APPDATA%\gui-termius\gui-termius\config\` sous Windows). Le renommer
  ferait démarrer l'app sur un dossier vide au prochain lancement : hôtes,
  `known_hosts`, historique de commandes et de flotte tous "perdus" (en
  réalité toujours sur disque sous l'ancien chemin, juste plus lus).
- **`src/lib/preferences.ts`** (`STORAGE_KEY = "gui-termius-prefs"`) et
  **`src/lib/tabPersistence.ts`** (`STORAGE_KEY = "gui-termius-tabs"`) — clés
  `localStorage` de la webview. Même piège que documenté plus haut dans ce
  fichier (« Préférences = `localStorage` de la webview, pas un fichier ») :
  les renommer réinitialiserait silencieusement thème/raccourcis/onglets
  restaurés de l'utilisateur au prochain lancement.
- **Le crate Rust `termius-core`** (`core/Cargo.toml`, tous les
  `use termius_core::...`) — laissé tel quel : risque de marque quasi nul
  (invisible en dehors du code source), et le renommer aurait touché ~20
  fichiers Rust pour un bénéfice cosmétique interne. Reste un nettoyage
  possible plus tard si quelqu'un s'y attelle, pas une priorité.
- **`tauri.conf.json`'s `identifier`** (`"dev.guitermius.app"`) — c'est
  l'identifiant de bundle utilisé par l'installeur pour détecter une mise à
  jour d'une installation existante (code de mise à niveau MSI, etc.) ;
  déjà sans trait d'union (curieusement déjà "guitermius" et pas
  "gui-termius") et laissé identique pour ne pas casser la continuité de
  mise à jour d'une install déjà en place.
- **Le fichier `gui-termius Prototype Connexions (standalone).html`** à la
  racine — maquette statique de design, pas branchée sur le build réel, non
  renommée.

**Fait le 2026-07-16, plus tard le même jour** : l'utilisateur a renommé le
dépôt GitHub lui-même en `GulliGulli28/Guiterm` (casse exacte : majuscule sur
le G, reste en minuscules — GitHub est insensible à la casse pour la
résolution des URLs, mais toutes les références dans le code/la doc ont été
alignées sur cette casse précise plutôt que de compter dessus) et mis à jour
le remote local (`git remote set-url origin
git@github.com:GulliGulli28/Guiterm.git`). Toutes les URLs qui pointaient
vers `GulliGulli28/guiterm` (minuscule, anticipé avant le renommage réel) —
badges/liens de `README.md`, endpoint de l'updater dans `tauri.conf.json`,
liens du post technique — ont été corrigées vers `GulliGulli28/Guiterm`.
`Cargo.lock`/`package-lock.json` régénérés (`cargo build --workspace`,
`npm install`) et re-vérifiés (`cargo clippy --workspace --all-targets --
-D warnings` sur les deux workspaces, `npx tsc --noEmit`, `cargo test
--workspace`, `npx vitest run`, `node scripts/e2e-run.mjs` — tous verts,
capture d'écran réelle confirmant "Guiterm" dans la barre de titre et les
hôtes existants de l'utilisateur toujours chargés).

## Opérations de flotte : bouton dédié, facts persistées, filtres étendus, snippets (2026-07-16)

Le fleet executor existait déjà (`core/src/fleet.rs`, `FleetTab.tsx`, ouvert
jusque-là uniquement via la palette de commandes) — cette session l'a rendu
plus accessible et plus riche, sans toucher au mécanisme de fan-out
lui-même.

- **Bouton dédié dans la barre d'onglets** : nouvelle icône (`IconServerStack`,
  `ui-icons.tsx`) à côté du bouton diffusion dans `TabBar.tsx`, plutôt que de
  fusionner les deux concepts malgré leur icône partagée d'origine (diffusion
  = terminaux déjà ouverts ; flotte = hôtes, indépendamment de tout onglet
  ouvert). `App.tsx::openFleet` ne crée plus un nouvel onglet à chaque clic :
  il refocalise l'onglet Flotte existant s'il y en a déjà un.
- **État collecté (`facts`) persisté sur l'hôte**, plutôt que gardé en mémoire
  React le temps de l'onglet : `Host` gagne `last_facts: Option<HostFacts>` +
  `last_facts_at_ms: Option<u64>` (`core/src/model.rs`, `#[serde(default)]`
  pour rester compatible avec un `workspace.json` existant). `HostFacts`
  elle-même a été déplacée de `core/src/facts.rs` vers `model.rs` (c'est
  maintenant une partie du modèle de données persisté, pas seulement le
  type de retour d'une collecte ponctuelle). `commands::facts::collect_facts`
  met à jour et sauvegarde le workspace après chaque collecte plutôt que de
  se contenter de renvoyer les résultats ; une collecte en échec sur un hôte
  laisse le dernier état connu inchangé plutôt que de l'effacer. Affiché en
  petit sous chaque hôte SSH dans `HostsPanel.tsx` et dans la liste de cibles
  de `FleetTab.tsx` (OS + RAM% + horodatage relatif via le nouveau
  `src/lib/format.ts::formatRelativeTime`, extrait de `NotificationBell.tsx`
  qui en avait déjà une copie locale). **Piège UX trouvé par l'utilisateur** :
  OS et RAM sur la même ligne devenaient illisibles panneau réduit — les deux
  informations sont maintenant sur des lignes séparées dans les deux
  affichages.
- **Filtres de sélection étendus** : le filtre RAM-seul d'origine est devenu
  cinq critères combinables en ET (RAM/CPU/charge 1 min/uptime/OS), chacun
  avec sa propre case à cocher (`FactFilters` dans `FleetTab.tsx`) — cocher
  active le critère, pas besoin de valeur sentinelle « désactivé » pour les
  champs numériques.
- **Snippets exécutables depuis la flotte** : bouton « Snippet » dans le
  composeur, ouvre le `SnippetPicker` déjà utilisé ailleurs dans l'app. Il
  remplit la zone de commande plutôt que d'exécuter immédiatement — choix
  délibéré : un run de flotte part potentiellement vers des dizaines
  d'hôtes réels, l'étape de relecture explicite avant « Exécuter » reste la
  garde-fou, contrairement au comportement usuel du picker sur un terminal
  unique.
- `core::fleet::run_on_hosts` généralisé de `(host_ids: Vec<HostId>,
  command: String)` à `(commands: HashMap<HostId, String>)` — un hôte peut
  désormais exécuter une commande différente des autres dans un même run,
  brique nécessaire pour tout ce qui suit (moteur adaptatif). Un nouvel
  helper `fleet::uniform_commands(&host_ids, &command)` reconstruit la carte
  uniforme pour l'usage classique (`run_fleet_command`, `facts::collect`),
  aucun appelant existant n'a eu besoin de changer de comportement.

**Vérifié** : `cargo clippy --workspace --all-targets -- -D warnings`
propre, `cargo test --workspace` vert, `npx tsc --noEmit`, `node
scripts/e2e-run.mjs`, et un vrai build Windows relancé pour test utilisateur
après chaque changement de cette section.

## Moteur de snippets adaptatifs : d'une classification IA vers un petit langage textuel (2026-07-16)

Trois itérations la même journée, chacune motivée par un retour direct de
l'utilisateur une fois la précédente testée. Décrit ici l'architecture
**finale** (la seule encore présente dans le code) puis, brièvement,
pourquoi les deux précédentes ont été abandonnées — utile pour ne pas les
redécouvrir en se demandant « pourquoi ne pas juste utiliser le tool-use
d'Anthropic ici, ce serait plus simple ? ».

### Le besoin

Exécuter une opération sur une flotte hétérogène (Ubuntu, CentOS, Alpine…)
sans écrire soi-même la commande spécifique à chaque gestionnaire de
paquets/service, et sans confier à une IA la génération du shell final
elle-même (risque d'hallucination sur la syntaxe exacte, différent par
plateforme).

### Architecture finale : un petit DSL textuel, l'IA comme rédactrice de ce texte

Un *programme* est le seul artefact que le moteur manipule — écrit à la
main, écrit/étendu par l'IA à partir d'une instruction en français, ou les
deux à la fois sur le même texte (`Snippet.command` porte ce texte quand
`adaptive: true`, exactement comme il porte déjà un `{{template}}` pour un
snippet classique — les `{{variables}}` fonctionnent donc gratuitement,
aucun traitement spécial nécessaire).

**Grammaire** (`core/src/adaptive.rs`, en tête de fichier pour la version
autoritative) : le programme est une suite de *blocs* séparés par une ligne
vide. Un bloc = zéro ou plusieurs lignes de condition/option, puis
exactement une ligne de commande :

```
target os: debian
sudo: true
install-package nginx

target ram: > 80
restart-service nginx
```

- `target <champ>: <valeur>` — `champ` ∈ {os, ram, cpu, load, uptime}. Pour
  `os`, texte libre comparé en sous-chaîne insensible à la casse contre
  `os_id`/`os_name`. Pour les champs numériques, un opérateur optionnel
  (`>`, `>=`, `<`, `<=`, `=`, défaut `=`) puis un nombre — `uptime` est en
  jours. Plusieurs `target` peuvent se combiner sur une même ligne avec
  `&&` (ET) / `||` (OU) — `&&` prioritaire sur `||`, comme dans la plupart
  des langages (voir « Opérateurs `&&`/`||` » ci-dessous). Plusieurs
  *lignes* `target` dans un bloc se combinent toujours en ET entre elles,
  quel que soit le contenu de chaque ligne ; un bloc sans aucun `target`
  s'applique à tous les hôtes.
- `sudo: true` (ou juste `sudo`) — préfixe la commande de ce bloc avec `sudo `.
- La ligne de commande nomme une des huit fonctions connues —
  `install-package`, `remove-package`, `update-packages`, `start-service`,
  `stop-service`, `restart-service`, `enable-service`, `disable-service` —
  avec un argument (nom de paquet/service) pour toutes sauf
  `update-packages`.

**Évaluation par hôte** (`compose_for_host`) : chaque bloc dont les
conditions correspondent à l'hôte contribue sa commande rendue ; toutes les
commandes retenues sont jointes par des retours à la ligne, dans l'ordre du
programme — un hôte peut donc exécuter plusieurs blocs, pas un seul.
`preview()` regroupe ensuite tous les hôtes ciblés par leur commande
composée résultante (ou leur absence de commande + la raison) — c'est ce
regroupement, pas un regroupement par plateforme, qui permet à l'écran de
relecture d'afficher **la vraie liste des hôtes concernés par chaque
commande**, demandé explicitement par l'utilisateur (avant : juste un
nombre).

**Rendu déterministe** (`render_command`, table écrite et testée à la main,
inchangée dans son principe depuis la toute première itération) : familles
de gestionnaires de paquets (apt/dnf/apk/pacman/zypper) et de services
(systemd/openrc), un hôte inconnu ou une plateforme non couverte renvoie
`None` plutôt qu'une supposition. `is_safe_token` valide chaque argument
(paquet/service) contre une liste blanche de caractères avant de
l'interpoler dans le gabarit shell — seul rempart réel contre une injection
via un nom fourni par l'IA (ou tapé à la main), donc jamais retiré au fil
des réécritures.

**Le rôle de l'IA** (`generate_program`) : rédiger — jamais exécuter — du
texte dans cette même grammaire, à partir d'une instruction en français et
(si non vide) du programme déjà existant à étendre. Système d'invite qui
décrit la grammaire complète ; la réponse est repassée dans le **même**
`parse_program` que la saisie manuelle avant d'être renvoyée au frontend —
une réponse mal formée remonte comme une erreur explicite, jamais acceptée
telle quelle. Un seul appel IA par génération, quel que soit le nombre de
plateformes distinctes parmi les hôtes ciblés (contrairement à la première
itération, voir plus bas).

**Opérateurs `&&`/`||` dans les conditions (2026-07-16, ajouté après coup à
la demande de l'utilisateur).** Jusque-là, plusieurs `target` dans un bloc
ne pouvaient se combiner qu'en ET (une ligne par condition), sans aucun
moyen d'exprimer un OU — pour cibler par exemple « debian OU ubuntu » il
aurait fallu dupliquer tout le bloc. `core/src/adaptive.rs` : `Condition`
(un atome) reste inchangé, mais `Statement.conditions` est passé de
`Vec<Condition>` à `Vec<ConditionExpr>` — un nouvel enum
`ConditionExpr::{Atom, And, Or}` (arbre binaire) qui représente le résultat
du parsing d'**une ligne** de condition. Une ligne peut désormais contenir
plusieurs atomes `target …` combinés avec `&&`/`||` (`parse_condition_expr`,
précédence conventionnelle : split d'abord sur `||` — priorité la plus
basse —, puis chaque partie sur `&&`) ; plusieurs *lignes* dans un bloc
continuent de se combiner en ET entre elles exactement comme avant, donc
tout programme déjà écrit (une condition par ligne) reste valide et se
comporte à l'identique — testé explicitement
(`one_line_and_is_equivalent_to_two_separate_lines`). `condition_expr_matches`
évalue l'arbre récursivement ; `statement_applies` en fait le ET sur les
lignes, inchangé dans son principe. Le prompt système de l'IA
(`SYSTEM_PROMPT`) documente la nouvelle syntaxe pour qu'elle puisse aussi
écrire des `||`, pas seulement les révisions manuelles. Aide-mémoire mis à
jour dans les deux endroits qui l'affichent (`FleetTab.tsx`,
`SnippetsPanel.tsx`) — un seul texte statique ajouté à la main dans chacun,
`src/lib/operations.ts` n'avait pas besoin de nouvelle structure de données
pour une seule ligne d'aide. **Vérifié** : `cargo test -p termius-core`
(33 tests dans `adaptive::tests`, dont 6 nouveaux couvrant `&&`, `||`, la
précédence, l'équivalence une-ligne/deux-lignes, et une expression avec
opérateur en trop — 27 existaient déjà avant cet ajout), `cargo clippy
--workspace --all-targets -- -D warnings` propre, `npx tsc --noEmit` propre
(aucun changement frontend au-delà de l'aide-mémoire — l'évaluation reste
entièrement côté Rust, `preview_adaptive_program` inchangé dans sa
signature).

### Ce qui a été essayé puis abandonné le même jour

- **Itération 1 : classification par tool-use Anthropic.** L'IA choisissait,
  via le tool-use natif (sortie contrainte par schéma JSON), une parmi huit
  « opérations » structurées (`Operation` — alors un champ persisté sur
  `Snippet`, avec un `platform_commands: HashMap<os_id, String>` en guise de
  cache), un appel IA **par plateforme détectée**. Séquence des étapes :
  `core::vault` généralisé pour un secret global non lié à un hôte (clé API
  Anthropic — `store_raw`/`load_raw`/`delete_raw` factorisés, les fonctions
  par-hôte existantes deviennent de simples enveloppes), section « IA » dans
  Paramètres → Sécurité (`AdaptiveEngineSettings.tsx`). Abandonnée : une
  seule opération par snippet, pas de conditions, pas de `sudo`, et coder
  des conditions/blocs multiples dans un schéma de tool-use aurait été
  nettement plus complexe pour un bénéfice de sûreté équivalent à « l'IA
  écrit du texte que mon propre parseur valide ».
- **Itération 2 : création manuelle par menu déroulant.** Une fois le
  besoin « je veux aussi pouvoir le faire sans IA » exprimé, un mode
  « Adaptatif » dans `SnippetsPanel.tsx` proposait un `<select>` des huit
  opérations + un champ argument, construisant le même `Operation`
  structuré à la main. Abandonnée le jour même quand l'utilisateur a demandé
  les conditions/`sudo`/blocs multiples : un menu déroulant ne s'y prêtait
  pas, contrairement à du texte libre. Le mode « Adaptatif » de
  `SnippetsPanel.tsx` est aujourd'hui une simple zone de texte (comme le
  mode « Script »), avec un aide-mémoire de syntaxe repliable
  (`<details>`) réutilisant `src/lib/operations.ts` — ce fichier, qui
  contenait la liste pour le `<select>` disparu, sert maintenant uniquement
  de référence statique affichée à l'utilisateur.

Conséquence architecturale de cet historique : `Operation`/`Condition`/
`Statement`/`Program` ne sont **plus** des champs persistés sur `Snippet`
(model.rs) — ils vivent uniquement dans `core/src/adaptive.rs` comme
représentation interne de parsing, jamais sérialisée. `Snippet` a perdu ses
champs `operation`/`platform_commands` : un snippet adaptatif n'a plus que
`command` (le texte du programme) et `adaptive: bool`. Plus rien n'est mis
en cache — reparser et réévaluer est gratuit et déterministe, donc rejouer
un snippet adaptatif sur une flotte jamais vue coûte toujours zéro appel IA,
y compris sur une plateforme totalement nouvelle (contrairement à
l'itération 1, où seule une plateforme *déjà rencontrée* évitait un nouvel
appel).

### Fichiers touchés (état final)

- `core/src/adaptive.rs` — grammaire, parseur (`parse_program`), évaluateur
  (`condition_matches`/`statement_applies`/`compose_for_host`/`preview`),
  table de rendu, appel IA (`generate_program`). 27 tests unitaires.
- `core/src/model.rs` — `Snippet` simplifié (`adaptive: bool` seulement en
  plus de `command`/`name`/`tags`/`id`).
- `core/src/vault.rs` — primitives génériques `store_raw`/`load_raw`/
  `delete_raw` + `store_anthropic_api_key`/`load_anthropic_api_key`/
  `delete_anthropic_api_key`.
- `core/Cargo.toml` — dépendance directe `reqwest` (rustls, sans
  native-tls) pour l'appel Anthropic ; vérifié qu'elle ne réintroduit pas de
  conflit façon `ecdsa`/RDP (voir plus haut) — resolution propre et rapide
  la première fois, aucun souci.
- `src-tauri/src/commands/adaptive.rs` — `generate_adaptive_program`,
  `preview_adaptive_program`, `run_adaptive_plan` (réutilise
  `commands::fleet::execute_and_record`, factorisé hors de
  `run_fleet_command` pour être partagé), `save_adaptive_snippet`,
  gestion de la clé API.
- Frontend : `FleetTab.tsx` (mode « Intention (IA) » = zone de texte pour le
  programme + petit champ d'instruction français + bouton Générer, bouton
  Prévisualiser séparé qui n'appelle jamais l'IA), `SnippetsPanel.tsx`
  (mode « Adaptatif »), `src/lib/operations.ts` (aide-mémoire statique),
  `src/lib/types.ts` (`ExecutionGroup` remplace les types des itérations
  précédentes).

**Vérifié à chaque itération** : `cargo clippy --workspace --all-targets --
-D warnings` (+ `rdp-sidecar` séparément) propre, `cargo test --workspace`
vert (91 tests unitaires au total après la version finale, dont 27 pour
`adaptive.rs`), `npx tsc --noEmit`, `npx vitest run`, `node
scripts/e2e-run.mjs`, et un vrai build Windows release reconstruit et
relancé après chaque itération pour que l'utilisateur teste l'UI.

**Non vérifié, à confirmer par l'utilisateur** : aucun appel réel à l'API
Anthropic n'a eu lieu dans cet environnement de dev (aucune clé configurée
ici) — seuls les chemins déterministes (parseur, évaluateur, rendu) ont été
exercés pour de vrai. Le chemin manuel (écrire `install-package nginx` à la
main dans Opérations de flotte, Prévisualiser, Exécuter) est le seul
testable sans clé API et devrait être la première chose validée en
conditions réelles, avant `generate_program` lui-même.

## Habitudes de collaboration sur ce projet

- Ne jamais committer sans demande explicite — même après plusieurs tours de
  changements validés. Cette instruction a été redonnée plusieurs fois dans les
  sessions passées ; par défaut, laisser les changements non committés et le
  dire clairement en fin de réponse.
- L'utilisateur écrit et pense en français ; les réponses, les libellés UI, les
  messages de commit et la documentation du projet suivent cette convention.
- Avant une fonctionnalité un peu ambiguë (ex. « menu contextuel » vs « action
  instantanée » pour un clic droit), une question courte à choix (2-3 options)
  vaut mieux qu'une supposition — surtout quand les deux implémentations sont
  d'ampleur comparable mais donnent une UX très différente.
- Sur les demandes larges (« qu'est-ce que tu améliorerais ? »), il vaut mieux
  proposer une liste concrète et ancrée dans le code réel (pas des idées
  génériques de client SSH) puis laisser l'utilisateur choisir ce qui vaut le
  coup d'être implémenté, plutôt que de tout construire d'un coup.
