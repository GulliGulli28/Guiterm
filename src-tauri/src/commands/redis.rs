use crate::state::AppState;
use serde::Serialize;
use tauri::State;
use termius_core::model::{SqlConnectionId, SqlEngine};
use termius_core::redis_client::{self, RedisHandle, RedisKeyDetail, RedisReply, ScanPage};
use termius_core::sync_ext::MutexExt;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenRedisSessionResult {
    pub session_id: String,
    pub database: u8,
}

/// Opens a connection (directly, or through an ephemeral SSH tunnel — see
/// `termius_core::redis_client::connect`) and stores it in
/// `AppState.redis_sessions` under a freshly generated id, returned for the
/// frontend to pass back on every subsequent `scan_redis_keys`/
/// `get_redis_value`/`run_redis_command`/`close_redis_session` call — same
/// "opaque id → live resource" shape as `commands::sql::open_sql_session`.
#[tauri::command]
pub async fn open_redis_session(state: State<'_, AppState>, connection_id: SqlConnectionId) -> Result<OpenRedisSessionResult, String> {
    let (workspace, conn) = {
        let workspace = state.workspace.lock_recover();
        let conn = workspace
            .sql_connection(connection_id)
            .cloned()
            .ok_or_else(|| "connexion inconnue".to_string())?;
        if conn.engine() != SqlEngine::Redis {
            return Err("cette connexion n'est pas une connexion Redis".to_string());
        }
        (workspace.clone(), conn)
    };
    let session = redis_client::connect(&workspace, &conn).await.map_err(|e| e.to_string())?;
    let session_id = uuid::Uuid::new_v4().to_string();
    let database = session.database;
    state.redis_sessions.lock_recover().insert(session_id.clone(), session);
    Ok(OpenRedisSessionResult { session_id, database })
}

#[tauri::command]
pub async fn close_redis_session(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    let session = state.redis_sessions.lock_recover().remove(&session_id);
    if let Some(session) = session {
        session.close().await.map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Clones the handle (cheap — `RedisHandle` is `Arc`-based internally) out
/// of the session map under the lock, then drops the lock before returning —
/// every command below calls this first so the actual Redis round trip never
/// happens while holding the (non-`Send`-across-`.await`)
/// `std::sync::MutexGuard`, same discipline as `commands::sql::session_pool`.
fn session_handle(state: &AppState, session_id: &str) -> Result<RedisHandle, String> {
    let sessions = state.redis_sessions.lock_recover();
    let session = sessions.get(session_id).ok_or_else(|| "session Redis inconnue ou fermée".to_string())?;
    Ok(session.handle())
}

#[tauri::command]
pub async fn scan_redis_keys(state: State<'_, AppState>, session_id: String, cursor: u64, pattern: Option<String>) -> Result<ScanPage, String> {
    let handle = session_handle(&state, &session_id)?;
    redis_client::scan_keys(handle, cursor, pattern.as_deref()).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_redis_value(state: State<'_, AppState>, session_id: String, key: String) -> Result<Option<RedisKeyDetail>, String> {
    let handle = session_handle(&state, &session_id)?;
    redis_client::get_value(handle, &key).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn run_redis_command(state: State<'_, AppState>, session_id: String, command: String) -> Result<RedisReply, String> {
    let handle = session_handle(&state, &session_id)?;
    redis_client::run_command(handle, &command).await.map_err(|e| e.to_string())
}
