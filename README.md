# Guiterm

**A fast, local-first SSH/SFTP desktop client for people who live in a terminal —
with Docker exec, an integrated RDP viewer, and an optional encrypted secrets
vault built in. No mandatory cloud account, no subscription to use it.**

[![CI](https://github.com/GulliGulli28/Guiterm/actions/workflows/ci.yml/badge.svg)](https://github.com/GulliGulli28/Guiterm/actions/workflows/ci.yml)
[![Security](https://github.com/GulliGulli28/Guiterm/actions/workflows/security.yml/badge.svg)](https://github.com/GulliGulli28/Guiterm/actions/workflows/security.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20Linux-informational)](#installation)
[![Latest release](https://img.shields.io/github/v/release/GulliGulli28/Guiterm?include_prereleases)](https://github.com/GulliGulli28/Guiterm/releases)

<!--
  TODO before publishing: replace this block with a real screenshot or short
  GIF of the terminal + split-pane view, and one of the SFTP dual-pane
  browser. A picture is what actually gets a README read past the first
  screen on Hacker News / Reddit / GitHub trending.
-->
> 🖼️ *Screenshots coming soon — see [Contributing](#contributing) if you'd like
> to help capture a good one.*

---

## Table of contents

- [Why another SSH client?](#why-another-ssh-client)
- [How it compares](#how-it-compares)
- [Features](#features)
- [Architecture](#architecture)
- [Installation](#installation)
- [Development](#development)
- [Project structure](#project-structure)
- [Data & configuration](#data--configuration)
- [Known limitations](#known-limitations)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [License](#license)

## Why another SSH client?

Guiterm started as a personal itch: juggling a dozen servers, bastions,
Docker hosts, and the occasional Windows box behind RDP, using a pile of
tools that each did one part of the job — and none of them locally, for free,
without nagging for an account. It grew from real day-to-day usage rather
than a fixed roadmap, which is why some of its features (bastion chaining,
snippet variables, broadcast typing) exist precisely because a generic tool
made them annoying.

It's built with [Tauri 2](https://tauri.app/) + Rust + React — SSH over a
pure-Rust implementation ([`russh`](https://github.com/Eugeny/russh), no
shelling out to a system `ssh` binary), a native window instead of an
Electron blob, and a project layout that keeps all the protocol logic
(`core/`) independent of the UI framework.

**The plan going forward is open-core**: the client itself — everything in
this repository — is free and MIT-licensed, full stop, no feature gating.
If a paid offering ever exists, it will be *around* the client (hosted
sync, priority support, signed/notarized builds) — never a toggle that locks
functionality you already have.

## How it compares

No shade intended at any of these — they're all solid tools that solve real
problems. This is just where Guiterm sits relative to them, as honestly
as I can put it:

| | Guiterm | Termius | PuTTY | MobaXterm | mRemoteNG |
|---|---|---|---|---|---|
| License | MIT | Proprietary | MIT | Proprietary (freemium) | GPL-2.0 |
| Free for commercial use | ✅ | ❌ (subscription) | ✅ | Free tier is limited | ✅ |
| Works fully offline, no account | ✅ | Pushes cloud sync | ✅ | ✅ | ✅ |
| Bastion / jump-host chaining | ✅ built-in | ✅ | Manual | ✅ | Limited |
| Integrated dual-pane SFTP | ✅ | ✅ | ❌ (separate tool) | ✅ | Limited |
| Docker `exec` as a first-class host | ✅ | ❌ | ❌ | ❌ | ❌ |
| Integrated RDP viewer (no external client) | ✅ | ❌ | ❌ | ✅ | ✅ |
| Optional encrypted secrets vault (Argon2id + XChaCha20-Poly1305) | ✅ | Cloud-based | ❌ | ❌ | Weak (reversible) |
| Command broadcast across terminals | ✅ | ✅ | ❌ | ✅ | ✅ |
| Platforms | Windows, Linux | Win/Mac/Linux/Mobile | Windows (+ Linux build) | Windows only | Windows only |

## Features

**SSH terminals**
- Direct connections or chained through one or more bastions/jump hosts
  (like `ssh -J`), agent forwarding, configurable keepalive.
- Multiple tabs, side-by-side split view.
- Broadcast a command to a chosen subset of open terminals — either
  "one command at a time" or "live typing" mode (keystrokes in one terminal
  mirrored to the others in real time).
- Auto-reconnect on drop, with configurable backoff.
- Scrollback search (Ctrl+F) with case/regex options, and scrollback export
  to a file.

**Beyond SSH: Docker, RDP, Kubernetes**
- **Docker exec** — open a shell directly inside a running container, either
  by talking to the Docker Engine API directly or tunneled through an
  already-configured SSH host (no need to expose the Docker socket over
  unauthenticated TCP). Snippets, environment variables, and file browsing
  (list/create/rename/permissions/upload/download, backed by the container
  archive API) all work the same way they do for SSH hosts.
- **Integrated RDP viewer** — a real remote-desktop frame rendered inside
  the app, with mouse/keyboard forwarding, bidirectional clipboard sync on
  Windows, dynamic resolution resize as you resize the tab, and drag-and-drop
  file transfer onto the remote clipboard. Runs through an isolated sidecar
  process — see [Architecture](#architecture) for why. No cursor rendering
  yet; see [Known limitations](#known-limitations).
- **Kubernetes exec** — UI scaffolding (context/namespace picker) exists;
  the backend isn't implemented yet. See [Roadmap](#roadmap).

**Local terminal**
- Integrated system shell, with auto-detection of available shells
  (PowerShell, cmd, PowerShell 7, Git Bash, WSL…) and a per-session or
  default choice.

**SFTP & file transfer**
- Dual-pane browser (local ↔ remote or remote ↔ remote), drag-and-drop from
  Explorer or between panes.
- Create folders/files, rename, edit permissions, quick-edit small text
  files without leaving the app.

**Snippets & scripts**
- Reusable commands or scripts with `{{like_this}}` variables.
- Fast keyboard picker: type the snippet name followed by its arguments in
  one go (`sys start apache2`), or fill them in one at a time.
- Run against the active terminal or a chosen set of open terminals.

**Organization**
- Hierarchical folders with icon + color (visible at a glance on tabs),
  search, import hosts from `~/.ssh/config`, export/import a single host or
  the whole workspace.

**Security**
- Host key verification on first connection ("trust on first use", in the
  spirit of `known_hosts`), with an alert if a key changes later.
- Secrets (passwords, passphrases, private key contents) stored in the OS
  keychain by default, with an **optional encrypted vault** (Argon2id key
  derivation + XChaCha20-Poly1305, envelope DEK/KEK scheme) for anyone who
  wants something portable/syncable and independent of the OS keychain —
  locked at launch, configurable auto-lock.
- SSH key generation (Ed25519 by default, RSA 4096 optional) and one-click
  deployment to a remote `authorized_keys` (an `ssh-copy-id` equivalent).

**Comfort**
- Command palette (Ctrl+K), customizable keyboard shortcuts — with
  collision detection against common shell bindings (Ctrl+W, Ctrl+K, Ctrl+\,
  …) so you don't lose readline's kill-word by accident.
- Terminal themes (Dracula, Nord, Gruvbox, Solarized…), fonts, accent
  colors, light/dark mode.
- Silent auto-update on launch, or on demand from Settings.

## Architecture

- **Backend**: Tauri 2, Rust. SSH via [`russh`](https://github.com/Eugeny/russh)
  (pure Rust, no system `ssh` binary involved), local terminals via
  `portable-pty`, secrets via `keyring` + an optional homegrown encrypted
  vault.
- **Frontend**: React 19, TypeScript, Tailwind CSS,
  [xterm.js](https://xtermjs.org/) for terminal rendering.
- The Rust side is split into `core/` (pure business logic — SSH, SFTP,
  Docker, vault, known_hosts, `~/.ssh/config` parsing — with zero Tauri
  dependency, unit- and integration-tested against a real `sshd`) and
  `src-tauri/` (one Tauri command module per domain, thin glue over `core/`).

**The RDP viewer runs as a separate process (`rdp-sidecar`), not inside the
main binary.** This isn't a stylistic choice — it's the only thing that
compiles: the RDP library pulls in a crate version that hard-conflicts with
`russh`'s, at the level of an exact-pinned dependency that both sides refuse
to bump. Isolating it in its own Cargo workspace, talking to the main app
over a small hand-rolled stdin/stdout protocol, is what makes both halves
buildable at all. The full story — the exact dependency conflict, why a
plain workspace member wasn't enough, and three real bugs found only by
testing against a live RDP server (a rustls crypto-provider panic, a
permanently black screen after resizing, and a Win32 message-pump problem
for clipboard sync) — is written up in
**[docs/blog/rdp-sidecar-architecture.md](docs/blog/rdp-sidecar-architecture.md)**.

## Installation

Download the latest installer for your platform from the
[Releases](https://github.com/GulliGulli28/Guiterm/releases) page
(Windows `.msi`/`.exe`, Linux `.deb`/`.rpm`/AppImage). The app updates
itself afterward (silent check on launch, or Settings → General → "Check
for updates").

macOS isn't built yet — there's no technical blocker, just no CI runner for
it configured so far. Contributions welcome; see [Contributing](#contributing).

## Development

Prerequisites: [Node.js](https://nodejs.org/) 20+, [Rust](https://rustup.rs/)
stable, and your platform's webview — WebView2 (ships with up-to-date
Windows 10/11) or `webkit2gtk` (Linux, see `.github/workflows/ci.yml` for the
exact `apt` packages).

```bash
npm install        # frontend dependencies
npm run tauri dev  # run the app in dev mode (hot reload)
```

Other useful commands:

```bash
npm run build          # frontend build only (tsc + vite)
npm run tauri build    # full production build (packaged installer)
npm test               # frontend unit tests (vitest)
npm run test:e2e        # real end-to-end smoke test (WebDriver, driving the actual compiled binary)
cargo test --workspace  # Rust unit + integration tests (see core/tests/, needs a real sshd on Linux)
```

The RDP sidecar (`rdp-sidecar/`) is its own separate Cargo workspace and
needs to be built and staged manually before the main app's `cargo
build`/`cargo check` will even compile — see
[CONTRIBUTING.md](CONTRIBUTING.md#building-the-rdp-sidecar) for the exact
commands.

See [`RELEASING.md`](RELEASING.md) for how a new version gets tagged, built
by CI, and published.

## Project structure

```
core/           pure Rust business logic, no Tauri dependency
  ssh.rs          direct and chained (bastion) SSH connections
  sftp.rs         remote file operations
  docker.rs       Docker Engine API client (direct or tunneled over SSH)
  docker_pane.rs  Docker-backed file browsing (container archive API)
  local_fs.rs     local file operations (SFTP panel's local side)
  transfer.rs     copy/upload logic shared across all file-backed panes
  vault.rs        secrets (OS keychain + in-memory fallback)
  crypto.rs / master_vault.rs   optional encrypted vault (Argon2id + XChaCha20-Poly1305)
  known_hosts.rs  host key verification (trust on first use)
  ssh_config.rs   parsing/import of ~/.ssh/config
  port_forward.rs local/remote tunnels + dynamic SOCKS
  keygen.rs       SSH key generation + authorized_keys deployment
  store.rs        workspace persistence (workspace.json)
  export.rs       host / workspace export-import

src-tauri/      Tauri bridge
  src/commands/   one command module per domain (hosts, terminal, sftp, forward, docker, rdp_view, keys, …)
  src/state.rs    shared app state (active sessions, in-memory workspace)

rdp-ipc/        wire protocol shared between src-tauri and rdp-sidecar (no risky deps)
rdp-sidecar/    isolated RDP client process (IronRDP), its own Cargo workspace

src/            React/TypeScript frontend
  components/     one file per panel/widget
  lib/            Tauri API bridge, preferences, shared types, shortcuts
```

## Data & configuration

- The workspace (hosts, folders, snippets, tunnels) is stored in plain
  `workspace.json` under the standard per-OS config directory (via the
  `directories` crate — e.g. `%APPDATA%\gui-termius\gui-termius\config\` on
  Windows). This path intentionally still says `gui-termius`, not `Guiterm`:
  it's the app's internal storage identifier (also used for the OS keychain
  service name), kept stable across the rename specifically so existing
  installs don't lose their configured hosts or secrets.
- Secrets (passwords, passphrases, private key contents) are **never** in
  that file: they live in the OS keychain, or in the optional encrypted
  vault if one is set up.
- UI preferences (theme, shortcuts, font size…) live in the webview's
  `localStorage`, not in `workspace.json`.
- All config/secret writes are atomic (write-temp-then-rename) and reads are
  fail-closed, so a crash mid-write can't silently truncate your
  `workspace.json` or `known_hosts.json`.

## Known limitations

Being upfront about what isn't solid yet, rather than letting you find out
the hard way:

- **RDP**: no cursor is rendered (pointer events are currently ignored);
  mouse wheel sends a fixed-magnitude tick per event rather than the exact
  scroll delta; if the server doesn't offer the Display Control channel, a
  resize request is silently ignored rather than falling back to a full
  reconnect.
- **Kubernetes exec** is UI-only right now — picking a context/namespace
  doesn't actually open a session yet.
- **Docker-backed file browsing** (list/mkdir/rename/upload/download over
  the container archive API) is covered by unit tests but hasn't yet been
  exercised against a real Docker daemon end-to-end — the basic Docker
  `exec` terminal path has been, and a couple of real bugs were found and
  fixed that way (see `CLAUDE.md` in this repo for the blow-by-blow if
  you're curious). Upload/download also buffer the whole file in memory via
  a tar stream — fine for configs and code, not for multi-gigabyte files.
- **macOS** isn't built or tested at all yet.

## Roadmap

Recently shipped: encrypted secrets vault, dynamic SOCKS tunnels, SSH key
generation/deployment, Docker exec (direct or over an SSH bastion),
integrated RDP viewer with input forwarding, clipboard sync, and dynamic
resize.

Up next, roughly in priority order:
- Kubernetes exec (real backend, not just the UI scaffold).
- Keyboard-interactive auth (MFA/OTP) — currently missing from `AuthMethod`.
- RDP cursor rendering.
- A binary IPC channel for terminal output (mirroring the optimization
  already done for RDP frames) — the current JSON+base64 event path is the
  single most-invoked code path in the app and the most likely place left
  with a measurable, fixable overhead.

Longer-term, as the open-core model takes shape: possibly a hosted
sync/backup service and priority support as a paid offering *around* the
free client — nothing decided or built yet.

## Contributing

Bug reports, feature ideas, and pull requests are all welcome — see
[CONTRIBUTING.md](CONTRIBUTING.md) for how the project is organized, how to
get a dev environment running, and what CI will check on your PR.

## License

[MIT](LICENSE).
