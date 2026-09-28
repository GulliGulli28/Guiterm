//! Le trousseau vu par l'agent : les clés cochées, leur partie publique, les
//! hôtes qui les utilisent, et la clé privée au moment de signer. Même source
//! que les connexions de Guiterm (`ssh::authenticate`) : le contenu de la clé
//! dans le coffre déverrouillé, sinon dans le workspace, sinon le fichier
//! d'origine ; la phrase de passe dans le coffre.
use super::{AgentKey, KnownHost};
use crate::model::{AuthMethod, KeyId, PrivateKey as KeychainKey, Workspace};
use crate::vault::{self, SecretKind};
use russh::keys::decode_secret_key;
use russh::keys::ssh_key::{PrivateKey, PublicKey};

/// Le texte de la clé privée (PEM ou OpenSSH), où qu'il soit rangé.
pub fn key_content(key: &KeychainKey) -> Option<String> {
    vault::load_key_content(key.id)
        .ok()
        .flatten()
        .or_else(|| key.content.clone())
        .or_else(|| (!key.path.trim().is_empty()).then(|| std::fs::read_to_string(&key.path).ok()).flatten())
}

fn passphrase(key_id: KeyId) -> Option<String> {
    vault::load(key_id, SecretKind::KeyPassphrase).ok().flatten()
}

/// La partie publique : lue en clair dans une clé OpenSSH, même chiffrée ;
/// sinon (PEM ancien) en déchiffrant avec la phrase de passe enregistrée.
pub fn public_key(content: &str, passphrase: Option<&str>) -> Option<PublicKey> {
    if let Ok(k) = PrivateKey::from_openssh(content) {
        return Some(k.public_key().clone());
    }
    decode_secret_key(content, passphrase).ok().map(|k| k.public_key().clone())
}

/// Les hôtes du workspace qui s'authentifient avec cette clé.
fn hosts_using(workspace: &Workspace, key_id: KeyId) -> Vec<String> {
    workspace
        .hosts
        .iter()
        .filter(|h| matches!(&h.auth, AuthMethod::PrivateKey { key_id: Some(k), .. } if *k == key_id))
        .map(|h| h.id.to_string())
        .collect()
}

/// Les clés cochées pour l'agent, dans l'ordre du trousseau. Une clé
/// illisible (fichier disparu, PEM chiffré sans phrase de passe enregistrée)
/// est simplement absente.
pub fn agent_keys(workspace: &Workspace, enabled: &[KeyId]) -> Vec<AgentKey> {
    workspace
        .keychain
        .iter()
        .filter(|k| enabled.contains(&k.id))
        .filter_map(|k| {
            let content = key_content(k)?;
            let public = public_key(&content, passphrase(k.id).as_deref())?;
            Some(AgentKey { id: k.id.to_string(), name: k.name.clone(), public, hosts: hosts_using(workspace, k.id) })
        })
        .collect()
}

/// La clé privée, déchiffrée, pour signer.
pub fn private_key(workspace: &Workspace, key_id: &str) -> anyhow::Result<PrivateKey> {
    let id: KeyId = key_id.parse().map_err(|_| anyhow::anyhow!("identifiant de clé invalide"))?;
    let key = workspace
        .keychain
        .iter()
        .find(|k| k.id == id)
        .ok_or_else(|| anyhow::anyhow!("clé absente du trousseau"))?;
    let content = key_content(key).ok_or_else(|| anyhow::anyhow!("contenu de la clé « {} » introuvable", key.name))?;
    decode_secret_key(&content, passphrase(id).as_deref())
        .map_err(|e| anyhow::anyhow!("impossible de déchiffrer la clé « {} » (phrase de passe enregistrée ?) : {e}", key.name))
}

/// Les hôtes du workspace dont Guiterm a approuvé cette clé d'hôte.
pub fn hosts_with_key(workspace: &Workspace, host_key: &PublicKey) -> Vec<KnownHost> {
    let ids = crate::known_hosts::identities_with_key(host_key);
    workspace
        .hosts
        .iter()
        .filter(|h| ids.contains(&h.id.to_string()))
        .map(|h| KnownHost { id: h.id.to_string(), label: h.label.clone() })
        .collect()
}
