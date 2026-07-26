use crate::state::AppState;
use tauri::State;
use termius_core::model::{SqlConnectionId, SqlEngine};
use termius_core::mongo_client::{self, CollectionInfo, MongoHandle, MongoQueryResult};
use termius_core::sync_ext::MutexExt;

/// Opens a connection (directly, or through an ephemeral SSH tunnel — see
/// `termius_core::mongo_client::connect`) and stores it in
/// `AppState.mongo_sessions` under a freshly generated id, returned for the
/// frontend to pass back on every subsequent `list_mongo_databases`/
/// `list_mongo_collections`/`find_mongo_documents`/`close_mongo_session`
/// call — same "opaque id → live resource" shape as
/// `commands::sql::open_sql_session`/`commands::redis::open_redis_session`.
#[tauri::command]
pub async fn open_mongo_session(state: State<'_, AppState>, connection_id: SqlConnectionId) -> Result<String, String> {
    let (workspace, conn) = {
        let workspace = state.workspace.lock_recover();
        let conn = workspace
            .sql_connection(connection_id)
            .cloned()
            .ok_or_else(|| "connexion inconnue".to_string())?;
        if conn.engine() != SqlEngine::Mongodb {
            return Err("cette connexion n'est pas une connexion MongoDB".to_string());
        }
        (workspace.clone(), conn)
    };
    let session = mongo_client::connect(&workspace, &conn).await.map_err(|e| e.to_string())?;
    let session_id = uuid::Uuid::new_v4().to_string();
    state.mongo_sessions.lock_recover().insert(session_id.clone(), session);
    Ok(session_id)
}

#[tauri::command]
pub async fn close_mongo_session(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    let session = state.mongo_sessions.lock_recover().remove(&session_id);
    if let Some(session) = session {
        session.close().await.map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Clones the handle (cheap — `MongoHandle` is `Arc`-based internally) out
/// of the session map under the lock, then drops the lock before returning —
/// same discipline as `commands::sql::session_pool`/
/// `commands::redis::session_handle`.
fn session_handle(state: &AppState, session_id: &str) -> Result<MongoHandle, String> {
    let sessions = state.mongo_sessions.lock_recover();
    let session = sessions.get(session_id).ok_or_else(|| "session MongoDB inconnue ou fermée".to_string())?;
    Ok(session.handle())
}

#[tauri::command]
pub async fn list_mongo_databases(state: State<'_, AppState>, session_id: String) -> Result<Vec<String>, String> {
    let handle = session_handle(&state, &session_id)?;
    mongo_client::list_databases(handle).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_mongo_collections(state: State<'_, AppState>, session_id: String, database: String) -> Result<Vec<CollectionInfo>, String> {
    let handle = session_handle(&state, &session_id)?;
    mongo_client::list_collections(handle, &database).await.map_err(|e| e.to_string())
}

/// `filter`: a JSON filter object typed into the "Requête" tab, or `None`
/// for the "Données" tab's unfiltered listing — both funnel through the
/// same `find_documents`, see its doc comment.
#[tauri::command]
pub async fn find_mongo_documents(
    state: State<'_, AppState>,
    session_id: String,
    database: String,
    collection: String,
    filter: Option<String>,
) -> Result<MongoQueryResult, String> {
    let handle = session_handle(&state, &session_id)?;
    mongo_client::find_documents(handle, &database, &collection, filter.as_deref()).await.map_err(|e| e.to_string())
}
