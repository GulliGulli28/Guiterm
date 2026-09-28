//! L'agent SSH de Guiterm (`termius_core::ssh_agent`) branché sur
//! l'application : les clés viennent du trousseau du workspace, et chaque
//! demande de signature devient un événement `ssh-agent-confirm` — la fenêtre
//! revient au premier plan, l'utilisateur accepte ou refuse, la réponse
//! revient par [`ssh_agent_answer`]. Sans réponse en une minute : refusé.
use crate::state::AppState;
use serde::Serialize;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};
use termius_core::model::KeyId;
use termius_core::ssh_agent::{
    Agent, AgentKey, Backend, Decision, KnownHost, SshPrivateKey, SshPublicKey, UseRequest, keyring, server, settings,
};
use termius_core::sync_ext::MutexExt;
use tokio::sync::oneshot;

/// Assez pour lever les yeux de son terminal ; au-delà, le client (`ssh`,
/// `git`) attendrait indéfiniment une fenêtre oubliée.
const CONFIRM_TIMEOUT: Duration = Duration::from_secs(60);

/// L'agent en marche, ou pourquoi il ne l'est pas.
#[derive(Default)]
pub struct AgentRuntime {
    running: Option<server::Running>,
    agent: Option<Arc<Agent>>,
    error: Option<String>,
}

struct TauriBackend {
    app: AppHandle,
}

impl TauriBackend {
    /// Une copie du workspace : l'agent ne tient pas son verrou pendant qu'il
    /// lit le coffre.
    fn workspace(&self) -> termius_core::model::Workspace {
        self.app.state::<AppState>().workspace.lock_recover().clone()
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ConfirmEvent {
    id: String,
    request: UseRequest,
}

#[async_trait::async_trait]
impl Backend for TauriBackend {
    fn keys(&self) -> Vec<AgentKey> {
        keyring::agent_keys(&self.workspace(), &settings::load().keys)
    }

    fn hosts_with_key(&self, host_key: &SshPublicKey) -> Vec<KnownHost> {
        keyring::hosts_with_key(&self.workspace(), host_key)
    }

    fn private_key(&self, key_id: &str) -> anyhow::Result<SshPrivateKey> {
        keyring::private_key(&self.workspace(), key_id)
    }

    async fn confirm(&self, request: UseRequest) -> Decision {
        let id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel::<Decision>();
        self.app.state::<AppState>().ssh_agent_prompts.lock_recover().insert(id.clone(), tx);
        if let Some(window) = self.app.get_webview_window("main") {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
            let _ = window.request_user_attention(Some(tauri::UserAttentionType::Critical));
        }
        if self.app.emit("ssh-agent-confirm", ConfirmEvent { id: id.clone(), request }).is_err() {
            self.app.state::<AppState>().ssh_agent_prompts.lock_recover().remove(&id);
            return Decision::default();
        }
        match tokio::time::timeout(CONFIRM_TIMEOUT, rx).await {
            Ok(Ok(decision)) => decision,
            _ => {
                self.app.state::<AppState>().ssh_agent_prompts.lock_recover().remove(&id);
                Decision::default()
            }
        }
    }
}

/// Démarre l'agent (réglages : allumé). Une erreur (socket prise par une
/// autre instance, tube occupé) reste affichée dans les réglages.
pub async fn start(app: &AppHandle) {
    let agent = Arc::new(Agent::new(Arc::new(TauriBackend { app: app.clone() })));
    let result = match server::default_endpoint() {
        Ok(endpoint) => server::start(&endpoint, agent.clone()).await,
        Err(e) => Err(e),
    };
    let state = app.state::<AppState>();
    let mut rt = state.ssh_agent.lock_recover();
    match result {
        Ok(running) => {
            tracing::info!(endpoint = %running.endpoint, "agent SSH démarré");
            *rt = AgentRuntime { running: Some(running), agent: Some(agent), error: None };
        }
        Err(e) => {
            tracing::warn!(error = %e, "agent SSH : démarrage impossible");
            *rt = AgentRuntime { running: None, agent: None, error: Some(e.to_string()) };
        }
    }
}

fn stop(state: &AppState) {
    *state.ssh_agent.lock_recover() = AgentRuntime::default();
    // Les demandes en attente sont refusées (canal fermé).
    state.ssh_agent_prompts.lock_recover().clear();
}

/// Au lancement de l'application, si l'agent était allumé.
pub fn spawn_at_startup(app: AppHandle) {
    if settings::load().enabled {
        tauri::async_runtime::spawn(async move { start(&app).await });
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentKeyStatus {
    id: KeyId,
    name: String,
    enabled: bool,
    /// La ligne `ssh-ed25519 AAAA… nom`, pour `git config user.signingkey` ;
    /// absente si la clé est illisible (fichier disparu, PEM chiffré sans
    /// phrase de passe enregistrée).
    public_key: Option<String>,
    fingerprint: Option<String>,
    /// Combien d'hôtes du workspace s'authentifient avec elle.
    hosts: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStatus {
    enabled: bool,
    running: bool,
    /// Où les clients le trouvent (`SSH_AUTH_SOCK`).
    endpoint: Option<String>,
    error: Option<String>,
    windows: bool,
    keys: Vec<AgentKeyStatus>,
}

fn status(state: &AppState) -> AgentStatus {
    let s = settings::load();
    let workspace = state.workspace.lock_recover().clone();
    let all: Vec<KeyId> = workspace.keychain.iter().map(|k| k.id).collect();
    let readable = keyring::agent_keys(&workspace, &all);
    let keys = workspace
        .keychain
        .iter()
        .map(|k| {
            let found = readable.iter().find(|a| a.id == k.id.to_string());
            AgentKeyStatus {
                id: k.id,
                name: k.name.clone(),
                enabled: s.keys.contains(&k.id),
                public_key: found.and_then(|a| {
                    let mut pk = a.public.clone();
                    pk.set_comment(k.name.as_str());
                    pk.to_openssh().ok()
                }),
                fingerprint: found.map(|a| a.public.fingerprint(Default::default()).to_string()),
                hosts: found.map(|a| a.hosts.len()).unwrap_or(0),
            }
        })
        .collect();
    let rt = state.ssh_agent.lock_recover();
    AgentStatus {
        enabled: s.enabled,
        running: rt.running.is_some(),
        endpoint: rt.running.as_ref().map(|r| r.endpoint.clone()).or_else(|| server::default_endpoint().ok()),
        error: rt.error.clone(),
        windows: cfg!(windows),
        keys,
    }
}

#[tauri::command]
pub fn ssh_agent_status(state: State<'_, AppState>) -> AgentStatus {
    status(&state)
}

#[tauri::command]
pub async fn ssh_agent_set_enabled(app: AppHandle, enabled: bool) -> Result<AgentStatus, String> {
    let mut s = settings::load();
    s.enabled = enabled;
    settings::save(&s).map_err(|e| e.to_string())?;
    let state = app.state::<AppState>();
    stop(&state);
    if enabled {
        start(&app).await;
    }
    Ok(status(&state))
}

#[tauri::command]
pub fn ssh_agent_set_key(state: State<'_, AppState>, key_id: KeyId, enabled: bool) -> Result<AgentStatus, String> {
    let mut s = settings::load();
    s.keys.retain(|k| *k != key_id);
    if enabled {
        s.keys.push(key_id);
    }
    settings::save(&s).map_err(|e| e.to_string())?;
    // Une clé retirée ne garde pas un accord « pour 10 minutes ».
    if let Some(agent) = &state.ssh_agent.lock_recover().agent {
        agent.forget();
    }
    Ok(status(&state))
}

/// La réponse de la fenêtre de confirmation. Un id inconnu (demande expirée)
/// est ignoré.
#[tauri::command]
pub fn ssh_agent_answer(state: State<'_, AppState>, id: String, allow: bool, remember: bool) {
    if let Some(tx) = state.ssh_agent_prompts.lock_recover().remove(&id) {
        let _ = tx.send(Decision { allow, remember });
    }
}
