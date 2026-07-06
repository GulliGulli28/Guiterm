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
    Mismatch { previous_fingerprint: String },
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
        .ok_or_else(|| anyhow::anyhow!("could not determine config directory"))?;
    Ok(dirs.config_dir().join("known_hosts.json"))
}

fn read() -> Store {
    path()
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn write(store: &Store) -> anyhow::Result<()> {
    let p = path()?;
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(p, serde_json::to_string_pretty(store)?)?;
    Ok(())
}

/// Checks `key` against the stored key for `identity` (the workspace host's stable ID),
/// trusting it automatically the first time it is seen. `label` is stored alongside for
/// display purposes and refreshed on every trusted connection (e.g. after a rename).
pub fn check_and_trust(identity: &str, label: &str, key: &PublicKey) -> anyhow::Result<Verdict> {
    let encoded = key.to_openssh()?;
    let mut store = read();
    match store.0.get(identity) {
        Some(entry) if entry.public_key == encoded => {
            if entry.label != label {
                store.0.insert(identity.to_string(), Entry { label: label.to_string(), public_key: encoded });
                write(&store)?;
            }
            Ok(Verdict::AlreadyTrusted)
        },
        Some(entry) => {
            let previous_fingerprint = PublicKey::from_openssh(&entry.public_key)
                .map(|k| k.fingerprint(HashAlg::Sha256).to_string())
                .unwrap_or_else(|_| entry.public_key.clone());
            Ok(Verdict::Mismatch { previous_fingerprint })
        },
        None => {
            store.0.insert(identity.to_string(), Entry { label: label.to_string(), public_key: encoded });
            write(&store)?;
            Ok(Verdict::NewlyTrusted)
        },
    }
}

/// Lists every trusted `(identity, label, openssh-encoded public key)`, sorted by label.
pub fn list() -> Vec<(String, String, String)> {
    let mut entries: Vec<(String, String, String)> =
        read().0.into_iter().map(|(identity, entry)| (identity, entry.label, entry.public_key)).collect();
    entries.sort_by(|a, b| a.1.cmp(&b.1));
    entries
}

/// Revokes trust for `identity` — the next connection to it will be treated as newly seen.
pub fn remove(identity: &str) -> anyhow::Result<()> {
    let mut store = read();
    store.0.remove(identity);
    write(&store)
}
