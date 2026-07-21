# Historique de dev : décisions, bugs corrigés, spécifications fines

Ce fichier n'est **pas** chargé automatiquement dans le contexte d'une
session Claude (contrairement à `CLAUDE.md`, à la racine). Il conserve le
détail fin de comment/pourquoi certaines parties de l'app ont été
construites — utile pour ne pas redécouvrir un piège déjà rencontré ou
reposer une question déjà tranchée, mais pas nécessaire pour la plupart des
tâches du quotidien. `CLAUDE.md` reste la référence pour l'essentiel
(environnement de dev, gates CI, obligations de test, architecture, pièges
généraux, habitudes de collaboration) ; ce fichier-ci consomme tout ce qui
est spécifique à une fonctionnalité précise ou à un bug déjà corrigé.

Organisé par thème puis chronologiquement à l'intérieur de chaque thème.

## Renommage `gui-termius` → `Guiterm` (2026-07-16)

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
  `localStorage` de la webview. Même piège que documenté dans `CLAUDE.md`
  (« Préférences = `localStorage` de la webview, pas un fichier ») : les
  renommer réinitialiserait silencieusement thème/raccourcis/onglets
  restaurés de l'utilisateur au prochain lancement.
- **Le crate Rust `termius-core`** (`core/Cargo.toml`, tous les
  `use termius_core::...`) — laissé tel quel : risque de marque quasi nul
  (invisible en dehors du code source), et le renommer aurait touché ~20
  fichiers Rust pour un bénéfice cosmétique interne.
- **`tauri.conf.json`'s `identifier`** (`"dev.guitermius.app"`) — c'est
  l'identifiant de bundle utilisé par l'installeur pour détecter une mise à
  jour d'une installation existante (code de mise à niveau MSI, etc.) ;
  déjà sans trait d'union (curieusement déjà "guitermius" et pas
  "gui-termius") et laissé identique pour ne pas casser la continuité de
  mise à jour d'une install déjà en place.
- **Le fichier `gui-termius Prototype Connexions (standalone).html`**
  (maintenant `docs/design/`) — maquette statique de design, pas branchée
  sur le build réel, non renommée.

**Fait le 2026-07-16, plus tard le même jour** : l'utilisateur a renommé le
dépôt GitHub lui-même en `GulliGulli28/Guiterm` (casse exacte : majuscule sur
le G, reste en minuscules) et mis à jour le remote local (`git remote
set-url origin git@github.com:GulliGulli28/Guiterm.git`). Toutes les URLs qui
pointaient vers `GulliGulli28/guiterm` (minuscule, anticipé avant le
renommage réel) — badges/liens de `README.md`, endpoint de l'updater dans
`tauri.conf.json`, liens du post technique — ont été corrigées vers
`GulliGulli28/Guiterm`. `Cargo.lock`/`package-lock.json` régénérés et
re-vérifiés (clippy, tsc, cargo test, vitest, e2e — tous verts, capture
d'écran réelle confirmant "Guiterm" dans la barre de titre et les hôtes
existants de l'utilisateur toujours chargés).

## Tests E2E : setup one-time et pièges rencontrés

Détail de mise en place référencé par la section « Tests E2E réels » de
`CLAUDE.md` — utile seulement si ce setup doit être refait (nouvelle
machine, réinstallation).

**Setup one-time Linux/WSL** :
```bash
wsl.exe -e bash -lc "sudo apt-get update && sudo apt-get install -y webkit2gtk-driver scrot"
wsl.exe -e bash -lc "cd ~/gui-termius && cargo install tauri-driver"
wsl.exe -e bash -lc "cd ~/gui-termius/src-tauri && cargo build"
```
`sudo` n'a pas d'accès non-interactif dans ce WSL — si ce setup doit être
refait, demander à l'utilisateur de lancer la commande `apt-get` lui-même
via le préfixe `!`.

**Setup one-time Windows** — piloté depuis PowerShell, jamais `wsl.exe` pour
cette partie :
```powershell
$env:PATH += ";$env:USERPROFILE\.cargo\bin;C:\Program Files\NASM"

winget install --id NASM.NASM -e --accept-package-agreements --accept-source-agreements
& "$env:USERPROFILE\.cargo\bin\cargo.exe" install tauri-driver

# msedgedriver DOIT correspondre exactement à la version du WebView2 Runtime installé :
$wv2 = (Get-ItemProperty "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}").pv
curl.exe -sL "https://msedgedriver.microsoft.com/$wv2/edgedriver_win64.zip" -o "$env:TEMP\ed.zip"
Expand-Archive "$env:TEMP\ed.zip" "$env:USERPROFILE\edgedriver" -Force

$env:CARGO_TARGET_DIR = "$env:USERPROFILE\gui-termius-target-windows"
Set-Location "\\wsl.localhost\Ubuntu-24.04\home\glorin\gui-termius\src-tauri"
& "$env:USERPROFILE\.cargo\bin\cargo.exe" build --release --features tauri/custom-protocol
```
MSVC Build Tools et le WebView2 Runtime étaient déjà présents sur cette
machine (`vswhere.exe` pour vérifier, `winget` pour installer sinon).

**Pièges Windows rencontrés en mettant ça en place (dans l'ordre où ils
mordent)** :
- **`aws-lc-sys` a besoin de NASM** pour compiler ses routines assembleur sous
  MSVC — `cargo build` échoue avec `NASM command not found` sinon.
- **Lock file de compilation incrémentale impossible à créer sur un chemin
  UNC** (`\\wsl.localhost\...`) — `cargo build` échoue avec `could not create
  session directory lock file: Fonction incorrecte`. Fixé en pointant
  `CARGO_TARGET_DIR` vers un chemin NTFS natif ; le code source reste lu
  depuis le chemin UNC sans problème, seul le répertoire de build doit être
  natif.
- **`npm run ...` échoue sur un `cwd` UNC** : `npm` passe par `cmd.exe`, qui
  ne supporte pas les chemins UNC comme répertoire courant (retombe
  silencieusement sur `C:\Windows`). Contournement dans
  `scripts/e2e-run.mjs` : invoquer `node.exe` directement sur les fichiers
  `.js` plutôt que passer par les shims `.cmd` (`npx`, `npm run`).
- **Un `node_modules` installé via WSL ne peut pas faire tourner Vite
  nativement sous Windows** : `esbuild` (et d'autres) livrent un binaire
  natif par plateforme, choisi à l'installation — seul le binaire Linux est
  installé. Contourné en testant un **build release** côté Windows :
  `frontendDist` (contenu de `dist/`, déjà construit via WSL) est purement
  statique donc portable, la tooling de build (`node_modules`) ne l'est pas.
- **`cargo build --release` seul ne suffit PAS à embarquer `frontendDist`** —
  le binaire continue de charger `devUrl` même en release, sans le feature
  flag Cargo `custom-protocol` (activé automatiquement par la CLI `tauri
  build`, jamais par un `cargo build` direct). Fix : `cargo build --release
  --features tauri/custom-protocol`.

**Techniques plus légères, sans lancer l'app entière** — mises en place le
2026-07-07 en développant les suggestions de commandes (ghost-text) des
terminaux locaux :

- **Tests unitaires (`npm run test`, vitest)** pour toute la logique pure
  découplée de React/xterm/Tauri. Voir `src/lib/lineBuffer.ts` +
  `src/lib/lineBuffer.test.ts`. **Piège Node** : vitest ≥ 4 exige Node ≥ 20 ;
  le Node de ce WSL est en 18.19 → utiliser `vitest@^2`.
- **Rendu DOM réel dans un navigateur headless (Playwright), sans Tauri**
  pour tout ce qui dépend du DOM produit par xterm.js (mesures de cellules,
  positionnement d'un overlay). Voir
  `scripts/visual-check-ghost-text.{html,client.mjs,mjs}`. **Piège install** :
  `npx playwright install --with-deps chromium` invoque `sudo apt-get
  install` en cascade, qui bloque indéfiniment sur un prompt de mot de passe
  dans ce WSL — utiliser `npx playwright install chromium` (sans
  `--with-deps`).

Aucune des deux ne couvre ce qui passe par `invoke(...)` — c'est exactement
ce que `npm run test:e2e` couvre.

## RDP intégré : détails de build, protocole, et bugs corrigés

Complète la section « RDP intégré : architecture sidecar » de `CLAUDE.md`
(qui garde le *pourquoi* architectural — conflit `ecdsa` insoluble entre
`russh` et `ironrdp-connector`, nécessité d'un workspace Cargo séparé).

### Build et vérifications historiques

`rdp-sidecar` compile et passe `cargo clippy --all-targets -- -D warnings`
propre, à la fois sous WSL et nativement sous Windows (testé le 2026-07-10 —
`ironrdp-tokio`'s feature `reqwest-rustls-ring` utilise `ring`, qui a lui
aussi besoin de NASM sous MSVC). La logique de connexion/décodage a été
portée depuis `ironrdp-client/src/rdp.rs` (client de référence du dépôt
`Devolutions/IronRDP`) en vérifiant chaque type/signature contre les sources
de la version réellement résolue par Cargo — un premier essai basé sur une
API plus récente que celle effectivement résolue a échoué à la compilation
et a dû être corrigé contre les sources réelles.

**Bug réel trouvé au premier test interactif** (2026-07-10) : le process
`rdp-sidecar` plantait immédiatement à la première connexion avec *"Could
not automatically determine the process-level CryptoProvider from Rustls
crate features"*. Cause : rustls 0.23 refuse de choisir implicitement un
`CryptoProvider` dès que plus d'un provider (`ring` et `aws-lc-rs`) se
retrouve dans le graphe de dépendances (`reqwest`/`ironrdp-tls` ne
s'accordent pas sur un défaut). Fix : dépendance directe sur `rustls` +
`rustls::crypto::ring::default_provider().install_default()` tout au début
de `main()`, avant toute connexion.

### Où placer le binaire compilé (référence build)

`tauri.conf.json` déclare `bundle.externalBin: ["binaries/rdp-sidecar"]`.
Deux emplacements différents comptent :

- **Pour `tauri build`/`tauri-action`** (packaging, `release.yml`) : le
  binaire compilé doit être copié vers
  `src-tauri/binaries/rdp-sidecar-<triple-cible>[.exe]` (suffixe de triple
  obligatoire).
- **Pour un `cargo build` direct côté `src-tauri`, ou `cargo run`/`tauri
  dev`** : `tauri_plugin_shell::Command::sidecar()` résout le binaire au
  runtime à côté de l'exécutable principal, sans suffixe de triple
  (`target/debug/rdp-sidecar` en dev) — copié automatiquement par
  `tauri-build`'s `build.rs` (déclenché par n'importe quel `cargo
  build`/`check`/`run`) depuis `src-tauri/binaries/rdp-sidecar-<triple-hôte>`.

  **Piège** : ce même `build.rs` vérifie que le chemin `bundle.externalBin`
  existe **même pour un simple `cargo check`** — sans le fichier
  triple-suffixé déjà en place, même la compilation du crate principal
  échoue (`resource path "binaries/rdp-sidecar-<triple>" doesn't exist`).
  `src-tauri/binaries/` est gitignored — après un `git clone` frais ou un
  changement de plateforme de build, ce binaire doit être reconstruit et
  recopié :
  ```bash
  wsl.exe -e bash -lc "cd ~/gui-termius/rdp-sidecar && cargo build && \
    cp target/debug/rdp-sidecar ../src-tauri/binaries/rdp-sidecar-x86_64-unknown-linux-gnu"
  ```

### CI : `rdp-sidecar` (corrigé le 2026-07-11, cassait tout `windows-workspace`)

Les commandes `cargo clippy --workspace`/`cargo build --workspace` du job
`windows-workspace` ne touchent jamais `rdp-sidecar` (isolation de
workspace, voir plus haut) — mais `tauri-build`'s `build.rs` vérifie que
`src-tauri/binaries/rdp-sidecar-x86_64-pc-windows-msvc.exe` existe **avant
même de compiler `gui-termius`**, fichier gitignored donc absent sur un
checkout CI frais. `windows-workspace` échouait à 100 % dès le premier
`cargo clippy --workspace`. Fix : `ci.yml` construit maintenant
`rdp-sidecar` (debug) et copie le binaire au bon endroit avant `Clippy
(workspace)`. Un job clippy dédié à `rdp-sidecar` a aussi été ajouté (`core`
Linux + `windows-workspace` pour le chemin `WinClipboard` réel).

**Piège NASM sur `windows-latest`** : vérifié via le manifeste logiciel
officiel (`actions/runner-images`) que l'image Windows Server 2025/VS2026 ne
liste pas NASM — `ilammy/setup-nasm@v1` ajouté explicitement dans `ci.yml`
*et* `release.yml`.

### Protocole `rdp-ipc`

`rdp-ipc/src/lib.rs` définit la trame entre les deux processus (10 tests
unitaires, `tokio::io::duplex`) :
- **stdin du sidecar** : une ligne JSON `ConnectRequest { host, port,
  username, password, width, height }` (largeur/hauteur ajoutées avec le
  redimensionnement dynamique, voir plus bas), puis un flux continu de
  lignes JSON `ClientMessage` — `MouseMove`, `MouseButton`, `MouseWheel`,
  `Key`, `ReleaseAll`, `Resize { width, height }`, `TypeText { text }`,
  `PushClipboardFiles { files }`.
- **stdout du sidecar** : `SidecarMessage` — `Image { canvas_width,
  canvas_height, x, y, width, height, pixels }` (RGBA8 brut, tag-byte +
  longueur préfixée, pas de framing texte), `Error(String)`, `Closed`.

**Piège vérifié empiriquement, rencontré 5 fois dans ce projet — voir
`CLAUDE.md`, section « Pièges déjà rencontrés »** : `#[serde(rename_all =
"camelCase")]` sur un enum à tag interne ne renomme que les valeurs de
variantes, jamais les champs des variantes struct. Pour `rdp-ipc`, `delta_y`
de `MouseWheel` restait `delta_y` en JSON malgré l'attribut d'enum —
nécessitant un `#[serde(rename = "deltaY")]` explicite. Couvert par un test
dédié plutôt qu'un simple roundtrip Rust→Rust (qui ne prouve rien sur la
casse réelle du JSON).

**Optimisation perf (2026-07-11)** : `Image` ne renvoie plus la totalité du
framebuffer à chaque mise à jour — seulement le rectangle réellement modifié
(`ActiveStageOutput::GraphicsUpdate(region)`). Un frame complet reste forcé
juste après la connexion et après chaque réactivation. Gain réel signalé par
l'utilisateur : un écran 1280×800 est passé de ~4 Mo par mise à jour à
quelques centaines d'octets pour le cas courant.

**Canal binaire `tauri::ipc::Channel` pour `Image` (2026-07-11)** :
`connect_rdp_view` prend un paramètre `channel: tauri::ipc::Channel` (créé
côté `RdpTab.tsx`, un par session). Chaque `Image` est sérialisée en un
en-tête binaire de 12 octets little-endian (`canvas_width`/`canvas_height`/
`x`/`y`/`width`/`height`, `u16` chacun) suivi des pixels RGBA8 bruts, envoyée
via `channel.send(InvokeResponseBody::Raw(...))` — remplace l'event Tauri
JSON + base64 précédent. Côté JS, `parseRdpFrame` (`lib/api.ts`) relit
l'en-tête avec un `DataView` et expose `pixels` comme vue `Uint8Array`
zéro-copie.

**Piège vérifié, pas supposé** : `tauri::ipc::Channel<TSend =
InvokeResponseBody>` suffit sans implémenter `IpcResponse` soi-même —
`InvokeResponseBody` s'auto-implémente `IpcResponse`, sans `#[derive
(Serialize)]` (vérifié dans les sources vendues de `tauri-2.11.5`) pour ne
pas entrer en conflit avec le blanket impl `impl<T: Serialize> IpcResponse
for T`. Côté JS, un payload `Raw(bytes)` arrive dans `Channel.onmessage` en
`ArrayBuffer` quelle que soit sa taille (petit payload = `eval`é
directement, gros payload = repasse par `fetch`/`response.arrayBuffer()`).
`RdpFrame.pixels` doit être typé `Uint8Array<ArrayBuffer>` explicitement
(pas juste `Uint8Array`) pour que `ImageData` l'accepte.

Côté `rdp-sidecar`, `main.rs` garde `stdin` ouvert après le `ConnectRequest`
et lance une tâche séparée poussant chaque `ClientMessage` dans un
`mpsc::unbounded_channel`, lu par `active_session`'s `tokio::select!` en
parallèle de `reader.read_pdu()`. Piège évité : un `mpsc::Receiver` fermé
renvoie `None` à *chaque* poll — sélectionner sans précaution ferait tourner
la boucle en busy-loop CPU dès que stdin se ferme ; `recv_or_pending`
bascule la branche sur `std::future::pending()` après le premier `None`.

La conversion `ClientMessage` → PDU RDP passe par `ironrdp::input`
(`Database::apply(operations)`/`release_all()`). La seule pièce qu'il ne
fournit pas : convertir `KeyboardEvent.code` en scancode PS/2 Set 1 — table
faite à la main dans `rdp-sidecar/src/input.rs::scancode_for` (lettres/
chiffres/ponctuation/flèches/modifieurs/F1-F12/pavé numérique ; touches
média et impr-écran absentes).

`commands/rdp_view.rs` lance le sidecar via `app.shell().sidecar(...)` avec
`.set_raw_out(true)` — **obligatoire** : sans ce flag, le plugin découpe
stdout ligne par ligne, corrompant le framing binaire dès qu'un octet
`\n`/`\r` apparaît dans des pixels. Les chunks `CommandEvent::Stdout` bruts
sont réassemblés via `tokio::io::duplex()`, relus avec
`rdp_ipc::SidecarMessage::read_from`.

**Aucune entrée de capability n'est nécessaire** dans
`capabilities/default.json` pour `tauri-plugin-shell` : `app.shell()
.sidecar(...)` est un appel Rust-vers-Rust interne à la commande
`connect_rdp_view`, jamais un `invoke()` frontend vers le plugin lui-même.

### Forward souris/clavier — comportements notables

Validé pour de vrai contre un serveur RDP réel le 2026-07-10. Côté
`RdpTab.tsx` :
- Coalesce `mousemove` à une frame d'animation max (`requestAnimationFrame`).
- Capture le relâchement de bouton au niveau `window`, pas juste sur le
  `<canvas>` (un drag qui sort du canvas avant `mouseup` doit rester vu).
- Attache `wheel` manuellement via `addEventListener(..., { passive: false
  })` — React délègue cet événement en mode passif par défaut, ce qui
  rendrait `preventDefault()` sans effet.
- Réutilise `shouldBubbleToShortcut` (`lib/shortcuts.ts`) pour laisser
  passer les raccourcis de l'appli.
- Envoie `ReleaseAll` sur perte de focus/visibilité (évite une touche
  « collée » côté serveur après un alt-tab).

### Presse-papiers (CLIPRDR) — texte, Windows uniquement

Option volontairement plus ambitieuse que le forward souris/clavier, choisie
par l'utilisateur après présentation des deux alternatives. Entièrement
contenue dans `rdp-sidecar/src/clipboard.rs` — aucun nouveau message
`rdp-ipc`, aucune commande Tauri, aucun changement frontend.

- `ironrdp-cliprdr-native`'s `WinClipboard` (Windows) fait le travail
  OS-spécifique ; `StubClipboard` (autre plateforme) négocie le canal sans
  jamais produire/accepter de données.
- **Piège central** : `WinClipboard` s'appuie sur `WM_CLIPBOARDUPDATE`
  livré à une fenêtre cachée qu'elle possède — exige une vraie boucle de
  messages Win32 (`GetMessageW`/`DispatchMessageW`) quelque part dans le
  process, alors que `rdp-sidecar` est un process tokio pur. Solution : un
  thread OS dédié (`std::thread::spawn`, jamais joint), sur lequel
  `WinClipboard` est créée (elle est `!Send`) et où la boucle de messages
  tourne indéfiniment. `backend_factory()` remonte vers l'async via un
  `tokio::sync::oneshot`.
- Les messages sortants remontent via `mpsc::UnboundedSender` (safe depuis un
  thread non-tokio). Troisième branche du `tokio::select!` d'
  `active_session` (même piège « channel fermé = busy-loop » que pour
  `input_rx`).
- **Validé pour de vrai le 2026-07-10** : copier-coller dans les deux sens,
  nativement sous Windows, contre un vrai serveur RDP (Vite resté côté WSL
  via port-forwarding WSL2).

### Redimensionnement dynamique — deux bugs réels corrigés

Ajouté après le forward souris/clavier, sur demande explicite (« je peux
redimensionner cette fenêtre, ça doit pouvoir s'adapter »).

- **Taille initiale** : `ConnectRequest` transporte `width`/`height`,
  mesurés par `RdpTab.tsx` sur son conteneur au moment de la connexion —
  passés par `MonitorLayoutEntry::adjust_display_size` (MS-RDPEDISP exige
  200..=8192 et une largeur paire).
- **Redimensionnement en cours de session** : `ResizeObserver` débounce à
  400 ms, envoie `ClientMessage::Resize`. `active_stage.encode_resize(...)`
  (Display Control Virtual Channel) encode la demande ; si le canal n'est
  pas disponible, la demande est simplement ignorée (pas de fallback
  reconnexion — jugé disproportionné pour un cas rare avec des serveurs
  modernes).
- **Séquence de Désactivation-Réactivation** (MS-RDPBCGR §1.3.1.3) :
  `handle_deactivate_all` (`main.rs`) rejoue le mini échange
  capacités/finalisation via `ironrdp_tokio::single_sequence_step_read`.
  Porté depuis `ironrdp-client/src/rdp.rs` mais adapté à l'API réellement
  résolue (`ActiveStageOutput::DeactivateAll` transporte directement un
  `Box<ConnectionActivationSequence>`, `ConnectionResult.connection_activation`
  pas `activation_factory`).

- **Bug n°1** (2026-07-10, premier test réel) : plantage immédiat au premier
  redimensionnement (`"Fast-Path ... custom error"`). Cause :
  `handle_deactivate_all` reconstruisait le fast-path processor avec
  `bulk_decompressor: None` sans condition, alors que le serveur négocie
  `CompressionType::K64` et continue d'envoyer des mises à jour compressées
  après réactivation. Fix initial : reconstruire un `BulkCompressor` frais à
  chaque réactivation.
- **Bug n°2** (2026-07-11, retest) : le fix n°1 arrêtait le plantage, mais
  l'affichage restait **définitivement noir** après un redimensionnement.
  Diagnostiqué via les logs `debug!` d'`ironrdp-session` (`RUST_LOG`,
  infrastructure conservée — voir plus bas) : les compteurs
  `total_compressed`/`total_uncompressed` repartaient de zéro à chaque
  réactivation — un `BulkCompressor` frais, donc un historique glissant
  MPPC vide, alors que cet historique doit rester continu avec celui du
  serveur (la Deactivation-Reactivation Sequence renégocie les capacités,
  elle ne relance pas la compression bulk au niveau transport). Un
  décompresseur désynchronisé produit un flux de longueur correcte mais de
  contenu faux, échouant en aval après quelques trames.
- **Fix final** : `handle_deactivate_all` n'appelle plus
  `set_fastpath_processor(...)` — le `fast_path::Processor` existant (avec
  son `bulk_decompressor` intact) reste en place à travers la réactivation ;
  seuls `image`/`share_id`/`enable_server_pointer` sont mis à jour via les
  setters dédiés. Contrepartie acceptée : `share_id`/`io_channel_id`/
  `user_channel_id` internes au processor (utilisés seulement pour le
  pacing bande-passante, pas le rendu) restent ceux de la connexion
  initiale — pas de setter dédié, seul compromis possible sans forker
  `ironrdp-session`.
- **Validé pour de vrai le 2026-07-11** : connexion + plusieurs
  redimensionnements de la fenêtre principale, sans erreur ni écran noir.

**Infrastructure de diagnostic conservée** (pas temporaire) :
- `commands/rdp_view.rs` capture les 4 derniers Ko de stderr du sidecar et
  émet un vrai `rdp-view-error` sur sortie anormale — visible dans l'onglet
  plutôt qu'un message générique.
- `rdp-sidecar` construit son subscriber via
  `EnvFilter::try_from_default_env()` (repli sur `"info"`) — `RUST_LOG`
  fonctionne maintenant (`tracing-subscriber` avec feature `env-filter`).
  Pour un futur diagnostic : `.env("RUST_LOG", "ironrdp_session=debug")` sur
  le `Command` du sidecar (`connect_rdp_view`) avant `.spawn()`.

### Frappe clavier simulée (snippets/diffusion sur RDP) — 2026-07-11

Décision de conception tranchée par l'utilisateur via `AskUserQuestion` :
frappe clavier simulée (a) plutôt que presse-papiers à la demande (b), pour
que snippets et diffusion fonctionnent aussi sur une cible RDP.
`ClientMessage::TypeText { text }` (nouveau) : chaque caractère devient une
paire `Operation::UnicodeKeyPressed`/`UnicodeKeyReleased`
(`ironrdp_input` 0.6.0, gère nativement les paires de substituts UTF-16).
`\n`/`\r` ne sont **pas** tapés comme caractère Unicode littéral — traités à
part comme une vraie pression de la touche Entrée via le chemin scancode
(un retour à la ligne tapé comme texte n'est pas interprété comme « valider
cette ligne » par la plupart des applications, contrairement à une vraie
frappe physique). `RdpTab.tsx::runCommand` fait simplement `text: command +
"\n"`, un snippet multi-ligne RDP est tapé ligne par ligne tel quel (pas de
compression en one-liner base64 comme pour SSH/Docker — rien ne garantit
qu'un shell a le focus côté bureau distant).

`RdpTab.tsx` expose un handle `TerminalTabHandle` (même forme que
`TerminalTab`/`LocalTerminalTab`). `getScrollbackText` renvoie `""` (RDP est
une image, pas un terminal). `writeRaw` (diffusion « frappe synchronisée en
direct ») relaie fidèlement les caractères imprimables mais tape
littéralement toute séquence d'échappement ANSI reçue — limitation connue,
pas de parseur ANSI construit pour ce mode secondaire.

### Glisser-déposer vers le presse-papiers (fichiers/dossiers) — 2026-07-12

Décisions actées avec l'utilisateur avant tout code : (1) glisser un
fichier/dossier rend disponible sur le presse-papiers distant, l'utilisateur
colle lui-même (CLIPRDR n'a aucune notion de dossier cible) ; (2) fichiers
*et* dossiers dès la première version.

Chaîne complète : `commands/rdp_view.rs::push_rdp_view_clipboard_entries`
(résout le pane source, aplatit récursivement en `Vec<rdp_ipc::PushedFile>`)
→ `core::transfer::resolve_local_path` (téléchargement immédiat vers un
fichier temporaire privé pour une entrée distante — nécessaire car
`on_file_contents_request` côté sidecar est un callback **synchrone**, sans
`.await` possible) → `ClientMessage::PushClipboardFiles` → sidecar construit
un `Vec<FileDescriptor>`, enregistre les chemins dans une `FileTable`
partagée, appelle `CliprdrClient::initiate_file_copy`.

**Pièce architecturale centrale** : `rdp-sidecar/src/clipboard.rs`'s
`FilePushBackend` — décorateur qui enveloppe le backend texte existant
(`WinClipboard`/`StubClipboard`), délègue tout le texte tel quel, n'implémente
que `client_capabilities()` (OR avec `STREAM_FILECLIP_ENABLED`) et
`on_file_contents_request` (lit l'octet range demandé directement dans le
fichier local via la `FileTable`). Décision explicite de ne pas étendre
`WinClipboard` lui-même : `ironrdp-cliprdr-native` 0.6.0 n'a aucun support
fichier câblé sur aucune plateforme — y ajouter le vrai rendu différé COM
Windows aurait été un chantier bien plus gros pour rien ici (les octets
viennent toujours d'un chemin connu, jamais d'une vraie lecture du
presse-papiers OS). Ce découplage rend `FilePushBackend` cross-platform,
sans `#[cfg(windows)]`.

**Piège vérifié en lisant les sources vendues d'`ironrdp-cliprdr` 0.6.0** :
le moteur de protocole (distinct de `-native`) supporte déjà intégralement
le format liste de fichiers (`FileContentsRequest`/`Response`,
`initiate_file_copy`/`submit_file_contents`) — juste besoin de brancher
l'appel réel plutôt que d'ajouter quoi que ce soit de neuf.

**Bugs réels trouvés au premier test utilisateur (2026-07-12), tous côté
frontend, pas dans le protocole CLIPRDR** :
- **Bouton flèche/« Copier » en mode RDP** : câblé sur la fonction
  générique `copy()`, qui a besoin d'un `paneId` distant ouvert — mais en
  mode RDP le panneau droit n'est jamais ouvert comme pane (`<RdpTab>` en
  direct). `copy()` ressortait silencieusement sans erreur. Fix : nouveau
  `copyOrPushToRdp`, redirige vers `pushToRdp` quand la cible est RDP.
- **Aucune confirmation visuelle de succès sur `pushToRdp`** — un push
  réussi n'avait aucun effet visible, lu comme un échec. Fix : nouveau prop
  `onPushed`, notification "success" (jusque-là seul le type "error" était
  utilisé dans ce projet).

**Retest utilisateur (2026-07-12, même jour)** :
- **Bug n°3 — glisser-déposer interne jamais amorcé** : chaque ligne de
  fichier a un `onMouseDown` qui arme un drag — mais le bouton Nom (zone la
  plus naturelle à saisir) avait un `stopPropagation()` copié par analogie
  avec la checkbox voisine (qui, elle, en a réellement besoin). Résultat :
  cliquer sur l'icône/nom n'armait jamais de drag. Fix : suppression du
  `stopPropagation` sur le bouton Nom.
- **Collage automatique demandé** : appliqué aux trois méthodes
  (Explorateur, glisser interne, bouton flèche) via une seule fonction côté
  `rdp-sidecar` (`paste_key_sequence`, simule Ctrl+V juste après l'annonce
  de la liste de formats, sans attendre `FormatListResponse` — les deux PDUs
  partent sur le même flux TCP ordonné). Non testé contre un vrai serveur au
  moment d'écrire ceci.

**Nettoyage ultérieur (2026-07-12)** : après test en conditions réelles,
l'utilisateur a jugé le glisser-déposer *interne* (souris, panneau gauche →
droit) trop fragile pour sa valeur et a demandé son retrait complet
(`dragPayload`, `handleDropEntries`, `manualDragRef`, etc., supprimés de
`TransferTab.tsx`). Le glisser-déposer natif OS (Explorateur → vue RDP,
`webview.onDragDropEvent`) reste intact, ainsi que le bouton flèche. Le
lanceur RDP système (`connect_rdp`, `mstsc.exe`/`xfreerdp`) a aussi été
retiré le même jour, jugé redondant une fois l'aperçu intégré validé —
fichiers `core/src/rdp.rs`/`src-tauri/src/commands/rdp.rs` supprimés,
`connectRdp` retiré d'`api.ts`. L'aperçu intégré est désormais l'unique mode
de connexion RDP de l'app.

### Limites connues restantes

- **Pas de curseur rendu** — les événements `PointerDefault`/`Hidden`/
  `Position`/`Bitmap` sont ignorés côté `rdp-sidecar`.
- **Molette approximative** — chaque `wheel` envoie un cran fixe (±120) dans
  le sens du signe de `deltaY`, pas la magnitude réelle (évite un
  wraparound sur l'octet signé de `MousePdu`).
- **Pas de fallback reconnexion si le Display Control Virtual Channel est
  indisponible** — un resize demandé dans ce cas est simplement ignoré.

## Docker exec via SSH (bastion) — `Host::docker_via_host_id` (2026-07-11)

Joindre le démon Docker d'un hôte distant sans exposer son API Engine en TCP
(risque d'accès root-équivalent sans authentification). `docker::connect_via_ssh`
(`core/src/docker.rs`) tunnelle l'API Engine sur une connexion SSH déjà
configurée dans l'app.

**Pourquoi pas la feature `ssh` de `bollard`** : elle shell-out vers le
binaire `ssh` du système via `openssh` (ControlMaster) — modèle
d'authentification différent (config/agent SSH système) de celui de l'app
(coffre/`known_hosts.json` propres à `russh`). `DialStdioConnector`
(nouveau) reproduit le même principe (`docker system dial-stdio` sur l'hôte
distant) mais en s'appuyant sur une session `russh` déjà authentifiée.
Implémente `tower_service::Service<Uri>`, branché sur un vrai
`hyper_util::client::legacy::Client`.

**Piège vérifié** : l'API bas niveau `hyper::client::conn::http1` ne pose
jamais de header `Host` — chaque requête partait sans, rejetée par Docker
(`400 Bad Request`). Fix : construire un vrai `Client<DialStdioConnector,
BodyType>` (comme `bollard` le fait en interne), pas l'API bas niveau
directement.

**Bug réel trouvé par l'utilisateur, sans rapport avec le tunnel SSH** :
conteneurs bien listés, mais ouvrir un exec donnait un terminal vide, aucune
frappe n'avait d'effet. Cause : `docker::open_exec`'s commande codée en dur
`sh -c "exec bash || exec sh"` — sur une image sans `bash` (alpine), le
`/bin/sh` par défaut est BusyBox `ash`, qui **quitte tout le script**
immédiatement sur un `exec` ciblant une commande introuvable plutôt que de
renvoyer un code d'erreur que `||` pourrait rattraper. Le `|| exec sh` de
secours n'était donc jamais atteint. Fix : `command -v bash >/dev/null 2>&1
&& exec bash || exec sh`.

**Harnais de diagnostic réutilisable** : `core/examples/docker_ssh_debug.rs`
(`cargo run --example docker_ssh_debug -- <uuid-hôte-docker>`) — lit le vrai
`workspace.json`/trousseau de la machine, permet d'itérer en quelques
secondes plutôt qu'un cycle complet de rebuild+relance de l'app GUI.
Conservé pour tout futur bug Docker/SSH.

## Harmonisation snippets/diffusion : Docker exec + RDP (2026-07-11)

Investigation préalable (agent Explore) : l'exécution manuelle de snippets
et la diffusion (`BroadcastBar`) ne font **aucune** distinction par
`HostKind` — elles passent par `api.writeTerminal`, déjà backend-agnostique.
Ça marchait donc déjà pour Docker exec avant toute modification. Le seul
vrai trou : les **snippets au démarrage** (auto, à la connexion), absents
côté backend (`connect_docker_exec` ignorait `startup_snippets`/`env_vars`)
et côté UI (`HostForm.tsx` masquait le champ). Fix (petit, fait directement) :
extraction de `startup_commands(workspace, host_id)` partagée entre
`connect_terminal`/`connect_docker_exec` ; `HostForm.tsx`'s `sshOnlyExtras`
scindé en `shellExtras = kind === "ssh" || kind === "dockerExec"`.

RDP, en revanche, n'avait structurellement rien (onglets pas enregistrés
dans `terminalRefs`, `ClientMessage` sans moyen d'injecter du texte) — voir
la section RDP ci-dessus pour la solution retenue (frappe clavier simulée).

## Nettoyage général + optimisations (2026-07-12)

Passe demandée par l'utilisateur (« voir s'il y a du code mort à supprimer,
des optimisations à faire »). Trouvé et corrigé :
- `vite.config.d.ts` (généré, projet composite) committé par erreur — retiré
  du suivi, ajouté au `.gitignore`.
- `thiserror`/`rand` dans `core/Cargo.toml` déclarés mais jamais utilisés
  (trouvés via `cargo-machete`, confirmés par grep avant suppression).
- `ActiveForward::config()` (`core/src/port_forward.rs`) : méthode publique
  jamais appelée — invisible à clippy (une lib ne warn pas sur du `pub`
  inutilisé), trouvée par un agent Explore cross-référençant les symboles
  `pub` contre leurs call sites. Supprimée.
- **Suppression multiple dans l'explorateur de fichiers, O(n²) → O(n)** :
  `pane_remove` relistait tout le répertoire après *chaque* suppression
  individuelle. Sur un backend Docker exec, chaque listing relance un `exec`
  dans le conteneur. Fix : `pane_remove` prend `entries: Vec<Entry>`,
  supprime tout puis liste une seule fois à la fin.
- **Trois blocages du runtime tokio** (I/O synchrone sans `spawn_blocking`) :
  `known_hosts::check_and_trust`, `transfer::list` (`PaneRef::Local`),
  `write_local_terminal` (écriture PTY bloquante à chaque frappe).

**Trois optimisations identifiées mais volontairement pas faites cette
session** (voir aussi « Dette technique » plus bas pour la suite) :
1. Sous-ensembles de polices (`@fontsource/*` importe tous les charsets
   Unicode, ~1.2 Mo) — décision utilisateur (besoin de cyrillique/grec ?),
   pas une déduction depuis le code.
2. Découpage du bundle JS (809 Ko non compressé, un seul chunk) — gain
   incertain sans mesure de démarrage perçu comme lent.
3. Canal binaire pour `terminal-data` — fait le 2026-07-20, voir plus bas.

## Opérations de flotte + moteur de snippets adaptatifs

### Bouton dédié, facts persistées, filtres étendus (2026-07-16)

- Bouton dédié dans `TabBar.tsx` (`IconServerStack`) plutôt que de fusionner
  avec le bouton diffusion malgré leur icône partagée d'origine.
- **Facts persistées sur l'hôte** plutôt que gardées en mémoire React :
  `Host` gagne `last_facts`/`last_facts_at_ms`. `HostFacts` déplacée de
  `core/src/facts.rs` vers `model.rs`. Affichées en petit sous chaque hôte
  SSH (`HostsPanel.tsx`) et dans `FleetTab.tsx` — **piège UX trouvé par
  l'utilisateur** : OS et RAM sur la même ligne devenaient illisibles
  panneau réduit, séparés sur deux lignes.
- **Filtres étendus** : cinq critères combinables en ET (RAM/CPU/charge
  1 min/uptime/OS), chacun avec sa case à cocher.
- **Snippets exécutables depuis la flotte** : remplit la zone de commande
  plutôt que d'exécuter immédiatement — l'étape de relecture explicite avant
  « Exécuter » reste le garde-fou pour un run potentiellement vers des
  dizaines d'hôtes réels.
- `core::fleet::run_on_hosts` généralisé de `(host_ids, command)` à
  `(commands: HashMap<HostId, String>)` — un hôte peut exécuter une commande
  différente des autres dans un même run.

### Le DSL adaptatif : trois itérations le même jour (2026-07-16)

**Le besoin** : exécuter une opération sur une flotte hétérogène (Ubuntu,
CentOS, Alpine…) sans écrire soi-même la commande spécifique à chaque
gestionnaire de paquets/service, et sans confier à une IA la génération du
shell final elle-même (risque d'hallucination sur la syntaxe exacte).

**Itération 1 (abandonnée) : classification par tool-use Anthropic.** L'IA
choisissait, via tool-use natif, une parmi huit « opérations » structurées
(`Operation`, alors persisté sur `Snippet`, avec un cache
`platform_commands: HashMap<os_id, String>`), un appel IA par plateforme
détectée. Abandonnée : une seule opération par snippet, pas de conditions,
pas de `sudo` — coder ça dans un schéma de tool-use aurait été nettement
plus complexe pour un bénéfice de sûreté équivalent à « l'IA écrit du texte
que mon propre parseur valide ».

**Itération 2 (abandonnée) : création manuelle par menu déroulant.** Un
mode « Adaptatif » dans `SnippetsPanel.tsx` proposait un `<select>` des huit
opérations + un champ argument. Abandonnée le jour même quand l'utilisateur
a demandé conditions/`sudo`/blocs multiples : un menu déroulant ne s'y
prêtait pas, contrairement à du texte libre.

**Architecture finale (celle en place aujourd'hui) : un petit DSL textuel,
l'IA comme rédactrice de ce texte.** Un *programme* est le seul artefact que
le moteur manipule. Grammaire, parseur (`parse_program`), évaluateur
(`compose_for_host`/`preview`) et table de rendu déterministe vivent dans
`core/src/adaptive.rs` — **la grammaire complète est documentée en tête de
ce fichier**, c'est la version autoritative, pas la peine de la dupliquer
ici. Rendu déterministe par familles de gestionnaires de paquets
(apt/dnf/apk/pacman/zypper/winget) et de services (systemd/openrc/
pwsh-service) — un hôte inconnu renvoie `None` plutôt qu'une supposition.
`is_safe_token` valide chaque argument contre une liste blanche de
caractères avant interpolation shell — seul rempart réel contre une
injection.

Le rôle de l'IA (`generate_program`) : rédiger — jamais exécuter — du texte
dans cette même grammaire. La réponse est repassée dans le **même**
`parse_program` que la saisie manuelle avant d'être renvoyée au frontend.
Un seul appel IA par génération, quel que soit le nombre de plateformes
distinctes parmi les hôtes ciblés (contrairement à l'itération 1).

Conséquence architecturale de cet historique : `Operation`/`Condition`/
`Statement`/`Program` ne sont **plus** des champs persistés sur `Snippet` —
ils vivent uniquement dans `adaptive.rs` comme représentation interne de
parsing, jamais sérialisée. Rejouer un snippet adaptatif sur une flotte
jamais vue coûte toujours zéro appel IA, y compris sur une plateforme
totalement nouvelle.

### Opérateurs `&&`/`||` dans les conditions (2026-07-16)

Ajouté après coup à la demande de l'utilisateur : jusque-là, plusieurs
`target` dans un bloc ne pouvaient se combiner qu'en ET, sans moyen
d'exprimer un OU. `Statement.conditions` passé de `Vec<Condition>` à
`Vec<ConditionExpr>` (`ConditionExpr::{Atom, And, Or}`, arbre binaire,
précédence conventionnelle `&&` > `||`). Plusieurs *lignes* dans un bloc
continuent de se combiner en ET entre elles — tout programme déjà écrit
reste valide et se comporte à l'identique.

### Extension à Docker exec, terminal local, Windows (2026-07-16)

Décision actée avec l'utilisateur (`AskUserQuestion`, vrai fork) : sur
Windows, le terminal local par défaut lance PowerShell (pas un shell
POSIX) — l'utilisateur a choisi le support Windows complet plutôt que de se
limiter aux terminaux locaux déjà sous un shell POSIX (WSL), argument en sa
faveur : contrairement à SSH/RDP, cette plateforme est directement testable
en conditions réelles.

- **Docker exec** : `docker::probe_container_facts` — sonde via
  `exec_capture`, aucune nouvelle logique de sonde. Pas de cache de facts
  pour Docker (un `Host` `dockerExec` n'est pas lié à un conteneur précis) —
  sondé à chaque exécution.
- **Terminal local** : `core/src/local_shell.rs` centralise la résolution
  "quel shell tourne dans cet onglet". Un shell natif Windows ne passe
  jamais par une sonde : la plateforme est synthétisée directement (connue
  instantanément, c'est l'OS sur lequel Guiterm tourne). Tout autre shell
  passe par `facts::probe_local(shell)` (process local ponctuel
  non-interactif, jamais le pty interactif déjà ouvert). **Élégance
  trouvée en cours de route** : Git Bash n'a pas de vrai `/etc/os-release` —
  pas besoin de le détecter comme cas à part, la sonde y échoue juste
  silencieusement, donnant le message « non pris en charge » déjà existant.
- **Plateforme Windows dans `render_command`** : nouvelle famille `"winget"`
  et `"pwsh-service"`. **Piège trouvé en écrivant les tests** : deux tests
  existants utilisaient `"windows"` comme exemple volontairement non
  supporté — cassés dès l'ajout du vrai support, corrigés en remplaçant par
  `"freebsd"`.
- **Nouvelles commandes Tauri** : `compose_adaptive_for_local`/`_docker`
  ciblent toujours une seule cible (pas de `Workspace`/`host_id` nécessaire
  pour le terminal local, qui n'a pas de `Host`).

### Neuf opérations supplémentaires + `target name`/`target tag` (2026-07-17)

**Bug restauration de session corrigé en passant** : `saveTabs`/`loadTabs`
ne persistaient pas le champ `shell` d'un onglet `local-terminal` — un
placeholder restauré retombait toujours sur `preferences.defaultLocalShell`
plutôt que le shell réellement utilisé (ex. `wsl`).

`target name`/`target tag` : `name` = sous-chaîne insensible à la casse sur
le nom d'affichage ; `tag` = correspondance **exacte** (volontairement — un
`target tag: prod` ne doit pas matcher `prod-test`). A nécessité
`HostContext` (facts + name + tags) en remplacement de `Option<&HostFacts>`.

Neuf nouvelles opérations, même table de rendu + validation de charset :
`service-logs`, `create-directory`/`remove-directory`, `create-user`/
`remove-user`, `reboot`, `set-hostname`, `open-port`/`close-port`.

### Bug `FleetTarget` : `rename_all` ne renomme pas les champs (2026-07-17)

**6e occurrence du même piège dans ce projet** (voir `CLAUDE.md`, section
« Pièges déjà rencontrés »). Signalé par l'utilisateur : lancer une commande
de flotte fait « mouliner » indéfiniment l'onglet « Résultats », alors que
l'Historique affiche bien le résultat. `FleetTarget` (enum à tag interne,
variantes struct `Ssh { host_id }`/`Docker { host_id, container_id }`) —
`rename_all` ne renomme que la valeur du tag, jamais les champs de variante.
L'entrée fonctionnait (passe par `GroupCommand`, struct classique
correctement casée) ; seule la **sortie** (`fleet-run-outcome`) était cassée
— `outcome.target.hostId` valait `undefined` côté JS, la clé de dé-pending
ne correspondait jamais. Fix : `rename_all_fields = "camelCase"` (serde ≥
1.0.145), qui renomme les champs de *toutes* les variantes.

**Migration `fleet_history.json`** : nouvelle couche
`fleet_history::legacy_snake_case_target` (même principe que le module
`legacy` déjà existant pour le tout premier schéma pré-`targets`) — l'ordre
d'essai est schéma courant → intermédiaire → plus ancien, l'historique
existant n'est jamais perdu.

### FleetTab : dépassement aide-mémoire, sélection libre, redimensionnement (2026-07-17)

- Aide-mémoire de syntaxe (8→17 entrées) dépassait de la fenêtre sans
  scroll — fix : `max-h-64 overflow-y-auto`.
- Cases SSH restaient désactivées en mode Langage même pour un programme
  sans aucun `target` (qui s'applique alors à tous les hôtes par
  sémantique du DSL) — fix : `programHasTargetLine(text)` limite l'effet de
  sélection auto/désactivation aux programmes qui contiennent réellement une
  ligne `target`.
- Sections redimensionnables à la souris (liste de cibles / composeur+
  résultats, composeur / résultats) — repris **exactement** le mécanisme
  déjà utilisé 4 fois ailleurs dans le code à cette date (`App.tsx` ×3,
  `TransferTab.tsx`), jamais extrait en composant partagé à cette date (fait
  ensuite, voir « Dette technique » plus bas).

### Cibles unifiées (SSH + Docker exec + terminal local) — mode Commande (2026-07-16)

Décision actée avec l'utilisateur (`AskUserQuestion`, vrai fork d'ampleur) :
intégration complète, avec conservation dans l'Historique persistant.
**`core::fleet::FleetTarget`** (`Ssh { host_id } | Docker { host_id,
container_id } | Local`) remplace `HostId` partout dans ce sous-système —
introduit parce qu'un conteneur Docker/le terminal local n'ont pas d'`Uuid`
à donner. Portée volontairement limitée au mode « Commande » : le mode
« Langage » (DSL adaptatif) reste strictement SSH-only.

- `docker::exec_with_exit_code` (nouveau) : `exec_capture` `bail!` sur code
  de sortie non nul (bonne politique pour `docker_pane`), mauvaise pour la
  flotte où un code non nul est un résultat normal, pas une erreur de
  connexion.
- `local_shell::one_shot_command` route explicitement par famille de shell
  (`wsl.exe` → `-e sh -c`, `cmd.exe` → `/c`, PowerShell/pwsh →
  `-Command`, POSIX → `-c`) — nécessaire pour exécuter du texte tapé à la
  main avec le vrai shell par défaut de l'onglet, PowerShell y compris.
- **Migration `fleet_history.json`** (schéma pré-`targets`) : `load_from`
  essaie le nouveau schéma, retombe sur un module `legacy` privé si le champ
  `targets` manque — migration paresseuse au chargement, même pattern que
  `store::resilient_load` pour `workspace.json`.
- Frontend : `fleetTargetKey()` (`src/lib/types.ts`) produit une string
  stable (`ssh:<uuid>`, `docker:<hostId>:<containerId>`, `"local"`) pour
  servir de clé React/Set/Map.

### Revue de conception : idempotence, arrêt à la première erreur, fraîcheur des facts (2026-07-17)

Suite à une discussion de conception (retour honnête demandé sur le moteur
adaptatif).

- **Idempotence** : `useradd`/`userdel` échouaient net si la cible
  existait déjà/n'existait plus — rejouer sur une flotte partiellement
  convergée faisait remonter un échec artificiel. `user_cmd` protège
  désormais chaque branche par un test d'existence (`id -u`,
  `Get-LocalUser -ErrorAction SilentlyContinue`) avant d'agir. Même piège
  sur `remove-directory` côté Windows (`Remove-Item -Recurse -Force` lève
  une erreur si le chemin est déjà absent) — protégé par `Test-Path`. **Non
  corrigé, noté plutôt que deviné** : `netsh advfirewall firewall add rule`
  n'est pas idempotent (deux exécutions créent deux règles) — pas de démon
  pare-feu réel disponible pour vérifier empiriquement un fix.
- **Arrêt à la première erreur entre blocs** : le script composé est
  désormais préfixé `set -e` (POSIX) ou `$ErrorActionPreference = 'Stop'`
  (Windows) — sans ça, un échec dans un bloc n'empêchait pas le suivant de
  s'exécuter, et le code de sortie remonté était celui de la dernière
  commande, masquant un vrai échec survenu plus tôt. `fish` comme shell de
  login distant n'est pas géré spécifiquement (`set -e` y a un tout autre
  sens) — documenté plutôt que traité en silence.
- **Fraîcheur des facts** : la condition de recollecte est passée de
  « `lastFacts` absentes » à « absentes ou plus vieilles que 15 minutes »
  (`factsAreStale`). **Limite connue, non traitée** : rien ne revérifie la
  fraîcheur entre le clic « Prévisualiser » et le clic « Exécuter le plan » —
  volontairement pas corrigé, re-évaluer silencieusement avant l'exécution
  pourrait faire tourner un plan différent de celui relu/validé.

### DSL adaptatif → export Ansible : piste envisagée, pas implémentée (2026-07-17)

Discussion de conception : Terraform écarté (résout un problème différent,
provisionnement déclaratif de ressources cloud). Ansible jugé valable :
exporter un programme DSL + une sélection d'hôtes en playbook Ansible
(`target tag:`/`target name:` → groupes d'inventaire, chaque opération DSL
→ module Ansible idiomatique plutôt que la commande shell brute — pas
besoin de réimplémenter l'idempotence, Ansible la fournit nativement). Point
dur : les conditions numériques (`ram`/`cpu`/`load`/`uptime`) n'ont pas
d'équivalent en groupe d'inventaire, il faudrait les transformer en `when:`
contre des facts Ansible dont les noms exacts sont pénibles à obtenir sans
les vérifier contre un vrai dump `ansible_facts` (indisponible dans cet
environnement). Reste un export à sens unique, en lecture seule — pas de
nouveau chemin d'exécution, pas de dépendance à `ansible-playbook`. Proposé
comme chantier séparé, jamais scopé plus avant.

## Docker exec / K8s exec unifiés dans le mode SFTP (2026-07-12)

**Split terminal (panneau 2) : Docker exec et RDP.** `SplitPane.tsx` ne
gérait avant que `"local" | HostId` en supposant un shell SSH-shaped —
sélectionner un hôte Docker exec ou RDP y tentait silencieusement une
connexion SSH. Fix : résolution par `host.kind`, branchement vers `RdpTab`/
picker Docker/message explicite pour K8s (à l'époque).

**Docker exec dans le mode SFTP — le morceau substantiel.** Docker n'a pas
de sous-système SFTP.

- `core/src/sftp.rs` : nouveau trait `RemoteFileClient` (`async_trait`),
  implémenté pour `SftpClient` (délégation directe) et `DockerPaneClient`.
  `download`/`upload` prennent `&mut (dyn FnMut(u64, u64) + Send)` plutôt
  qu'un générique — object-safety, `PaneRef` stocke `Arc<dyn
  RemoteFileClient>`. **Piège rencontré** : passer `&Arc<dyn
  RemoteFileClient>` là où `&dyn RemoteFileClient` est attendu échoue à la
  compilation (la coercion ne s'applique pas à travers ce genre de double
  indirection) — fix : `.as_ref()` explicite à chaque site d'appel.
- `core/src/transfer.rs` : `PaneRef::Remote(Arc<SftpClient>)` →
  `Arc<dyn RemoteFileClient>` — toute la logique de dispatch reste
  inchangée, fonctionne désormais génériquement.
- `core/src/docker_pane.rs` : deux surfaces API différentes selon
  l'opération — métadonnées (list/mkdir/rename/remove/chmod) via
  `exec_capture` (shell dans le conteneur, script délimité par
  tabulations, chemins passés en paramètres positionnels, pas
  d'interpolation) ; contenu (read/write/upload/download) via les endpoints
  d'archive Docker Engine (`download_from_container`/`upload_to_container`,
  streams tar). **Limitation connue** : upload comme download bufferisent
  le fichier entier en mémoire (pas de risque pour du config/code
  ordinaire, risqué pour du multi-gigaoctets).
- Frontend : `PaneSource` gagne le variant `docker` ; picker de conteneur
  réutilisé dans `TransferTab.tsx`/`SftpPanel.tsx` (3e réutilisation du
  même pattern dans la session).

**Bug réel trouvé par l'utilisateur au premier essai contre un vrai
conteneur** : `open_pane` échouait avec `missing field container_id`.
**Même piège `rename_all` que documenté ailleurs** — `PaneSource::Docker`
avait un `#[serde(rename = "hostId")]` explicite (copié depuis `Remote`)
mais pas l'équivalent sur `container_id`. Fix : `#[serde(rename =
"containerId")]` explicite + test de régression dédié désérialisant un JSON
écrit à la main.

## K8s exec : backend réel (2026-07-20)

Jusqu'ici, `HostKind::K8sExec` n'existait que côté cosmétique (picker à
données d'exemple codées en dur, bandeau « pas encore de backend »). Demande
explicite : parité complète avec Docker exec en une seule vague plutôt que
le terminal seul d'abord (tranché via `AskUserQuestion`, les deux ampleurs
étant comparables).

**Dépendance `kube`/`k8s-openapi` — pas de sidecar séparé nécessaire.** Le
conflit de version `ecdsa` qui avait forcé un workspace séparé pour RDP a
été retesté pour Kubernetes : `kube = "0.99"` + `k8s-openapi = "0.24"`
ajoutés directement à `core/Cargo.toml`, résolution propre, aucun conflit
(`kube-client` s'appuie sur la même famille `hyper`/`tower`/`rustls` déjà
présente via `bollard`/`reqwest`). `core/k8s.rs`/`k8s_pane.rs` vivent donc
directement dans `core/`.

**`core/src/k8s.rs`** — mirroir direct de `docker.rs`, API `kube` vérifiées
contre les sources vendues avant d'écrire le code :
- `connect(context)` : authentification entièrement déléguée au kubeconfig
  (jeton, certificat client, ou plugin `exec:`) — pas un secret géré par le
  coffre Guiterm.
- `open_exec(...)` : `Api::<Pod>::exec` retourne un `AttachedProcess`, dont
  `.stdin()`/`.stdout()` sont des `tokio::io::DuplexStream` (buffer interne
  **1 Kio par défaut**, important pour `exec_raw`).
- `exec_raw`/`exec_capture`/`exec_with_exit_code` — **piège vérifié
  empiriquement dans les sources** : le code de sortie n'est pas un champ
  direct, il vient de l'objet `Status` sur le canal de statut
  (`status.status == "Success"` → 0 ; `"Failure"`/`"NonZeroExitCode"` → code
  réel dans `details.causes[].message` de la cause `reason == "ExitCode"`,
  convention `client-go`). Lire stdout/stderr séquentiellement puis
  attendre le statut **bloquerait** sur toute sortie dépassant le buffer de
  1 Kio — `exec_raw` draine stdout/stderr/écrit stdin concurremment via
  `tokio::join!`.

**`core/src/remote_shell_pane.rs`** (renommé depuis `tar_utils.rs`) —
Kubernetes n'a pas d'équivalent aux endpoints d'archive Docker ; `kubectl
cp` lui-même n'est qu'un `tar` par-dessus `exec`. `K8sPaneClient` reproduit
ce principe (`tar cf - | ...` / `tar xf - -C ...`). `LIST_SCRIPT`/
`parse_listing`/`split_parent_and_name`/etc. extraits de `docker_pane.rs`
vers ce module commun. **Limitation différente de Docker** : `exec_capture`
bufferise la totalité de l'archive en mémoire — la progression n'est jamais
progressive pour le download non plus (contrairement à Docker, dont le
flux d'archive arrive par chunks).

**Câblage Tauri** : `register_shell_session` n'a nécessité aucun changement
— un troisième appelant, `connect_k8s_exec`, lui passe simplement
`TerminalBackend::K8s`. `PaneSource::K8s { host_id, pod_name,
container_name }` avec le même `#[serde(rename = "...")]` explicite par
champ que `Docker` — testé en régression une 5e fois plutôt que supposé
couvert. `FleetTarget::K8s` testé en régression camelCase comme les deux
autres variantes.

**Frontend** : mêmes pickers, mêmes conventions déjà établies. Un pod
pouvant avoir plusieurs conteneurs, chaque picker aplatit en une entrée par
conteneur (`podPickerId`/`parsePodPickerId`, encodage `podName/containerName`
sans ambiguïté — un nom de pod ne contient jamais `/`). `useTabs.ts`'s
`runSnippet`/`useBroadcast.ts` n'ont eu **besoin d'aucun changement** — déjà
backend-agnostiques.

**Non vérifié** : aucun cluster Kubernetes joignable dans cet environnement
de dev. Point le plus incertain à valider en premier : `exec_raw`'s
extraction du code de sortie (dérivée de la convention `client-go`, jamais
observée sur une vraie réponse serveur). Second point : comportement d'un
pod à conteneurs multiples sans `container` explicite.

## Canal binaire `tauri::ipc::Channel` pour `terminal-data` (2026-07-20)

Dernier morceau du backlog d'optimisation identifié le 2026-07-12 (« Canal
binaire pour terminal-data »), qualifié à l'époque de « chantier le plus
invasif ». Même transformation que celle déjà faite pour les frames RDP :
`terminal-data` était un event Tauri JSON global filtré côté frontend par
`session_id` — l'événement le plus fréquent de toute l'app. Remplacé par un
`tauri::ipc::Channel` **par session**, transportant les octets bruts sans
JSON ni base64.

- `commands/terminal.rs::spawn_output_bridge` prend un `channel: Channel` en
  plus du `mpsc::Receiver<Vec<u8>>`, `channel.send(InvokeResponseBody::Raw
  (bytes))` — partagé par `connect_terminal`/`connect_docker_exec`.
  `open_local_terminal` convertit séparément (bridge synchrone dans un
  `spawn_blocking`). `terminal-closed` **reste** un event JSON classique
  (fire au plus une fois par session, coût négligeable).
- `TerminalDataEvent`/`util::encode`/`onTerminalData`/`base64ToBytes`
  supprimés. La voie d'**entrée** (frappe → `write_terminal`) n'a pas été
  touchée (volume par appel bien plus faible, pas le goulot identifié).
- **Bénéfice de correction, pas seulement de perf** : avec l'ancien event
  global, il existait une fenêtre de race entre la résolution de
  `connect_terminal` et l'enregistrement du listener où une sortie précoce
  (bannière de login) pouvait être perdue en silence ; le `Channel` est
  câblé avant même l'appel `invoke`, cette fenêtre n'existe plus.
- **Couverture E2E étendue** (`scripts/e2e-run.mjs`, pas un script séparé) :
  ouvre un terminal local, tape `echo <marqueur>` caractère par caractère
  (pas en bloc — `WebKitWebDriver` a été vu perdre un caractère sur un envoi
  en bloc pendant cette session), vérifie le marqueur dans le DOM. Seul
  scénario de la suite à exercer un vrai flux de sortie continu via
  `invoke`+`Channel` de bout en bout.

**Non vérifié** : le mode diffusion/synchro live avec plusieurs terminaux
ouverts simultanément (chemin de code partagé, à faible risque, mais pas
exercé pour de vrai avec plusieurs channels actifs en parallèle).

## Dette technique : deux passes d'audit (2026-07-18 et 2026-07-20)

### Revue exhaustive du 2026-07-18 : 6 points corrigés le jour même

Audit demandé par l'utilisateur (« quels seraient mes points d'amélioration,
soit ultra exhaustif »). Corrigés le jour même :
1. CI : `npm run test` (job `frontend`) et `cargo test --all-targets` pour
   `rdp-sidecar` (job `core`) — absents jusque-là.
2. `core/src/transfer.rs::copy_dir` — `local_fs::list` enveloppé dans
   `spawn_blocking`.
3. `keys.rs::deploy_public_key` — `PrivateKey` clonée hors du lock,
   `resolve_key_content` dans un `spawn_blocking` séparé.
4. `src/hooks/useResizablePane.ts` — remplace 6 duplications de la logique
   de redimensionnement à la souris.
5. Modules `#[cfg(test)]` ajoutés à `port_forward.rs` (`socks_reply`) et
   `ssh.rs` (`identity_of`/`label_of`/`mismatch_error`/`ensure_success`).
6. `src/hooks/useNotifications.ts` — extrait `status`/`notifications` d'
   `App.tsx`.
7. `src/lib/tabPersistence.test.ts` (5 tests) + durcissement `loadTabs`
   (`Array.isArray` avant de faire confiance au JSON parsé).

**Piège rencontré en écrivant les tests `tabPersistence.test.ts`** :
l'environnement vitest du projet est `"node"`, pas `jsdom` — aucun
`localStorage` global. Stub `MemoryStorage` minimal posé sur
`globalThis.localStorage` plutôt qu'ajouter `jsdom` comme dépendance.

**Constats non corrigés cette session-là, corrigés le 2026-07-20 (voir
plus bas) ou encore ouverts** :
- `core/src/transfer.rs:228` (`copy_dir`) et
  `commands/keys.rs:15-23` (`resolve_key_content`) — blocages tokio non
  couverts par le fix du 2026-07-12. → corrigés le 2026-07-18 (points 2/3
  ci-dessus).
- `core/src/ssh.rs` (0 test/544 lignes) et `core/src/port_forward.rs`
  (0 test/264 lignes) → tests ajoutés le 2026-07-18 (point 5).
- Un seul fichier de test dans tout `src/` frontend à cette date
  (`lineBuffer.test.ts`) pour ~11 250 lignes — `operations.ts`,
  `ghostText.ts`, `tabPersistence.ts` non couverts. `tabPersistence.ts`
  couvert le 2026-07-18 (point 7) ; les deux autres restent ouverts.
- `rdp-sidecar` jamais testé en CI (build+lint mais pas `cargo test`), job
  `frontend` sans `npm run test` automatique, aucun `timeout-minutes`, pas
  de job macOS, aucun ESLint. → **les trois derniers ✅ faits le
  2026-07-20** (voir section suivante).
- Duplication de la logique de redimensionnement à la souris (6 fois, pas
  4 comme noté lors de l'ajout des poignées `FleetTab.tsx`) → fixé le
  2026-07-18 (point 4).
- `connect_terminal`/`connect_docker_exec` dupliquaient presque mot pour mot
  leur séquence de câblage → fixé le 2026-07-20 (`register_shell_session`).
- `App.tsx` : 942 lignes, 28 `useState`, 11 `useEffect`, 0 `useMemo` à cette
  date → allégé à 605 lignes le 2026-07-20.
- Deux artefacts de design à la racine du repo (`gui-termius Prototype
  Connexions (standalone).html`, `Redesign gui-termius.pdf`) → déplacés vers
  `docs/design/` le 2026-07-20.

**Point de confiance noté, pas un bug, toujours d'actualité** : importer un
`workspace.json` externe (`export.rs`) peut ramener des `startup_snippets`
qui s'exécutent automatiquement à la prochaine connexion sur l'hôte importé
— pas une injection (le shell-quoting est correct), mais un fichier importé
non fiable peut faire exécuter une commande sans confirmation explicite au
moment de l'import.

### Suite du 2026-07-20 : ESLint, CI macOS, factorisation, canal binaire

Trois commits successifs le même jour, à la demande explicite de
l'utilisateur (« on voit s'il y a des choses à améliorer » puis « on passe à
la suite : dette technique »).

**1. ESLint + job CI macOS + allègement d'`App.tsx`** — repris depuis un WIP
non committé trouvé en début de session. `eslint.config.js`
(`typescript-eslint` + `eslint-plugin-react-hooks`), `npm run lint` ajouté
au job `frontend` de `ci.yml`. Nouveau job `core-macos` (clippy + test de
`termius-core`/`rdp-sidecar` sur `macos-latest`, pas de build Tauri complet —
`release.yml` ne shippe toujours pas macOS). `App.tsx` 942 → 605 lignes via
`src/hooks/useTabs.ts` + `src/hooks/useBroadcast.ts` +
`src/lib/runOnTerminalHandle.ts`.

**2. Factorisation `connect_terminal`/`connect_docker_exec` +
`timeout-minutes` CI + rangement fichiers de design.**
`register_shell_session` (`pub(crate) async fn` dans `commands/terminal.rs`) :
bridge de sortie, replay des startup snippets/env vars, insertion dans
`state.terminals` — la queue commune aux deux backends. `timeout-minutes`
ajouté aux 4 jobs de `ci.yml` (20/20/30/15 min) et au job de `release.yml`
(60 min).

**3. Canal binaire pour `terminal-data`** — voir la section dédiée plus
haut.

**Vérifié pour l'ensemble de cette suite** : clippy propre (racine +
`rdp-sidecar`), `cargo test -p termius-core -p guiterm` (148 + 4 tests)
vert, `tsc --noEmit` propre, `npm run lint` propre (4 warnings
pré-existants, 0 erreur), `vitest run` (24 tests) vert, `e2e-run.mjs` vert
avec le nouveau scénario Ctrl+T. Binaire Windows natif release reconstruit
et relancé pour test utilisateur.

## Client SQL (MySQL/PostgreSQL) (2026-07-21)

Grande fonctionnalité ajoutée sur demande explicite : arborescence de
schéma + panneau d'exécution de requêtes pour MySQL/PostgreSQL, avec deux
modes de connexion (directe, ou tunnelée via un hôte SSH enregistré). Quatre
décisions de conception tranchées avec l'utilisateur via `AskUserQuestion`
avant tout code (mode de connexion, emplacement UI, moteurs v1, éditeur) —
toutes dans le sens recommandé.

### Dépendance `sqlx` — vérifiée avant d'écrire une ligne de code métier

Même discipline que pour `kube`/`k8s-openapi` en son temps (voir la section
K8s exec plus haut) : `sqlx = { features = ["any", "postgres", "mysql",
"tls-rustls", ...] }` ajouté à `core/Cargo.toml` à titre de sonde, `cargo
check -p termius-core` lancé tel quel avant d'écrire quoi que ce soit
d'autre. **Résolution propre** — un seul `ecdsa`/`rustls` dans tout le
graphe, réutilisant les versions déjà présentes via `russh`/`kube`/
`reqwest`. Aucun conflit façon `ironrdp-connector`/`picky` : `core/src/sql.rs`
vit donc directement dans `core/`, pas de workspace/process séparé comme
pour RDP.

### Modèle de données : `SqlConnection`, volontairement pas un `HostKind`

`core/src/model.rs` : `SqlConnection` (id, label, engine, `tunnel_host_id:
Option<HostId>`, address, port, username, database, group_id, tags) —
entité de premier niveau sur `Workspace` (`sql_connections: Vec<SqlConnection>`,
`#[serde(default)]`, testé pour la compat ascendante comme `keychain`/
`custom_icons` en leur temps), **pas** une nouvelle variante de `HostKind`.
Raison : contrairement à SSH/Docker exec/K8s exec/RDP, une connexion SQL
n'a pas de shell et n'est pas une cible de flotte — l'intégrer à `HostKind`
aurait forcé fleet.rs/adaptive.rs/tabPersistence.ts/etc. à gérer un cas
« ce type n'a pas de shell » de plus. Elle peut quand même *référencer* un
`Host` SSH existant via `tunnel_host_id`, purement pour le tunnel — un
simple champ optionnel, pas un couplage structurel.

### Deux modes de connexion, un seul mécanisme de tunnel éphémère

Décision utilisateur : les deux modes (direct, ou tunnelé via un hôte SSH
enregistré), au choix par connexion — pas l'un ou l'autre en dur. Le tunnel
n'est **jamais persisté** ni visible dans le panneau Tunnels :
`core::port_forward::start(connection, forward)` accepte déjà un
`PortForward` construit à la volée sans jamais toucher
`workspace.port_forwards` — juste jamais exploité ainsi avant (le seul
appelant existant, `commands::forward::start_forward`, va chercher son
`PortForward` dans le workspace en premier). `core::sql::connect` construit
un `PortForward` en mémoire avec `bind_port: 0` (port éphémère choisi par
l'OS) et le passe directement à `port_forward::start`.

**Piège réel trouvé en lisant `port_forward.rs`** : `TcpListener::bind` avec
`bind_port: 0` fonctionne très bien, mais `start_local` ne remontait jamais
le port réellement choisi par l'OS — `ActiveForward` ne stockait que la
config *demandée*, jamais `listener.local_addr()`. Sans ce port, impossible
de savoir où dialer ensuite. Fix : nouveau champ `ActiveForward.bound_addr:
Option<SocketAddr>`, capturé juste après le `bind` dans `start_local` (et,
par cohérence, `start_dynamic` — `start_remote` n'a pas de listener local à
rapporter), exposé via `ActiveForward::bound_addr()`. Testé pour de vrai
contre un `sshd` réel (`core/tests/sftp_and_forward_integration.rs`,
`local_forward_with_ephemeral_bind_port_reports_the_bound_port` — bind sur
le port 0, vérifie que le port rapporté n'est pas 0, s'y connecte
réellement et fait un aller-retour de données à travers le tunnel).

### Secrets : nouvelle variante de `SecretKind`, pas un nouveau mécanisme

`vault::SecretKind::SqlPassword` (suffixe `"sql-password"`) — les fonctions
existantes `vault::store/load/delete(host_id: HostId, kind, ...)`
fonctionnent sans changement pour une `SqlConnectionId` puisque les deux
types sont de simples alias de `Uuid` et que la clé n'est jamais qu'un
`{uuid}:{suffixe}` — exactement le raisonnement déjà identifié par
l'exploration préalable du code (`vault.rs`'s `global_key`/
`store_anthropic_api_key` étant le précédent le plus proche pour un secret
qui n'appartient pas littéralement à un `Host`).

### Décodage générique des résultats de requête — vérifié dans les sources vendues

Le point le plus risqué de toute l'implémentation : décoder une ligne de
résultat *sans connaître à l'avance* le type de chaque colonne (le pilote
`sqlx::Any` doit marcher aussi bien pour MySQL que PostgreSQL). Plutôt que
de deviner, lecture des sources vendues de `sqlx-core-0.8.6/src/any/{type_info,row,value}.rs` :
`AnyTypeInfoKind` est un jeu **fermé** de 9 variantes (`Null`/`Bool`/
`SmallInt`/`Integer`/`BigInt`/`Real`/`Double`/`Text`/`Blob`) — tous les
types natifs de chaque moteur sont normalisés vers ce petit ensemble par le
pilote lui-même. `core::sql::decode_value` bascule sur
`column.type_info().kind()` et appelle `row.try_get::<Option<T>, _>(i)`
pour le type correspondant (jamais les champs `#[doc(hidden)]`
`AnyValue`/`AnyValueKind` internes, uniquement l'API publique documentée
`Row`/`Column`/`TypeInfo`) — `Option<T>` gère nativement les NULL quel que
soit le type déclaré de la colonne. Un décodage qui échoue malgré tout
(valeur qui ne rentre pas dans le type annoncé) retombe sur `null` JSON
plutôt que de faire échouer toute la requête — perdre une cellule vaut
mieux que perdre tout le résultat.

**URL de connexion via `url::Url`, jamais `format!`** — un nom d'utilisateur/
mot de passe contenant `@`/`:`/`/`/`%` casserait silencieusement une URL
construite à la main (ces caractères seraient interprétés comme de la
structure d'URL). `core::sql::build_url` utilise les setters de `url::Url`
(`set_username`/`set_password`/`set_host`/`set_port`), qui percent-encodent
correctement — testé unitairement avec un mot de passe contenant
littéralement `@`, `:` et `/`, vérifiant que le round-trip
stringify→re-parse récupère les valeurs exactes.

**Cap de lignes appliqué en flux, pas après coup** — même discipline que le
fix `k8s_pane.rs` de la session précédente (cap de téléchargement en flux
plutôt qu'après bufferisation complète, voir plus haut) : `execute_query`
utilise `sqlx::query(sql).fetch(&pool)` (un `Stream`, via
`futures_util::TryStreamExt`) et s'arrête dès que `MAX_RESULT_ROWS` (5000)
lignes sont atteintes, plutôt que `fetch_all` qui aurait tout bufferisé
avant de tronquer.

### Deux limitations connues, actées sciemment

- **Pas de compte « N lignes affectées » pour INSERT/UPDATE/DELETE/DDL.**
  `execute_query` utilise la même primitive (`fetch`) pour `SELECT` et pour
  les instructions mutantes plutôt que d'appeler `execute()` séparément
  pour obtenir ce compte — appeler les deux aurait exécuté une instruction
  mutante **deux fois**, un risque jugé bien pire que l'absence de ce
  compte. Une instruction mutante retourne simplement zéro ligne (`columns:
  []`), affiché comme « requête exécutée » côté UI plutôt qu'un faux « 0
  ligne affectée » trompeur.
- **`list_columns` ne rapporte ni clé primaire ni index** — seulement nom/
  type/nullabilité, via une requête `information_schema.columns` strictement
  portable entre les deux moteurs. La détection de clé primaire aurait
  demandé une jointure différente par moteur (MySQL : `key_column_usage`
  filtré sur `constraint_name = 'PRIMARY'` ; PostgreSQL : jointure via
  `table_constraints` faute de nom de contrainte prévisible) — complexité
  et risque jugés disproportionnés pour une first version sans base réelle
  contre laquelle vérifier la jointure.

### MySQL vs PostgreSQL : bases vs schémas, assumé plutôt que masqué

`list_schemas` sert un seul niveau d'arborescence aux deux moteurs pour une
raison différente selon le moteur, documentée dans le doc-comment du module
plutôt que laissée implicite : MySQL peut lister/changer de base sans se
reconnecter (chaque requête `information_schema` est déjà qualifiée par nom
de base) ; PostgreSQL reste connecté à **une seule** base fixée à la
connexion — il n'y a donc rien à « lister » au niveau serveur qui soit
réellement navigable sans reconnexion, seuls les schémas *à l'intérieur* de
cette base le sont. Plutôt que de fabriquer une fausse notion uniforme de
« bases de données », les deux notions partagent le même niveau d'arbre
parce que c'est le même *grain de navigation* pour chaque moteur, pas parce
que ce sont le même concept.

### Frontend : nouvelle section dédiée, pas un `HostKind` de plus

Décision utilisateur : section « Bases de données » séparée du panneau
Hôtes (recommandé, pour les mêmes raisons que la décision « pas un
`HostKind` » côté backend). `Sidebar.tsx` gagne un 7e panneau (`"database"`,
lazy-loadé comme tous les autres panneaux sauf Hôtes depuis le chantier de
découpage du bundle) → **`SqlConnectionsPanel.tsx`** (liste + formulaire
inline, même forme que `TunnelsPanel.tsx` — plus simple qu'une page de
formulaire séparée façon `HostForm.tsx`, suffisant pour le nombre de champs
en jeu). Un nouveau type de tab `"sql"` dans `TabMeta` (`sqlConnectionId`,
pas `hostId`) ouvre **`SqlTab.tsx`** (lazy-loadé comme `RdpTab`/
`TransferTab`/`FleetTab`) : arbre schéma/tables/colonnes à gauche
(redimensionnable via `useResizablePane`, même hook que `TransferTab.tsx`),
éditeur `<textarea>` + résultats à droite (Ctrl+Entrée pour exécuter, zone
de texte simple sans coloration syntaxique — décision utilisateur, cohérent
avec l'éditeur DSL adaptatif existant, zéro nouvelle dépendance frontend).
Cliquer sur un nom de table insère un `SELECT * FROM <schema>.<table> LIMIT
100;` dans l'éditeur, un raccourci pratique plutôt qu'une fonctionnalité
demandée.

**`SqlTab` ne prend pas de prop `isActive`** — contrairement à `TerminalTab`/
`RdpTab` (qui en ont besoin pour xterm/le canvas), `SqlTab` n'a rien
d'équivalent à redessiner selon la visibilité — même choix déjà fait pour
`TransferTab`/`FleetTab`. La session reste ouverte tant que l'onglet reste
monté (masqué en CSS quand inactif, comme tous les autres onglets) ; elle ne
se ferme (`closeSqlSession`) qu'au vrai démontage, donc à la fermeture de
l'onglet.

**Piège de narrowing TypeScript trouvé en ajoutant la 5ᵉ variante à
`TabMeta`** : `useTabs.ts`'s logique de restauration d'onglets excluait déjà
`"local-terminal"` puis traitait tout le reste comme
`"terminal"|"transfer"|"rdp-view"` avec un `hostId` — ça « marchait » par
accident pour `"fleet"` (pas de `hostId`, donc le check `if (!p.hostId...)
return []` l'excluait quand même) mais l'ajout de `"sql"` (qui a lui aussi
`sqlConnectionId` requis à la place de `hostId`) a fait échouer la
vérification de type sur ce point précis — le littéral construit avait un
`kind` trop large pour matcher une seule variante du union `TabMeta`.
Corrigé en excluant explicitement `"fleet"`/`"sql"` avant le check
`hostId` plutôt que de compter sur l'effet de bord — les onglets flotte et
SQL ne se restaurent délibérément jamais au lancement (une session flotte
ou SQL est un instantané, pas quelque chose à rouvrir silencieusement),
maintenant vrai par construction plutôt que par accident.

### Vérifié / non vérifié

**Vérifié** : `cargo check -p termius-core` (sonde `sqlx` initiale, propre),
`cargo clippy --workspace --all-targets -- -D warnings` propre,
`cargo test -p termius-core -p guiterm` vert (160 tests unitaires — 8 de
plus que la session précédente : 3 `sql::tests` sur `build_url`
— percent-encoding, schéma/host/port/database, mot de passe absent/vide —
plus les tests d'intégration réels avec un vrai `sshd`, dont le nouveau test
de port éphémère), `npx tsc --noEmit` propre, `npm run lint` propre (4
warnings pré-existants, 0 nouveau), `npx vitest run` (48 tests, aucun
nouveau côté frontend — logique trop couplée à l'UI/Tauri pour être testée
isolément, comme `HostsPanel`/`TransferTab`/`TunnelsPanel` avant elle),
`npm run build` propre (nouveaux chunks lazy `SqlConnectionsPanel`/`SqlTab`
correctement séparés du bundle principal), `node scripts/e2e-run.mjs` vert
contre le binaire WSL/WebKitGTK fraîchement reconstruit (capture d'écran
réelle confirmant la nouvelle icône de section dans la barre latérale et le
chargement du vrai workspace de l'utilisateur). Binaire Windows natif
release reconstruit (les crates `sqlx-mysql`/`sqlx-postgres` compilent
proprement sous MSVC) et relancé pour test utilisateur.

**Non vérifié** : aucun serveur MySQL/PostgreSQL joignable dans cet
environnement de dev — même limitation que RDP/K8s/Docker-via-SSH en leur
temps. Rien de tout le chemin métier (connexion directe, connexion
tunnelée, introspection de schéma, exécution de requête, décodage de
lignes réelles) n'a tourné contre un vrai serveur. Points les plus
incertains à valider en premier, par ordre de risque : (1) le décodage
générique des types de colonnes (`decode_value`) contre de vraies données
— dérivé de la lecture attentive des sources vendues de `sqlx-core`, jamais
observé en pratique ; (2) l'introspection PostgreSQL (jointures
`information_schema` moins testées en pratique par l'auteur que
l'équivalent MySQL) ; (3) le tunnel SSH éphémère bout-en-bout avec une
vraie base de données au bout (le mécanisme de port forward lui-même est
testé pour de vrai avec un service echo, mais jamais avec un vrai serveur
SQL en bout de chaîne).
