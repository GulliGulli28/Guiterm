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
- Servers that trust a certificate authority instead of listing keys can now be
  reached. A host using a private key takes an optional certificate alongside
  it — filled in for you when the usual `<key>-cert.pub` sits next to the key.
  It's held as a path and re-read at every connection, because certificates
  from a CA are short-lived by design: whatever renews the file is enough, with
  nothing to redo here. When one won't work, the app says which of the possible
  reasons it is instead of relaying the server's single `Permission denied` —
  expired (and for how long), not valid yet (a clock that disagrees with the
  one that signed it, which is a different fix), missing, or a public key given
  where a certificate was meant.
- A fleet run written in the adaptive language can be undone, from the history:
  "Annuler" shows what the rollback would do before it does anything — the undo
  program in the same language you wrote, the commands each host would actually
  run, and, first and in red, everything it will **not** put back. Undoing
  happens in reverse order, keeping the original's conditions and `sudo`, so it
  reaches exactly the hosts the run reached and no others. Some operations have
  no inverse and say so rather than being quietly skipped: updating packages,
  restarting a service, removing a directory or a user. The rollback is itself
  recorded as a run, so it can be undone in turn.

  Runs made with a free command, and runs from before this release, aren't
  undoable — nothing recorded which operations they performed, and guessing
  that back from the shell they ran is exactly what would undo the wrong thing.
  Their button says so instead of disappearing.
- Fleet operations can tell you which hosts have drifted from a state you
  describe, without changing anything. Write the same adaptive program you
  would run — `install-package nginx` now also reads as "nginx should be
  installed" — and press "Vérifier l'écart": each host comes back compliant,
  drifted (with the lines that don't hold), or undetermined. The hosts that
  drifted can then be selected in one click, so repairing is just running what
  you already wrote — and undoing it is the rollback above.

  Undetermined is a real answer, never rounded to "fine": some operations leave
  no state to compare (updating packages, rebooting), some platforms the probe
  doesn't speak, and reading the firewall would need privileges we don't ask
  for — a check that failed for lack of rights would report drift that isn't
  there. A line whose answer doesn't come back counts as undetermined too,
  rather than sending you to repair a machine nobody could look at.

  Checks run only when you ask, and every check a host needs travels in one
  command: nothing polls your fleet in the background.
- Hosts can be imported from an Ansible inventory, from Hosts → Add → Import an
  Ansible inventory. Both syntaxes are read — the INI-ish one and the YAML one —
  and which is which is decided from the file's content, since inventories are
  routinely called `hosts` or `prod` with no extension. `ansible_host`,
  `ansible_user` and `ansible_port` are picked up, with the same precedence
  Ansible itself applies: a value on the host's own line wins over its group's.
  Groups become tags, so `target tag: webservers` reaches them in fleet
  operations straight away. A line standing for many machines
  (`web[01:50].example.com`) is expanded, zero-padding included.

  Re-importing a changed inventory refreshes what it already created rather
  than adding a second copy of everything — matched on the inventory name, not
  on the address, because the address is exactly what an inventory edits when a
  machine moves. Your own edits survive: the label, the login, the folder and
  the credentials are yours, and a re-import only updates what the inventory
  owns. Renaming an entry in the inventory does create a new host, which is
  said here rather than left to be discovered.

  Anything the parser won't guess at — an alphabetic range, say — is listed
  with the reason instead of quietly dropped: a file that half-imported must
  not look complete.
- Redis connections can use TLS (`rediss://`), from a checkbox on the
  connection — and automatically for an imported ElastiCache group that has
  encryption in transit enabled.
- MongoDB connections can require TLS, with an optional path to a certificate
  bundle for servers whose authority isn't in the system trust store — which is
  what DocumentDB needs. Combining TLS with a tunnel additionally needs
  certificate checking turned off, because no certificate can match the tunnel's
  local address; the app says so instead of failing with a bare TLS error, and
  never makes that choice for you.
- A database connection can reach its server through AWS Session Manager
  instead of an SSH host, from the Tunnel picker on the connection form and in
  the AWS database import. Reaching a managed database no longer means keeping
  a bastion alive for it: the traffic still goes through an instance, but that
  instance needs no SSH server, no key of yours and no inbound port open — only
  the SSM agent and the IAM permission. Available for MySQL, PostgreSQL, Redis
  and MongoDB alike, which is what DocumentDB clusters wanted.

  A "Test the tunnel" button next to it opens a real session, tries one
  connection through it and closes it again, separating three answers rather
  than two: the tunnel reached the database, or it opened but the instance
  can't reach the database (a wrong endpoint or a security group — not
  credentials to go and re-check), or it never opened, with the CLI's own error
  and what to do about it. It sends nothing to the database, so it won't appear
  in its logs as a failed login.

  A connection that goes through a tunnel now says which one in the connections
  list, including for SSM. And when a tunnel dies under a live connection, the
  error says the tunnel went down rather than blaming the database for
  refusing.
- An Activity tab, answering "who did what, where, when" across the three
  trails the app already kept but could only be read separately: fleet runs,
  commands typed in a terminal, and session recordings. Filter by kind, by
  host, by period, or search the command text, then export what's on screen to
  CSV or JSON.

  The three sources keep their own files, their own caps and their own writers
  — nothing is merged on disk, so nothing has to be migrated the day one of
  them changes, and retention stays what each already applied. Command history
  gained a timestamp and a host to make this possible: entries written before
  that read as "date inconnue" rather than being given the date of the upgrade,
  and they sort last instead of being hidden by a period filter, because "we
  don't know when" and "nothing happened then" are different answers. A
  recording whose file has been moved or deleted is reported as missing rather
  than dropped from the list.
- Azure VMs and Google Cloud instances can be imported as hosts, alongside EC2,
  from Hosts → Add → Import from the cloud. Pick a subscription or a project,
  search by name, address, region, OS or tag, tick what you want. Addresses,
  location, power state and tags are filled in — plus the administrator login
  on Azure, which records one; GCP doesn't, so the batch login applies there.
  Labels and network tags both become tags, so `target tag: prod` reaches the
  imported fleet straight away.

  Re-importing refreshes what the provider owns — the address and the tags —
  and never touches what you decided: the label, the login, the port, the group
  and the credentials survive. Machines are matched on the provider's own
  resource identifier (the ARM id on Azure, the numeric instance id on GCP),
  which survives a rename, a restart and a change of address, so re-importing
  an account doesn't append a second copy of every machine.

  As with EC2, nothing asks for a cloud credential or stores one: every call
  goes through the `az` / `gcloud` CLI you already have configured, so your
  tenant, your MFA and your SSO keep working exactly as they do in your
  terminal.
- An Azure session that has expired can be renewed from inside the app, rather
  than being told to go and run `az login` in a terminal somewhere else. The
  error offers to sign in; the panel shows what the CLI prints while it waits,
  which is where the verification URL and, in device-code mode, the code
  itself appear. The tenant comes pre-filled from Azure's own error message,
  so there is no GUID to copy out of it.

  The same panel reaches a subscription in another directory, from "Add a
  subscription / switch account" — with a "sign out first" option, because
  `az login` otherwise reuses the cached account and you land on the same
  subscriptions again. Sign-in is the CLI's own: the token goes to `~/.azure`
  exactly as it would from a terminal, so your other tools see the same
  session, and this app still holds no credential of its own.
- Fourteen more keyboard shortcuts, all rebindable in Settings alongside the
  existing ones. `Ctrl` `1`…`8` go straight to a tab and `Ctrl` `9` to the last
  one, the way browsers do — until now the only way across was `Ctrl` `Tab`,
  one tab at a time. `Ctrl` `Shift` `E` reconnects the active tab, `Ctrl`
  `Shift` `S` starts or stops recording the session, `Ctrl` `Shift` `X` exports
  its scrollback, `Ctrl` `Shift` `B` turns broadcasting on and off, `Ctrl`
  `Shift` `N` opens a new host, and `Ctrl` `Shift` `O` / `A` / `Q` open fleet
  operations, activity and databases. All of them work from inside a terminal,
  which is where you are when you want them.

  On a French keyboard the number row needs `Shift` just to produce a digit, so
  `Ctrl` `1` used to be impossible to type. The digit shortcuts now read the
  physical key: `Ctrl` `1`, `Ctrl` `Shift` `1` and `Ctrl` `&` are the same
  shortcut, whichever layout you use.
- A Network diagnostics tab, from the sidebar next to fleet operations (or
  `Ctrl` `Shift` `D`). Pick an address, tick the checks — TCP, DNS, HTTP(S),
  ping, traceroute — and the machines to run them from: each one answers for
  itself, in a grid that fills in as results arrive. That is what separates
  "the service is down" from "that network can't reach it". Click any result
  to unfold the tool's own output.

  It also runs the other way round: from this machine against each of your
  saved hosts. That direction opens no SSH connection, so it still answers
  about a host that is itself the thing that has broken.

  Results say what they mean rather than pass or fail. A refusal (something
  answered and said no — you are on the right machine) is not a silence
  (nothing answered — a firewall, a security group, a missing route), an
  unresolved name is a DNS problem and not a network one, and a check no tool
  on that machine can perform says exactly that instead of looking like a
  failure — common in slim containers, which often ship no `ping` at all.
  Traceroute is reported as inconclusive when it doesn't complete, because most
  routers on the internet drop its probes: a trace full of asterisks says
  nothing about whether the destination is reachable.

  This replaces the "Test the reachability" dialog, which was one check of the
  same kind. Its two ways in still work: a host's menu opens the tab with that
  host preselected as the source, the command palette with this machine.
  Nothing is installed on any target — each check is a small script, so an SSH
  host, a Docker container, a Kubernetes pod and this machine all work without
  anything to set up.
- Several hosts can be edited at once, from "Sélectionner plusieurs hôtes…" in
  the Hosts panel: the login, the port, the group, the authentication, and tags
  to add or remove. Importing fifty machines from a subscription took one
  click; changing anything about them afterwards took fifty.

  **Only the fields you tick are written.** Everything else is left exactly as
  it is on each host, so an edit meant for the login can't quietly reset ports
  or groups — a write across fifty hosts is not something you undo by hand.
  Tags are added and removed rather than replaced, which keeps the labels an
  import wrote from the provider.
- The keychain says how many hosts authenticate with each key, and deleting one
  now names them and asks first. Removing a key used to break every host using
  it with nothing on screen to say which, or why — the kind of failure you
  spend an afternoon blaming on the server. Keys referenced by path rather than
  from the keychain aren't counted: those hosts keep working.
- Importing from Azure or GCP now also reports what has **disappeared**. Until
  now a re-import refreshed the machines still there and added the new ones,
  but a VM destroyed in the console stayed in your host list forever, and one
  created since the last import existed nowhere. The panel lists both, and can
  tick the new ones for you.

  It only speaks about the subscription or project you are looking at. A host
  imported from somewhere else — or before this existed — is counted and left
  alone rather than reported as gone: "not in this listing" is not the same
  claim as "no longer exists", and acting on the difference would eventually
  delete a live machine. Nothing is deleted for you in any case; the panel
  reports and you decide.

### Fixed
- Console windows no longer flash on Windows when something runs on this
  machine — a fleet run against the local terminal, a facts probe, a network
  diagnostic. Each target was its own process, so a run could open several in
  a row.
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
