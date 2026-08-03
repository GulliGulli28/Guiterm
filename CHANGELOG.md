# Changelog

Notable user-facing changes to Guiterm, in the
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) style. Versions
correspond to the `v*` tags described in `RELEASING.md`.

This changelog starts 2026-07-21 — for earlier versions, see
[GitHub Releases](https://github.com/GulliGulli28/Guiterm/releases).

## [Unreleased]

### Added
- Servers that ask for a second factor (one-time code, MFA prompt) can now be
  reached. The app answers the server's questions during the handshake, in a
  dialog that shows the server's own wording — a saved password still answers
  the first hidden prompt on its own, so only the extra factor is asked for.

### Changed
- Terminal keystrokes travel to the session as raw bytes instead of being
  base64-encoded first, which was the app's most frequent call and carried
  about a third more data than it had to.

## [2.4.0] - 2026-07-27

### Added
- Redis and MongoDB in the database client, alongside MySQL/PostgreSQL/SQLite.
- SQL client: an Export tab, dumping a database or selected tables to a local
  file or straight onto a saved SSH host.
- A diagnostic log file (one per day, last 7 kept). Its location is shown in
  Settings → General — until now the app wrote its diagnostics to a console
  that doesn't exist in the shipped Windows build, so nothing was recoverable
  when something went wrong.
- Settings → Appearance: "Terminal GPU acceleration" (on by default) and a
  render-performance readout, to compare both renderers on your own machine.
- macOS builds are now produced on release. (Corrected after the fact: this
  entry originally said "for Apple Silicon and Intel", but the Intel job of
  that release never got a runner and was cancelled, so only the Apple
  Silicon `.dmg` shipped. macOS builds are also unsigned — macOS reports them
  as damaged on first launch; see the README for the workaround.)

### Changed
- SSH connections are shared between everything that talks to the same host.
  A terminal tab, a transfer pane, a tunnel and a tunnelled database session
  used to open one full connection each — three handshakes for three tabs, and
  three times that again through two bastions.
- A host's Docker daemon connection is kept instead of being rebuilt on every
  poll: a Docker-over-SSH host was paying a complete SSH handshake twice a
  minute, indefinitely, just to display a container count.
- Query results only render the visible rows, so a large result set no longer
  builds tens of thousands of table cells at once.

### Fixed
- An unexpected error in the interface now shows a recoverable screen with
  copyable details, instead of a blank window.

### Note
- Windows and macOS builds are still unsigned: SmartScreen warns on first
  run, and macOS requires right-click → Open. See `RELEASING.md`.

## [2.3.0] - 2026-07-22

### Added
- Kubernetes exec: real backend (terminal, file browsing, fleet target,
  adaptive snippets) — previously UI-only scaffolding with example data.
- Importing a host or a full workspace now strips startup snippets/env vars
  from the incoming file by default (opt-in checkbox to keep them) — these
  used to run automatically on the first connection, without review.
- `SECURITY.md` — private vulnerability reporting via GitHub.

### Changed
- Terminal and RDP output stream over a binary IPC channel instead of
  JSON+base64 events, reducing overhead on high-output sessions.
- Terminal fonts trimmed to latin/latin-ext subsets (~1.2 MB → ~640 KB of
  embedded font assets).
- The RDP viewer, file transfer, fleet operations tabs, and most sidebar
  panels now load on demand instead of being bundled into the app's
  initial chunk.

### Fixed
- A Kubernetes-exec terminal tab restored after an app restart could
  silently attempt an SSH connection instead of reconnecting to its pod
  (same for a Docker-exec transfer tab's container).
- A fleet operation targeting a Docker or Kubernetes container no longer
  risks silently misreading an unrelated host's fields when a target's
  host kind doesn't actually match.

## Earlier versions

Not tracked here — see
[GitHub Releases](https://github.com/GulliGulli28/Guiterm/releases) for the
history up to this point.
