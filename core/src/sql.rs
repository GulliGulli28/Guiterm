//! MySQL/PostgreSQL client — connects either directly to a database server
//! or tunnelled through an existing saved SSH host (see
//! [`crate::model::SqlConnection::tunnel_host_id`]), introspects the schema
//! (databases/schemas, tables, columns via `information_schema`), and runs
//! ad-hoc queries. Lives directly in `core/` rather than a separate sidecar
//! process/workspace (contrast RDP's `rdp-sidecar` — see CLAUDE.md's
//! "Pourquoi un processus RDP séparé"): `sqlx` was checked against this
//! workspace's existing dependency graph (`russh`/`kube`/`reqwest`/
//! `bollard`) before adding it and resolves cleanly, reusing the same
//! `ecdsa`/`rustls` versions already pulled in — no exact-pin conflict like
//! `ironrdp-connector`'s `picky` dependency had.
//!
//! **MySQL vs. PostgreSQL browsing shape.** A MySQL connection can list and
//! switch between every database on the server without reconnecting (each
//! query below just runs `information_schema` lookups scoped to whichever
//! database name is passed in). A PostgreSQL connection is permanently
//! scoped to the one database named at connect time — there is no
//! server-wide "list every database" step that would actually be
//! browsable, only *schemas* within that fixed database. [`list_schemas`]
//! reflects this honestly instead of faking a uniform "databases" list:
//! MySQL databases and PostgreSQL schemas are exposed through the same
//! function/tree level because they're the same *browsing granularity* for
//! each engine, not because they're the same concept.
//!
//! **Known limitations, accepted for a first version** (none of this has
//! been exercised against a real MySQL/PostgreSQL server — no server
//! reachable in this dev environment, same caveat as RDP/K8s/Docker-via-SSH
//! before this):
//! - No primary-key/index information in [`list_columns`] — name/type/
//!   nullability only, to keep the introspection query itself simple and
//!   fully portable (the `information_schema.columns` shape used here is
//!   identical for both engines).
//! - [`execute_query`] can't report a precise "N rows affected" for an
//!   INSERT/UPDATE/DELETE/DDL statement — see its doc comment.
//! - No streaming `Channel` for query results (see [`QueryResult`]'s doc
//!   comment) — a hard row cap instead, consistent with how this app
//!   already treats "small/bounded" vs. "hot path" data going to the
//!   frontend (`docs/dev-history.md`'s RDP-frames section spells out that
//!   threshold).

use crate::model::{PortForward, PortForwardKind, SqlConnection, SqlEngine, Workspace};
use crate::port_forward::{self, ActiveForward};
use crate::ssh::{self, Connection};
use crate::vault::{self, SecretKind};
use futures_util::TryStreamExt;
use serde::Serialize;
use sqlx::any::{AnyPoolOptions, AnyTypeInfoKind};
use sqlx::{Column, Row};
use std::sync::Arc;

// Re-exported so `src-tauri` never needs `sqlx` as a direct dependency —
// same convention already followed for `bollard`/`kube` (their types are
// only ever named through `core`'s own wrappers, never directly in
// `src-tauri`, see e.g. `state.rs`'s `Pane` doc comment).
pub use sqlx::AnyPool;

/// A live SQL connection: the pool, plus — when tunnelled — the SSH
/// connection and forward keeping the tunnel open for as long as the pool
/// is. Dropping this without calling [`close`](SqlSession::close) first
/// leaves the tunnel's accept loop running detached: `ActiveForward` has no
/// `Drop`-based teardown by design (see its doc comment), so `close()` must
/// be called explicitly — exactly like `commands::forward::stop_forward`
/// already has to for a persisted tunnel.
pub struct SqlSession {
    pub pool: AnyPool,
    /// Carried alongside the pool so the Tauri command layer can pick the
    /// right introspection SQL (see `list_schemas`/`list_tables`/
    /// `list_columns`) without re-reading the `SqlConnection` back out of
    /// the workspace, which may have been edited or deleted since this
    /// session was opened.
    pub engine: SqlEngine,
    tunnel: Option<(Arc<Connection>, ActiveForward)>,
}

impl SqlSession {
    pub async fn close(self) {
        self.pool.close().await;
        if let Some((connection, active)) = self.tunnel {
            active.stop(&connection).await;
        }
    }
}

fn scheme(engine: SqlEngine) -> &'static str {
    match engine {
        SqlEngine::Mysql => "mysql",
        SqlEngine::Postgres => "postgres",
    }
}

/// Builds a connection URL via `url::Url`'s own setters rather than
/// `format!`-ing the pieces together — a username/password containing `@`,
/// `:`, `/`, `%`, etc. would otherwise silently corrupt a hand-built URL
/// string instead of just failing loudly.
fn build_url(engine: SqlEngine, host: &str, port: u16, username: &str, password: Option<&str>, database: Option<&str>) -> anyhow::Result<url::Url> {
    let mut url = url::Url::parse(&format!("{}://placeholder", scheme(engine)))?;
    url.set_host(Some(host)).map_err(|_| anyhow::anyhow!("adresse invalide : {host:?}"))?;
    url.set_port(Some(port)).map_err(|_| anyhow::anyhow!("port invalide"))?;
    if !username.is_empty() {
        url.set_username(username).map_err(|_| anyhow::anyhow!("nom d'utilisateur invalide"))?;
    }
    url.set_password(password.filter(|p| !p.is_empty())).map_err(|_| anyhow::anyhow!("mot de passe invalide"))?;
    if let Some(db) = database.filter(|d| !d.is_empty()) {
        url.set_path(db);
    }
    Ok(url)
}

/// Connects to `conn` — directly, or (when `tunnel_host_id` is set) via an
/// ephemeral SSH local port forward through that saved host first. The
/// forward is never persisted / never visible in the Tunnels panel: it's
/// built in memory with `bind_port: 0` (OS-assigned, via
/// `ActiveForward::bound_addr`) and lives only inside the returned
/// `SqlSession`, torn down by `SqlSession::close`.
pub async fn connect(workspace: &Workspace, conn: &SqlConnection) -> anyhow::Result<SqlSession> {
    sqlx::any::install_default_drivers();

    let password = vault::load(conn.id, SecretKind::SqlPassword)?;

    let (dial_host, dial_port, tunnel) = match conn.tunnel_host_id {
        None => (conn.address.clone(), conn.port, None),
        Some(host_id) => {
            let connection = Arc::new(ssh::connect(workspace, host_id).await?);
            let forward = PortForward {
                id: uuid::Uuid::new_v4(),
                host_id,
                kind: PortForwardKind::Local,
                bind_address: "127.0.0.1".to_string(),
                bind_port: 0,
                dest_address: conn.address.clone(),
                dest_port: conn.port,
            };
            let active = port_forward::start(connection.clone(), forward).await?;
            let bound = active
                .bound_addr()
                .ok_or_else(|| anyhow::anyhow!("le tunnel SSH n'a pas pu s'ouvrir"))?;
            ("127.0.0.1".to_string(), bound.port(), Some((connection, active)))
        }
    };

    let url = build_url(conn.engine, &dial_host, dial_port, &conn.username, password.as_deref(), conn.database.as_deref())?;
    let pool = match AnyPoolOptions::new().max_connections(4).connect(url.as_str()).await {
        Ok(pool) => pool,
        Err(e) => {
            // The pool never opened — nothing to close, but the tunnel (if
            // any) is already live and must still be torn down here, since
            // there's no `SqlSession` for the caller to call `close()` on.
            if let Some((connection, active)) = tunnel {
                active.stop(&connection).await;
            }
            return Err(e.into());
        }
    };

    Ok(SqlSession { pool, engine: conn.engine, tunnel })
}

const MYSQL_SYSTEM_SCHEMAS: [&str; 4] = ["information_schema", "performance_schema", "mysql", "sys"];

/// The list of "database-like" containers to browse under the current
/// connection — see this module's doc comment for why MySQL databases and
/// PostgreSQL schemas share this one function despite not being the same
/// concept.
///
/// This and the three functions below take `&AnyPool` rather than
/// `&SqlSession` — `AnyPool` clones cheaply (it's `Arc`-based internally,
/// like every sqlx pool type), so the Tauri command layer can clone it out
/// of `AppState.sql_sessions`'s `std::sync::Mutex` and drop the lock before
/// awaiting, rather than holding a non-`Send` `MutexGuard` across `.await`.
pub async fn list_schemas(pool: &AnyPool, engine: SqlEngine) -> anyhow::Result<Vec<String>> {
    let sql = match engine {
        SqlEngine::Mysql => "SHOW DATABASES",
        SqlEngine::Postgres => {
            "SELECT schema_name FROM information_schema.schemata \
             WHERE schema_name NOT LIKE 'pg\\_%' AND schema_name <> 'information_schema' \
             ORDER BY schema_name"
        }
    };
    let rows = sqlx::query(sql).fetch_all(pool).await?;
    let mut names: Vec<String> = rows.iter().filter_map(|r| r.try_get::<String, _>(0).ok()).collect();
    if engine == SqlEngine::Mysql {
        names.retain(|n| !MYSQL_SYSTEM_SCHEMAS.contains(&n.as_str()));
    }
    Ok(names)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableInfo {
    pub name: String,
    /// `"table"` or `"view"` — `information_schema.tables.table_type`
    /// lowercased (`"BASE TABLE"` normalized to `"table"`).
    pub kind: String,
}

pub async fn list_tables(pool: &AnyPool, engine: SqlEngine, schema: &str) -> anyhow::Result<Vec<TableInfo>> {
    let sql = match engine {
        SqlEngine::Mysql => "SELECT table_name, table_type FROM information_schema.tables WHERE table_schema = ? ORDER BY table_name",
        SqlEngine::Postgres => "SELECT table_name, table_type FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name",
    };
    let rows = sqlx::query(sql).bind(schema).fetch_all(pool).await?;
    Ok(rows
        .iter()
        .map(|r| TableInfo {
            name: r.try_get(0).unwrap_or_default(),
            kind: if r.try_get::<String, _>(1).unwrap_or_default().eq_ignore_ascii_case("VIEW") { "view".to_string() } else { "table".to_string() },
        })
        .collect())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnInfo {
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
}

pub async fn list_columns(pool: &AnyPool, engine: SqlEngine, schema: &str, table: &str) -> anyhow::Result<Vec<ColumnInfo>> {
    let sql = match engine {
        SqlEngine::Mysql => {
            "SELECT column_name, data_type, is_nullable FROM information_schema.columns \
             WHERE table_schema = ? AND table_name = ? ORDER BY ordinal_position"
        }
        SqlEngine::Postgres => {
            "SELECT column_name, data_type, is_nullable FROM information_schema.columns \
             WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position"
        }
    };
    let rows = sqlx::query(sql).bind(schema).bind(table).fetch_all(pool).await?;
    Ok(rows
        .iter()
        .map(|r| ColumnInfo {
            name: r.try_get(0).unwrap_or_default(),
            data_type: r.try_get(1).unwrap_or_default(),
            nullable: r.try_get::<String, _>(2).map(|s| s.eq_ignore_ascii_case("YES")).unwrap_or(true),
        })
        .collect())
}

/// Hard cap on rows returned by [`execute_query`] — enforced incrementally
/// while streaming (`fetch`, not `fetch_all`), so a `SELECT` without a
/// `LIMIT` against a huge table doesn't have to be fully buffered in memory
/// first, same discipline as `core::k8s_pane`'s size-capped downloads.
const MAX_RESULT_ROWS: usize = 5000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryResult {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<serde_json::Value>>,
    /// `true` when more than [`MAX_RESULT_ROWS`] rows matched — only the
    /// first `MAX_RESULT_ROWS` are in `rows`. No pagination/streaming to
    /// fetch the rest in this first version — see this module's doc comment.
    pub truncated: bool,
}

/// Runs `sql` and returns whatever rows it produced. Uses the same call
/// (`fetch`) for `SELECT` and for `INSERT`/`UPDATE`/`DELETE`/DDL — the
/// latter simply produce zero rows rather than erroring, which also means
/// there is no "N rows affected" count in `QueryResult` for those: getting
/// that would need a separate `execute()` call, and calling both would run
/// a mutating statement twice.
pub async fn execute_query(pool: &AnyPool, sql: &str) -> anyhow::Result<QueryResult> {
    let mut stream = sqlx::query(sql).fetch(pool);
    let mut columns: Vec<String> = Vec::new();
    let mut rows: Vec<Vec<serde_json::Value>> = Vec::new();
    let mut truncated = false;
    while let Some(row) = stream.try_next().await? {
        if columns.is_empty() {
            columns = row.columns().iter().map(|c| c.name().to_string()).collect();
        }
        if rows.len() >= MAX_RESULT_ROWS {
            truncated = true;
            break;
        }
        rows.push(decode_row(&row));
    }
    Ok(QueryResult { columns, rows, truncated })
}

fn decode_row(row: &sqlx::any::AnyRow) -> Vec<serde_json::Value> {
    (0..row.columns().len()).map(|i| decode_value(row, i)).collect()
}

/// Decodes one cell into a JSON value, branching on the column's declared
/// type (`AnyTypeInfoKind` — a closed 9-variant set the `Any` driver
/// normalizes every backend's native types down to, verified against the
/// vendored `sqlx-core` source rather than assumed). `Option<T>`'s `Decode`
/// impl already treats a NULL value as `None` regardless of declared
/// column type, so NULLs fall out of this naturally. A decode that still
/// fails (e.g. a value that doesn't actually fit the declared type) falls
/// back to JSON `null` rather than erroring the whole query — losing one
/// cell's value beats losing the entire result set.
fn decode_value(row: &sqlx::any::AnyRow, i: usize) -> serde_json::Value {
    use AnyTypeInfoKind::*;
    match row.columns()[i].type_info().kind() {
        Null => serde_json::Value::Null,
        Bool => row.try_get::<Option<bool>, _>(i).ok().flatten().map(serde_json::Value::Bool).unwrap_or(serde_json::Value::Null),
        SmallInt => row.try_get::<Option<i16>, _>(i).ok().flatten().map(|v| serde_json::json!(v)).unwrap_or(serde_json::Value::Null),
        Integer => row.try_get::<Option<i32>, _>(i).ok().flatten().map(|v| serde_json::json!(v)).unwrap_or(serde_json::Value::Null),
        BigInt => row.try_get::<Option<i64>, _>(i).ok().flatten().map(|v| serde_json::json!(v)).unwrap_or(serde_json::Value::Null),
        Real => row.try_get::<Option<f32>, _>(i).ok().flatten().map(|v| serde_json::json!(v as f64)).unwrap_or(serde_json::Value::Null),
        Double => row.try_get::<Option<f64>, _>(i).ok().flatten().map(|v| serde_json::json!(v)).unwrap_or(serde_json::Value::Null),
        Text => row.try_get::<Option<String>, _>(i).ok().flatten().map(serde_json::Value::String).unwrap_or(serde_json::Value::Null),
        Blob => row
            .try_get::<Option<Vec<u8>>, _>(i)
            .ok()
            .flatten()
            .map(|b| serde_json::Value::String(format!("\\x{}", b.iter().map(|byte| format!("{byte:02x}")).collect::<String>())))
            .unwrap_or(serde_json::Value::Null),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_url_percent_encodes_special_characters_in_credentials() {
        let url = build_url(SqlEngine::Postgres, "db.example.com", 5432, "ro user", Some("p@ss:w/rd"), Some("app")).unwrap();
        // A hand-`format!`-ed URL would have broken here (the `@`/`:`/`/`
        // inside the password would have been parsed as URL structure) —
        // `Url`'s setters percent-encode instead, and re-parsing the
        // stringified URL recovers the exact original values.
        assert_eq!(url.username(), "ro%20user");
        assert_eq!(url.password(), Some("p%40ss%3Aw%2Frd"));
        let reparsed = url::Url::parse(url.as_str()).unwrap();
        assert_eq!(reparsed.username(), "ro%20user");
        assert_eq!(reparsed.password(), Some("p%40ss%3Aw%2Frd"));
    }

    #[test]
    fn build_url_uses_the_engines_scheme_and_carries_host_port_and_database() {
        let mysql = build_url(SqlEngine::Mysql, "10.0.0.5", 3306, "root", None, Some("app_db")).unwrap();
        assert_eq!(mysql.scheme(), "mysql");
        assert_eq!(mysql.host_str(), Some("10.0.0.5"));
        assert_eq!(mysql.port(), Some(3306));
        assert_eq!(mysql.path(), "/app_db");

        let pg = build_url(SqlEngine::Postgres, "127.0.0.1", 5432, "postgres", None, None).unwrap();
        assert_eq!(pg.scheme(), "postgres");
        assert_eq!(pg.port(), Some(5432));
    }

    #[test]
    fn build_url_omits_password_when_none_or_empty() {
        let no_password = build_url(SqlEngine::Mysql, "localhost", 3306, "root", None, None).unwrap();
        assert_eq!(no_password.password(), None);
        let empty_password = build_url(SqlEngine::Mysql, "localhost", 3306, "root", Some(""), None).unwrap();
        assert_eq!(empty_password.password(), None);
    }
}
