# Changelog

Notable user-facing changes to Guiterm, in the
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) style. Versions
correspond to the `v*` tags described in `RELEASING.md`.

This changelog starts 2026-07-21 — for earlier versions, see
[GitHub Releases](https://github.com/GulliGulli28/Guiterm/releases).

## [Unreleased]

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
