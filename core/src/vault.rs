//! Secret storage for passwords and key passphrases. Two backends:
//!
//! - **Default (keychain):** the OS keychain (Keychain / Credential Manager /
//!   Secret Service), with a process-lifetime in-memory fallback when it is
//!   unavailable (headless Linux / WSL without Secret Service). On restart the
//!   user re-enters the password once.
//! - **Opt-in master-password vault:** once the user sets a master password, an
//!   encrypted file ([`crate::master_vault`]) supersedes the keychain. It is
//!   portable (safe to sync between machines) and works where no OS keychain
//!   exists — but is only readable while unlocked.
//!
//! `store`/`load`/`delete` keep the same signature in both modes, so callers
//! (`ssh::authenticate`, `commands::hosts`) don't care which backend is active.
use crate::master_vault::MasterVault;
use crate::model::{HostId, KeyId};
use crate::sync_ext::MutexExt;
use keyring::Entry;
use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

const SERVICE: &str = "gui-termius";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SecretKind {
    Password,
    KeyPassphrase,
}

impl SecretKind {
    fn suffix(self) -> &'static str {
        match self {
            SecretKind::Password => "password",
            SecretKind::KeyPassphrase => "passphrase",
        }
    }
}

/// Whether the master-password vault is configured, and if so whether it is
/// currently unlocked. Reported to the frontend so it can prompt for unlock.
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultStatus {
    pub enabled: bool,
    pub unlocked: bool,
}

// ─── Backend state ──────────────────────────────────────────────────────────

enum Backend {
    /// No master password set: secrets live in the OS keychain (+ fallback map).
    Keychain,
    /// A master-vault file exists but hasn't been unlocked this session.
    Locked,
    /// Unlocked master vault held in memory (the data key is zeroized on drop).
    Unlocked(Box<MasterVault>),
}

fn state() -> &'static Mutex<Backend> {
    static STATE: OnceLock<Mutex<Backend>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(initial_backend()))
}

fn initial_backend() -> Backend {
    match vault_file() {
        Ok(p) if MasterVault::exists(&p) => Backend::Locked,
        _ => Backend::Keychain,
    }
}

fn vault_file() -> anyhow::Result<PathBuf> {
    let dirs = directories::ProjectDirs::from("dev", "gui-termius", "gui-termius")
        .ok_or_else(|| anyhow::anyhow!("could not determine config directory"))?;
    Ok(dirs.config_dir().join("secrets.enc"))
}

fn secret_key(host_id: HostId, kind: SecretKind) -> String {
    format!("{host_id}:{}", kind.suffix())
}

/// Key for a secret that isn't scoped to any host — e.g. an API key used by
/// the app itself rather than for authenticating to a remote. Namespaced
/// (`global:`) so it can never collide with a `{host_id}:{suffix}` key —
/// `host_id` is a UUID, which never contains a literal `:`.
fn global_key(name: &str) -> String {
    format!("global:{name}")
}

const ANTHROPIC_API_KEY: &str = "anthropic-api-key";

// ─── Public secret API (backend-agnostic) ───────────────────────────────────

pub fn store(host_id: HostId, kind: SecretKind, secret: &str) -> anyhow::Result<()> {
    store_raw(&secret_key(host_id, kind), secret)
}

pub fn load(host_id: HostId, kind: SecretKind) -> anyhow::Result<Option<String>> {
    load_raw(&secret_key(host_id, kind))
}

pub fn delete(host_id: HostId, kind: SecretKind) -> anyhow::Result<()> {
    delete_raw(&secret_key(host_id, kind))
}

/// Stores the Anthropic API key used by the adaptive-snippet engine (see
/// `crate::adaptive`) — not tied to any host, so it goes through the same
/// backend (keychain or master vault) under a namespaced global key rather
/// than a new storage mechanism.
pub fn store_anthropic_api_key(secret: &str) -> anyhow::Result<()> {
    store_raw(&global_key(ANTHROPIC_API_KEY), secret)
}

pub fn load_anthropic_api_key() -> anyhow::Result<Option<String>> {
    load_raw(&global_key(ANTHROPIC_API_KEY))
}

pub fn delete_anthropic_api_key() -> anyhow::Result<()> {
    delete_raw(&global_key(ANTHROPIC_API_KEY))
}

fn store_raw(key: &str, secret: &str) -> anyhow::Result<()> {
    let mut st = state().lock_recover();
    match &mut *st {
        Backend::Unlocked(vault) => vault.set(key, secret),
        Backend::Locked => {
            anyhow::bail!("coffre verrouillé — déverrouillez-le avant d'enregistrer un secret")
        }
        Backend::Keychain => keychain_store(key, secret),
    }
}

fn load_raw(key: &str) -> anyhow::Result<Option<String>> {
    let st = state().lock_recover();
    match &*st {
        Backend::Unlocked(vault) => vault.get(key),
        Backend::Locked => {
            anyhow::bail!("coffre verrouillé — déverrouillez-le pour utiliser ce secret")
        }
        Backend::Keychain => keychain_load(key),
    }
}

fn delete_raw(key: &str) -> anyhow::Result<()> {
    let mut st = state().lock_recover();
    match &mut *st {
        Backend::Unlocked(vault) => vault.remove(key),
        // Removing a slot while locked would need the file rewritten; the stale
        // encrypted entry is harmless, so defer rather than fail unrelated edits
        // (e.g. `save_host` cleaning up an old auth slot).
        Backend::Locked => Ok(()),
        Backend::Keychain => keychain_delete(key),
    }
}

// ─── Private-key PEM content ─────────────────────────────────────────────────
//
// Unlike passwords/passphrases, private-key content lives in `workspace.json`
// (0600) by default rather than the OS keychain — the keychain has size limits
// (Windows CredWrite caps the blob) and its WSL fallback wouldn't survive a
// restart. When the master vault is unlocked it holds the key content instead
// (encrypted, no size limit, persistent), so these functions only ever touch
// the vault; the caller keeps managing the `workspace.json` copy for keychain
// mode.

fn key_content_id(key_id: KeyId) -> String {
    format!("{key_id}:content")
}

/// The encrypted key content from the vault, or `None` when the vault isn't the
/// active store (keychain mode / locked) — the caller then falls back to the
/// `workspace.json` copy.
pub fn load_key_content(key_id: KeyId) -> anyhow::Result<Option<String>> {
    match &*state().lock_recover() {
        Backend::Unlocked(vault) => vault.get(&key_content_id(key_id)),
        _ => Ok(None),
    }
}

/// Stores key content in the vault. Requires the vault to be unlocked (callers
/// gate on [`is_unlocked`]); in keychain mode the content stays in `workspace.json`.
pub fn store_key_content(key_id: KeyId, content: &str) -> anyhow::Result<()> {
    match &mut *state().lock_recover() {
        Backend::Unlocked(vault) => vault.set(&key_content_id(key_id), content),
        _ => anyhow::bail!("coffre non déverrouillé"),
    }
}

pub fn delete_key_content(key_id: KeyId) -> anyhow::Result<()> {
    match &mut *state().lock_recover() {
        Backend::Unlocked(vault) => vault.remove(&key_content_id(key_id)),
        _ => Ok(()),
    }
}

/// Whether the master vault is currently unlocked (so key content should be
/// routed through it rather than `workspace.json`).
pub fn is_unlocked() -> bool {
    matches!(&*state().lock_recover(), Backend::Unlocked(_))
}

// ─── Master-vault management ─────────────────────────────────────────────────

pub fn status() -> VaultStatus {
    match &*state().lock_recover() {
        Backend::Keychain => VaultStatus { enabled: false, unlocked: false },
        Backend::Locked => VaultStatus { enabled: true, unlocked: false },
        Backend::Unlocked(_) => VaultStatus { enabled: true, unlocked: true },
    }
}

/// Turns on the master-password vault: creates the encrypted file, moves the
/// given secrets into it, and clears them from the OS keychain. `migrate` is
/// collected by the caller (which knows the workspace) *before* calling this,
/// while the keychain backend is still active.
pub fn enable(password: &str, migrate: &[(HostId, SecretKind, String)]) -> anyhow::Result<()> {
    let mut st = state().lock_recover();
    if !matches!(&*st, Backend::Keychain) {
        anyhow::bail!("un mot de passe maître est déjà configuré");
    }
    let mut vault = MasterVault::create(&vault_file()?, password)?;
    for (id, kind, secret) in migrate {
        vault.set(&secret_key(*id, *kind), secret)?;
    }
    *st = Backend::Unlocked(Box::new(vault));
    drop(st);
    // The secrets now live (encrypted) in the vault; remove the keychain copies.
    for (id, kind, _) in migrate {
        let _ = keychain_delete(&secret_key(*id, *kind));
    }
    Ok(())
}

/// Unlocks the vault for this session. No-op if already unlocked; errors on a
/// wrong password.
pub fn unlock(password: &str) -> anyhow::Result<()> {
    let mut st = state().lock_recover();
    if matches!(&*st, Backend::Unlocked(_)) {
        return Ok(());
    }
    let vault = MasterVault::unlock(&vault_file()?, password)?;
    *st = Backend::Unlocked(Box::new(vault));
    Ok(())
}

/// Drops the in-memory data key (manual lock or auto-lock). Secrets become
/// unreadable until unlocked again.
pub fn lock() {
    let mut st = state().lock_recover();
    if matches!(&*st, Backend::Unlocked(_)) {
        *st = Backend::Locked;
    }
}

/// Changes the master password (verifying `current` first). Cheap — only the
/// wrapped data key is re-derived, not every secret.
pub fn change_password(current: &str, new: &str) -> anyhow::Result<()> {
    // Verify `current` by re-unlocking from disk regardless of session state.
    let mut vault = MasterVault::unlock(&vault_file()?, current)?;
    vault.change_password(new)?;
    *state().lock_recover() = Backend::Unlocked(Box::new(vault));
    Ok(())
}

/// Turns the master vault back off: verifies `current`, restores the given
/// secrets to the OS keychain, and deletes the encrypted file. `migrate` is
/// collected by the caller from the (still unlocked) vault before calling this.
pub fn disable(current: &str, migrate: &[(HostId, SecretKind, String)]) -> anyhow::Result<()> {
    MasterVault::unlock(&vault_file()?, current)?; // verify current password
    let mut st = state().lock_recover();
    *st = Backend::Keychain;
    let _ = std::fs::remove_file(vault_file()?);
    drop(st);
    for (id, kind, secret) in migrate {
        keychain_store(&secret_key(*id, *kind), secret)?;
    }
    Ok(())
}

// ─── OS keychain backend ─────────────────────────────────────────────────────

fn entry(key: &str) -> Result<Entry, keyring::Error> {
    Entry::new(SERVICE, key)
}

fn fallback() -> &'static Mutex<HashMap<String, String>> {
    static STORE: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    STORE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn keychain_store(key: &str, secret: &str) -> anyhow::Result<()> {
    let keychain_ok = entry(key).and_then(|e| e.set_password(secret)).is_ok();
    if !keychain_ok {
        tracing::debug!("OS keychain unavailable, storing secret for {key} in process memory");
        fallback().lock_recover().insert(key.to_owned(), secret.to_owned());
    }
    Ok(())
}

fn keychain_load(key: &str) -> anyhow::Result<Option<String>> {
    match entry(key).and_then(|e| e.get_password()) {
        Ok(secret) => Ok(Some(secret)),
        Err(keyring::Error::NoEntry) => Ok(fallback().lock_recover().get(key).cloned()),
        Err(err) => {
            tracing::debug!("OS keychain unavailable for load ({err}), checking process memory");
            Ok(fallback().lock_recover().get(key).cloned())
        }
    }
}

fn keychain_delete(key: &str) -> anyhow::Result<()> {
    fallback().lock_recover().remove(key);
    match entry(key) {
        Ok(e) => match e.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(err) => Err(err.into()),
        },
        Err(_) => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    // These exercise the keychain backend (the default). On machines with a
    // working OS keychain they round-trip through the real Credential Manager /
    // Keychain / Secret Service; otherwise through the in-memory fallback. Each
    // test uses a random host_id so runs never collide, and cleans up after
    // itself. The master-vault backend is covered in `crate::master_vault`.

    #[test]
    fn load_missing_secret_returns_none() {
        let host_id = Uuid::new_v4();
        assert!(load(host_id, SecretKind::Password).unwrap().is_none());
    }

    #[test]
    fn store_then_load_roundtrips() {
        let host_id = Uuid::new_v4();
        store(host_id, SecretKind::Password, "hunter2").unwrap();
        assert_eq!(load(host_id, SecretKind::Password).unwrap().as_deref(), Some("hunter2"));
        delete(host_id, SecretKind::Password).unwrap();
        assert!(load(host_id, SecretKind::Password).unwrap().is_none());
    }

    #[test]
    fn password_and_passphrase_are_independent() {
        let host_id = Uuid::new_v4();
        store(host_id, SecretKind::Password, "pw-secret").unwrap();
        store(host_id, SecretKind::KeyPassphrase, "passphrase-secret").unwrap();
        assert_eq!(load(host_id, SecretKind::Password).unwrap().as_deref(), Some("pw-secret"));
        assert_eq!(load(host_id, SecretKind::KeyPassphrase).unwrap().as_deref(), Some("passphrase-secret"));
        delete(host_id, SecretKind::Password).unwrap();
        delete(host_id, SecretKind::KeyPassphrase).unwrap();
    }

    #[test]
    fn delete_is_idempotent_for_missing_entry() {
        let host_id = Uuid::new_v4();
        assert!(delete(host_id, SecretKind::Password).is_ok());
        assert!(delete(host_id, SecretKind::Password).is_ok());
    }

    #[test]
    fn overwriting_a_secret_replaces_it() {
        let host_id = Uuid::new_v4();
        store(host_id, SecretKind::Password, "first").unwrap();
        store(host_id, SecretKind::Password, "second").unwrap();
        assert_eq!(load(host_id, SecretKind::Password).unwrap().as_deref(), Some("second"));
        delete(host_id, SecretKind::Password).unwrap();
    }

    #[test]
    fn key_content_falls_back_when_no_vault_is_unlocked() {
        // Without an unlocked master vault (the default: keychain mode), key
        // content is never in the vault — `load_key_content` returns None so the
        // caller (ssh::authenticate) falls back to the workspace/file copy, and
        // storing into the vault is refused. `delete` is a harmless no-op.
        let key_id = Uuid::new_v4();
        assert!(!is_unlocked());
        assert!(load_key_content(key_id).unwrap().is_none());
        assert!(store_key_content(key_id, "-----BEGIN KEY-----").is_err());
        assert!(delete_key_content(key_id).is_ok());
    }
}
