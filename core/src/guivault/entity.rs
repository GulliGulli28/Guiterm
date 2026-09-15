//! Correspondance entre les entités du workspace et les items d'un vault.
//!
//! Un item = une entité **avec ses secrets** (mot de passe, passphrase,
//! contenu de clé, variables d'environnement secrètes), sérialisée en JSON
//! puis chiffrée sous la clé du vault. Le serveur ne voit que le type.
//!
//! L'empreinte SHA-256 de ce JSON est ce qui dit « a changé depuis la dernière
//! synchronisation » — calculée à la volée, elle évite d'instrumenter les
//! dizaines de chemins qui modifient le workspace.
use crate::model::{Group, Host, PrivateKey, Snippet, SqlConnection, VaultId, Workspace};
use crate::vault::{self as local_vault, SecretKind};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use uuid::Uuid;

pub const TYPE_HOST: &str = "host";
pub const TYPE_GROUP: &str = "group";
pub const TYPE_SNIPPET: &str = "snippet";
pub const TYPE_KEY: &str = "key";
pub const TYPE_SQL: &str = "sql-connection";

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HostSecrets {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub password: Option<String>,
    /// Passphrase d'une clé référencée par chemin (une clé du trousseau
    /// porte la sienne dans son propre item).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub passphrase: Option<String>,
    /// Valeurs des variables d'environnement marquées secrètes.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub env: BTreeMap<String, String>,
}

/// Le contenu en clair d'un item, par type.
// `large_enum_variant` : un `Host` pèse plus qu'un `Group`, et alors ? Ces
// valeurs vivent le temps d'une synchronisation, jamais en tableau.
#[allow(clippy::large_enum_variant)]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum Payload {
    Host {
        host: Host,
        #[serde(default)]
        secrets: HostSecrets,
    },
    Group {
        group: Group,
    },
    Snippet {
        snippet: Snippet,
    },
    Key {
        key: PrivateKey,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        content: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        passphrase: Option<String>,
    },
    SqlConnection {
        connection: SqlConnection,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        password: Option<String>,
    },
}

impl Payload {
    pub fn item_type(&self) -> &'static str {
        match self {
            Payload::Host { .. } => TYPE_HOST,
            Payload::Group { .. } => TYPE_GROUP,
            Payload::Snippet { .. } => TYPE_SNIPPET,
            Payload::Key { .. } => TYPE_KEY,
            Payload::SqlConnection { .. } => TYPE_SQL,
        }
    }

    pub fn id(&self) -> Uuid {
        match self {
            Payload::Host { host, .. } => host.id,
            Payload::Group { group } => group.id,
            Payload::Snippet { snippet } => snippet.id,
            Payload::Key { key, .. } => key.id,
            Payload::SqlConnection { connection, .. } => connection.id,
        }
    }

    /// JSON canonique : l'ordre des champs est celui des structs, les maps
    /// sont des `BTreeMap` — deux clients produisent le même texte pour la
    /// même entité, donc la même empreinte.
    pub fn to_json(&self) -> anyhow::Result<String> {
        Ok(serde_json::to_string(self)?)
    }

    pub fn from_json(json: &[u8]) -> anyhow::Result<Self> {
        Ok(serde_json::from_slice(json)?)
    }
}

pub fn hash(json: &str) -> String {
    let h = Sha256::digest(json.as_bytes());
    h.iter().map(|b| format!("{b:02x}")).collect()
}

/// Une entité locale prête à être comparée/poussée.
#[derive(Debug, Clone)]
pub struct LocalEntity {
    pub id: Uuid,
    pub item_type: &'static str,
    pub vault_id: VaultId,
    pub json: String,
    pub hash: String,
}

/// Un hôte tel qu'il voyage : sans l'état observé (`last_facts`), qui
/// appartient à cette machine et changerait l'empreinte à chaque collecte.
fn portable_host(host: &Host) -> Host {
    let mut h = host.clone();
    h.last_facts = None;
    h.last_facts_at_ms = None;
    // Les valeurs secrètes sont dans `secrets.env`, jamais dans le JSON de
    // l'hôte (même règle que `workspace.json`).
    for v in &mut h.env_vars {
        if v.secret {
            v.value.clear();
        }
    }
    h
}

fn host_secrets(host: &Host) -> HostSecrets {
    let mut s = HostSecrets {
        password: local_vault::load(host.id, SecretKind::Password).ok().flatten(),
        passphrase: local_vault::load(host.id, SecretKind::KeyPassphrase).ok().flatten(),
        env: BTreeMap::new(),
    };
    for v in host.env_vars.iter().filter(|v| v.secret) {
        if let Ok(Some(val)) = local_vault::load_env_var(host.id, &v.key) {
            s.env.insert(v.key.clone(), val);
        }
    }
    s
}

/// Toutes les entités synchronisables du workspace, avec leurs secrets lus
/// depuis le coffre local. `personal` est le vault par défaut de ce qui n'a
/// pas d'affiliation explicite.
pub fn collect(workspace: &Workspace, personal: VaultId) -> anyhow::Result<Vec<LocalEntity>> {
    let vault_of = |id: Uuid| workspace.vault_bindings.get(&id).copied().unwrap_or(personal);
    let mut out = Vec::new();
    let mut push = |payload: Payload| -> anyhow::Result<()> {
        let json = payload.to_json()?;
        out.push(LocalEntity {
            id: payload.id(),
            item_type: payload.item_type(),
            vault_id: vault_of(payload.id()),
            hash: hash(&json),
            json,
        });
        Ok(())
    };
    for g in &workspace.groups {
        push(Payload::Group { group: g.clone() })?;
    }
    for k in &workspace.keychain {
        let content = k
            .content
            .clone()
            .or_else(|| local_vault::load_key_content(k.id).ok().flatten());
        push(Payload::Key {
            key: PrivateKey {
                content: None,
                ..k.clone()
            },
            content,
            passphrase: local_vault::load(k.id, SecretKind::KeyPassphrase).ok().flatten(),
        })?;
    }
    for s in &workspace.snippets {
        push(Payload::Snippet { snippet: s.clone() })?;
    }
    for h in &workspace.hosts {
        push(Payload::Host {
            host: portable_host(h),
            secrets: host_secrets(h),
        })?;
    }
    for c in &workspace.sql_connections {
        push(Payload::SqlConnection {
            connection: c.clone(),
            password: local_vault::load(c.id, SecretKind::SqlPassword).ok().flatten(),
        })?;
    }
    Ok(out)
}

fn upsert<T>(list: &mut Vec<T>, id: Uuid, id_of: impl Fn(&T) -> Uuid, value: T) {
    match list.iter_mut().find(|x| id_of(x) == id) {
        Some(slot) => *slot = value,
        None => list.push(value),
    }
}

fn set_secret(id: Uuid, kind: SecretKind, value: &Option<String>) {
    match value {
        Some(v) => {
            let _ = local_vault::store(id, kind, v);
        }
        None => {
            let _ = local_vault::delete(id, kind);
        }
    }
}

/// Écrit une entité venue du serveur dans le workspace et ses secrets dans
/// le coffre local. L'état observé d'un hôte déjà connu (`last_facts`) est
/// conservé : il n'a pas voyagé.
pub fn apply(workspace: &mut Workspace, payload: Payload) {
    match payload {
        Payload::Host { mut host, secrets } => {
            if let Some(existing) = workspace.host(host.id) {
                host.last_facts = existing.last_facts.clone();
                host.last_facts_at_ms = existing.last_facts_at_ms;
            }
            let id = host.id;
            set_secret(id, SecretKind::Password, &secrets.password);
            set_secret(id, SecretKind::KeyPassphrase, &secrets.passphrase);
            for v in host.env_vars.iter().filter(|v| v.secret) {
                match secrets.env.get(&v.key) {
                    Some(val) => {
                        let _ = local_vault::store_env_var(id, &v.key, val);
                    }
                    None => {
                        let _ = local_vault::delete_env_var(id, &v.key);
                    }
                }
            }
            upsert(&mut workspace.hosts, id, |h| h.id, host);
        }
        Payload::Group { group } => upsert(&mut workspace.groups, group.id, |g| g.id, group),
        Payload::Snippet { snippet } => upsert(&mut workspace.snippets, snippet.id, |s| s.id, snippet),
        Payload::Key {
            mut key,
            content,
            passphrase,
        } => {
            // Même règle que l'import local : le PEM va dans le coffre si un
            // mot de passe maître local est actif, sinon dans workspace.json.
            key.content = None;
            if let Some(c) = &content {
                if local_vault::is_unlocked() {
                    let _ = local_vault::store_key_content(key.id, c);
                } else {
                    key.content = Some(c.clone());
                }
            }
            set_secret(key.id, SecretKind::KeyPassphrase, &passphrase);
            upsert(&mut workspace.keychain, key.id, |k| k.id, key);
        }
        Payload::SqlConnection { connection, password } => {
            set_secret(connection.id, SecretKind::SqlPassword, &password);
            upsert(&mut workspace.sql_connections, connection.id, |c| c.id, connection);
        }
    }
}

/// Retire une entité (et ses secrets) suite à une pierre tombale ou à la
/// perte d'accès à son vault.
pub fn remove(workspace: &mut Workspace, item_type: &str, id: Uuid) {
    match item_type {
        TYPE_HOST => {
            if let Some(h) = workspace.host(id) {
                for v in h.env_vars.iter().filter(|v| v.secret) {
                    let _ = local_vault::delete_env_var(id, &v.key);
                }
            }
            workspace.hosts.retain(|h| h.id != id);
            let _ = local_vault::delete(id, SecretKind::Password);
            let _ = local_vault::delete(id, SecretKind::KeyPassphrase);
        }
        TYPE_GROUP => {
            workspace.groups.retain(|g| g.id != id);
            for h in &mut workspace.hosts {
                if h.group_id == Some(id) {
                    h.group_id = None;
                }
            }
        }
        TYPE_SNIPPET => workspace.snippets.retain(|s| s.id != id),
        TYPE_KEY => {
            workspace.keychain.retain(|k| k.id != id);
            let _ = local_vault::delete_key_content(id);
            let _ = local_vault::delete(id, SecretKind::KeyPassphrase);
        }
        TYPE_SQL => {
            workspace.sql_connections.retain(|c| c.id != id);
            let _ = local_vault::delete(id, SecretKind::SqlPassword);
        }
        _ => {}
    }
    workspace.vault_bindings.remove(&id);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_payload_is_stable_and_strips_observed_state() {
        let mut host = Host::new("db", "10.0.0.1", "root");
        host.last_facts_at_ms = Some(42);
        let p = Payload::Host {
            host: portable_host(&host),
            secrets: HostSecrets::default(),
        };
        let json = p.to_json().unwrap();
        assert!(!json.contains("42"));
        assert_eq!(hash(&json), hash(&Payload::from_json(json.as_bytes()).unwrap().to_json().unwrap()));
        assert_eq!(p.item_type(), TYPE_HOST);
        assert_eq!(p.id(), host.id);
    }

    #[test]
    fn apply_then_collect_roundtrips_without_secret_store() {
        let mut ws = Workspace::default();
        let vault = Uuid::new_v4();
        let host = Host::new("web", "example.org", "deploy");
        apply(&mut ws, Payload::Host { host: host.clone(), secrets: HostSecrets::default() });
        apply(&mut ws, Payload::Group { group: Group { id: Uuid::new_v4(), name: "g".into(), parent_id: None, icon: None, color: None } });
        let all = collect(&ws, vault).unwrap();
        assert_eq!(all.len(), 2);
        assert!(all.iter().all(|e| e.vault_id == vault));
        let h = all.iter().find(|e| e.item_type == TYPE_HOST).unwrap();
        assert_eq!(h.id, host.id);
        remove(&mut ws, TYPE_HOST, host.id);
        assert!(ws.hosts.is_empty());
    }
}
