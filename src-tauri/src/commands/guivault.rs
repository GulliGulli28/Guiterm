//! Commandes GuiVault : compte, synchronisation, vaults partagés. Fine couche
//! au-dessus de `termius_core::guivault` — la logique est là-bas, ici on
//! prend les verrous du workspace et on convertit les erreurs.
use crate::state::AppState;
use guivault_protocol::Role;
use serde::Deserialize;
use tauri::{AppHandle, Emitter, Manager as _, State};
use termius_core::guivault::{LoginStep, Report, Status, VaultSummary, sharing, sync};
use termius_core::model::{VaultId, Workspace};
use termius_core::store;
use termius_core::sync_ext::MutexExt;
use uuid::Uuid;

/// Événement émis après chaque synchronisation (manuelle ou automatique) :
/// le frontend recharge le workspace et affiche conflits/avertissements.
pub const SYNCED_EVENT: &str = "guivault-synced";

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

fn persist(workspace: &Workspace) -> Result<(), String> {
    store::save(workspace).map_err(err)
}

/// Une synchronisation complète : copie du workspace, réseau + crypto hors
/// verrou, application des changements sous verrou, sauvegarde, événement.
pub async fn run_sync(app: &AppHandle, state: &AppState) -> anyhow::Result<Report> {
    let Ok(_guard) = state.guivault_sync_lock.try_lock() else {
        anyhow::bail!("synchronisation déjà en cours");
    };
    let snapshot = state.workspace.lock_recover().clone();
    let (changes, report) = sync::run(&state.guivault, &snapshot).await?;
    if !changes.is_empty() {
        let mut ws = state.workspace.lock_recover();
        sync::apply_changes(&mut ws, changes);
        store::save(&ws)?;
    }
    let _ = app.emit(SYNCED_EVENT, &report);
    Ok(report)
}

/// La boucle de synchronisation automatique, lancée une fois au démarrage.
/// Relit l'intervalle à chaque tour (il se change dans les réglages) ; ne
/// fait rien tant qu'aucun compte n'est déverrouillé.
pub fn spawn_auto_sync(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        // Première synchro peu après le lancement, le temps que la fenêtre
        // s'ouvre — sans bloquer le démarrage sur le réseau.
        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
        loop {
            let state: State<'_, AppState> = app.state();
            let status = state.guivault.status();
            if status.configured && status.unlocked {
                match run_sync(&app, &state).await {
                    Ok(r) => tracing::info!(pulled = r.pulled, pushed = r.pushed, "synchronisation GuiVault"),
                    Err(e) => tracing::warn!("synchronisation GuiVault : {e}"),
                }
            }
            let secs = state.guivault.status().auto_sync_secs;
            // `0` = manuelle seulement : on revérifie toutes les minutes si
            // ça a changé, sans synchroniser.
            let wait = if secs == 0 { 60 } else { secs.max(30) };
            tokio::time::sleep(std::time::Duration::from_secs(wait)).await;
        }
    });
}

/// Écoute le flux d'événements du serveur et synchronise dès que quelque
/// chose change — au lieu d'attendre le prochain tour de la boucle. Se
/// reconnecte avec un délai croissant ; ne fait rien sans compte déverrouillé.
pub fn spawn_event_listener(app: AppHandle) {
    use futures_util::StreamExt;
    tauri::async_runtime::spawn(async move {
        let mut backoff = 5u64;
        loop {
            let state: State<'_, AppState> = app.state();
            let status = state.guivault.status();
            let client = match (status.configured && status.unlocked, state.guivault.client()) {
                (true, Ok(c)) => c,
                _ => {
                    tokio::time::sleep(std::time::Duration::from_secs(10)).await;
                    continue;
                }
            };
            match client.events().await {
                Ok(mut events) => {
                    backoff = 5;
                    while let Some(ev) = events.next().await {
                        tracing::debug!(?ev, "événement GuiVault");
                        // Plusieurs événements peuvent arriver d'un coup (une
                        // rotation, un import) : on laisse passer une seconde
                        // et une seule synchro les couvre tous.
                        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                        if let Err(e) = run_sync(&app, &state).await {
                            tracing::warn!("synchronisation sur événement : {e}");
                        }
                    }
                    tracing::info!("flux d'événements GuiVault fermé, reconnexion");
                }
                Err(e) => {
                    tracing::warn!("flux d'événements GuiVault : {e} — nouvel essai dans {backoff}s");
                    tokio::time::sleep(std::time::Duration::from_secs(backoff)).await;
                    backoff = (backoff * 2).min(120);
                }
            }
        }
    });
}

// ─── Compte ──────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn guivault_status(state: State<'_, AppState>) -> Status {
    state.guivault.status()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectInput {
    pub server_url: String,
    pub email: String,
    pub password: String,
    #[serde(default)]
    pub device_name: Option<String>,
}

#[tauri::command]
pub async fn guivault_register(app: AppHandle, state: State<'_, AppState>, input: ConnectInput) -> Result<Status, String> {
    let status = state
        .guivault
        .register(&input.server_url, &input.email, &input.password, input.device_name)
        .await
        .map_err(err)?;
    let _ = run_sync(&app, &state).await;
    Ok(status)
}

/// `connected` → synchro immédiate ; `totpRequired` → le frontend demande
/// le code et appelle `guivault_login_totp`.
#[tauri::command]
pub async fn guivault_login(app: AppHandle, state: State<'_, AppState>, input: ConnectInput) -> Result<LoginStep, String> {
    let step = state
        .guivault
        .login(&input.server_url, &input.email, &input.password, input.device_name)
        .await
        .map_err(err)?;
    if matches!(step, LoginStep::Connected(_)) {
        let _ = run_sync(&app, &state).await;
    }
    Ok(step)
}

#[tauri::command]
pub async fn guivault_login_totp(app: AppHandle, state: State<'_, AppState>, code: String) -> Result<Status, String> {
    let status = state.guivault.login_totp(&code).await.map_err(err)?;
    let _ = run_sync(&app, &state).await;
    Ok(status)
}

#[tauri::command]
pub async fn guivault_unlock(app: AppHandle, state: State<'_, AppState>, password: String) -> Result<LoginStep, String> {
    let step = state.guivault.unlock(&password).await.map_err(err)?;
    if matches!(step, LoginStep::Connected(_)) {
        let _ = run_sync(&app, &state).await;
    }
    Ok(step)
}

#[tauri::command]
pub async fn guivault_totp_status(state: State<'_, AppState>) -> Result<bool, String> {
    state.guivault.totp_status().await.map_err(err)
}

#[tauri::command]
pub async fn guivault_totp_setup(state: State<'_, AppState>) -> Result<guivault_protocol::TotpSetupResponse, String> {
    state.guivault.totp_setup().await.map_err(err)
}

#[tauri::command]
pub async fn guivault_totp_enable(state: State<'_, AppState>, code: String) -> Result<Vec<String>, String> {
    state.guivault.totp_enable(&code).await.map_err(err)
}

#[tauri::command]
pub async fn guivault_totp_disable(state: State<'_, AppState>, code: String) -> Result<(), String> {
    state.guivault.totp_disable(&code).await.map_err(err)
}

#[tauri::command]
pub async fn guivault_logout(state: State<'_, AppState>) -> Result<Status, String> {
    state.guivault.logout().await.map_err(err)
}

/// Retire le compte de la machine. Les entités restent, toutes redevenues
/// locales (plus d'affiliation à un vault partagé).
#[tauri::command]
pub async fn guivault_disconnect(state: State<'_, AppState>) -> Result<Status, String> {
    let status = state.guivault.disconnect().await.map_err(err)?;
    let mut ws = state.workspace.lock_recover();
    sync::detach_all(&mut ws);
    persist(&ws)?;
    Ok(status)
}

#[tauri::command]
pub fn guivault_set_preferences(state: State<'_, AppState>, auto_sync_secs: u64, persist_unlock: bool) -> Result<Status, String> {
    state.guivault.set_preferences(auto_sync_secs, persist_unlock).map_err(err)
}

#[tauri::command]
pub async fn guivault_change_password(state: State<'_, AppState>, current: String, new: String) -> Result<(), String> {
    if new.len() < 12 {
        return Err("le nouveau mot de passe maître doit faire au moins 12 caractères".into());
    }
    state.guivault.change_password(&current, &new).await.map_err(err)
}

#[tauri::command]
pub async fn guivault_sync(app: AppHandle, state: State<'_, AppState>) -> Result<Report, String> {
    run_sync(&app, &state).await.map_err(err)
}

#[tauri::command]
pub async fn guivault_sessions(state: State<'_, AppState>) -> Result<Vec<guivault_protocol::Session>, String> {
    sharing::sessions(&state.guivault).await.map_err(err)
}

#[tauri::command]
pub async fn guivault_revoke_session(state: State<'_, AppState>, id: Uuid) -> Result<(), String> {
    sharing::revoke_session(&state.guivault, id).await.map_err(err)
}

// ─── Vaults ──────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn guivault_create_vault(state: State<'_, AppState>, name: String) -> Result<VaultSummary, String> {
    sharing::create_vault(&state.guivault, &name).await.map_err(err)
}

#[tauri::command]
pub async fn guivault_rename_vault(state: State<'_, AppState>, vault_id: VaultId, name: String) -> Result<Status, String> {
    sharing::rename_vault(&state.guivault, vault_id, &name).await.map_err(err)?;
    Ok(state.guivault.status())
}

/// Sans affiliation, une entité du vault serait retirée d'ici à la synchro
/// suivante (« plus d'accès à son vault ») : `keep_local` la rapatrie dans
/// le vault personnel avant.
fn detach_vault(ws: &mut Workspace, vault_id: VaultId) {
    ws.vault_bindings.retain(|_, v| *v != vault_id);
}

#[tauri::command]
pub async fn guivault_delete_vault(app: AppHandle, state: State<'_, AppState>, vault_id: VaultId, keep_local: bool) -> Result<Status, String> {
    if keep_local {
        let mut ws = state.workspace.lock_recover();
        detach_vault(&mut ws, vault_id);
        persist(&ws)?;
    }
    sharing::delete_vault(&state.guivault, vault_id).await.map_err(err)?;
    let _ = run_sync(&app, &state).await;
    Ok(state.guivault.status())
}

#[tauri::command]
pub async fn guivault_leave_vault(app: AppHandle, state: State<'_, AppState>, vault_id: VaultId, keep_local: bool) -> Result<Status, String> {
    if keep_local {
        let mut ws = state.workspace.lock_recover();
        detach_vault(&mut ws, vault_id);
        persist(&ws)?;
    }
    sharing::leave_vault(&state.guivault, vault_id).await.map_err(err)?;
    let _ = run_sync(&app, &state).await;
    Ok(state.guivault.status())
}

/// Déplace une entité (hôte, groupe, snippet, clé, connexion SQL) vers un
/// vault partagé, ou vers le personnel (`None`). Un hôte emmène la clé du
/// trousseau qu'il référence, si elle n'est pas déjà partagée : sans elle,
/// les autres membres verraient un hôte qui pointe vers une clé qu'ils
/// n'ont pas.
#[tauri::command]
pub fn guivault_move_entity(state: State<'_, AppState>, id: Uuid, vault_id: Option<VaultId>) -> Result<Workspace, String> {
    let mut ws = state.workspace.lock_recover();
    let key_to_follow = ws.host(id).and_then(|h| match &h.auth {
        termius_core::model::AuthMethod::PrivateKey { key_id: Some(k), .. } => Some(*k),
        _ => None,
    });
    match vault_id {
        Some(v) => {
            ws.vault_bindings.insert(id, v);
            if let Some(k) = key_to_follow
                && !ws.vault_bindings.contains_key(&k)
            {
                ws.vault_bindings.insert(k, v);
            }
        }
        None => {
            ws.vault_bindings.remove(&id);
        }
    }
    persist(&ws)?;
    Ok(ws.clone())
}

#[tauri::command]
pub async fn guivault_rotate_vault_key(state: State<'_, AppState>, vault_id: VaultId) -> Result<(), String> {
    sync::rotate_vault_key(&state.guivault, vault_id).await.map_err(err)
}

#[tauri::command]
pub async fn guivault_vault_audit(state: State<'_, AppState>, vault_id: VaultId) -> Result<serde_json::Value, String> {
    sharing::audit(&state.guivault, vault_id).await.map_err(err)
}

// ─── Membres ─────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn guivault_members(state: State<'_, AppState>, vault_id: VaultId) -> Result<Vec<sharing::MemberView>, String> {
    sharing::members(&state.guivault, vault_id).await.map_err(err)
}

#[tauri::command]
pub async fn guivault_update_member(state: State<'_, AppState>, vault_id: VaultId, user_id: Uuid, role: Role) -> Result<(), String> {
    sharing::update_member(&state.guivault, vault_id, user_id, role).await.map_err(err)
}

#[tauri::command]
pub async fn guivault_remove_member(state: State<'_, AppState>, vault_id: VaultId, user_id: Uuid, rotate: bool) -> Result<(), String> {
    sharing::remove_member(&state.guivault, vault_id, user_id, rotate).await.map_err(err)
}

#[tauri::command]
pub async fn guivault_transfer_ownership(state: State<'_, AppState>, vault_id: VaultId, user_id: Uuid) -> Result<Status, String> {
    sharing::transfer_ownership(&state.guivault, vault_id, user_id).await.map_err(err)?;
    Ok(state.guivault.status())
}

#[tauri::command]
pub async fn guivault_lookup_user(state: State<'_, AppState>, email: String) -> Result<Option<sharing::UserLookup>, String> {
    sharing::lookup_user(&state.guivault, &email).await.map_err(err)
}

#[tauri::command]
pub fn guivault_pin_fingerprint(state: State<'_, AppState>, email: String, fingerprint: String) -> Result<(), String> {
    state.guivault.pin_fingerprint(&email.trim().to_lowercase(), &fingerprint).map_err(err)
}

// ─── Invitations ─────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn guivault_invite(state: State<'_, AppState>, vault_id: VaultId, email: String, role: Role) -> Result<sharing::InvitationView, String> {
    sharing::invite(&state.guivault, vault_id, &email, role).await.map_err(err)
}

#[tauri::command]
pub async fn guivault_vault_invitations(state: State<'_, AppState>, vault_id: VaultId) -> Result<Vec<sharing::InvitationView>, String> {
    sharing::vault_invitations(&state.guivault, vault_id).await.map_err(err)
}

#[tauri::command]
pub async fn guivault_my_invitations(state: State<'_, AppState>) -> Result<Vec<sharing::InvitationView>, String> {
    sharing::my_invitations(&state.guivault).await.map_err(err)
}

#[tauri::command]
pub async fn guivault_accept_invitation(app: AppHandle, state: State<'_, AppState>, id: Uuid) -> Result<sharing::InvitationView, String> {
    let inv = sharing::accept_invitation(&state.guivault, id).await.map_err(err)?;
    let _ = run_sync(&app, &state).await;
    Ok(inv)
}

#[tauri::command]
pub async fn guivault_decline_invitation(state: State<'_, AppState>, id: Uuid) -> Result<(), String> {
    sharing::decline_invitation(&state.guivault, id).await.map_err(err)
}

#[tauri::command]
pub async fn guivault_revoke_invitation(state: State<'_, AppState>, id: Uuid) -> Result<(), String> {
    sharing::revoke_invitation(&state.guivault, id).await.map_err(err)
}

#[tauri::command]
pub async fn guivault_complete_invitation(state: State<'_, AppState>, vault_id: VaultId, id: Uuid) -> Result<sharing::InvitationView, String> {
    sharing::complete_invitation(&state.guivault, vault_id, id).await.map_err(err)
}

