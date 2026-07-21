# Security Policy

## Reporting a vulnerability

Please **don't** open a public issue for a security vulnerability — report
it privately instead, using GitHub's private vulnerability reporting:
[open a security advisory](https://github.com/GulliGulli28/Guiterm/security/advisories/new)
(Security tab → "Report a vulnerability"). It's visible only to the
maintainer until a fix ships, and gives you a private thread to share
reproduction details, logs, or a proof of concept without exposing them
publicly in the meantime.

Include enough to reproduce the issue: affected version/platform, steps,
and the impact you think it has.

## Scope

Guiterm stores SSH/RDP credentials and, optionally, an encrypted secrets
vault on the user's machine, and connects out to hosts the user configures.
In scope:
- The credential/secrets storage path — OS keychain fallback, and the
  encrypted vault (Argon2id + XChaCha20-Poly1305 envelope DEK/KEK scheme,
  `core/src/{vault,crypto,master_vault}.rs`).
- SSH/SFTP/RDP/Docker-exec/K8s-exec protocol handling and authentication.
- How imported configuration (`workspace.json` import/export,
  `core/src/export.rs`) is trusted — e.g. whether an untrusted import file
  can cause code/commands to run without the user reviewing them first.

Out of scope: vulnerabilities that require the attacker to already have
arbitrary code execution on the user's machine (at that point the OS
keychain/vault are no stronger than any other local secret store).

## Dependency vulnerabilities

Third-party dependency advisories are scanned automatically
(`.github/workflows/security.yml`: `cargo audit` + `npm audit`, on every
push/PR and weekly). Known, reviewed exceptions are tracked in
`.cargo/audit.toml` — check there before re-reporting one of those.

## Supported versions

Guiterm doesn't maintain multiple release branches — only the latest
release is supported. Please update before reporting.
