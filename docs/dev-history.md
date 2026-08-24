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

### Curseur distant (2026-08-17)

Les événements `PointerBitmap`/`Hidden`/`Default` étaient ignorés côté
`rdp-sidecar` : l'aperçu s'utilisait sans voir son curseur. Ils sont désormais
relayés (trois nouveaux tags dans le cadrage binaire de `rdp-ipc`, puis un
événement Tauri `rdp-view-pointer`) et le curseur est peint en **CSS sur le
canvas** (`lib/rdpCursor.ts`), pas composité dans l'image.

**Pourquoi CSS plutôt que composité** : le serveur envoie une *forme*, la
position étant celle de la vraie souris — que seul le navigateur connaît. En
CSS, c'est lui qui dessine, à la position exacte du pointeur. Composité dans le
framebuffer, le curseur suivrait la position que le serveur *croit* correcte,
soit un aller-retour réseau complet derrière la main qui tient la souris.

**Conséquence assumée** : `PointerPosition` — le serveur qui *déplace* le
curseur — reste ignoré et le restera, une page web ne pouvant pas déplacer le
pointeur de l'OS. N'affecte que les applications qui recentrent le pointeur
elles-mêmes.

Deux pièges traités, tous deux invisibles à la compilation et silencieux au
runtime, car ils produisent une déclaration CSS que le navigateur **jette sans
rien dire** — donc *aucun* curseur, strictement pire que le curseur système
qu'on remplaçait : un bitmap plus grand que 128×128, et un hotspot hors de
l'image. Les deux retombent sur `default` (le second en serrant le hotspot).
Testés dans `lib/rdpCursor.test.ts`.

Pas de conversion d'alpha nulle part : `pointer_software_rendering: false` fait
décoder ironrdp en `PointerBitmapTarget::Accelerated`, c'est-à-dire du RGBA
**non prémultiplié** — exactement ce que `putImageData` attend. Basculer ce
drapeau assombrirait silencieusement tout bord semi-transparent.

### TLS : native-tls et non rustls (2026-08-20)

Un serveur Windows réel (un WSUS joignable par mstsc, pas par l'app) échouait
sur `passage en TLS : Une connexion existante a dû être fermée par l'hôte
distant. (os error 10054)`. Diagnostic mené en sondant le serveur, parce
qu'aucune hypothèse ne tenait toute seule :

1. Négociation X.224 : le serveur retient bien `CredSSP/NLA`. Ce n'est donc pas
   un refus de protocole.
2. Versions TLS acceptées, testées via SChannel : **1.2, 1.1, 1.0 oui, 1.3
   non** — et un refus de 1.3 se manifeste par exactement ce message. Fausse
   piste cependant : annoncer 1.3 *à côté* de 1.2 fonctionne parfaitement, le
   serveur redescend.
3. Rejeu du ClientHello exact de rustls (capturé dans ses traces) : refusé.
   Variantes sans TLS 1.3, et avec un `key_share` P-256 au lieu de X25519 :
   refusées aussi. Ni la version, ni la courbe.
4. **La suite négociée par SChannel est `ECDHE_RSA_AES256_CBC_SHA384`** —
   du **CBC**. Or rustls ne propose, par choix de conception, aucune suite CBC :
   il n'y a donc aucun recouvrement, et ce serveur ferme la connexion sans même
   envoyer d'alerte `handshake_failure`, d'où le `10054` nu.

**Piège rencontré pendant le diagnostic, à ne pas refaire** : les ClientHello
fabriqués à la main pour isoler une suite étaient **malformés** (longueur du
champ `signature_algorithms` fausse), et échouaient donc *quelle que soit* la
suite testée. Un serveur public a répondu `decode_error`, ce qui l'a révélé —
**valider l'instrument avant de lire ses mesures**, sans quoi on conclut
« aucune suite ne marche » alors qu'on n'a rien mesuré.

Correctif : `ironrdp-tls` passe de la feature `rustls` à `native-tls`. Sous
Windows cela revient à **SChannel**, la pile qu'utilise mstsc — un client RDP
doit joindre ce que le client RDP du système joint. Sous Linux cela devient
OpenSSL. Validé en relançant le vrai sidecar contre le serveur : TLS passe,
CredSSP/NTLM se déroule, et le serveur répond `0xc000006d`
(STATUS_LOGON_FAILURE) au faux mot de passe utilisé pour la sonde — soit
exactement le comportement attendu.

### Limites connues restantes

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

## Client SQL : `sqlx::Any` remplacé par des pools natifs, après un vrai test contre BPCE_DEV (2026-07-21)

Le point (1) ci-dessus était fondé — l'utilisateur a testé contre une vraie
connexion PostgreSQL de prod (`BPCE_DEV`, tunnelée via un hôte SSH) dès la
session suivante, et deux bugs réels sont apparus, dans cet ordre.

### Bug 1 — `information_schema.schemata.schema_name` : type `NAME`, pas `TEXT`

Premier symptôme : `open_sql_session` réussissait (connexion + tunnel + auth
OK), mais `list_sql_schemas` échouait juste après avec `error in Any driver
mapping: Any driver does not support the Postgres type PgTypeInfo(Name)` —
et `SqlTab.tsx` chaînait les deux appels sous un seul `.catch`, donc l'UI
affichait « Impossible de se connecter » alors que la connexion elle-même
marchait. `schema_name`/`table_name`/`column_name` dans `information_schema`
sont du type `sql_identifier`, un domaine basé sur le type interne `NAME` —
pas `TEXT`. Fix ponctuel (temporaire, remplacé par le bug 2 ci-dessous) :
caster ces trois colonnes en `::text` dans les requêtes d'introspection.

### Bug 2 — plus grave : `NUMERIC`/`TIMESTAMP(TZ)`/`UUID`/`JSON(B)` cassent `execute_query` en entier

Pour aller plus loin, un vrai PostgreSQL de test a été monté sur le WSL de
l'utilisateur (`sudo apt-get install postgresql`, tunnelé via son hôte SSH
`ubuntu` déjà enregistré dans l'app — voir `core/examples/sql_wsl_smoke.rs`
ci-dessous) avec des tables représentatives (montants `NUMERIC`, dates
`TIMESTAMP`/`TIMESTAMPTZ`, `UUID`, `JSONB`, tableau `text[]`). Résultat :
**toute colonne d'un de ces types fait échouer `execute_query` en entier**,
pas seulement décoder à `null` comme documenté. Cause : `AnyTypeInfoKind`
(le jeu de types que le pilote `Any` sait produire) est fermé à 9 variantes
(`Null`/`Bool`/`SmallInt`/`Integer`/`BigInt`/`Real`/`Double`/`Text`/`Blob`) —
`NUMERIC`/`TIMESTAMP(TZ)`/`UUID`/`JSON(B)` n'y ont *aucune* représentation.
La conversion de la ligne brute vers `AnyRow` échoue donc avant même que
`decode_value` tourne — ce n'est pas le cas « décodage cellule par cellule
qui échoue » que le fallback `null` de la session précédente avait anticipé
et pouvait couvrir, c'est un échec plus tôt dans le pipeline qui emporte
toute la requête. Sévère en pratique : `NUMERIC`/`TIMESTAMP` sont parmi les
types de colonnes les plus courants qui existent (montants, dates) — la
session précédente avait identifié ce point comme le plus risqué à valider
en premier, mais n'avait pas anticipé qu'un type puisse être *absent* du
jeu fermé plutôt que simplement mal décodé pour une valeur donnée.

**Fix** : `core::sql::SqlPool`, un enum (`Postgres(PgPool)`/`Mysql(MySqlPool)`)
remplaçant `AnyPool` partout — plus de driver générique. `decode_pg_value`/
`decode_mysql_value` décodent en essayant des types Rust candidats dans
l'ordre, gardant le premier qui type-check *et* décode (`NUMERIC` →
`rust_decimal::Decimal` → **string**, jamais `f64` : un montant arrondi
silencieusement par une conversion flottante serait pire qu'affiché en
texte ; `TIMESTAMP(TZ)`/`DATE`/`TIME` → `chrono`, en string ISO ; `UUID` →
string ; `JSON(B)` → `serde_json::Value` natif, pas re-stringifié).

**Piège MySQL découvert en lisant les sources vendues** (même discipline
que pour PostgreSQL en son temps — `sqlx-mysql-0.8.6/src/types/
{bytes,str,json,bool}.rs`) : contrairement à PostgreSQL où chaque type a un
OID exact et les vérifications de compatibilité ne se chevauchent jamais,
MySQL vérifie par *famille* de type protocole. `Vec<u8>` accepte n'importe
quelle colonne texte-ou-blob **qu'elle soit binaire ou non** ; `String`
exige en plus l'absence du flag binaire. Essayer `Vec<u8>` avant `String`
aurait donc affiché **toute colonne texte ordinaire en hexadécimal**.
Ordre retenu : `String` avant `Vec<u8>` (ne laisse que les vrais blobs
binaires atteindre `Vec<u8>`), `Json`/`JsonValue` après `String` (son check
accepte aussi tout ce qui est `String`/`Vec<u8>`-compatible, donc placé
après il n'attrape plus que les vraies colonnes `JSON`). Le cas `bool` est
volontairement **jamais tenté** côté MySQL : sa vérification de
compatibilité accepte n'importe quelle colonne entière (MySQL n'a pas de
vrai type booléen, `BOOLEAN` est un alias de `TINYINT(1)`, et le check ne
vérifie pas cette largeur `(1)`) — un vrai `INT`/`BIGINT` s'y serait laissé
décoder à tort en `true`/`false`.

### Outil de test réutilisable : `core/examples/sql_wsl_smoke.rs`

Sur le modèle de `docker_ssh_debug.rs` (déjà existant) : charge le vrai
`workspace.json`, trouve un hôte SSH enregistré par label (argv[1]), construit
une `SqlConnection` éphémère tunnelée à travers lui, stocke son mot de passe
dans le trousseau réel juste le temps du test puis le supprime. Lancé en
natif Windows, il lit le vrai mot de passe SSH de l'hôte depuis le
Gestionnaire d'identifiants Windows via `vault::load` — exactement comme le
ferait l'app, sans que l'agent voie jamais aucun secret. C'est ce qui a
permis de dérouler tout le chemin (tunnel → connexion → introspection →
requête) contre un vrai serveur sans avoir à automatiser la fenêtre
WebView2 (aucun outil de ce genre disponible). À garder pour la prochaine
fois qu'un point du client SQL doit être vérifié en conditions réelles —
usage : `cargo run --example sql_wsl_smoke -- <label-hôte-ssh> <mot-de-passe-pg> <base>`.

## Redis dans le client BDD (2026-07-24)

Nouvelle connexion Redis dans le même panneau et la même entité que les
connexions SQL (`SqlConnection` + `SqlEngine::Redis`), mais rendue par un
composant dédié `RedisTab` plutôt qu'une branche de `SqlTab` : une base
clé-valeur n'a ni arborescence de tables ni langage de requête SQL à
parcourir. Même raisonnement que le `RdpTab` séparé de `TerminalTab`.

Côté `core/src/redis_client.rs` :

- Connexion directe ou via le même tunnel SSH éphémère que `core::sql`, mot
  de passe dans le même trousseau (`SecretKind::SqlPassword` réutilisé, pas
  une nouvelle variante).
- Parcours de clés **borné** : boucle `SCAN` par lots, jamais un `KEYS *`
  bloquant — sur une base de production, `KEYS *` fige le serveur le temps du
  parcours.
- Lecture de valeur type-aware et bornée (string/hash/list/set/zset), avec
  repli explicite « non pris en charge » pour les streams et les types de
  module, plus le TTL.
- Console de commandes brutes : tokenizer avec support des guillemets,
  **aucune liste noire** — cohérent avec l'onglet Query SQL, qui n'interdit
  pas non plus le `DROP`. Rafraîchissement ciblé de la clé affichée après une
  commande qui la modifie.

**Vérifié en conditions réelles** contre un vrai serveur Redis en Docker
(`core/examples/redis_wsl_smoke.rs`, sur le modèle de `sql_wsl_smoke.rs`) :
tous les types de valeurs, TTL, recherche par motif, et les trois cas de la
console (lecture, écriture, erreur).

## Mutualisation des connexions SSH — `core/src/ssh_pool.rs` (2026-07-26)

**Le problème.** Chaque fonctionnalité appelait `ssh::connect` pour son
compte : onglet terminal, panneau de transfert, tunnel, session SQL/Redis
tunnelée, run de flotte, collecte de facts, déploiement de clé. Ouvrir un
terminal, un transfert et un tunnel sur le même hôte, c'était donc trois
connexions TCP, trois échanges de clés, trois authentifications et trois
vérifications `known_hosts` contre le même serveur — et le triple encore à
travers deux bastions, chaque saut étant recomposé. SSH multiplexe les canaux
nativement : ces poignées de main n'achetaient rien. C'est exactement ce que
résout `ControlMaster` côté OpenSSH.

**La forme retenue.** `ssh_pool::acquire` rend un `SshLease` qui déréférence
vers une `Connection` partagée.

**Pourquoi un débordement plutôt qu'une seule connexion par hôte.**
`MaxSessions` de sshd (10 par défaut) plafonne le nombre de canaux
shell/exec/subsystem d'une *même* connexion. Multiplexer sans limite aurait
transformé « le 11ᵉ onglet sur cet hôte » de « marche » en « échoue » — une
régression pour les utilisateurs les plus chargés, précisément ceux que
l'optimisation vise. D'où `MAX_LEASES_PER_CONNECTION = 8`, délibérément sous
`MaxSessions` : les port forwards sont loués ici aussi mais ouvrent des canaux
`direct-tcpip`, que `MaxSessions` ne compte **pas** — la marge absorbe cette
approximation.

**Durée de vie.** Le pool ne retient que des `Weak`. Une connexion vit tant
qu'au moins un bail la tient et se ferme au dernier — exactement la durée de
vie d'avant, donc fermer tous les onglets d'un hôte ferme toujours sa
connexion au lieu de laisser une connexion inactive garée dans un cache.

**Conséquence non évidente sur `fleet.rs`** : il ne déconnecte plus
explicitement après un run. La connexion peut désormais être partagée avec un
onglet ouvert, et la couper tuerait une session en cours d'utilisation. Le
drop du bail s'en charge, et seulement si plus personne ne l'utilise.

**Exception documentée** : `docker::connect_for_host` reste volontairement
hors du pool — chaque requête HTTP y ouvre son propre canal exec et le
connecteur est cloné librement par hyper, donc le modèle « un bail ≈ un
canal » n'y tient pas.

Prérequis de l'auth interactive (plus bas) : sans mutualisation, un code à
usage unique aurait été redemandé à chaque nouvel onglet.

## `EngineConfig` : typer les connexions BDD par moteur (2026-07-26)

`SqlConnection` était un struct **plat** portant les champs des cinq moteurs
côte à côte, chacun documenté par les moteurs auxquels il s'appliquait
(« Sqlite uniquement », « 0 pour Sqlite », « inutilisé pour ce moteur »). Le
type autorisait donc des connexions impossibles — une SQLite avec un port, une
MongoDB avec une adresse — et `sql.rs` portait six `unreachable!()` dont
l'unique rôle était d'affirmer que ces combinaisons n'arrivaient pas.

Remplacé par un enum à tag interne sur `engine`, aplati dans la structure :
**le JSON sur disque est identique**, et `SqlEngineConfig` en donne le miroir
TypeScript en union discriminée, donc le frontend ne peut plus lire `port` sur
une connexion SQLite. Les six `unreachable!()` deviennent des branches réelles
d'un `match`.

**Le test de compatibilité a immédiatement attrapé un vrai bug.** Les tests
désérialisent l'ancienne forme à plat *écrite à la main* (un aller-retour
Rust→Rust ne prouverait rien sur la casse réelle du JSON) :
`#[serde(default)]` ne couvre pas un `null` explicite, seulement un champ
**absent** — or l'ancien format écrivait `"path": null`. Sans le
`deserialize_with` ajouté ici, un `workspace.json` existant devenait
illisible, donc mis de côté au démarrage, et **toutes les connexions
enregistrées disparaissaient de l'interface**. À garder en tête pour toute
évolution de schéma : tester avec du JSON écrit à la main, pas avec un
roundtrip.

## MongoDB : backend livré, onglet frontend jamais écrit (2026-07-26, constaté le 2026-07-27)

Repris sur le modèle `EngineConfig` ci-dessus. `core/src/mongo_client.rs`
connecte via une **chaîne de connexion complète** (`mongodb://` ou
`mongodb+srv://`, typiquement collée depuis Atlas) plutôt que les champs
discrets adresse/port que partagent MySQL/PostgreSQL/Redis — d'où sa propre
variante d'`EngineConfig`. Seule une chaîne `mongodb://` mono-hôte peut être
tunnelée à travers un forward TCP ; `mongodb+srv://` (résolution DNS,
multi-hôtes) est rejetée pour le tunnel, vérifié à la saisie.

Le crate `mongodb` se résout proprement dans le graphe de dépendances de ce
workspace (une seule version de `chrono`/`rustls`/`time`/`hickory-resolver`,
aucun pin exact conflictuel comme le `picky` d'`ironrdp-connector`) : pas
besoin d'un sidecar séparé, contrairement au RDP. Détails de feature flags
dans les commentaires de `core/Cargo.toml` (`bson-3`/`compat-3-3-0`
obligatoires, et une ligne `bson` **directe** uniquement pour unifier dans
`serde_json-1`).

**Ce qui manquait, découvert le 2026-07-27** : `MongoTab.tsx` n'avait jamais
été écrit. Tout le reste était en place et complet — `mongo_client.rs`,
`commands/mongo.rs`, les bindings `api.ts`, les types TS, et même
`core/examples/mongo_wsl_smoke.rs`. Quatre commentaires (`types.ts`,
`model.rs`, `mongo_client.rs`, `mongo_wsl_smoke.rs`) désignaient un composant
`MongoTab` qui n'existait pas.

Conséquence utilisateur : le formulaire **proposait** MongoDB et savait
enregistrer la connexion, mais `App.tsx` routait tout ce qui n'est pas Redis
vers `SqlTab` — ouvrir une connexion MongoDB appelait donc `sql::connect`, qui
répond « ne s'applique pas à MongoDB — utiliser `mongo_client::connect` » et
affichait un échec de connexion. Pas de panique, mais la fonctionnalité était
inatteignable, **alors que le CHANGELOG 2.4.0 l'annonçait comme livrée**.

Leçon de méthode, à retenir au-delà de MongoDB : rien dans l'outillage ne
pouvait attraper ça. `cargo check`, clippy `-D warnings`, 218 tests Rust,
`tsc`, les tests frontend et l'E2E passaient tous au vert — la branche
manquante d'un `if` sur `connection.engine` n'est un trou pour aucun d'entre
eux. Il n'existait aucun test qui affirme que **chaque moteur proposé dans le
formulaire a un composant de rendu**. C'est le type de test qui manquait, pas
l'effort de vérification. D'où les trois filets posés le même jour (voir la
section « Définition de « fini » » de `CLAUDE.md`).

### `MongoTab.tsx` écrit — la lacune est refermée (2026-07-27)

Arborescence bases → collections à gauche, deux onglets à droite, sur le même
cycle de vie connect-au-montage/close-au-démontage que `SqlTab`/`RedisTab` :

- **« Données »** — `find` sans filtre sur la collection cliquée.
- **« Requête »** — même appel avec un filtre JSON saisi dans une zone de
  texte multi-ligne (Ctrl+Entrée exécute ; Entrée seule insère un saut de
  ligne, contrairement à la console Redis mono-ligne, un filtre JSON
  s'écrivant couramment sur plusieurs lignes). Un filtre vide est envoyé en
  `null`, que le backend traite exactement comme l'onglet Données.

Les deux panneaux gardent leur résultat séparément : basculer de l'un à
l'autre ne jette pas celui qu'on quitte. Les documents sont affichés en JSON
étendu relaxé tel que le backend le renvoie (`$oid`/`$date` uniquement là où
JSON ne peut pas représenter le type BSON), sans réinterprétation côté
frontend — c'est ce que montrent aussi `mongosh` et Compass. Les collections
d'une base sont chargées une fois puis conservées : replier/déplier ne
requête pas un serveur potentiellement distant et tunnelé.

Toujours **pas de « Structure » ni de « Console »**, choix de périmètre
d'origine (voir plus haut), pas un oubli.

**Non vérifié** : jamais exécuté contre un vrai serveur MongoDB — aucun n'est
accessible dans cet environnement de dev, même limitation que le client SQL à
ses débuts. `core/examples/mongo_wsl_smoke.rs` existe pour ça, sur le modèle
de `sql_wsl_smoke.rs`/`redis_wsl_smoke.rs`. Le câblage moteur → composant est
lui couvert par `src/components/SqlConnectionTab.test.ts`.

## Frappes du terminal en binaire, au lieu de base64 (2026-07-27)

Symétrique de la section « Canal binaire `tauri::ipc::Channel` pour
`terminal-data` » plus haut, mais dans l'autre sens : la *sortie* du terminal
évitait déjà toute conversion, l'entrée non.

L'écriture terminal est l'appel le plus fréquent de l'application — un par
frappe, plus un par morceau lors d'un collage. Chaque octet faisait trois
conversions : encodage base64 caractère par caractère en JS, sérialisation
JSON, puis décodage retour côté Rust — le tout avec ~33 % de volume en plus
sur le fil, pour une donnée qui était déjà un `Uint8Array`.

Passé à la forme « corps brut » d'`invoke` (`InvokeBody::Raw`), vérifiée dans
l'API des deux côtés avant d'être adoptée : `InvokeArgs` accepte bien un
`Uint8Array`, et `Request::body()` le rend tel quel. **Le corps étant la
charge utile, il ne reste plus d'objet JSON où loger l'identifiant de
session** : il passe par un en-tête, dont le nom est défini des deux côtés
avec un commentaire croisé pour qu'un renommage unilatéral saute aux yeux.

`bytesToBase64` disparaît, et avec elle le module `src-tauri/src/util.rs` dont
c'était l'unique raison d'être (`base64` reste dans les dépendances : le
coffre chiffré s'en sert).

**Vérifié** par l'E2E, qui est le test qui compte ici puisque le changement
porte sur le canal IPC lui-même : le scénario tape réellement des caractères
dans un terminal local et attend leur sortie. L'E2E local tourne sous
WebKitGTK — confirmation sous WebView2 faite ensuite en lançant le binaire
Windows release.

## Auth keyboard-interactive : MFA / code à usage unique (2026-07-27)

Dernière lacune protocole du client : les serveurs qui exigent un second
facteur utilisent keyboard-interactive (RFC 4256), que l'app ne savait pas
parler — ces hôtes étaient tout simplement inaccessibles.

**Pourquoi ça ne ressemble à aucune des trois autres méthodes.** Le serveur
n'accepte pas un identifiant fourni d'avance : il envoie une *série* de
questions (« Password: », puis « Verification code: »), chacune devant être
répondue avant qu'il dise si l'authentification réussit, et c'est lui qui
décide quand il en a assez. C'est donc la seule méthode qui ne peut pas se
résoudre depuis la configuration enregistrée — il faut un aller-retour avec
l'utilisateur **au milieu de la poignée de main**.

**Découpage.** `core` n'a ni interface ni dépendance Tauri : il décrit la
forme de la conversation (trait `Prompter` dans
`core/src/interactive_auth.rs`) et garde une instance de processus, même forme
de global ambiant que `vault` et `ssh_pool`, et pour la même raison —
`ssh::connect` est atteint depuis une dizaine d'appelants qui n'ont pas à
connaître le prompting. `src-tauri` installe une implémentation qui émet
l'événement `ssh-auth-prompt` et attend la réponse sur un oneshot. Sans
prompteur installé (tests, exemples), l'authentification échoue avec un
message clair plutôt que d'attendre indéfiniment une réponse qui ne viendra
jamais.

**La partie qui méritait des tests unitaires** : le mot de passe enregistré
répond automatiquement à la **première invite masquée du premier tour
seulement** (`autofilled_answers`). Les serveurs demandent le mot de passe
puis le second facteur — auto-répondre au second tour enverrait un mot de
passe périmé à la place du code, en consommant une des rares tentatives
autorisées, sans que l'utilisateur puisse comprendre pourquoi. Cinq tests
couvrent le cas normal, le tour OTP, un tour uniquement échoué, deux invites
masquées dans un même tour, et l'absence de mot de passe enregistré.

**Frontend** : les demandes sont mises en **file** plutôt que gardées une par
une — une opération de flotte ou une restauration d'onglets peut faire
authentifier plusieurs hôtes à la fois, chacun étant une poignée de main
bloquée. La modale rend les intitulés du serveur **tels quels** : c'est la
seule chose qui indique quel facteur est attendu, et la formulation varie d'un
déploiement à l'autre. Le champ est masqué ou non selon ce que dit le serveur
(`echo`) — un OTP est souvent envoyé avec `echo: true` puisqu'il est à usage
unique.

**Deux garde-fous** contre une connexion suspendue indéfiniment : un délai de
3 minutes côté Rust, et un bouton Annuler qui fait échouer cette
authentification tout de suite. Les réponses ne sont ni journalisées ni
persistées.

**Non vérifié** : jamais testé contre un vrai serveur MFA — le sshd des tests
d'intégration demanderait une configuration PAM dédiée. La logique de décision
est couverte par les tests unitaires ci-dessus, le reste est du câblage
vérifié par compilation, clippy et E2E.

## Panneau de transfert : colonnes, navigation, glisser-déposer, taille des dossiers, archivage (2026-08-21)

Cinq points remontés d'un coup après la 3.1.0, tous dans l'onglet de
transfert. Trois bugs et deux manques, mais un fil commun : ce qui n'était
vérifié par aucun test était exactement ce qui ne marchait pas.

**1. Colonnes désalignées.** L'en-tête et les lignes empilaient chacun leur
propre jeu de largeurs Tailwind (`w-32`, `w-12`, `w-14`) — mêmes chiffres,
mais l'en-tête sans `shrink-0` et les lignes portant *un nombre variable* de
boutons d'action (0 à 3 selon dossier/fichier/taille du fichier) alors que
l'en-tête n'en réservait qu'un. Une ligne sans bouton d'édition décalait donc
toutes ses colonnes par rapport à sa voisine. À quoi s'ajoutait une largeur
de date fixe (128 px) tandis que la police du panneau est réglable jusqu'à
20 px : au-delà de ~14 px, « 20/08/2026 14:32 » débordait sur *Type*, sans
`overflow-hidden` pour le retenir.

Corrigé par **une seule grille CSS partagée** par l'en-tête et les lignes
(`gridStyle`, calculée une fois dans `PaneView`), des largeurs **dérivées de
la taille de police**, et trois emplacements d'action de largeur fixe,
remplis ou vides. Les colonnes *Modifié* et *Type* disparaissent sous une
certaine largeur de panneau, mesurée par un `ResizeObserver` sur le panneau
lui-même — les points d'arrêt `sm:` de Tailwind regardent la fenêtre, qui est
large même quand le panneau ne l'est pas, donc le `hidden sm:block` d'avant
ne se déclenchait jamais.

**2. « Dossier parent » ramenait à la racine.** `parentPath` cherchait le
dernier `/` d'un chemin. Or le panneau local sous Windows ouvre sur
`C:\Users\glorin`, qui n'en contient aucun : la fonction rendait `/`, et
l'app listait la racine du disque. Même symptôme après un « Aller à » relatif
(le backend renvoyait le chemin tel quel comme `cwd`). Les manipulations de
chemin sont sorties dans `src/lib/panePath.ts` — fonctions pures, séparateur
déduit du chemin et non de la plateforme, jamais de remontée au-delà de la
racine — avec `panePath.test.ts` dont un test vérifie que chaque niveau du
fil d'Ariane est bien le parent du suivant.

**3. « Aller à » remplacé par « Rechercher ».** Le champ filtre le dossier
courant au fil de la frappe ; `Entrée` lance une recherche récursive sous le
dossier courant. La navigation directe qu'assurait « Aller à » est reprise
par un **fil d'Ariane cliquable** à la place du chemin en texte.

**4. Le glisser-déposer entre panneaux n'avait jamais marché** — il n'avait
en fait jamais été écrit : aucun `onDragStart` nulle part, seulement le dépôt
OS venu de l'Explorateur. Et l'écrire avec l'API HTML5 n'aurait rien donné :
le glisser-déposer OS de Tauri la neutralise pour toute la fenêtre sous
Windows (piège déjà documenté dans CLAUDE.md). Implémenté à la souris dans
`src/hooks/usePaneDrag.ts` : seuil de 5 px avant d'armer le geste,
`elementFromPoint` pour savoir quel panneau — et quel dossier — est sous le
curseur au lâcher, drapeau `justDragged` pour que le `click` que le
navigateur émet derrière n'ouvre pas le dossier de départ. Déposer sur un
dossier copie dedans ; relâcher dans son propre panneau hors d'un dossier ne
fait rien (le geste « finalement non »).

**5. Taille des dossiers et archivage** — `core/src/pane_ops.rs`. Les deux
posaient le même problème : avec les seules primitives de
`RemoteFileClient`, une somme de tailles coûte un aller-retour SFTP par
fichier, et archiver un dossier distant reviendrait à le rapatrier
entièrement pour le renvoyer compressé. Chaque opération s'exécute donc **du
côté où vivent les fichiers** : un petit script `sh` (`du`, `find`,
`tar`/`zip`) pour un panneau SSH/Docker/K8s, l'équivalent Rust pour le
panneau local (Windows n'a pas de `sh`). D'où le trait `ShellExec`, implémenté
par `SshShellExec` (un canal `exec` sur la connexion SSH qui porte déjà le
sous-système SFTP — pas de deuxième connexion) et par les clients Docker/K8s,
qui savaient déjà lancer un `sh -c` de cette forme pour lister un dossier. Le
panneau garde les deux vues du même objet (`Pane::exec` à côté de
`Pane::client`) : `Arc<dyn RemoteFileClient>` ne se re-transtype pas en
`Arc<dyn ShellExec>`, alors qu'à l'ouverture le type concret se coerce vers
les deux.

Choix assumés : la taille d'un dossier n'est calculée **qu'à la demande** (un
`du` complet par dossier, jamais lancé d'office sur un listing) ; `du -sb`
avec repli sur `du -sk` (busybox et les `du` BSD ignorent `-b`) ; l'archive
refuse d'écraser un fichier existant, ce que `zip` ferait pire qu'écraser —
il *ajoute* à l'archive déjà là ; les noms d'entrée sont préfixés `./` plutôt
que protégés par un `--` que busybox ne comprend pas toujours.

**Ce qui a été mis sous test, et pourquoi.** Le fil rouge de ce lot : chaque
bug corrigé était d'une catégorie qu'aucun outil du dépôt ne regardait.

- Les scripts `sh` ne sont pas du Rust : rien à la compilation ne dit s'ils
  tournent. `pane_ops.rs` les passe au `sh` de la machine (dash sous Ubuntu,
  POSIX strict, plus proche d'un busybox de conteneur que bash) avec les mêmes
  paramètres positionnels qu'en production, et compare au résultat de
  l'implémentation Rust locale. Y compris le nom de fichier qui commence par
  un tiret, le vrai piège du préfixe `./`.
- L'alignement des colonnes est de la mise en page : ni `tsc` ni vitest (pas
  de moteur de rendu) ne peuvent le voir. `scripts/visual-check-transfer-columns.mjs`
  monte un vrai `PaneView` dans Chromium (sans Tauri — le composant ne parle à
  `invoke` que par ses callbacks) et mesure la géométrie réelle des cellules à
  cinq combinaisons police × largeur.
- Un glisser-déposer est un geste : il se lit très bien et ne marche pas pour
  autant. `scripts/visual-check-transfer-dnd.mjs` presse, déplace et relâche
  vraiment la souris sur deux panneaux montés avec le hook de production.

Les deux contrôles Playwright tournent avec `npm run check:transfer`. Chacun
a été validé en réintroduisant temporairement le bug qu'il est censé attraper
(largeur de date fixe → colonne rognée signalée ; règle du même panneau
retirée → dépôt parasite signalé) : un test qui ne casse jamais ne prouve
rien.

## Sélection d'hôtes : arborescence et tags partout (2026-08-24)

**Le constat.** La barre latérale range les hôtes en dossiers récursifs et
affiche leurs tags depuis toujours. Aucun des **douze champs** où l'on choisit
un hôte ailleurs dans l'app ne le faisait : tous listaient `workspace.hosts`
à plat, dans l'ordre de stockage. Sur un workspace d'une trentaine de
machines, deux `api` rangées dans deux dossiers différents y sont
rigoureusement indiscernables — c'est ce que l'utilisateur a remonté, en
partant du sélecteur de source du mode transfert.

**Pourquoi un composant maison et pas un `<select>` amélioré.** Un `<option>`
natif ne contient que du texte : pas de pastille de tag, pas d'icône, pas
d'indentation fiable. `<optgroup>` ne s'imbrique pas, or les dossiers de ce
projet sont récursifs — un dossier dans un dossier n'a aucune représentation.
D'où `src/components/HostTreePicker.tsx`, en trois enveloppes autour d'un
corps unique :

- `HostTreeList` — recherche + arbre dossiers/hôtes + tags ;
- `HostTreePicker` — un bouton qui déploie cette liste en popup, positionnée
  en `fixed` calculé à l'ouverture (même mécanique que `GroupTreePicker`, pour
  ne pas être rognée par l'`overflow` d'un panneau parent) ;
- `HostTreeModal` — la même liste en boîte de dialogue, pour les parcours qui
  demandent l'hôte avant toute autre chose.

Le calcul de l'arbre **n'a pas été réécrit** : `buildHostTree`
(`src/lib/hostTree.ts`), extrait de `HostsPanel` lors d'un chantier
précédent, indexe déjà en une passe et compare déjà libellé, adresse,
utilisateur **et tags** — taper « eu-west » retrouvait donc les hôtes tagués
sans une ligne de plus.

**Les listes à cocher sont un autre problème.** La flotte et le diagnostic
réseau ne listent pas des hôtes mais des *cibles* : le terminal local, les
hôtes SSH, et surtout les conteneurs Docker et pods Kubernetes, qui viennent
d'un listing vivant et n'ont pas de `groupId` à eux — ils héritent de la
position de leur hôte relais. `buildHostTree` ne pouvait pas les classer.
D'où une seconde fonction pure, `src/lib/targetTree.ts`, sur une entrée
générique (`TargetLike`) plutôt que sur `Host`, qui rend une **liste plate de
lignes déjà ordonnées et indentées** (dossier / hôte relais / cible) — le
composant la parcourt exactement comme il parcourait `allTargets` avant,
aucune récursion dans le rendu. `FleetTargetInfo` a gagné un champ `hostId` :
l'information existait déjà dans `target`, mais sous une forme propre à
chaque variante. Les en-têtes portent les clés de tout leur sous-arbre, ce
qui donne gratuitement la case « tout le dossier » — impossible tant qu'un
dossier n'existait pas dans la liste.

**Un effet de bord côté SQL.** `RemoteSavePathPicker` recevait `hosts:
Host[]`, ce qui ne suffit plus (il faut les dossiers et les icônes
personnalisées). La chaîne `modules/sql.tsx` → `SqlConnectionTab` → `SqlTab`
→ `SqlExportPanel` est passée de `hosts` à `workspace` — un seul prop au lieu
de trois à enfiler, et c'est déjà ce que `SqliteRemoteFilePicker` recevait.

**La palette de commandes reste une liste** — c'est sa nature. Elle a gagné
le chemin de dossiers dans le libellé (« Se connecter — Prod › Web › api »,
via `groupPath`, ajouté à `hostTree.ts`) et un champ `keywords` non affiché
mais cherchable, qui porte les tags et l'adresse.

### Ce qui a été mis sous test, et pourquoi

Quatre filets, chacun pour une chose que les autres ne peuvent pas voir :

- `src/lib/targetTree.test.ts` et les cas `groupPath` de
  `src/lib/hostTree.test.ts` : le **calcul** de l'arbre — imbrication, clés de
  sous-arbre, recherche par tag, dossiers vidés qui disparaissent, cycles de
  `parentId` qui ne bouclent pas.
- `src/lib/hostPickers.test.ts` : le **retour en arrière**. Rien dans les
  types n'empêche le treizième champ d'être écrit à plat — un `<select>`
  d'`<option>` compile parfaitement. Un détecteur signale tout `<option>`
  produit par une boucle sur une liste d'hôtes, et un inventaire nommé exige
  que les douze fichiers repris continuent d'importer l'arborescence
  partagée. Le détecteur est lui-même vérifié sur l'extrait exact qu'il a
  servi à supprimer (contrôle anti-vacuité, comme `tauriCommands.test.ts`).
- `scripts/visual-check-host-picker.mjs` (`npm run check:hosts`) : le
  **rendu**. « L'arborescence est visible » est une affirmation sur des
  pixels — un enfant décalé vers la droite de son parent, une pastille qui a
  une largeur — et la liste ne se déploie qu'au clic. Playwright mesure les
  deux, plus la recherche par tag et le choix par identifiant entre deux
  homonymes. Validé en cassant volontairement l'indentation : les deux
  décalages manquants sont bien signalés.
- Scénario `runHostTreePickerScenario` dans `scripts/e2e-run.mjs` : le
  **chemin complet**. Les trois filets ci-dessus montent le composant avec
  des données fabriquées ; celui-ci crée un dossier puis un hôte tagué **par
  les vrais formulaires**, ouvre le champ hôte du formulaire de tunnel, et
  vérifie que le dossier est là, que l'hôte est rangé dedans, que son tag
  s'affiche et le retrouve, et que le choix s'applique. C'est la question que
  MongoDB avait ratée : un composant qui marche isolément mais que rien
  n'alimente.

**Deux pièges rencontrés en écrivant ce scénario**, tous deux dus au fait que
le workspace n'est relu qu'au montage de l'app (`App.tsx`,
`api.getWorkspace()` dans un `useEffect` sans dépendance) :

- créer le dossier ou l'hôte par un `invoke` direct ne les fait apparaître
  dans **aucun** champ — l'écriture réussit côté backend, React n'en sait
  rien. Tout doit passer par les formulaires, qui rendent un workspace frais ;
- la ligne d'un dossier porte son icône dans le même bouton que son nom
  (« 📁mon-dossier »), donc `textContent === nom` ne correspond jamais.

Et un piège corrigé au passage dans un scénario existant :
`runTunnelEditScenario` décidait « y a-t-il un hôte ? » avec
`document.querySelector("select")`. Le champ hôte n'étant plus un `<select>`,
ce sélecteur attrapait celui du *type* de tunnel — la réponse était donc oui
même sur un workspace vide. Il lit maintenant le workspace.

## Sessions persistantes (tmux) — tranche 1 (2026-08-24)

**Le manque.** `TerminalTab` reconnecte avec un repli exponentiel et écrit
« [reconnecté] », mais `ssh::open_shell` demandait un pty puis un shell : un
pty **neuf** à chaque fois. Le dossier courant, le `tail -f` en cours et la
commande à moitié tapée partaient avec le canal. `tabPersistence` le disait
sans détour — « never a live session id » —, et rien dans le dépôt ne parlait
tmux ni screen.

**Le principe, en une ligne.** `channel.exec(true, "tmux new-session -A -s
<clé>")` à la place de `request_shell`, sur une clé conservée avec l'onglet.
`open_shell` délègue désormais à `open_shell_with_command`, qui ne diffère que
par ce `match` : même canal, même demande de pty, même boucle de pompage —
donc le forward d'agent, le canal binaire de sortie, l'enregistrement
asciicast et le redimensionnement continuent de marcher sans rien savoir de
tmux.

### Cinq décisions, et pourquoi

- **Deux modes, pas trois.** `PersistentShellMode` vaut `Off` ou `Tmux`. Un
  mode « auto » qui voudrait dire « tmux s'il est là » serait exactement
  `Tmux`, déjà au conditionnel : un hôte sans tmux ouvre un shell ordinaire et
  le signale, il n'échoue pas.
- **Défaut `Off`, et ce n'est pas de la prudence de façade.** Un
  `#[serde(default)]` sur un champ de `Host` s'applique à *tous* les hôtes déjà
  écrits sur le disque de tous les utilisateurs — contrairement à
  `DEFAULT_PREFERENCES`, qui ne touche que les nouvelles installations. Un
  défaut `Tmux` aurait changé le comportement de chaque hôte existant à la
  mise à jour, en silence. Épinglé par
  `a_host_saved_before_persistent_sessions_loads_as_off`, qui désérialise un
  `Host` écrit à la main dans la forme d'un workspace 3.1.1.
- **Les commandes de démarrage ne sont rejouées qu'à la création.** C'est le
  point subtil de toute la tranche. `register_shell_session` *tape* les
  `export` et les snippets dans le shell ; sur un rattachement, elles
  repartiraient dans la session vivante, par-dessus ce qui est à l'écran. La
  distinction « ouvrir une connexion » ≠ « ouvrir un shell » n'existait pas
  tant que les deux étaient la même chose — d'où le drapeau `replay_startup`,
  faux dans exactement un cas.
- **Lister les sessions plutôt que `tmux has-session`.** `has-session -t nom`
  résout sa cible comme n'importe quelle cible tmux : nom exact d'abord, mais
  préfixe ou motif ensuite selon la version. Deux clés dont l'une préfixe
  l'autre suffiraient à répondre « oui » pour la mauvaise. Le sondage liste les
  noms (`list-sessions -F`) et compare en Rust — exact quelle que soit la
  version, et c'est déjà la liste dont la tranche 2 aura besoin. Un seul
  aller-retour, en lignes `CLÉ=valeur` comme `facts::PROBE`, donc indifférent
  au MOTD.
- **`-A` malgré le sondage.** `new-session -A` crée *ou* rattache selon ce qui
  existe au moment où il tourne. Le sondage ne décide donc pas de la connexion
  — seulement du rejeu des commandes de démarrage — et une session ouverte
  entre les deux est rattachée au lieu d'échouer.

**Ce que valide une clé qu'on génère soi-même.** `is_valid_session_key`
existe pour deux raisons : la clé fait l'aller-retour par le `localStorage` du
frontend, et **tmux interdit `.` et `:` dans un nom de session** (il les lit
comme les séparateurs `session:fenêtre.panneau`). Une clé qui en contient ne
produit pas une erreur franche mais une session au mauvais nom, introuvable
ensuite. Une clé invalide est remplacée, jamais refusée : le pire cas est une
session neuve, pas un terminal qui ne s'ouvre pas.

**Qui retient la clé.** Le backend la nomme, le frontend la retient : elle ne
vaut que si elle survit au processus, et l'onglet est déjà ce qui est persisté
d'un lancement à l'autre. D'où `TabMeta.sessionKey`, sa persistance dans
`tabPersistence`, et `rememberSessionKey` dans le contexte des modules —
volontairement étroit plutôt qu'un `updateTab` générique. Côté `TerminalTab`
la clé vit dans une `ref` et non dans les dépendances de l'effet : elle est
semée par la prop puis réécrite par la première connexion, et faire dépendre
l'effet de sa valeur détruirait le terminal qu'on est justement en train de
rattraper.

### Ce qui est sous test, et ce qui ne l'est pas

- `core/tests/persistent_shell_integration.rs` est **le** test qui prouve la
  fonctionnalité : vrai `sshd` (le harnais de `core/tests/common`) et vrai
  tmux, deux connexions successives, un dossier courant et une variable qui
  traversent l'intervalle. Un second test sert de témoin — un shell ordinaire
  ne garde rien —, sans quoi le premier pourrait passer pour une mauvaise
  raison. Validé en cassant `attach_command` : le scénario persistant échoue,
  le témoin reste vert. Ignoré proprement quand tmux manque : le sondage
  répond `NoTmux`, ce qui est le repli promis.
- Pour attendre, un motif et jamais un délai : `PR''ET` tapé en deux morceaux
  n'apparaît dans le flux que quand le shell l'a réellement imprimé — l'écho
  du pty, lui, montre les quotes. Un `sleep` calibré sur cette machine serait
  instable ailleurs.
- Le scénario e2e `runPersistentSessionScenario` couvre ce que le test
  d'intégration ne peut pas voir : que le réglage est **atteignable** dans le
  formulaire et qu'il fait l'aller-retour par `save_host`/`workspace.json`.
  C'est le trou par lequel MongoDB était parti. Validé en retirant l'affectation
  de `persistent_shell` dans `save_host` : l'e2e tombe sur « le réglage n'a pas
  fait l'aller-retour ». Il vérifie aussi que l'échec de connexion sur
  127.0.0.1:1 est bien un refus TCP et pas un `invalid args` — `connect_terminal`
  a gagné un argument, et une casse ratée s'y verrait là.
- **Pas testé** : le partage de session, le redimensionnement à plusieurs
  clients attachés, et le comportement d'un `screen` (non implémenté). La
  barre d'état tmux reste visible — c'est la tranche 5.

**La limite assumée de cette tranche : les sessions orphelines.** Fermer un
onglet lâche le canal, donc tmux détache — et c'est bien ce qu'on veut, sans
quoi fermer l'app tuerait tout. Mais l'onglet disparu emporte la seule clé que
l'app connaissait : la session continue de tourner sur le serveur, hors de
portée de l'interface. Rien n'est perdu (elles portent toutes le préfixe
`guiterm-`, et `parse_sessions` les retrouve déjà), mais tant que la
tranche 2 — lister, reprendre, terminer — n'est pas là, un usage intensif les
laisse s'accumuler. C'est la raison pour laquelle le réglage est désactivé par
défaut, et pas seulement la compatibilité ascendante.

## Sessions persistantes — tranche 2 : le gestionnaire (2026-08-24)

La tranche 1 laissait un trou nommé dans sa propre documentation : fermer un
onglet détache la session (c'est le but — fermer l'app ne doit pas tuer le
travail en cours), mais l'onglet emportait la seule clé que l'app connaissait.
La session continuait de tourner sur le serveur, hors de portée de
l'interface. Rien n'était perdu, rien n'était atteignable non plus.

**Un seul script pour deux usages.** `probe_script` rend maintenant quatre
champs par session (`nom|création|fenêtres|clients`) au lieu du seul nom, et
sert aussi bien à décider quoi faire à la connexion qu'à alimenter le
gestionnaire. Le séparateur est `|`, précisément parce
qu'`is_valid_session_key` l'interdit dans une clé : le nom ne peut donc jamais
en contenir, et découper dessus est sûr. `parse_session_names` a disparu au
profit de `parse_sessions`, qui rend des `RunningSession` complets.

**Trois réponses, pas deux** — `SessionListing` porte `tmux_available` à côté
de la liste, pour la même raison que `drift.rs` compte trois verdicts : « aucune
session » et « je ne peux pas savoir » ne sont pas la même chose, et les
confondre ferait passer un hôte sans tmux pour un hôte propre. La modale
affiche l'un ou l'autre.

**`list` remonte ses erreurs, `probe` non.** Les deux appellent pourtant le
même script. La différence est la question posée : à la connexion, un sondage
raté doit retomber sur un shell ordinaire sans rien casser ; dans le
gestionnaire, l'utilisateur a demandé à *voir*, et lui rendre « aucune
session » parce que la commande a échoué serait un mensonge.

**La garde qui compte le plus du module.** `kill_command` refuse tout nom qui
ne porte pas le préfixe `guiterm-`. La clé fait l'aller-retour par le
frontend, et un `tmux kill-session -t travail` détruirait la session
personnelle de l'utilisateur — sans confirmation possible, puisque tmux n'en
demande pas. Le refus est en `core`, avant que quoi que ce soit parte sur le
réseau, et un test d'intégration crée une vraie session au nom personnel pour
vérifier qu'elle survit à la demande *et* qu'elle n'est jamais proposée dans
la liste.

**Deux détails d'interface qui ne se voient pas dans le code.**

- L'entrée « Sessions » est proposée sur **tout** hôte SSH, pas seulement ceux
  réglés sur tmux : repasser le réglage à « désactivée » ne fait pas
  disparaître les sessions déjà ouvertes, et masquer l'entrée les rendrait
  définitivement inatteignables.
- La confirmation avant de terminer **remplace** le sélecteur au lieu de se
  poser dessus. Deux `useModalSurface` actifs en même temps se disputeraient
  Échap et le piège à focus ; l'état de la liste vivant dans le composant, elle
  revient telle quelle après une annulation.

**Reprendre une session déjà ouverte dans un onglet active cet onglet** plutôt
que d'en ouvrir un second. Ce n'est pas de la politesse : tmux attacherait les
deux clients à la même session et calerait la fenêtre sur le plus petit des
deux, ce qui donne un terminal tronqué sans rien à l'écran pour l'expliquer.

**Réutilise `ConnectionPickerModal`** — même chrome que les sélecteurs de
conteneurs Docker et de pods K8s, actions par ligne comprises, qui existaient
déjà pour qu'une ligne puisse porter autre chose que « choisir celle-ci ».

### Sous test

- Les cas de format dans `persistent_shell` : les quatre champs relus, une
  version de tmux qui en omet (chaîne vide → `None`/`0`, jamais une date de
  1970), une clé qui en préfixe une autre, et le refus de tuer une session
  étrangère.
- `src/lib/persistentSessions.ts` — la formulation d'une ligne, sortie du JSX
  parce que ce qu'elle décide (pluriel, « détachée » contre « ouverte
  ailleurs », date inconnue) se trompe en silence et qu'aucun rendu ne le
  signalerait.
- Le scénario e2e `runSessionManagerScenario` : l'entrée de menu existe, la
  modale s'ouvre, et `list_persistent_sessions` répond pour de vrai sur un
  hôte injoignable — avec un contrôle explicite que le message n'est pas
  « commande inconnue », ce qui ferait passer une commande jamais enregistrée
  pour une panne réseau. Validé en renommant l'entrée de menu : l'e2e tombe.
  L'enregistrement lui-même reste couvert, plus vite, par
  `tauriCommands.test.ts`.

## Sessions persistantes — tranche 3 : la reprise automatique (2026-08-24)

Les deux tranches précédentes rendaient la reprise **possible**. Celle-ci la
rend automatique, ou au moins évidente, sur les trois chemins par lesquels on
perd un terminal : la coupure de connexion, la fermeture de l'app, et
l'inattention.

### La coupure de connexion — le vrai sujet

`autoReconnect` est **désactivé par défaut**. Une coupure de VPN ne passait
donc pas par le repli exponentiel : elle allait droit à `onDisconnect`, qui
ferme l'onglet. Avec une session persistante, c'était le pire des deux mondes
— la session continuait de tourner sur l'hôte, et l'onglet emportait en
partant la seule clé qui permettait d'y revenir.

Un terminal persistant repasse maintenant en **vignette** au lieu de se
fermer (`detachTab`), en gardant sa clé. Le terminal l'écrit avant de
disparaître : « la session est toujours ouverte sur l'hôte ».

**La décision est sortie du composant.** Elle croise trois règles qui
interagissent — repli exponentiel, épuisement des tentatives, session
persistante ou non — et vivait au milieu de trois refs dans un composant de
500 lignes, donc invérifiable. `lib/terminalClosure.ts` la rend pure et
testée, même forme que `pollSchedule.ts` ou `terminalZoom.ts`. L'ordre entre
les règles y est explicite et sous test : une session persistante ne
court-circuite pas la reconnexion automatique, parce que se rattacher tout de
suite vaut mieux que repasser par une vignette à recliquer.

### La fermeture de l'app

Nouvelle préférence, **désactivée par défaut** : « Reprendre seules les
sessions persistantes ». Les onglets restaurés qui portent une clé se
rouvrent d'eux-mêmes ; tous les autres restent des vignettes, comme avant.

Le défaut compte autant que la fonctionnalité : l'app ne se connecte à rien
au lancement, et se mettre à ouvrir des connexions SSH sans qu'on l'ait
demandé changerait ce contrat pour tout le monde. La restriction aux onglets
persistants n'est pas de la prudence non plus — ce sont les seuls où rouvrir
rend quelque chose (l'écran laissé) plutôt qu'un shell vierge. Le texte du
réglage prévient du cas où il ne faut pas l'activer : des hôtes à code à usage
unique demanderaient plusieurs codes dès le démarrage.

La décision elle-même est `restoredTabStatus` dans `tabPersistence.ts`, pure
et testée : trois conditions doivent tenir ensemble, dont « c'est bien un
onglet terminal » — les onglets terminal, transfert et RDP partagent un membre
de `TabMeta`, donc une clé sur un onglet de transfert est représentable au
typage et ne doit rien déclencher.

### L'inattention

- **Une punaise dans la barre d'onglets** sur les terminaux à session
  persistante. Ce n'est pas décoratif : c'est l'information qui change le
  geste — fermer cet onglet-là ne perd rien. Icône ajoutée exprès
  (`IconPin`) parce qu'aucune des existantes ne dit ça : une flèche circulaire
  se lit « recharger », un bouclier se lit « sécurité ».
- **La vignette d'un onglet restauré dit ce qui l'attend** : « la reprendre
  rend le terminal tel qu'il était » plutôt que « session restaurée — non
  reconnectée », et le bouton dit « Reprendre la session ». Ce qu'elle ne
  promet pas : que la session soit *toujours* vivante — seule la connexion
  peut le dire, et le terminal l'annonce alors (« session reprise » ou
  « recréée »).
- **Plus de confirmation à la fermeture** d'un onglet persistant. Elle existe
  parce que fermer « kills the remote session outright » ; ce n'est plus vrai,
  et avertir d'un danger qui n'existe pas réintroduirait exactement la friction
  que la fonctionnalité sert à retirer.

**Ce qui n'est toujours pas couvert automatiquement** : le passage effectif en
vignette à la coupure demande une vraie session SSH qui tombe, ce qu'aucun
scénario e2e ne peut provoquer ici (le harnais `sshd` vit dans les tests Rust,
pas dans l'app). La *décision* l'est (`terminalClosure.test.ts`), le câblage du
réglage aussi (scénario e2e, validé en débranchant le `onChange` : « le choix
n'a pas été persisté »), mais le trajet complet reste à vérifier à la main.
