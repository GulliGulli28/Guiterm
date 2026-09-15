//! Le compte GuiVault de l'utilisateur sur cette machine : ce qui est
//! persisté (fichier `guivault.json` non secret + jetons/clés dans le coffre
//! local), et la session déverrouillée en mémoire.
//!
//! Deux niveaux de persistance, au choix de l'utilisateur (`persist_unlock`) :
//! - **par défaut**, la *user key* et la clé privée sont rangées dans le coffre
//!   local de Guiterm (trousseau OS, ou `secrets.enc` si un mot de passe maître
//!   local est défini) : l'app se resynchronise au lancement sans rien
//!   demander. C'est le compromis de Termius/Bitwarden « rester connecté ».
//! - sinon, seul le jeton de rafraîchissement est conservé : au lancement,
//!   on peut parler au serveur mais rien déchiffrer tant que le mot de passe
//!   maître GuiVault n'a pas été ressaisi (`unlock`).
use crate::guivault::client::{Client, ClientError, ClientResult, LoginOutcome, Tokens};
use crate::model::VaultId;
use crate::vault as local_vault;
use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use chrono::{DateTime, Utc};
use guivault_crypto as gc;
use guivault_protocol::{self as proto, Role, VaultKind};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::Arc;
use uuid::Uuid;

// ─── État persistant non secret ─────────────────────────────────────────────

/// Ce qu'on sait d'un item côté client après sa dernière synchronisation.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ItemState {
    pub vault_id: VaultId,
    pub item_type: String,
    /// SHA-256 du JSON de l'entité telle qu'elle a été poussée ou tirée :
    /// si le JSON courant a une autre empreinte, l'entité a changé localement.
    pub hash: String,
    pub revision: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SyncState {
    /// Dernière révision vue de chaque vault (pour `?since=`).
    #[serde(default)]
    pub vault_revisions: BTreeMap<VaultId, i64>,
    #[serde(default)]
    pub items: BTreeMap<Uuid, ItemState>,
}

fn default_auto_sync() -> u64 {
    300
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalState {
    pub server_url: String,
    pub email: String,
    pub user_id: Uuid,
    #[serde(with = "proto::b64")]
    pub public_key: Vec<u8>,
    pub device_name: String,
    /// `0` = pas de synchronisation automatique.
    #[serde(default = "default_auto_sync")]
    pub auto_sync_secs: u64,
    #[serde(default = "default_true")]
    pub persist_unlock: bool,
    #[serde(default)]
    pub sync: SyncState,
    /// Empreintes de clés publiques vérifiées hors bande, par e-mail (TOFU) :
    /// un partage n'est proposé que vers une empreinte épinglée, et un
    /// changement d'empreinte est signalé comme une alerte, jamais accepté
    /// en silence. Voir `docs/SECURITY.md` de GuiVault.
    #[serde(default)]
    pub pinned_fingerprints: BTreeMap<String, String>,
    #[serde(default)]
    pub last_sync_at: Option<DateTime<Utc>>,
}

pub fn default_state_path() -> anyhow::Result<PathBuf> {
    let dirs = directories::ProjectDirs::from("dev", "gui-termius", "gui-termius")
        .ok_or_else(|| anyhow::anyhow!("impossible de déterminer le dossier de configuration"))?;
    Ok(dirs.config_dir().join("guivault.json"))
}

fn load_state(path: &std::path::Path) -> anyhow::Result<Option<LocalState>> {
    if !path.exists() {
        return Ok(None);
    }
    let text = std::fs::read_to_string(path)?;
    Ok(Some(serde_json::from_str(&text)?))
}

fn save_state(path: &std::path::Path, state: &LocalState) -> anyhow::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    Ok(crate::secure_file::write_private(path, serde_json::to_string_pretty(state)?.as_bytes())?)
}

fn delete_state(path: &std::path::Path) -> anyhow::Result<()> {
    if path.exists() {
        std::fs::remove_file(path)?;
    }
    Ok(())
}

// ─── Secrets dans le coffre local ───────────────────────────────────────────

/// Où vont les jetons et les clés du compte. En production, le coffre local
/// de Guiterm ([`LocalVaultStore`]) ; en test, une map en mémoire pour ne pas
/// toucher au trousseau de la machine.
pub trait SecretStore: Send + Sync {
    fn store(&self, name: &str, value: &str) -> anyhow::Result<()>;
    fn load(&self, name: &str) -> Option<String>;
    fn delete(&self, name: &str);
}

pub struct LocalVaultStore;

impl SecretStore for LocalVaultStore {
    fn store(&self, name: &str, value: &str) -> anyhow::Result<()> {
        local_vault::store_global(name, value)
    }

    fn load(&self, name: &str) -> Option<String> {
        local_vault::load_global(name).ok().flatten()
    }

    fn delete(&self, name: &str) {
        let _ = local_vault::delete_global(name);
    }
}

#[derive(Default)]
pub struct MemoryStore(std::sync::Mutex<HashMap<String, String>>);

impl SecretStore for MemoryStore {
    fn store(&self, name: &str, value: &str) -> anyhow::Result<()> {
        self.0.lock().unwrap_or_else(|p| p.into_inner()).insert(name.into(), value.into());
        Ok(())
    }

    fn load(&self, name: &str) -> Option<String> {
        self.0.lock().unwrap_or_else(|p| p.into_inner()).get(name).cloned()
    }

    fn delete(&self, name: &str) {
        self.0.lock().unwrap_or_else(|p| p.into_inner()).remove(name);
    }
}

const K_ACCESS: &str = "guivault-access-token";
const K_REFRESH: &str = "guivault-refresh-token";
const K_USER_KEY: &str = "guivault-user-key";
const K_PRIVATE_KEY: &str = "guivault-private-key";

fn store_tokens(store: &dyn SecretStore, t: &Tokens) -> anyhow::Result<()> {
    store.store(K_ACCESS, &t.access)?;
    store.store(K_REFRESH, &t.refresh)
}

fn load_tokens(store: &dyn SecretStore) -> Option<Tokens> {
    let access = store.load(K_ACCESS)?;
    let refresh = store.load(K_REFRESH)?;
    Some(Tokens { access, refresh })
}

fn store_keys(store: &dyn SecretStore, account: &gc::UnlockedAccount) -> anyhow::Result<()> {
    store.store(K_USER_KEY, &B64.encode(account.user_key.as_bytes()))?;
    store.store(K_PRIVATE_KEY, &B64.encode(account.keypair.private.to_bytes()))
}

fn load_keys(store: &dyn SecretStore) -> Option<gc::UnlockedAccount> {
    let uk = B64.decode(store.load(K_USER_KEY)?).ok()?;
    let pk = B64.decode(store.load(K_PRIVATE_KEY)?).ok()?;
    let user_key = gc::SymmetricKey::from_slice(&uk).ok()?;
    let private = gc::PrivateKey::try_from(pk.as_slice()).ok()?;
    Some(gc::UnlockedAccount {
        user_key,
        keypair: gc::KeyPair {
            public: private.public_key(),
            private,
        },
    })
}

fn clear_secrets(store: &dyn SecretStore) {
    for k in [K_ACCESS, K_REFRESH, K_USER_KEY, K_PRIVATE_KEY] {
        store.delete(k);
    }
}

// ─── Session en mémoire ─────────────────────────────────────────────────────

/// Un vault tel que le client le voit : nom déchiffré, rôle, et sa clé.
#[derive(Clone)]
pub struct VaultInfo {
    pub id: VaultId,
    pub name: String,
    pub kind: VaultKind,
    pub role: Role,
    pub revision: i64,
    pub key: gc::SymmetricKey,
}

/// Résumé sérialisable d'un vault, pour le frontend (sans la clé).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultSummary {
    pub id: VaultId,
    pub name: String,
    pub kind: VaultKind,
    pub role: Role,
    pub revision: i64,
}

impl From<&VaultInfo> for VaultSummary {
    fn from(v: &VaultInfo) -> Self {
        VaultSummary {
            id: v.id,
            name: v.name.clone(),
            kind: v.kind,
            role: v.role,
            revision: v.revision,
        }
    }
}

/// Une session : on peut parler au serveur (`client`), et — si `account`
/// est là — déchiffrer.
pub struct Session {
    pub client: Arc<Client>,
    pub account: Option<Arc<gc::UnlockedAccount>>,
    pub vaults: HashMap<VaultId, VaultInfo>,
}

impl Session {
    pub fn is_unlocked(&self) -> bool {
        self.account.is_some()
    }

    pub fn account(&self) -> anyhow::Result<Arc<gc::UnlockedAccount>> {
        self.account
            .clone()
            .ok_or_else(|| anyhow::anyhow!("compte GuiVault verrouillé : saisir le mot de passe maître"))
    }

    pub fn vault(&self, id: VaultId) -> anyhow::Result<&VaultInfo> {
        self.vaults.get(&id).ok_or_else(|| anyhow::anyhow!("vault {id} inconnu"))
    }

    pub fn personal_vault(&self) -> Option<&VaultInfo> {
        self.vaults.values().find(|v| v.kind == VaultKind::Personal)
    }

    /// Déchiffre la liste de vaults renvoyée par `/sync` et met à jour la
    /// table locale : nouvelles clés, rôles, révisions, vaults quittés.
    pub fn absorb_vaults(&mut self, vaults: &[proto::Vault]) -> anyhow::Result<()> {
        let account = self.account()?;
        let mut next = HashMap::with_capacity(vaults.len());
        for v in vaults {
            // Ré-ouverte à chaque fois (1 µs) : la clé ne change qu'à une
            // rotation, et alors l'enveloppe aussi.
            let key = gc::unwrap_vault_key(&account, &v.wrapped_vault_key)
                .map_err(|e| anyhow::anyhow!("clé du vault {} illisible : {e}", v.id))?;
            let name = gc::open_vault_name(&key, &v.id.to_string(), &v.name_enc)
                .unwrap_or_else(|_| "(nom illisible)".to_string());
            next.insert(
                v.id,
                VaultInfo {
                    id: v.id,
                    name,
                    kind: v.kind,
                    role: v.role,
                    revision: v.revision,
                    key,
                },
            );
        }
        self.vaults = next;
        Ok(())
    }
}

// ─── Manager : l'API que la couche Tauri appelle ────────────────────────────

/// État de haut niveau pour le frontend.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// Un compte est configuré sur cette machine.
    pub configured: bool,
    /// Les clés sont en mémoire : on peut chiffrer/déchiffrer.
    pub unlocked: bool,
    pub server_url: Option<String>,
    pub email: Option<String>,
    pub user_id: Option<Uuid>,
    pub fingerprint: Option<String>,
    pub device_name: Option<String>,
    pub auto_sync_secs: u64,
    pub persist_unlock: bool,
    pub last_sync_at: Option<DateTime<Utc>>,
    pub vaults: Vec<VaultSummary>,
}

pub struct Manager {
    state_path: PathBuf,
    secrets: Box<dyn SecretStore>,
    state: std::sync::Mutex<Option<LocalState>>,
    session: std::sync::Mutex<Option<Session>>,
    /// Connexion arrêtée au second facteur (voir [`Manager::login`]).
    pending: std::sync::Mutex<Option<PendingLogin>>,
}

/// Où en est une connexion.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "step")]
pub enum LoginStep {
    Connected(Status),
    /// Mot de passe accepté, code TOTP attendu (`login_totp`).
    TotpRequired,
}

struct PendingLogin {
    server_url: String,
    client: Client,
    stretched_key: gc::SymmetricKey,
    totp_token: String,
    device_name: Option<String>,
}

fn device_name_default() -> String {
    let host = std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .ok()
        .filter(|h| !h.is_empty())
        .or_else(|| {
            std::fs::read_to_string("/etc/hostname")
                .ok()
                .map(|h| h.trim().to_string())
                .filter(|h| !h.is_empty())
        })
        .unwrap_or_else(|| "cet ordinateur".to_string());
    format!("Guiterm sur {host}")
}

impl Default for Manager {
    /// Le manager de l'application ; si le dossier de configuration est
    /// indéterminable, un chemin relatif — l'app est de toute façon
    /// inutilisable dans ce cas (le workspace non plus ne se charge pas).
    fn default() -> Self {
        Self::new().unwrap_or_else(|_| Self::with(PathBuf::from("guivault.json"), Box::new(LocalVaultStore)))
    }
}

impl Manager {
    /// Le manager de l'application : `guivault.json` dans le dossier de
    /// config, secrets dans le coffre local.
    pub fn new() -> anyhow::Result<Self> {
        Ok(Self::with(default_state_path()?, Box::new(LocalVaultStore)))
    }

    pub fn with(state_path: PathBuf, secrets: Box<dyn SecretStore>) -> Self {
        Self {
            state_path,
            secrets,
            state: std::sync::Mutex::new(None),
            session: std::sync::Mutex::new(None),
            pending: std::sync::Mutex::new(None),
        }
    }

    /// Recharge l'état persistant et, si les secrets sont là, restaure la
    /// session sans toucher au réseau. À appeler une fois au lancement — et
    /// après le déverrouillage du coffre local (les secrets n'étaient pas
    /// lisibles avant).
    pub fn restore(&self) -> anyhow::Result<Status> {
        let state = load_state(&self.state_path)?;
        let session = state.as_ref().and_then(|st| {
            let tokens = load_tokens(self.secrets.as_ref())?;
            let client = Client::new(&st.server_url, Some(tokens)).ok()?;
            let account = if st.persist_unlock { load_keys(self.secrets.as_ref()).map(Arc::new) } else { None };
            Some(Session {
                client: Arc::new(client),
                account,
                vaults: HashMap::new(),
            })
        });
        *self.lock_state() = state;
        *self.lock_session() = session;
        Ok(self.status())
    }

    fn lock_state(&self) -> std::sync::MutexGuard<'_, Option<LocalState>> {
        self.state.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn lock_session(&self) -> std::sync::MutexGuard<'_, Option<Session>> {
        self.session.lock().unwrap_or_else(|p| p.into_inner())
    }

    pub fn status(&self) -> Status {
        let state = self.lock_state();
        let session = self.lock_session();
        let fingerprint = state
            .as_ref()
            .and_then(|s| gc::PublicKey::try_from(s.public_key.as_slice()).ok())
            .map(|pk| gc::fingerprint(&pk));
        let mut vaults: Vec<VaultSummary> = session
            .as_ref()
            .map(|s| s.vaults.values().map(VaultSummary::from).collect())
            .unwrap_or_default();
        vaults.sort_by_key(|v| (v.kind != VaultKind::Personal, v.name.to_lowercase()));
        Status {
            configured: state.is_some(),
            unlocked: session.as_ref().is_some_and(Session::is_unlocked),
            server_url: state.as_ref().map(|s| s.server_url.clone()),
            email: state.as_ref().map(|s| s.email.clone()),
            user_id: state.as_ref().map(|s| s.user_id),
            fingerprint,
            device_name: state.as_ref().map(|s| s.device_name.clone()),
            auto_sync_secs: state.as_ref().map(|s| s.auto_sync_secs).unwrap_or(300),
            persist_unlock: state.as_ref().map(|s| s.persist_unlock).unwrap_or(true),
            last_sync_at: state.as_ref().and_then(|s| s.last_sync_at),
            vaults,
        }
    }

    /// Le client HTTP de la session courante (les jetons sont partagés :
    /// un rafraîchissement fait dans une tâche profite aux suivantes).
    pub fn client(&self) -> anyhow::Result<Arc<Client>> {
        self.lock_session()
            .as_ref()
            .map(|s| s.client.clone())
            .ok_or_else(|| anyhow::anyhow!("aucun compte GuiVault connecté"))
    }

    pub fn account(&self) -> anyhow::Result<Arc<gc::UnlockedAccount>> {
        self.lock_session()
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("aucun compte GuiVault connecté"))?
            .account()
    }

    pub fn vault_infos(&self) -> Vec<VaultInfo> {
        self.lock_session()
            .as_ref()
            .map(|s| s.vaults.values().cloned().collect())
            .unwrap_or_default()
    }

    pub fn vault_info(&self, id: VaultId) -> anyhow::Result<VaultInfo> {
        self.lock_session()
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("aucun compte GuiVault connecté"))?
            .vault(id)
            .cloned()
    }

    pub fn with_state<T>(&self, f: impl FnOnce(&LocalState) -> T) -> anyhow::Result<T> {
        self.lock_state()
            .as_ref()
            .map(f)
            .ok_or_else(|| anyhow::anyhow!("aucun compte GuiVault configuré"))
    }

    /// Modifie et persiste l'état local.
    pub fn update_state(&self, f: impl FnOnce(&mut LocalState)) -> anyhow::Result<()> {
        let mut guard = self.lock_state();
        let st = guard
            .as_mut()
            .ok_or_else(|| anyhow::anyhow!("aucun compte GuiVault configuré"))?;
        f(st);
        save_state(&self.state_path, st)
    }

    pub fn update_session(&self, f: impl FnOnce(&mut Session) -> anyhow::Result<()>) -> anyhow::Result<()> {
        let mut guard = self.lock_session();
        let s = guard
            .as_mut()
            .ok_or_else(|| anyhow::anyhow!("aucun compte GuiVault connecté"))?;
        f(s)
    }

    /// À appeler après toute requête : si le client a tourné ses jetons, la
    /// nouvelle paire doit survivre au redémarrage.
    pub fn persist_tokens(&self) {
        if let Some(t) = self.lock_session().as_ref().and_then(|s| s.client.tokens()) {
            let _ = store_tokens(self.secrets.as_ref(), &t);
        }
    }

    // ─── Inscription / connexion ─────────────────────────────────────────

    /// Crée un compte sur `server_url`. Tout le matériel cryptographique est
    /// généré ici ; seul ce qui est chiffré ou public part au serveur.
    pub async fn register(&self, server_url: &str, email: &str, password: &str, device_name: Option<String>) -> anyhow::Result<Status> {
        let client = Client::new(server_url, None)?;
        client.health().await.map_err(|e| anyhow::anyhow!("ce n'est pas un serveur GuiVault joignable : {e}"))?;

        let password = password.to_string();
        let (material, account) = tokio::task::spawn_blocking(move || gc::create_account(&password)).await??;
        let personal_id = Uuid::new_v4();
        let personal_key = gc::SymmetricKey::random();
        let req = proto::RegisterRequest {
            email: email.to_string(),
            kdf: material.kdf,
            kdf_salt: material.kdf_salt,
            auth_key: material.auth_key,
            protected_user_key: material.protected_user_key,
            public_key: material.public_key,
            protected_private_key: material.protected_private_key,
            personal_vault: proto::CreateVaultRequest {
                id: personal_id,
                name_enc: gc::seal_vault_name(&personal_key, &personal_id.to_string(), "Personnel")?,
                wrapped_vault_key: gc::wrap_vault_key(&account.keypair.public, &personal_key)?,
            },
            device_name: Some(device_name.clone().unwrap_or_else(device_name_default)),
        };
        let resp = client.register(&req).await?;
        self.install(server_url, resp, client, account, device_name).await
    }

    /// Se connecte à un compte existant depuis cette machine. Si le compte a
    /// un second facteur, s'arrête sur [`LoginStep::TotpRequired`] : la clé
    /// dérivée du mot de passe reste en mémoire le temps que
    /// [`Manager::login_totp`] fournisse le code — le mot de passe n'a pas à
    /// être ressaisi.
    pub async fn login(&self, server_url: &str, email: &str, password: &str, device_name: Option<String>) -> anyhow::Result<LoginStep> {
        let client = Client::new(server_url, None)?;
        let pre = client.prelogin(email).await?;
        let password = password.to_string();
        let lm = tokio::task::spawn_blocking(move || gc::prepare_login(&password, &pre.kdf_salt, pre.kdf)).await??;
        let outcome = client
            .login(&proto::LoginRequest {
                email: email.to_string(),
                auth_key: lm.auth_key.as_bytes().to_vec(),
                device_name: Some(device_name.clone().unwrap_or_else(device_name_default)),
            })
            .await
            .map_err(|e| match e.code() {
                Some("invalid_credentials") => anyhow::anyhow!("e-mail ou mot de passe maître incorrect"),
                _ => anyhow::anyhow!(e),
            })?;
        match outcome {
            LoginOutcome::Session(resp) => {
                let status = self.finish_login(server_url, resp, client, lm.stretched_key, device_name).await?;
                Ok(LoginStep::Connected(status))
            }
            LoginOutcome::TotpRequired(challenge) => {
                *self.lock_pending() = Some(PendingLogin {
                    server_url: server_url.to_string(),
                    client,
                    stretched_key: lm.stretched_key,
                    totp_token: challenge.totp_token,
                    device_name,
                });
                Ok(LoginStep::TotpRequired)
            }
        }
    }

    /// Deuxième temps de la connexion : le code TOTP (ou de récupération).
    pub async fn login_totp(&self, code: &str) -> anyhow::Result<Status> {
        let pending = self
            .lock_pending()
            .take()
            .ok_or_else(|| anyhow::anyhow!("aucune connexion en attente de code : recommencer la connexion"))?;
        let resp = match pending
            .client
            .totp_verify(&proto::TotpVerifyRequest {
                totp_token: pending.totp_token.clone(),
                code: code.trim().to_string(),
            })
            .await
        {
            Ok(r) => r,
            Err(e) => {
                let msg = match e.code() {
                    Some("invalid_code") => "code incorrect",
                    Some("challenge_expired") => "délai dépassé ou trop d'essais : recommencer la connexion",
                    _ => "",
                };
                // Un mauvais code n'annule pas la tentative : le défi
                // accepte encore quelques essais.
                if e.code() == Some("invalid_code") {
                    *self.lock_pending() = Some(pending);
                }
                return Err(if msg.is_empty() { anyhow::anyhow!(e) } else { anyhow::anyhow!(msg) });
            }
        };
        self.finish_login(&pending.server_url, resp, pending.client, pending.stretched_key, pending.device_name)
            .await
    }

    async fn finish_login(
        &self,
        server_url: &str,
        resp: proto::LoginResponse,
        client: Client,
        stretched_key: gc::SymmetricKey,
        device_name: Option<String>,
    ) -> anyhow::Result<Status> {
        let account = gc::unlock_account(&stretched_key, &resp.protected_user_key, &resp.protected_private_key)
            .map_err(|_| anyhow::anyhow!("le serveur a accepté la connexion mais les clés ne s'ouvrent pas — mot de passe ou compte incohérent"))?;
        self.install(server_url, resp, client, account, device_name).await
    }

    fn lock_pending(&self) -> std::sync::MutexGuard<'_, Option<PendingLogin>> {
        self.pending.lock().unwrap_or_else(|p| p.into_inner())
    }

    // ─── Second facteur ──────────────────────────────────────────────────

    pub async fn totp_status(&self) -> anyhow::Result<bool> {
        Ok(to_user(self.client()?.totp_status().await)?.enabled)
    }

    pub async fn totp_setup(&self) -> anyhow::Result<proto::TotpSetupResponse> {
        to_user(self.client()?.totp_setup().await)
    }

    pub async fn totp_enable(&self, code: &str) -> anyhow::Result<Vec<String>> {
        let r = self.client()?.totp_enable(code.trim()).await.map_err(|e| match e.code() {
            Some("invalid_code") => anyhow::anyhow!("code incorrect — vérifier l'heure de l'appareil"),
            _ => user_error(e),
        })?;
        Ok(r.recovery_codes)
    }

    pub async fn totp_disable(&self, code: &str) -> anyhow::Result<()> {
        self.client()?.totp_disable(code.trim()).await.map_err(|e| match e.code() {
            Some("invalid_code") => anyhow::anyhow!("code incorrect"),
            _ => user_error(e),
        })
    }

    async fn install(
        &self,
        server_url: &str,
        resp: proto::LoginResponse,
        client: Client,
        account: gc::UnlockedAccount,
        device_name: Option<String>,
    ) -> anyhow::Result<Status> {
        // Un compte différent de celui d'avant : son état de synchro ne
        // veut plus rien dire.
        let previous = load_state(&self.state_path)?;
        let keep_sync = previous
            .as_ref()
            .filter(|p| p.user_id == resp.user.id && p.server_url.trim_end_matches('/') == server_url.trim_end_matches('/'));
        let state = LocalState {
            server_url: server_url.trim_end_matches('/').to_string(),
            email: resp.user.email.clone(),
            user_id: resp.user.id,
            public_key: resp.user.public_key.clone(),
            device_name: device_name.unwrap_or_else(device_name_default),
            auto_sync_secs: keep_sync.map(|p| p.auto_sync_secs).unwrap_or(300),
            persist_unlock: keep_sync.map(|p| p.persist_unlock).unwrap_or(true),
            sync: keep_sync.map(|p| p.sync.clone()).unwrap_or_default(),
            pinned_fingerprints: keep_sync.map(|p| p.pinned_fingerprints.clone()).unwrap_or_default(),
            last_sync_at: None,
        };
        save_state(&self.state_path, &state)?;
        if let Some(t) = client.tokens() {
            store_tokens(self.secrets.as_ref(), &t)?;
        }
        if state.persist_unlock {
            store_keys(self.secrets.as_ref(), &account)?;
        } else {
            self.secrets.delete(K_USER_KEY);
            self.secrets.delete(K_PRIVATE_KEY);
        }
        *self.lock_state() = Some(state);
        *self.lock_session() = Some(Session {
            client: Arc::new(client),
            account: Some(Arc::new(account)),
            vaults: HashMap::new(),
        });
        Ok(self.status())
    }

    /// Ressaisie du mot de passe maître quand les clés ne sont pas persistées.
    /// Même chemin que la connexion, second facteur compris.
    pub async fn unlock(&self, password: &str) -> anyhow::Result<LoginStep> {
        let (server_url, email) = self.with_state(|s| (s.server_url.clone(), s.email.clone()))?;
        self.login(&server_url, &email, password, None).await
    }

    /// Oublie la session (serveur prévenu si possible) et les clés, garde
    /// la configuration et l'état de synchro pour une reconnexion.
    pub async fn logout(&self) -> anyhow::Result<Status> {
        if let Ok(client) = self.client() {
            let _ = client.logout().await;
        }
        clear_secrets(self.secrets.as_ref());
        *self.lock_session() = None;
        Ok(self.status())
    }

    /// Retire complètement le compte de cette machine. Les entités restent
    /// dans le workspace local ; seules leurs affiliations aux vaults partagés
    /// sont à nettoyer par l'appelant (voir `sync::detach_all`).
    pub async fn disconnect(&self) -> anyhow::Result<Status> {
        let _ = self.logout().await;
        delete_state(&self.state_path)?;
        *self.lock_state() = None;
        Ok(self.status())
    }

    pub fn set_preferences(&self, auto_sync_secs: u64, persist_unlock: bool) -> anyhow::Result<Status> {
        self.update_state(|s| {
            s.auto_sync_secs = auto_sync_secs;
            s.persist_unlock = persist_unlock;
        })?;
        if persist_unlock {
            if let Ok(account) = self.account() {
                store_keys(self.secrets.as_ref(), &account)?;
            }
        } else {
            self.secrets.delete(K_USER_KEY);
            self.secrets.delete(K_PRIVATE_KEY);
        }
        Ok(self.status())
    }

    pub async fn change_password(&self, current: &str, new: &str) -> anyhow::Result<()> {
        let client = self.client()?;
        let account = self.account()?;
        let email = self.with_state(|s| s.email.clone())?;
        let pre = client.prelogin(&email).await?;
        let (current, new) = (current.to_string(), new.to_string());
        let (lm, rk) = tokio::task::spawn_blocking(move || -> anyhow::Result<_> {
            let lm = gc::prepare_login(&current, &pre.kdf_salt, pre.kdf)?;
            let rk = gc::rekey_account(&account, &new)?;
            Ok((lm, rk))
        })
        .await??;
        client
            .change_password(&proto::ChangePasswordRequest {
                current_auth_key: lm.auth_key.as_bytes().to_vec(),
                kdf: rk.kdf,
                kdf_salt: rk.kdf_salt,
                auth_key: rk.auth_key,
                protected_user_key: rk.protected_user_key,
            })
            .await
            .map_err(|e| match e.code() {
                Some("invalid_credentials") => anyhow::anyhow!("mot de passe maître actuel incorrect"),
                _ => anyhow::anyhow!(e),
            })?;
        Ok(())
    }

    // ─── Empreintes (TOFU) ───────────────────────────────────────────────

    /// Ce qu'on sait d'une empreinte : épinglée telle quelle, jamais vue, ou
    /// **différente de celle épinglée** — le cas à traiter comme une alerte.
    pub fn fingerprint_trust(&self, email: &str, fingerprint: &str) -> FingerprintTrust {
        let pinned = self
            .lock_state()
            .as_ref()
            .and_then(|s| s.pinned_fingerprints.get(email).cloned());
        match pinned {
            None => FingerprintTrust::Unknown,
            Some(p) if p == fingerprint => FingerprintTrust::Pinned,
            Some(p) => FingerprintTrust::Changed { previous: p },
        }
    }

    pub fn pin_fingerprint(&self, email: &str, fingerprint: &str) -> anyhow::Result<()> {
        self.update_state(|s| {
            s.pinned_fingerprints.insert(email.to_string(), fingerprint.to_string());
        })
    }

    /// Refuse toute opération de partage vers une empreinte non vérifiée.
    pub fn require_pinned(&self, email: &str, fingerprint: &str) -> anyhow::Result<()> {
        match self.fingerprint_trust(email, fingerprint) {
            FingerprintTrust::Pinned => Ok(()),
            FingerprintTrust::Unknown => anyhow::bail!(
                "l'empreinte de {email} n'a pas été vérifiée : comparer {fingerprint} avec lui hors bande, puis l'épingler"
            ),
            FingerprintTrust::Changed { previous } => anyhow::bail!(
                "ALERTE : la clé publique de {email} a changé ({previous} → {fingerprint}). Ne pas partager avant d'avoir vérifié avec lui de vive voix."
            ),
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum FingerprintTrust {
    Pinned,
    Unknown,
    Changed { previous: String },
}

/// Convertit une erreur du client en erreur utilisateur, en signalant
/// spécifiquement une session morte (le frontend propose alors de se
/// reconnecter).
pub fn user_error(e: ClientError) -> anyhow::Error {
    if e.is_unauthorized() {
        anyhow::anyhow!("session GuiVault expirée ou révoquée : reconnectez-vous")
    } else {
        anyhow::anyhow!(e)
    }
}

pub fn to_user<T>(r: ClientResult<T>) -> anyhow::Result<T> {
    r.map_err(user_error)
}
