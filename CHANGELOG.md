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
- Each terminal's font size can be adjusted on its own with `Ctrl` `+` /
  `Ctrl` `-` / `Ctrl` `0`, or `Ctrl` and the mouse wheel. It affects only the
  terminal you're in — not the other tabs, and not the size saved in Settings.
- A fullscreen mode (`F11`, or the button next to broadcast and split). The
  title bar goes away with the window decorations, leaving the tabs and the
  terminal; push the pointer against the top edge of the screen to bring it
  back.
- Machines with no public address and no inbound SSH can now be reached, by
  giving a host a proxy command — the program is run locally and the session
  travels over its input and output, exactly as OpenSSH's `ProxyCommand` does.
  One generic setting rather than a per-provider integration, so AWS Session
  Manager, GCP IAP, `cloudflared` and a site's own jump tooling all work the
  same way. `ProxyCommand` entries are also picked up when importing
  `~/.ssh/config`.
- A "Test the command" button next to that field. It runs the command and says
  what happened: it reports success only when a real SSH server answers, and
  on failure shows the program's own error alongside what to do about it —
  a missing Session Manager plugin, a program that isn't on the PATH, an
  expired SSO session, an instance SSM can't see.
- EC2 instances can be imported as hosts, from Hosts → Add → Import from AWS.
  Pick a profile and a region, search the account by name, id, address, platform
  or tag, tick what you want: the instance id, the proxy command, the login
  guessed from the AMI and the EC2 tags are all filled in, with SSH credentials
  set for the whole batch. Instances SSM cannot reach are listed with the reason
  rather than hidden.
- RDS, Aurora, ElastiCache and DocumentDB databases can be imported as
  connections, from Databases → Import from AWS, each pointed at a saved host to
  reach it through — managed databases usually sit in a private subnet. Aurora
  clusters are offered by their cluster endpoint, the one that survives a
  failover, and their member instances are left out. Engines the app doesn't
  speak (Oracle, SQL Server) are listed with that reason instead of being
  hidden.
- An SSO session can be set up from the app, without a terminal: fill in the
  portal address, authenticate in the browser, then tick the accounts and roles
  you want profiles for. When a session later expires, the error offers to
  reconnect it in one click. Everything is written to `~/.aws/config` in the
  form the CLI writes itself, so your terminal and your other tools see the same
  configuration — and nothing is duplicated into a store of our own.
- Profile pickers show which account each profile reaches, by name rather than
  by twelve-digit number, and regions are picked from the full list (with a
  free-text escape for one newer than this release).

  Nothing about any of this asks for AWS credentials or stores any: every call
  goes through the `aws` CLI you already have configured, so SSO, assume-role
  and MFA keep working exactly as they do in your terminal.
- AWS identities have a sidebar tab of their own. It lists the SSO sessions in
  `~/.aws/config` with whether each one is signed in and for how much longer,
  and the profiles grouped under the session that authenticates them — with the
  account, the role and the region each one reaches. From there you can sign in,
  reconnect, add profiles to a session that is already signed in (no second trip
  through the browser), check who a profile really resolves to at this moment,
  and delete a profile or a session. Until now all of this was reachable only
  from inside the EC2 import panel, and nothing anywhere answered "am I still
  signed in, and as whom".
  A session whose hourly access token has lapsed reads as signed in with a token
  to renew, not as expired: the CLI renews it by itself, without a browser, for
  as long as the AWS session lives — and the app now triggers that renewal
  rather than refusing the operation.
- Connections through AWS Session Manager find the plugin even when it was
  installed while the app was running. A process keeps the PATH it started with,
  so `aws ssm start-session` could report the plugin as missing on a machine
  where it was installed *and* correctly on the system PATH; the standard
  install directories are now searched as well. And when a proxy command fails,
  its error comes with what to do about it — advice that until now appeared only
  under the settings form's "Test the command" button.
- « Est-ce que cet hôte atteint telle adresse, sur tel port ? » — from an SSH
  host's menu, or from the command palette to ask about this machine. The
  answer makes the distinction that matters: a **refusal** means something
  answered and the machine was reached (closed port, stopped service), a
  **silence** means nothing came back at all (firewall, security group, missing
  route). Same symptom, opposite investigations. A name that doesn't resolve
  and a network with no route are told apart too. Several sources can be asked
  at once, which is what turns "it fails from here" into "it fails from
  everywhere" — and nothing is installed on any of them.
- Files can be found on a host without opening a terminal, from an SSH host's
  menu: by name, or by what's inside them. Each hit shows the path, the line
  and the matching text — and opens straight in your editor, as any remote edit
  does, so saving pushes it back. Every search is bounded in depth, in results
  and in time, and says so when what it gives back is partial: a truncated list
  presented as a complete one would make "it isn't there" a wrong answer.
- Environment variables set on a host can be marked secret, one at a time. The
  value then lives in the vault — OS keychain, or the encrypted vault when you
  use one — instead of `workspace.json`, which is where an API token would
  otherwise sit in clear next to your hosts. The form never shows a stored
  secret back, so leaving the field empty keeps it; and when a secret can't be
  read as the session opens (locked vault), the session says which variable and
  why, instead of quietly starting without it.
- An SSO session about to lapse says so, instead of waiting to be looked at.
  A dot appears on the AWS identities tab, and a line in the panel names the
  hosts that are about to lose their access — the typical failure is finding
  the session dead in the middle of a transfer. Only sessions something depends
  on raise it: one no host reaches through costs nothing today, and being
  interrupted for it is what teaches you to ignore the dot on the day it
  matters. A session whose hourly token merely needs renewing is never flagged
  — the CLI renews that one by itself.
- Fleet operations can target an AWS account. Targeting by EC2 tag already
  worked; what no tag can express is "every host of account X", which is the
  real cut when you manage several. The adaptive language gains
  `target profile: prod-admin` (`account` works too), and the target picker a
  row of account chips that select everything reached through one — click two
  to combine them. The match is exact, so `prod` doesn't sweep in both
  `prod-admin` and `prod-readonly`, and a host reached without an AWS profile
  never matches.
- Redis connections can use TLS (`rediss://`), from a checkbox on the
  connection — and automatically for an imported ElastiCache group that has
  encryption in transit enabled.
- MongoDB connections can require TLS, with an optional path to a certificate
  bundle for servers whose authority isn't in the system trust store — which is
  what DocumentDB needs. Combining TLS with an SSH tunnel additionally needs
  certificate checking turned off, because no certificate can match the tunnel's
  local address; the app says so instead of failing with a bare TLS error, and
  never makes that choice for you.

### Fixed
- A private key chosen from the keychain was not saved with the host. The key's
  identifier never reached storage, so the link was lost and the passphrase was
  filed under the host instead of the key. Hosts saved before this keep working
  and pick their key back up.

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
