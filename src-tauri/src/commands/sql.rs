use crate::state::AppState;
use serde::{Deserialize, Serialize};
use tauri::State;
use termius_core::model::{GroupId, SqlConnection, SqlConnectionId, SqlEngine, Workspace};
use termius_core::sql::{self, ColumnInfo, QueryResult, SqlPool, TableInfo};
use termius_core::store;
use termius_core::sync_ext::MutexExt;
use termius_core::vault::{self, SecretKind};

fn persist(workspace: &Workspace) -> Result<(), String> {
    store::save(workspace).map_err(|e| e.to_string())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveSqlConnectionInput {
    pub id: Option<SqlConnectionId>,
    pub label: String,
    pub engine: SqlEngine,
    #[serde(default)]
    pub tunnel_host_id: Option<termius_core::model::HostId>,
    pub address: String,
    pub port: u16,
    pub username: String,
    #[serde(default)]
    pub database: Option<String>,
    #[serde(default)]
    pub group_id: Option<GroupId>,
    #[serde(default)]
    pub tags: Vec<String>,
    /// Plaintext password, stored in the vault — never persisted in
    /// `workspace.json`. `None`/omitted leaves whichever password (if any)
    /// is already stored untouched, same convention as `save_host`'s
    /// `secret` field — but unlike a host, there's no auth-method switch
    /// here to clean up a stale slot for.
    pub secret: Option<String>,
}

#[tauri::command]
pub fn save_sql_connection(state: State<'_, AppState>, input: SaveSqlConnectionInput) -> Result<Workspace, String> {
    let mut workspace = state.workspace.lock_recover();

    let conn_id = match input.id {
        Some(id) => {
            if let Some(conn) = workspace.sql_connections.iter_mut().find(|c| c.id == id) {
                conn.label = input.label;
                conn.engine = input.engine;
                conn.tunnel_host_id = input.tunnel_host_id;
                conn.address = input.address;
                conn.port = input.port;
                conn.username = input.username;
                conn.database = input.database;
                conn.group_id = input.group_id;
                conn.tags = input.tags;
            }
            id
        }
        None => {
            let mut conn = SqlConnection::new(input.label, input.engine, input.address, input.username);
            conn.tunnel_host_id = input.tunnel_host_id;
            conn.port = input.port;
            conn.database = input.database;
            conn.group_id = input.group_id;
            conn.tags = input.tags;
            let id = conn.id;
            workspace.sql_connections.push(conn);
            id
        }
    };

    if let Some(secret) = input.secret.filter(|s| !s.is_empty()) {
        let _ = vault::store(conn_id, SecretKind::SqlPassword, &secret);
    }

    persist(&workspace)?;
    Ok(workspace.clone())
}

#[tauri::command]
pub fn delete_sql_connection(state: State<'_, AppState>, connection_id: SqlConnectionId) -> Result<Workspace, String> {
    let mut workspace = state.workspace.lock_recover();
    workspace.sql_connections.retain(|c| c.id != connection_id);
    let _ = vault::delete(connection_id, SecretKind::SqlPassword);
    persist(&workspace)?;
    Ok(workspace.clone())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenSqlSessionResult {
    pub session_id: String,
    /// `None` only for a PostgreSQL connection with no database configured —
    /// the frontend then shows a database picker (via `list_sql_databases`)
    /// instead of going straight to `list_sql_schemas`. See
    /// `sql::SqlSession::database`'s doc comment.
    pub database: Option<String>,
}

/// Opens a pool (directly, or through an ephemeral SSH tunnel — see
/// `termius_core::sql::connect`) and stores it in `AppState.sql_sessions`
/// under a freshly generated id, returned for the frontend to pass back on
/// every subsequent `list_sql_*`/`run_sql_query`/`close_sql_session` call —
/// same "opaque id → live resource" shape as `commands::sftp::open_pane`.
#[tauri::command]
pub async fn open_sql_session(state: State<'_, AppState>, connection_id: SqlConnectionId) -> Result<OpenSqlSessionResult, String> {
    let (workspace, conn) = {
        let workspace = state.workspace.lock_recover();
        let conn = workspace
            .sql_connection(connection_id)
            .cloned()
            .ok_or_else(|| "connexion SQL inconnue".to_string())?;
        (workspace.clone(), conn)
    };
    let session = sql::connect(&workspace, &conn).await.map_err(|e| e.to_string())?;
    let session_id = uuid::Uuid::new_v4().to_string();
    let database = session.database.clone();
    state.sql_sessions.lock_recover().insert(session_id.clone(), session);
    Ok(OpenSqlSessionResult { session_id, database })
}

/// Real databases on the server — only meaningful for the PostgreSQL
/// "no database configured" case (see `OpenSqlSessionResult::database`);
/// `sql::list_databases` itself rejects a MySQL pool.
#[tauri::command]
pub async fn list_sql_databases(state: State<'_, AppState>, session_id: String) -> Result<Vec<String>, String> {
    let pool = session_pool(&state, &session_id)?;
    sql::list_databases(&pool).await.map_err(|e| e.to_string())
}

/// Reconnects the session's pool to `database` — PostgreSQL can't switch
/// database on an already-open connection, so this opens a fresh pool
/// through the *same* dial target (reusing the tunnel if any, never
/// reopening a second SSH connection) and swaps it in, closing the old
/// (bootstrap) pool. The session id is unchanged: every `list_sql_*`/
/// `run_sql_query` call after this uses the same `session_id`, now scoped
/// to `database`.
#[tauri::command]
pub async fn switch_sql_database(state: State<'_, AppState>, session_id: String, database: String) -> Result<(), String> {
    let dial = {
        let sessions = state.sql_sessions.lock_recover();
        let session = sessions.get(&session_id).ok_or_else(|| "session SQL inconnue ou fermée".to_string())?;
        session.dial()
    };
    let new_pool = sql::open_database(&dial, &database).await.map_err(|e| e.to_string())?;
    let old_pool = {
        let mut sessions = state.sql_sessions.lock_recover();
        let session = sessions.get_mut(&session_id).ok_or_else(|| "session SQL inconnue ou fermée".to_string())?;
        session.replace_pool(new_pool, database)
    };
    old_pool.close().await;
    Ok(())
}

#[tauri::command]
pub async fn close_sql_session(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    let session = state.sql_sessions.lock_recover().remove(&session_id);
    if let Some(session) = session {
        session.close().await;
    }
    Ok(())
}

/// Clones the pool (cheap — each `SqlPool` variant is `Arc`-based) out of
/// the session map under the lock, then drops the lock before returning —
/// every `list_sql_*`/`run_sql_query` command below calls this first so the
/// actual query `.await`s never happen while holding the
/// (non-`Send`-across-`.await`) `std::sync::MutexGuard`.
fn session_pool(state: &AppState, session_id: &str) -> Result<SqlPool, String> {
    let sessions = state.sql_sessions.lock_recover();
    let session = sessions.get(session_id).ok_or_else(|| "session SQL inconnue ou fermée".to_string())?;
    Ok(session.pool.clone())
}

#[tauri::command]
pub async fn list_sql_schemas(state: State<'_, AppState>, session_id: String) -> Result<Vec<String>, String> {
    let pool = session_pool(&state, &session_id)?;
    sql::list_schemas(&pool).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_sql_tables(state: State<'_, AppState>, session_id: String, schema: String) -> Result<Vec<TableInfo>, String> {
    let pool = session_pool(&state, &session_id)?;
    sql::list_tables(&pool, &schema).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_sql_columns(state: State<'_, AppState>, session_id: String, schema: String, table: String) -> Result<Vec<ColumnInfo>, String> {
    let pool = session_pool(&state, &session_id)?;
    sql::list_columns(&pool, &schema, &table).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn run_sql_query(state: State<'_, AppState>, session_id: String, sql: String) -> Result<QueryResult, String> {
    let pool = session_pool(&state, &session_id)?;
    sql::execute_query(&pool, &sql).await.map_err(|e| e.to_string())
}
