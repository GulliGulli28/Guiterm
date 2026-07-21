# Contributing to Guiterm

Thanks for considering it — this project grew out of one person's daily
SSH/SFTP workflow, and outside contributions are genuinely welcome now that
it's open. This document covers how the project is organized, how to get a
dev environment running, and what to expect from the review process.

## Code of conduct

Be respectful, assume good faith, keep disagreements about the code and not
the person. Harassment, personal attacks, or discriminatory language won't
be tolerated — maintainers can remove comments, close issues/PRs, or block
repeat offenders. Report a problem privately to the maintainer (see the
email in `LICENSE`/`package.json`) rather than escalating in public.

## Ways to contribute

- **Bug reports** — open an issue with steps to reproduce, what you
  expected, what happened, and your platform (Windows/Linux, version). A
  crash log or screenshot helps a lot.
- **Feature ideas** — open an issue first, even a rough one. For anything
  that changes UX or touches a core abstraction (a new host kind, a new
  protocol, a new panel), a short discussion before you write code saves
  everyone a rewritten PR later.
- **Pull requests** — bug fixes, small improvements, and docs/typo fixes
  can go straight to a PR. Anything larger, open an issue first (see above).
- **Docs and translations** — the app's UI and in-repo docs are currently
  French-first (the original author's language) with this README/CONTRIBUTING
  in English for reach; help making either side more complete, or adding a
  new language, is welcome.

## Development setup

Prerequisites:
- [Node.js](https://nodejs.org/) 20+
- [Rust](https://rustup.rs/) stable
- Your platform's webview:
  - **Windows**: WebView2 (already present on an up-to-date Windows 10/11)
    and the MSVC build tools (`rustup` will prompt you if missing).
  - **Linux**: `libwebkit2gtk-4.1-dev`, `libappindicator3-dev`,
    `librsvg2-dev`, `patchelf`, `libxdo-dev` (see
    `.github/workflows/ci.yml` for the exact `apt-get install` line CI uses).

```bash
npm install        # frontend dependencies
npm run tauri dev  # run the app in dev mode (hot reload)
```

### Building the RDP sidecar

**This is the one non-obvious step that trips up a fresh checkout.** The
integrated RDP viewer runs as a separate process, `rdp-sidecar`, built from
its *own* Cargo workspace (see the comment at the top of
`rdp-sidecar/Cargo.toml` for why — short version: an unresolvable exact
version conflict between two of its dependencies and the ones the rest of
the app already uses). Because of how Tauri's build script checks that its
bundled sidecar binaries exist, **even `cargo check`/`cargo build` on the
main app fails outright** until this binary is in place — this isn't
specific to packaging a release.

```bash
# Linux
cd rdp-sidecar && cargo build
mkdir -p ../src-tauri/binaries
cp target/debug/rdp-sidecar ../src-tauri/binaries/rdp-sidecar-x86_64-unknown-linux-gnu
```

```powershell
# Windows (PowerShell)
Set-Location rdp-sidecar
cargo build
New-Item -ItemType Directory -Force ../src-tauri/binaries
Copy-Item target/debug/rdp-sidecar.exe ../src-tauri/binaries/rdp-sidecar-x86_64-pc-windows-msvc.exe
```

Do this once after cloning, and again any time you change something under
`rdp-sidecar/` or `rdp-ipc/`. `src-tauri/binaries/` is gitignored on purpose
(platform-specific binary, never committed).

## Project layout

See the [Project structure](README.md#project-structure) section of the
README for the full breakdown. The short version, if you're adding
something new:

- **New Tauri command?** Business logic goes in `core/` (framework-agnostic,
  unit-testable), a thin wrapper in `src-tauri/src/commands/<domain>.rs`
  exposes it to the frontend, and `src/lib/api.ts` gets a typed entry — this
  is the *only* place the frontend is allowed to call `invoke(...)` from.
- **New frontend component?** One file per panel/widget under
  `src/components/`, following the existing naming (`XxxPanel.tsx` for a
  side panel, `XxxTab.tsx` for a tab's content).

## Before you open a PR

- `cargo clippy --workspace --all-targets -- -D warnings` on the root
  workspace, **and** `cd rdp-sidecar && cargo clippy --all-targets --
  -D warnings` on its separate workspace. CI enforces both — a single
  clippy warning fails the build.
- `npx tsc --noEmit` and `npm run build` for the frontend.
- `cargo test --workspace` (the integration tests under `core/tests/` spawn
  a real local `sshd`, so they run on Linux/WSL — see `core/tests/common/`).
- `npm test` (vitest) for frontend unit tests.
- If your change touches a React component, a terminal, keyboard/mouse
  interaction, or anything going through `invoke(...)`: also run
  `npm run test:e2e`. It drives the actual compiled binary over WebDriver
  (not a plain browser pointed at the dev server, which never sees
  `window.__TAURI__`) and takes a real screenshot. Compiling cleanly is not
  the same as working — several real bugs in this project were only found
  this way.

None of this needs to be perfect before you open a PR — CI will tell you
what's missing, and review is a normal part of the process, not a gate you
need to pre-clear alone.

## Pull request process

- Keep a PR to one logical change; it's easier to review and easier to
  revert if something's wrong.
- Write the *why* in the PR description, not just the *what* — the diff
  already shows what changed.
- Link the issue it addresses, if there is one.
- A maintainer will review, may ask for changes, and will merge once CI is
  green and the change makes sense. Response time is best-effort (this is
  not a funded full-time project — see [README](README.md#roadmap) for
  where things are headed).

## Licensing of contributions

Guiterm is [MIT-licensed](LICENSE). By submitting a pull request, you
agree your contribution is provided under the same license, with no
additional terms. There's no CLA to sign for now — if the project grows to
a point where that changes, it'll be called out clearly and won't apply
retroactively to contributions already made.

## Reporting a security issue

See [`SECURITY.md`](SECURITY.md) — please **don't** open a public issue for
a security vulnerability, use GitHub's private vulnerability reporting
instead.
