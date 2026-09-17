//! Commandes GuiVault : compte, synchronisation, vaults partagés. Fine couche
//! au-dessus de `termius_core::guivault` — la logique est là-bas, ici on
//! prend les verrous du workspace et on convertit les erreurs.
use crate::state::AppState;
use guivault_protocol::Role;
use serde::Deserialize;
use tauri::{AppHandle, Emitter, Manager as _, State};
use termius_core::guivault::{LoginStep, Report, Status, VaultSummary, sharing, sync, transfer};
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
    // Profil local affiché : le workspace en mémoire est le local, celui du
    // compte est sur le disque — c'est lui qu'on synchronise, sans rien
    // toucher à l'écran. La synchro continue donc quoi qu'on regarde.
    let account_file = match (state.guivault.view_local(), state.guivault.active_user_id()) {
        (true, Some(id)) => Some(state.guivault.workspace_path(id)),
        _ => None,
    };
    let snapshot = match &account_file {
        Some(path) => load_workspace_at(path),
        None => state.workspace.lock_recover().clone(),
    };
    let (changes, report) = sync::run(&state.guivault, &snapshot).await?;
    if !changes.is_empty() {
        match &account_file {
            Some(path) => {
                let mut ws = snapshot;
                sync::apply_changes(&mut ws, changes);
                store::save_at(path, &ws)?;
            }
            None => {
                let mut ws = state.workspace.lock_recover();
                sync::apply_changes(&mut ws, changes);
                store::save(&ws)?;
            }
        }
    }
    let _ = app.emit(SYNCED_EVENT, &report);
    Ok(report)
}

// ─── Déplacer des entités ────────────────────────────────────────────────────

/// Les deux workspaces d'un compte connecté : celui affiché est en mémoire,
/// l'autre sur le disque. `f` reçoit `(local, compte)` et dit si elle a
/// modifié quelque chose ; les deux sont alors sauvés.
fn with_both_workspaces<T>(
    state: &AppState,
    f: impl FnOnce(&mut Workspace, &mut Workspace) -> Result<T, String>,
) -> Result<T, String> {
    let user_id = state.guivault.active_user_id().ok_or("aucun compte connecté")?;
    let account_path = state.guivault.workspace_path(user_id);
    let local_path = store::local_workspace_path().map_err(err)?;
    let view_local = state.guivault.view_local();
    let mut shown = state.workspace.lock_recover();
    let mut other = load_workspace_at(if view_local { &account_path } else { &local_path });
    let out = if view_local { f(&mut shown, &mut other)? } else { f(&mut other, &mut shown)? };
    store::save(&shown).map_err(err)?;
    store::save_at(if view_local { &account_path } else { &local_path }, &other).map_err(err)?;
    Ok(out)
}

/// Les entités du profil local ou du compte, pour le menu des vaults.
#[tauri::command]
pub fn guivault_list_entities(state: State<'_, AppState>, scope: String) -> Result<Vec<transfer::EntitySummary>, String> {
    let want_local = match scope.as_str() {
        "local" => true,
        "account" => false,
        _ => return Err("scope : local | account".into()),
    };
    let shown_is_local = state.guivault.view_local() || state.guivault.active_user_id().is_none();
    if want_local == shown_is_local {
        return Ok(transfer::list(&state.workspace.lock_recover()));
    }
    let path = if want_local {
        store::local_workspace_path().map_err(err)?
    } else {
        let id = state.guivault.active_user_id().ok_or("aucun compte connecté")?;
        state.guivault.workspace_path(id)
    };
    Ok(transfer::list(&load_workspace_at(&path)))
}

/// Déplace des entités du profil local vers le compte (`to_account`,
/// affiliées à `vault_id` ou au personnel), ou l'inverse. Ce qui doit les
/// accompagner (dossiers, clé, sous-arbre) suit. Vers le local, une entité
/// d'un vault partagé est **retirée** du vault — donc refusé sans droit
/// d'écriture, sinon elle reviendrait à la synchro suivante.
#[tauri::command]
pub async fn guivault_transfer_entities(
    app: AppHandle,
    state: State<'_, AppState>,
    ids: Vec<Uuid>,
    to_account: bool,
    vault_id: Option<VaultId>,
    copy: bool,
) -> Result<usize, String> {
    let status = state.guivault.status();
    if let Some(v) = vault_id
        && !status.vaults.iter().any(|x| x.id == v && x.role.can_write_items())
    {
        return Err("pas de droit d'écriture dans ce vault".into());
    }
    let moved = with_both_workspaces(&state, |local, account| {
        if copy {
            // Une copie ne retire rien : le droit d'écriture ne compte que
            // du côté où elle arrive (vérifié plus haut pour un vault).
            return if to_account {
                transfer::copy(local, account, &ids, vault_id).map_err(err)
            } else {
                transfer::copy(account, local, &ids, None).map_err(err)
            };
        }
        if to_account {
            Ok(transfer::transfer(local, account, &ids, vault_id))
        } else {
            let set = transfer::closure(account, &ids);
            for id in &set {
                if let Some(v) = account.vault_bindings.get(id)
                    && !status.vaults.iter().any(|x| x.id == *v && x.role.can_write_items())
                {
                    return Err("une des entités vient d'un vault en lecture seule : impossible de la retirer".into());
                }
            }
            Ok(transfer::transfer(account, local, &ids, None))
        }
    })?;
    // Le compte a changé : pousser (ou tombaliser) tout de suite.
    let _ = run_sync(&app, &state).await;
    Ok(moved)
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

// ─── Un workspace par compte ─────────────────────────────────────────────────

/// Rend le workspace du compte qui vient de se connecter le workspace
/// courant. `adopt_local` : le compte n'avait pas encore de workspace sur
/// cette machine et l'utilisateur veut y **transférer** ce qu'il y a dans le
/// profil local — le local est alors vidé (les entités appartiennent
/// désormais au compte ; elles reviendront à chaque connexion).
fn activate_account_workspace(state: &AppState, status: &Status, adopt_local: bool) -> Result<(), String> {
    let Some(user_id) = status.user_id else {
        return Err("aucun compte actif après la connexion".into());
    };
    let account_path = state.guivault.workspace_path(user_id);
    let adopt = adopt_local && !account_path.exists();
    let mut ws = state.workspace.lock_recover();
    // Ce qui était affiché était le profil local : le sauver là où il est.
    store::save(&ws).map_err(err)?;
    if adopt {
        let adopted = std::mem::take(&mut *ws);
        // Le compte reçoit sa copie avant que le local, vidé, soit écrit :
        // si la suite échoue, rien n'est perdu.
        store::save_at(&account_path, &adopted).map_err(err)?;
        store::save(&ws).map_err(err)?;
        store::set_active_workspace(Some(account_path));
        *ws = adopted;
    } else {
        store::set_active_workspace(Some(account_path.clone()));
        *ws = load_workspace_at(&account_path);
    }
    Ok(())
}

/// Bascule ce qui est affiché entre le profil local et le compte connecté,
/// sans toucher à la session. Côté local, la synchronisation est en pause
/// (`sync::run` refuse) — rien du local ne part jamais vers le serveur.
#[tauri::command]
pub async fn guivault_switch_view(app: AppHandle, state: State<'_, AppState>, view_local: bool) -> Result<Status, String> {
    let Some(user_id) = state.guivault.active_user_id() else {
        return Err("aucun compte connecté".into());
    };
    if state.guivault.view_local() == view_local {
        return Ok(state.guivault.status());
    }
    let status = state.guivault.set_view_local(view_local).map_err(err)?;
    if view_local {
        activate_local_workspace(&state)?;
    } else {
        // Bloc : le verrou du workspace ne doit pas traverser l'`await`.
        {
            let path = state.guivault.workspace_path(user_id);
            let mut ws = state.workspace.lock_recover();
            store::save(&ws).map_err(err)?;
            store::set_active_workspace(Some(path.clone()));
            *ws = load_workspace_at(&path);
        }
        let _ = run_sync(&app, &state).await;
    }
    Ok(status)
}

/// Retour au profil local : le workspace du compte est sauvé, celui du local
/// rechargé.
fn activate_local_workspace(state: &AppState) -> Result<(), String> {
    let mut ws = state.workspace.lock_recover();
    store::save(&ws).map_err(err)?;
    store::set_active_workspace(None);
    let local = store::local_workspace_path().map_err(err)?;
    *ws = load_workspace_at(&local);
    Ok(())
}

fn load_workspace_at(path: &std::path::Path) -> Workspace {
    match store::load_resilient_at(path) {
        Ok(store::LoadOutcome::Loaded(ws)) => ws,
        Ok(store::LoadOutcome::Recovered { workspace, backup }) => {
            tracing::error!("workspace illisible — préservé sous « {} »", backup.display());
            workspace
        }
        Err(e) => {
            tracing::error!("chargement du workspace : {e}");
            Workspace::default()
        }
    }
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
    /// Transférer le profil local dans ce compte (première connexion de ce
    /// compte sur cette machine seulement).
    #[serde(default)]
    pub adopt_local: bool,
}

#[tauri::command]
pub async fn guivault_register(app: AppHandle, state: State<'_, AppState>, input: ConnectInput) -> Result<Status, String> {
    let status = state
        .guivault
        .register(&input.server_url, &input.email, &input.password, input.device_name)
        .await
        .map_err(err)?;
    activate_account_workspace(&state, &status, input.adopt_local)?;
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
    match &step {
        LoginStep::Connected(status) => {
            activate_account_workspace(&state, status, input.adopt_local)?;
            let _ = run_sync(&app, &state).await;
        }
        LoginStep::TotpRequired => {
            *state.guivault_pending_adopt.lock_recover() = input.adopt_local;
        }
    }
    Ok(step)
}

#[tauri::command]
pub async fn guivault_login_totp(app: AppHandle, state: State<'_, AppState>, code: String) -> Result<Status, String> {
    let status = state.guivault.login_totp(&code).await.map_err(err)?;
    let adopt = std::mem::take(&mut *state.guivault_pending_adopt.lock_recover());
    activate_account_workspace(&state, &status, adopt)?;
    let _ = run_sync(&app, &state).await;
    Ok(status)
}

/// Le compte est actif (son workspace est chargé) mais ses clés ne sont pas
/// en mémoire : même chemin qu'une connexion, sans changer de workspace.
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

/// Ferme la session et revient au profil local. Le compte reste connu et
/// son workspace l'attend.
#[tauri::command]
pub async fn guivault_logout(state: State<'_, AppState>) -> Result<Status, String> {
    let was_active = state.guivault.active_user_id().is_some();
    let status = state.guivault.logout().await.map_err(err)?;
    if was_active {
        activate_local_workspace(&state)?;
    }
    Ok(status)
}

/// Oublie un compte sur cette machine (session, clés, état de synchro et
/// son workspace local — les données restent sur le serveur).
#[tauri::command]
pub async fn guivault_forget(state: State<'_, AppState>, user_id: uuid::Uuid) -> Result<Status, String> {
    if state.guivault.active_user_id() == Some(user_id) {
        state.guivault.logout().await.map_err(err)?;
        activate_local_workspace(&state)?;
    }
    state.guivault.forget(user_id).await.map_err(err)
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
/// vault partagé, ou vers le personnel (`None`). Un hôte emmène ce qu'il
/// référence et qui n'est pas déjà partagé : la clé du trousseau, et son
/// dossier avec toute la chaîne de dossiers parents — sans eux, les autres
/// membres verraient un hôte qui pointe vers une clé qu'ils n'ont pas, ou
/// rangé dans un dossier qui n'existe pas chez eux (donc invisible).
#[tauri::command]
pub fn guivault_move_entity(state: State<'_, AppState>, id: Uuid, vault_id: Option<VaultId>) -> Result<Workspace, String> {
    let mut ws = state.workspace.lock_recover();
    let followers = transfer::closure(&ws, &[id]);
    match vault_id {
        Some(v) => {
            ws.vault_bindings.insert(id, v);
            for follower in followers {
                ws.vault_bindings.entry(follower).or_insert(v);
            }
        }
        None => {
            // Vers le personnel : le sous-arbre / la chaîne suit aussi, sinon
            // un dossier resterait partagé avec un hôte personnel dedans.
            for follower in followers {
                ws.vault_bindings.remove(&follower);
            }
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

