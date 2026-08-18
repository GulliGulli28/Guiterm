//! Trust-on-first-use host key verification, similar in spirit to `~/.ssh/known_hosts`.
//! The first time we see a host's key we record it; on later connections a different
//! key for the same identity is treated as a possible MITM and rejected.
//!
//! Entries are keyed by the workspace host's stable ID rather than `address:port`:
//! private IP ranges are routinely reused across separate environments (dev/qua/prod
//! VPCs, each behind their own bastion), so two distinct workspace hosts can share the
//! same address without actually being the same machine.
use russh::keys::ssh_key::{HashAlg, PublicKey};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    AlreadyTrusted,
    NewlyTrusted,
    /// A different key was already trusted for this identity. Carries the
    /// previously-trusted key's fingerprint so callers can surface a precise
    /// "the host key changed" message instead of a generic rejection.
    Mismatch {
        previous_fingerprint: String,
    },
}

#[derive(Serialize, Deserialize, Clone)]
struct Entry {
    /// Human-readable label (host name + address:port) shown in the Known Hosts panel.
    label: String,
    public_key: String,
}

#[derive(Default, Serialize, Deserialize)]
struct Store(HashMap<String, Entry>);

fn path() -> anyhow::Result<PathBuf> {
    let dirs = directories::ProjectDirs::from("dev", "gui-termius", "gui-termius")
        .ok_or_else(|| anyhow::anyhow!("impossible de déterminer le dossier de configuration"))?;
    Ok(dirs.config_dir().join("known_hosts.json"))
}

fn read_at(p: &std::path::Path) -> anyhow::Result<Store> {
    match std::fs::read_to_string(p) {
        Ok(raw) => serde_json::from_str(&raw).map_err(|e| {
            anyhow::anyhow!(
                "known_hosts.json est corrompu ({e}) — connexion refusée par sécurité plutôt que \
                 de re-faire confiance aveuglément à toutes les clés d'hôte (fenêtre d'usurpation MITM)"
            )
        }),
        // A missing file is the legitimate first-run case: nothing trusted yet.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Store::default()),
        // Any other read error (e.g. permissions) must NOT silently degrade to an
        // empty store: that would make every host look newly-seen and get its key
        // auto-trusted on the next connection, defeating the MITM protection.
        Err(e) => Err(anyhow::anyhow!("impossible de lire known_hosts.json : {e}")),
    }
}

fn read() -> anyhow::Result<Store> {
    read_at(&path()?)
}

fn write(store: &Store) -> anyhow::Result<()> {
    let p = path()?;
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent)?;
    }
    crate::secure_file::write_private(&p, serde_json::to_string_pretty(store)?.as_bytes())?;
    Ok(())
}

/// Checks `key` against the stored key for `identity` (the workspace host's stable ID),
/// trusting it automatically the first time it is seen. `label` is stored alongside for
/// display purposes and refreshed on every trusted connection (e.g. after a rename).
pub fn check_and_trust(identity: &str, label: &str, key: &PublicKey) -> anyhow::Result<Verdict> {
    let encoded = key.to_openssh()?;
    let mut store = read()?;
    match store.0.get(identity) {
        Some(entry) if entry.public_key == encoded => {
            if entry.label != label {
                store.0.insert(
                    identity.to_string(),
                    Entry {
                        label: label.to_string(),
                        public_key: encoded,
                    },
                );
                write(&store)?;
            }
            Ok(Verdict::AlreadyTrusted)
        }
        Some(entry) => {
            let previous_fingerprint = PublicKey::from_openssh(&entry.public_key)
                .map(|k| k.fingerprint(HashAlg::Sha256).to_string())
                .unwrap_or_else(|_| entry.public_key.clone());
            Ok(Verdict::Mismatch {
                previous_fingerprint,
            })
        }
        None => {
            store.0.insert(
                identity.to_string(),
                Entry {
                    label: label.to_string(),
                    public_key: encoded,
                },
            );
            write(&store)?;
            Ok(Verdict::NewlyTrusted)
        }
    }
}

/// Lists every trusted `(identity, label, openssh-encoded public key)`, sorted by label.
pub fn list() -> Vec<(String, String, String)> {
    // Listing is display-only, not a trust decision, so an unreadable store just
    // shows as empty here rather than erroring.
    let mut entries: Vec<(String, String, String)> = read()
        .unwrap_or_default()
        .0
        .into_iter()
        .map(|(identity, entry)| (identity, entry.label, entry.public_key))
        .collect();
    entries.sort_by(|a, b| a.1.cmp(&b.1));
    entries
}

/// Revokes trust for `identity` — the next connection to it will be treated as newly seen.
pub fn remove(identity: &str) -> anyhow::Result<()> {
    let mut store = read()?;
    store.0.remove(identity);
    write(&store)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn missing_file_is_empty_store_on_first_run() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("known_hosts.json");
        assert!(read_at(&p).unwrap().0.is_empty());
    }

    #[test]
    fn corrupt_store_is_rejected_not_silently_emptied() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("known_hosts.json");
        std::fs::File::create(&p)
            .unwrap()
            .write_all(b"{ this is not valid json")
            .unwrap();
        // Fail-closed: a corrupt trust store must surface an error. If it silently
        // became an empty store, the next connection to every host would treat its
        // key as newly-seen and auto-trust it — a MITM opening.
        assert!(read_at(&p).is_err());
    }

    #[test]
    fn valid_store_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("known_hosts.json");
        let mut store = Store::default();
        store.0.insert(
            "host-id-1".to_string(),
            Entry {
                label: "web (10.0.0.1:22)".to_string(),
                public_key: "ssh-ed25519 AAAAC3Nz".to_string(),
            },
        );
        std::fs::write(&p, serde_json::to_string(&store).unwrap()).unwrap();

        let loaded = read_at(&p).unwrap();
        assert_eq!(loaded.0.get("host-id-1").unwrap().label, "web (10.0.0.1:22)");
    }
}
