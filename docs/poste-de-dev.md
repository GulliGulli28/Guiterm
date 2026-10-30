# Installer un poste de développement

Ce qu'il faut pour développer Guiterm comme sur le poste d'origine :
Windows, WSL2 (Ubuntu 24.04) où vit le dépôt, et une chaîne Windows native
pour le binaire WebView2 et son E2E. Inventaire relevé le 2026-10-30 sur ce
poste. Les pièges déjà rencontrés pendant ces installations sont dans
`docs/dev-history.md` (« Setup one-time »).

## 1. Windows

| Outil | Pourquoi | Installation |
|---|---|---|
| WSL2 + Ubuntu 24.04, avec WSLg | Le dépôt, Rust « par défaut », l'E2E WebKitGTK, l'écran réel | `wsl --install -d Ubuntu-24.04` |
| Rust (rustup, toolchain stable MSVC) | Binaire Windows natif | rustup.rs |
| Visual Studio Build Tools (C++ / MSVC) | Éditeur de liens de Rust MSVC | `winget install Microsoft.VisualStudio.2022.BuildTools` (charge « Développement Desktop C++ ») |
| WebView2 Runtime | Ce que les utilisateurs lancent | déjà présent sur Windows 11 |
| NASM | `aws-lc-sys` le demande sous MSVC | `winget install --id NASM.NASM -e` → `C:\Program Files\NASM` |
| tauri-driver (côté Windows) | E2E WebView2 | `cargo install tauri-driver` |
| msedgedriver | E2E WebView2 — **même version** que le WebView2 Runtime | voir `docs/dev-history.md` (commande `curl.exe` sur la version lue dans le registre) |
| Azure CLI (facultatif) | Import Azure ; c'est le `az` Windows que WSL trouve | `winget install Microsoft.AzureCLI` |

Le binaire Windows se construit dans `%USERPROFILE%\gui-termius-target-windows`
(jamais sur le chemin `\\wsl.localhost`) : voir `CLAUDE.md`, « Lancer l'app
Windows en conditions réelles ».

## 2. WSL (Ubuntu 24.04)

```bash
# Paquets système : Tauri (WebKitGTK), E2E, tests d'intégration
sudo apt-get update
sudo apt-get install -y build-essential pkg-config curl git \
  libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libssl-dev libxdo-dev patchelf \
  webkit2gtk-driver xvfb scrot \
  openssh-server openssh-client tmux nasm \
  gh pipx

# Rust (stable) et les outils cargo du dépôt
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
cargo install tauri-driver tauri-cli cargo-audit cargo-machete

# Node 20 par nvm (pas celui d'apt, trop ancien pour ESLint 10 / vitest 3)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
nvm install 20 && nvm alias default 20
```

Le snippet `nvm` doit être chargé par **`~/.profile` et `~/.bashrc`** (et
`~/.zshrc` si le shell est zsh) : l'outillage lance `bash -lc`, qui ne lit pas
`~/.bashrc`. Si `node -v` répond 18, c'est que ce snippet manque.

| Outil | Pourquoi |
|---|---|
| `openssh-server` (`/usr/sbin/sshd`) | Les tests d'intégration de `core` lancent de vrais `sshd` |
| `tmux` | Tests des sessions persistantes |
| Docker (Docker Desktop avec l'intégration WSL, ou `docker.io`) | Tests GuiVault (`docker compose up` dans `~/GuiVault`), hôtes Docker exec |
| `gh`, connecté (`gh auth login`) | Suivre le CI (`gh run watch`) |
| graphify | Le graphe de code (`graphify query`, `graphify update .`, voir `CLAUDE.md`) : `pipx install graphifyy` |
| Playwright + Chromium | Tour visuel (`node scripts/visual-tour.mjs`) et contrôles visuels : `npx playwright install chromium` (pas `--with-deps`, qui demande `sudo` sans prévenir) |
| AWS CLI (facultatif) | Import EC2, tunnels SSM |
| `gcloud`, `kubectl` (facultatifs) | Import Google Cloud, hôtes Kubernetes exec — absents du poste d'origine |

## 3. Les dépôts

```bash
cd ~
git clone git@github.com:GulliGulli28/Guiterm.git gui-termius
git clone git@github.com:GulliGulli28/GuiVault.git GuiVault   # dépôt frère, tests d'intégration GuiVault
cd gui-termius
git config user.name "g.lorin"
npm install                                   # côté WSL uniquement — un seul node_modules
# Le sidecar RDP doit exister avant même un `cargo check` de l'app :
(cd rdp-sidecar && cargo build && cp target/debug/rdp-sidecar ../src-tauri/binaries/rdp-sidecar-x86_64-unknown-linux-gnu)
npm run verify                                # tout doit être vert
```

Garder **le même chemin** (`/home/<utilisateur>/gui-termius`) que sur le poste
d'origine si l'on veut reprendre la mémoire de Claude Code telle quelle
(section suivante).

## 4. Claude Code : ce que `git pull` ramène, et ce qu'il ne ramène pas

**Ramené par le dépôt** — l'essentiel pour reprendre le travail :
`CLAUDE.md` (consignes chargées à chaque session), `docs/refonte-ui.md` (plan,
tranches livrées, écarts restants), `docs/dev-history.md`, `docs/backlog.md`,
`CHANGELOG.md`, le graphe `graphify-out/`.

**Pas ramené** — tout ce qui vit dans `~/.claude/` sur l'ancien poste :

| Quoi | Où | À faire |
|---|---|---|
| La mémoire du projet (notes de travail : refonte, pièges du tour visuel, disque, CI…) | `~/.claude/projects/<chemin>/memory/` | **À copier.** Petit, et c'est ce qui manque le plus à une session neuve |
| L'historique des conversations (`claude --resume`) | `~/.claude/projects/<chemin>/*.jsonl` | Facultatif (≈ 130 Mo) : sans lui, on ne reprend pas *une conversation*, mais le travail se reprend avec `CLAUDE.md` et la mémoire |
| Réglages de Claude Code | `~/.claude/settings.json` | À recopier ou refaire (ici : `effortLevel`) |
| Identifiants | `~/.claude/.credentials.json` | **Ne pas copier** : se reconnecter avec `claude` sur le nouveau poste |

`<chemin>` est le chemin absolu du dépôt, `/` remplacés par `-` : ici
`-home-glorin-gui-termius`. Si le dépôt n'est pas au même endroit sur le
nouveau poste, renommer le dossier en conséquence.

```bash
# Sur l'ancien poste
tar czf ~/claude-guiterm.tgz -C ~/.claude/projects -- -home-glorin-gui-termius/memory
# (ajouter `-home-glorin-gui-termius` entier à la place de `.../memory` pour garder l'historique)

# Sur le nouveau poste, après avoir lancé `claude` une fois (crée ~/.claude)
mkdir -p ~/.claude/projects && tar xzf claude-guiterm.tgz -C ~/.claude/projects
```
