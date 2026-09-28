//! L'agent SSH de Guiterm, adossé au trousseau (et donc au coffre GuiVault) :
//! `ssh`, `git`, `scp`… lancés hors de Guiterm lui demandent de signer, et
//! les clés ne quittent jamais l'application.
//!
//! Ce qui le distingue d'un agent ordinaire :
//!
//! - **la bonne clé pour le bon hôte.** Un client OpenSSH récent annonce à
//!   quel serveur il est connecté (`session-bind@openssh.com` : la clé d'hôte
//!   et sa signature sur l'id de session, vérifiée ici). Guiterm reconnaît
//!   l'hôte à sa clé (ses `known_hosts`) et ne présente que la clé que cet
//!   hôte utilise — pas toutes les clés l'une après l'autre jusqu'au
//!   « Too many authentication failures » ;
//! - **une confirmation à chaque usage** (ou pour 10 minutes par clé), qui
//!   dit ce qui est signé : une connexion SSH (à quel hôte, sous quel
//!   utilisateur), un commit Git (`SSHSIG`, espace de noms `git`), autre
//!   chose — et qui le demande ;
//! - **rien n'y entre** : les clés viennent du trousseau, cochées une à une
//!   dans les réglages ; ajouter, retirer ou verrouiller des clés par le
//!   protocole est refusé.
//!
//! `core` n'a pas d'interface : la confirmation est demandée à un
//! [`Backend`] que `src-tauri` fournit (fenêtre de confirmation), comme
//! [`crate::interactive_auth`] pour les questions d'une authentification.
pub mod keyring;
pub mod protocol;
pub mod purpose;
pub mod server;
pub mod settings;

use protocol::Request;
use purpose::Purpose;
use russh::keys::signature::{Signer, Verifier};
use russh::keys::ssh_encoding::Encode;
use russh::keys::ssh_key::private::KeypairData;
use russh::keys::ssh_key::{HashAlg, PrivateKey, PublicKey, Signature};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::sync_ext::MutexExt;

/// Les types de clés que le [`Backend`] manipule, pour qui ne dépend pas de
/// `russh` (`src-tauri`).
pub use russh::keys::ssh_key::{PrivateKey as SshPrivateKey, PublicKey as SshPublicKey};

/// Combien de temps « ne plus demander pour cette clé » vaut.
pub const REMEMBER_FOR: Duration = Duration::from_secs(10 * 60);

/// Une clé que l'agent peut utiliser.
#[derive(Clone, Debug)]
pub struct AgentKey {
    /// L'id de la clé dans le trousseau.
    pub id: String,
    pub name: String,
    pub public: PublicKey,
    /// Les hôtes Guiterm (leurs ids) qui s'authentifient avec cette clé.
    pub hosts: Vec<String>,
}

/// Un hôte Guiterm reconnu à sa clé d'hôte.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnownHost {
    pub id: String,
    pub label: String,
}

/// Qui demande, quand le système le dit (Linux : le processus au bout de la
/// socket).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Client {
    pub pid: Option<u32>,
    pub program: Option<String>,
}

/// Ce qui est signé, dit pour l'utilisateur.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum UsePurpose {
    /// Une connexion SSH ; `hosts` vide : serveur inconnu de Guiterm (ou
    /// client qui ne l'a pas annoncé), `fingerprint` : sa clé d'hôte, quand
    /// on la connaît.
    SshLogin { user: String, hosts: Vec<KnownHost>, fingerprint: Option<String> },
    /// Un commit ou une étiquette Git signés (`SSHSIG`, espace `git`).
    GitSignature,
    /// Une autre signature `SSHSIG` (`ssh-keygen -Y sign -n <namespace>`).
    Sshsig { namespace: String },
    Unknown,
}

/// La question posée à l'utilisateur.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UseRequest {
    pub key_id: String,
    pub key_name: String,
    pub key_fingerprint: String,
    pub purpose: UsePurpose,
    pub client: Client,
    /// La demande vient d'un hôte distant par un agent transféré.
    pub forwarded: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct Decision {
    pub allow: bool,
    /// Ne plus demander pour cette clé pendant [`REMEMBER_FOR`].
    pub remember: bool,
}

/// Ce que l'agent demande à l'application : les clés, les hôtes, les clés
/// privées au moment de signer, et l'accord de l'utilisateur.
#[async_trait::async_trait]
pub trait Backend: Send + Sync {
    /// Les clés cochées pour l'agent, dans l'ordre où les proposer.
    fn keys(&self) -> Vec<AgentKey>;
    /// Les hôtes dont Guiterm a déjà vu (et approuvé) cette clé d'hôte.
    fn hosts_with_key(&self, host_key: &PublicKey) -> Vec<KnownHost>;
    /// La clé privée, déchiffrée, au moment de signer.
    fn private_key(&self, key_id: &str) -> anyhow::Result<PrivateKey>;
    async fn confirm(&self, request: UseRequest) -> Decision;
}

/// Ce que le client a annoncé de son serveur, vérifié.
#[derive(Clone, Debug)]
pub struct Binding {
    pub host_key: PublicKey,
    pub session_id: Vec<u8>,
    pub forwarding: bool,
    pub hosts: Vec<KnownHost>,
}

/// L'état d'une connexion d'un client à l'agent.
#[derive(Default)]
pub struct Session {
    pub client: Client,
    /// Une par saut (`ProxyJump`) : la dernière est la destination.
    pub bindings: Vec<Binding>,
}

/// Les clés à présenter : celles des hôtes reconnus au dernier
/// `session-bind`, s'il y en a ; sinon toutes.
pub fn presented(keys: Vec<AgentKey>, bound: &[KnownHost]) -> Vec<AgentKey> {
    if bound.is_empty() {
        return keys;
    }
    let for_host: Vec<AgentKey> = keys
        .iter()
        .filter(|k| k.hosts.iter().any(|h| bound.iter().any(|b| &b.id == h)))
        .cloned()
        .collect();
    if for_host.is_empty() { keys } else { for_host }
}

/// La signature d'un hôte sur l'id de session : ce qui prouve que la clé
/// d'hôte annoncée est bien celle du serveur de cette session — sans quoi un
/// processus local pourrait faire afficher le nom d'un hôte de confiance.
pub fn verify_binding(host_key: &[u8], session_id: &[u8], signature: &[u8]) -> Option<PublicKey> {
    let key = PublicKey::from_bytes(host_key).ok()?;
    let sig = Signature::try_from(signature).ok()?;
    Verifier::verify(&key, session_id, &sig).ok()?;
    Some(key)
}

/// Signe `data` avec `key`. RSA : l'algorithme de hachage que le client
/// demande (`rsa-sha2-512`, `rsa-sha2-256`, sinon l'ancien `ssh-rsa`).
pub fn sign(key: &PrivateKey, data: &[u8], flags: u32) -> anyhow::Result<Vec<u8>> {
    let sig: Signature = match key.key_data() {
        KeypairData::Rsa(rsa) => {
            let hash = if flags & protocol::RSA_SHA2_512 != 0 {
                Some(HashAlg::Sha512)
            } else if flags & protocol::RSA_SHA2_256 != 0 {
                Some(HashAlg::Sha256)
            } else {
                None
            };
            Signer::try_sign(&(rsa, hash), data).map_err(|e| anyhow::anyhow!("signature RSA impossible : {e}"))?
        }
        keypair => Signer::try_sign(keypair, data).map_err(|e| anyhow::anyhow!("signature impossible : {e}"))?,
    };
    sig.encode_vec().map_err(|e| anyhow::anyhow!("signature illisible : {e}"))
}

/// L'agent : le protocole au-dessus d'un [`Backend`], et les accords
/// « pour 10 minutes » en mémoire.
pub struct Agent {
    backend: Arc<dyn Backend>,
    remembered: Mutex<HashMap<String, Instant>>,
}

impl Agent {
    pub fn new(backend: Arc<dyn Backend>) -> Self {
        Self { backend, remembered: Mutex::new(HashMap::new()) }
    }

    /// Oublie les accords « pour 10 minutes » (verrouillage, réglages).
    pub fn forget(&self) {
        self.remembered.lock_recover().clear();
    }

    /// Répond à une trame ; `session` garde ce que le client a annoncé.
    pub async fn handle(&self, payload: &[u8], session: &mut Session) -> Vec<u8> {
        match protocol::parse(payload) {
            Ok(Request::Identities) => {
                let bound = session.bindings.last().map(|b| b.hosts.clone()).unwrap_or_default();
                let ids: Vec<(Vec<u8>, String)> = presented(self.backend.keys(), &bound)
                    .into_iter()
                    .filter_map(|k| Some((k.public.to_bytes().ok()?, k.name)))
                    .collect();
                protocol::identities_answer(&ids)
            }
            Ok(Request::Sign { key_blob, data, flags }) => match self.sign_request(&key_blob, &data, flags, session).await {
                Ok(sig) => protocol::sign_response(&sig),
                Err(e) => {
                    tracing::info!(error = %e, "agent SSH : signature refusée");
                    vec![protocol::FAILURE]
                }
            },
            Ok(Request::SessionBind { host_key, session_id, signature, forwarding }) => {
                match verify_binding(&host_key, &session_id, &signature) {
                    Some(key) => {
                        let hosts = self.backend.hosts_with_key(&key);
                        session.bindings.push(Binding { host_key: key, session_id, forwarding, hosts });
                        vec![protocol::SUCCESS]
                    }
                    None => {
                        tracing::warn!("agent SSH : session-bind dont la signature ne se vérifie pas, ignoré");
                        vec![protocol::FAILURE]
                    }
                }
            }
            Ok(Request::UnknownExtension(_)) => vec![protocol::EXTENSION_FAILURE],
            Ok(Request::Other(_)) | Err(_) => vec![protocol::FAILURE],
        }
    }

    async fn sign_request(&self, key_blob: &[u8], data: &[u8], flags: u32, session: &Session) -> anyhow::Result<Vec<u8>> {
        let key = self
            .backend
            .keys()
            .into_iter()
            .find(|k| k.public.to_bytes().is_ok_and(|b| b == key_blob))
            .ok_or_else(|| anyhow::anyhow!("clé inconnue de l'agent"))?;
        let purpose = match purpose::describe(data) {
            Purpose::SshLogin { session_id, user, host_key } => {
                // L'hôte n'est affiché que si le client l'a annoncé (et prouvé)
                // pour **cette** session.
                let binding = session.bindings.iter().find(|b| b.session_id == session_id);
                let embedded = host_key.as_deref().and_then(|k| PublicKey::from_bytes(k).ok());
                match binding {
                    Some(b) if embedded.as_ref().is_none_or(|k| k == &b.host_key) => UsePurpose::SshLogin {
                        user,
                        hosts: b.hosts.clone(),
                        fingerprint: Some(b.host_key.fingerprint(HashAlg::Sha256).to_string()),
                    },
                    _ => UsePurpose::SshLogin { user, hosts: vec![], fingerprint: None },
                }
            }
            Purpose::Sshsig { namespace } if namespace == "git" => UsePurpose::GitSignature,
            Purpose::Sshsig { namespace } => UsePurpose::Sshsig { namespace },
            Purpose::Unknown => UsePurpose::Unknown,
        };
        let forwarded = session.bindings.iter().any(|b| b.forwarding);
        let remembered = self.remembered.lock_recover().get(&key.id).is_some_and(|until| Instant::now() < *until);
        // Un agent transféré sur un hôte distant demande toujours : là-bas,
        // n'importe quel processus root peut s'en servir.
        if !remembered || forwarded {
            let decision = self
                .backend
                .confirm(UseRequest {
                    key_id: key.id.clone(),
                    key_name: key.name.clone(),
                    key_fingerprint: key.public.fingerprint(HashAlg::Sha256).to_string(),
                    purpose,
                    client: session.client.clone(),
                    forwarded,
                })
                .await;
            if !decision.allow {
                anyhow::bail!("refusée par l'utilisateur");
            }
            if decision.remember && !forwarded {
                self.remembered.lock_recover().insert(key.id.clone(), Instant::now() + REMEMBER_FOR);
            }
        }
        let private = self.backend.private_key(&key.id)?;
        sign(&private, data, flags)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use getrandom::SysRng;
    use getrandom::rand_core::UnwrapErr;
    use russh::keys::ssh_key::Algorithm;

    fn random(alg: Algorithm) -> PrivateKey {
        PrivateKey::random(&mut UnwrapErr(SysRng), alg).unwrap()
    }

    fn key(id: &str, hosts: &[&str]) -> AgentKey {
        let private = random(Algorithm::Ed25519);
        AgentKey { id: id.into(), name: id.into(), public: private.public_key().clone(), hosts: hosts.iter().map(|h| h.to_string()).collect() }
    }

    #[test]
    fn presents_the_host_key_when_the_server_is_recognised() {
        let keys = vec![key("perso", &[]), key("prod", &["h-prod"]), key("ci", &["h-ci", "h-prod"])];
        let names = |v: Vec<AgentKey>| v.into_iter().map(|k| k.id).collect::<Vec<_>>();
        assert_eq!(names(presented(keys.clone(), &[])), ["perso", "prod", "ci"]);
        let prod = [KnownHost { id: "h-prod".into(), label: "Prod".into() }];
        assert_eq!(names(presented(keys.clone(), &prod)), ["prod", "ci"]);
        // Un hôte reconnu qui n'utilise aucune de ces clés : toutes.
        let other = [KnownHost { id: "h-autre".into(), label: "Autre".into() }];
        assert_eq!(names(presented(keys, &other)), ["perso", "prod", "ci"]);
    }

    #[test]
    fn a_binding_needs_the_host_signature() {
        let host = random(Algorithm::Ed25519);
        let blob = host.public_key().to_bytes().unwrap();
        let sig = sign(&host, b"session-id", 0).unwrap();
        assert!(verify_binding(&blob, b"session-id", &sig).is_some());
        assert!(verify_binding(&blob, b"autre-session", &sig).is_none());
        let intruder = random(Algorithm::Ed25519);
        let forged = sign(&intruder, b"session-id", 0).unwrap();
        assert!(verify_binding(&blob, b"session-id", &forged).is_none());
    }

    #[test]
    fn rsa_signs_with_the_hash_the_client_asks_for() {
        let rsa = random(Algorithm::Rsa { hash: None });
        for (flags, alg) in [(protocol::RSA_SHA2_512, "rsa-sha2-512"), (protocol::RSA_SHA2_256, "rsa-sha2-256")] {
            let blob = sign(&rsa, b"donnees", flags).unwrap();
            let sig = Signature::try_from(blob.as_slice()).unwrap();
            assert_eq!(sig.algorithm().as_str(), alg);
            assert!(Verifier::verify(rsa.public_key(), b"donnees", &sig).is_ok());
        }
    }
}
