## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).

## Le projet en bref

`gui-termius` est un client SSH/SFTP de bureau (Tauri 2 + Rust + React/TypeScript),
à usage personnel (licence PolyForm Noncommercial). Voir `README.md` pour la
présentation complète des fonctionnalités et de la structure du dépôt — ce
fichier-ci se concentre sur ce qui n'est pas évident en lisant juste le code.

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

## Roadmap / prochaines features (décidées avec l'utilisateur)

Features majeures retenues, dans l'ordre de priorité restant :

1. **Coffre chiffré (mot de passe maître)** — ✅ **fait** (secrets, passphrases
   et clés privées chiffrés au repos ; voir la section « Stockage des secrets »).
2. **Tunnel SOCKS dynamique (`-D`)** — à faire. Ajouter
   `PortForwardKind::Dynamic` (`#[serde(default)]` pour la compat), un petit
   serveur SOCKS5 local (handshake CONNECT sans auth, ~40 lignes, sans
   dépendance) qui ouvre un `channel_open_direct_tcpip` par connexion dans
   `core/src/port_forward.rs`. Réutilise `commands/forward.rs` ; UI dans
   `TunnelsPanel.tsx` (masquer les champs « destination » pour ce type).
3. **Génération + déploiement de clés SSH** — à faire. Keygen via
   `russh::keys`/`ssh-key` (ed25519 par défaut, RSA en option, passphrase
   optionnelle, stockée comme les clés importées). Commande `deploy_public_key`
   = équivalent `ssh-copy-id` (crée `~/.ssh` en 700, ajoute la clé publique à
   `authorized_keys` en 600, idempotent, via SFTP). UI dans `KeychainPanel.tsx`.

**Avant de proposer une feature « évidente » de client SSH, vérifier
`src/components/` : elle existe probablement déjà.** L'app est déjà très complète
— palette de commandes (`CommandPalette`), broadcast/cluster (`BroadcastBar`),
split panes (`SplitPane`), recherche terminal (`TerminalSearchBar`), reconnexion
auto (pref `autoReconnect`), 8 thèmes de terminal, restauration d'onglets. Les
vraies lacunes restantes sont côté protocole/ops : auth keyboard-interactive
(MFA/OTP, absente de `AuthMethod`), les deux points ci-dessus.

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
