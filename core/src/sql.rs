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
//! **[`SqlPool`], not `sqlx::Any` — verified against a real server, not just
//! reasoned about.** An earlier version of this module used `sqlx`'s
//! generic `Any` driver so [`list_schemas`]/[`list_tables`]/[`list_columns`]/
//! [`execute_query`] wouldn't need an engine-specific branch. That driver
//! only decodes a **closed 9-variant type set**
//! (`Null`/`Bool`/`SmallInt`/`Integer`/`BigInt`/`Real`/`Double`/`Text`/
//! `Blob` — verified in the vendored `sqlx-core-0.8.6/src/any/{type_info,
//! row,value}.rs`), and normalizes every backend's native types down to it.
//! Against a real PostgreSQL server this broke immediately: `schema_name`/
//! `table_name`/`column_name` are `sql_identifier` (a domain over the
//! internal `NAME` type, not `TEXT`), so introspection failed outright, and
//! `execute_query` hard-failed on *any* table with a `NUMERIC`/
//! `TIMESTAMP(TZ)`/`UUID`/`JSON(B)` column — i.e. most real tables — because
//! those types have no representation in the 9-variant set at all. This
//! isn't the "a decode that still fails falls back to JSON `null`" case the
//! previous version's decoder was built to tolerate: the row itself can't
//! be converted to `Any`'s row type in the first place, so the failure
//! surfaces before any per-cell decoding even runs, and takes out the whole
//! query. [`SqlPool`] instead wraps the real per-engine pool
//! (`sqlx::PgPool`/`sqlx::MySqlPool`), decoded by [`decode_pg_value`]/
//! [`decode_mysql_value`] against the actual type each backend reports.
//! Exercised end-to-end against a real PostgreSQL server (tunnelled through
//! a real SSH host, `core/examples/sql_wsl_smoke.rs`) — MySQL's decode path
//! mirrors the same verified-compatibility approach but has not had the
//! same live test yet.
//!
//! **Other known limitations, accepted for a first version:**
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
use sqlx::mysql::{MySqlPool, MySqlPoolOptions};
use sqlx::postgres::{PgPool, PgPoolOptions};
use sqlx::types::chrono::{DateTime, NaiveDate, NaiveDateTime, NaiveTime, Utc};
use sqlx::types::{Decimal, Uuid};
use sqlx::{Column, Row};
use std::sync::Arc;

/// The live pool behind a [`SqlSession`] — see this module's doc comment for
/// why this is a real per-engine pool rather than `sqlx::AnyPool`.
#[derive(Clone)]
pub enum SqlPool {
    Postgres(PgPool),
    Mysql(MySqlPool),
}

impl SqlPool {
    pub async fn close(self) {
        match self {
            SqlPool::Postgres(pool) => pool.close().await,
            SqlPool::Mysql(pool) => pool.close().await,
        }
    }
}

/// Everything needed to open a pool against a given database on the server
/// `connect` already dialed (directly, or through its tunnel) — kept on
/// [`SqlSession`] so [`open_database`] can open another database on the
/// *same* already-established dial target (reusing an existing SSH tunnel
/// rather than opening a second one) without needing the original
/// `SqlConnection`/`Workspace` again. Fields are private: the command layer
/// only ever holds this opaquely (via [`SqlSession::dial`]) and passes it
/// straight back to [`open_database`] — connection details/secrets never
/// need to cross into `commands::sql`.
#[derive(Clone)]
pub struct DialTarget {
    engine: SqlEngine,
    host: String,
    port: u16,
    username: String,
    password: Option<String>,
}

/// A live SQL connection: the pool, plus — when tunnelled — the SSH
/// connection and forward keeping the tunnel open for as long as the pool
/// is. Dropping this without calling [`close`](SqlSession::close) first
/// leaves the tunnel's accept loop running detached: `ActiveForward` has no
/// `Drop`-based teardown by design (see its doc comment), so `close()` must
/// be called explicitly — exactly like `commands::forward::stop_forward`
/// already has to for a persisted tunnel.
pub struct SqlSession {
    pub pool: SqlPool,
    /// The database `pool` is actually scoped to — `None` only in the
    /// PostgreSQL "no database configured" case, where `pool` is connected
    /// to a bootstrap database (see [`connect`]) purely so [`list_databases`]
    /// can enumerate real ones; the frontend shows a database picker instead
    /// of a schema tree until [`SqlSession::replace_pool`] is called via the
    /// `switch_sql_database` command. Always `Some` for MySQL (it lists
    /// every database up front regardless — see this module's doc comment)
    /// and for PostgreSQL connections with an explicit database configured.
    pub database: Option<String>,
    dial: DialTarget,
    tunnel: Option<(Arc<Connection>, ActiveForward)>,
}

impl SqlSession {
    pub async fn close(self) {
        self.pool.close().await;
        if let Some((connection, active)) = self.tunnel {
            active.stop(&connection).await;
        }
    }

    pub fn dial(&self) -> DialTarget {
        self.dial.clone()
    }

    /// Swaps in an already-connected `pool` for `database`, returning the
    /// previous pool for the caller to [`SqlPool::close`] — deliberately not
    /// done here: closing is I/O that shouldn't happen while the caller
    /// might still be holding a lock on the session map (see
    /// `commands::sql::switch_sql_database`).
    pub fn replace_pool(&mut self, pool: SqlPool, database: String) -> SqlPool {
        self.database = Some(database);
        std::mem::replace(&mut self.pool, pool)
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

/// PostgreSQL requires a database name at connection time (unlike MySQL,
/// where connecting without one is fine) — used to bootstrap a connection
/// just to enumerate real databases via [`list_databases`] when the user
/// left `SqlConnection::database` empty. `postgres` is the standard
/// maintenance database present on effectively every real install (the one
/// `psql`/`pgAdmin` themselves connect to for this exact purpose).
const POSTGRES_BOOTSTRAP_DATABASE: &str = "postgres";

/// Connects to `conn` — directly, or (when `tunnel_host_id` is set) via an
/// ephemeral SSH local port forward through that saved host first. The
/// forward is never persisted / never visible in the Tunnels panel: it's
/// built in memory with `bind_port: 0` (OS-assigned, via
/// `ActiveForward::bound_addr`) and lives only inside the returned
/// `SqlSession`, torn down by `SqlSession::close`.
pub async fn connect(workspace: &Workspace, conn: &SqlConnection) -> anyhow::Result<SqlSession> {
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

    let requested_database = conn.database.clone().filter(|d| !d.is_empty());
    let bootstrap_database = requested_database.clone().or_else(|| (conn.engine == SqlEngine::Postgres).then(|| POSTGRES_BOOTSTRAP_DATABASE.to_string()));
    let dial = DialTarget { engine: conn.engine, host: dial_host, port: dial_port, username: conn.username.clone(), password };

    let pool = match open_database(&dial, bootstrap_database.as_deref().unwrap_or_default()).await {
        Ok(pool) => pool,
        Err(e) => {
            // The pool never opened — nothing to close, but the tunnel (if
            // any) is already live and must still be torn down here, since
            // there's no `SqlSession` for the caller to call `close()` on.
            if let Some((connection, active)) = tunnel {
                active.stop(&connection).await;
            }
            return Err(e);
        }
    };

    Ok(SqlSession { pool, database: requested_database, dial, tunnel })
}

/// Opens a fresh pool for `database` against an already-resolved dial
/// target — either the initial connection ([`connect`]) or a later switch
/// to a different PostgreSQL database via the same tunnel
/// (`commands::sql::switch_sql_database`), which PostgreSQL requires since a
/// single connection can't change database once established (unlike
/// MySQL's `USE`, which is why MySQL never needs this function at all).
pub async fn open_database(dial: &DialTarget, database: &str) -> anyhow::Result<SqlPool> {
    let url = build_url(dial.engine, &dial.host, dial.port, &dial.username, dial.password.as_deref(), Some(database))?;
    match dial.engine {
        SqlEngine::Postgres => Ok(SqlPool::Postgres(PgPoolOptions::new().max_connections(4).connect(url.as_str()).await?)),
        SqlEngine::Mysql => Ok(SqlPool::Mysql(MySqlPoolOptions::new().max_connections(4).connect(url.as_str()).await?)),
    }
}

/// Real databases on the server — PostgreSQL only. MySQL never needs this:
/// [`list_schemas`] already lists every database up front regardless of
/// whatever `SqlConnection::database` was configured (see this module's doc
/// comment), so there's no separate "pick a database first" step for it.
pub async fn list_databases(pool: &SqlPool) -> anyhow::Result<Vec<String>> {
    match pool {
        SqlPool::Postgres(pool) => {
            let rows = sqlx::query("SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname").fetch_all(pool).await?;
            Ok(rows.iter().filter_map(|r| r.try_get::<String, _>(0).ok()).collect())
        }
        SqlPool::Mysql(_) => anyhow::bail!("list_databases ne s'applique qu'à PostgreSQL — MySQL liste déjà toutes ses bases via list_schemas"),
    }
}

const MYSQL_SYSTEM_SCHEMAS: [&str; 4] = ["information_schema", "performance_schema", "mysql", "sys"];

/// The list of "database-like" containers to browse under the current
/// connection — see this module's doc comment for why MySQL databases and
/// PostgreSQL schemas share this one function despite not being the same
/// concept.
///
/// This and the three functions below take `&SqlPool` rather than
/// `&SqlSession` — `SqlPool` clones cheaply (each variant is `Arc`-based
/// internally, like every sqlx pool type), so the Tauri command layer can
/// clone it out of `AppState.sql_sessions`'s `std::sync::Mutex` and drop the
/// lock before awaiting, rather than holding a non-`Send` `MutexGuard`
/// across `.await`.
pub async fn list_schemas(pool: &SqlPool) -> anyhow::Result<Vec<String>> {
    match pool {
        SqlPool::Mysql(pool) => {
            let rows = sqlx::query("SHOW DATABASES").fetch_all(pool).await?;
            let mut names: Vec<String> = rows.iter().filter_map(|r| r.try_get::<String, _>(0).ok()).collect();
            names.retain(|n| !MYSQL_SYSTEM_SCHEMAS.contains(&n.as_str()));
            Ok(names)
        }
        SqlPool::Postgres(pool) => {
            let rows = sqlx::query(
                "SELECT schema_name FROM information_schema.schemata \
                 WHERE schema_name NOT LIKE 'pg\\_%' AND schema_name <> 'information_schema' \
                 ORDER BY schema_name",
            )
            .fetch_all(pool)
            .await?;
            Ok(rows.iter().filter_map(|r| r.try_get::<String, _>(0).ok()).collect())
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableInfo {
    pub name: String,
    /// `"table"` or `"view"` — `information_schema.tables.table_type`
    /// lowercased (`"BASE TABLE"` normalized to `"table"`).
    pub kind: String,
}

fn table_kind(table_type: &str) -> String {
    if table_type.eq_ignore_ascii_case("VIEW") {
        "view".to_string()
    } else {
        "table".to_string()
    }
}

pub async fn list_tables(pool: &SqlPool, schema: &str) -> anyhow::Result<Vec<TableInfo>> {
    let tables = match pool {
        SqlPool::Mysql(pool) => sqlx::query("SELECT table_name, table_type FROM information_schema.tables WHERE table_schema = ? ORDER BY table_name")
            .bind(schema)
            .fetch_all(pool)
            .await?
            .iter()
            .map(|r| TableInfo { name: r.try_get(0).unwrap_or_default(), kind: table_kind(&r.try_get::<String, _>(1).unwrap_or_default()) })
            .collect(),
        SqlPool::Postgres(pool) => sqlx::query("SELECT table_name, table_type FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name")
            .bind(schema)
            .fetch_all(pool)
            .await?
            .iter()
            .map(|r| TableInfo { name: r.try_get(0).unwrap_or_default(), kind: table_kind(&r.try_get::<String, _>(1).unwrap_or_default()) })
            .collect(),
    };
    Ok(tables)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnInfo {
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
}

fn column_info(name: String, data_type: String, is_nullable: &str) -> ColumnInfo {
    ColumnInfo { name, data_type, nullable: is_nullable.eq_ignore_ascii_case("YES") }
}

pub async fn list_columns(pool: &SqlPool, schema: &str, table: &str) -> anyhow::Result<Vec<ColumnInfo>> {
    let columns = match pool {
        SqlPool::Mysql(pool) => {
            sqlx::query("SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = ? AND table_name = ? ORDER BY ordinal_position")
                .bind(schema)
                .bind(table)
                .fetch_all(pool)
                .await?
                .iter()
                .map(|r| column_info(r.try_get(0).unwrap_or_default(), r.try_get(1).unwrap_or_default(), &r.try_get::<String, _>(2).unwrap_or_default()))
                .collect()
        }
        SqlPool::Postgres(pool) => {
            sqlx::query("SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position")
                .bind(schema)
                .bind(table)
                .fetch_all(pool)
                .await?
                .iter()
                .map(|r| column_info(r.try_get(0).unwrap_or_default(), r.try_get(1).unwrap_or_default(), &r.try_get::<String, _>(2).unwrap_or_default()))
                .collect()
        }
    };
    Ok(columns)
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
pub async fn execute_query(pool: &SqlPool, sql: &str) -> anyhow::Result<QueryResult> {
    match pool {
        SqlPool::Postgres(pool) => {
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
                rows.push((0..row.columns().len()).map(|i| decode_pg_value(&row, i)).collect());
            }
            Ok(QueryResult { columns, rows, truncated })
        }
        SqlPool::Mysql(pool) => {
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
                rows.push((0..row.columns().len()).map(|i| decode_mysql_value(&row, i)).collect());
            }
            Ok(QueryResult { columns, rows, truncated })
        }
    }
}

fn hex_encode(bytes: &[u8]) -> String {
    format!("\\x{}", bytes.iter().map(|byte| format!("{byte:02x}")).collect::<String>())
}

/// Decodes one PostgreSQL cell into a JSON value by trying candidate Rust
/// types in order and keeping the first that both type-checks *and*
/// decodes — safe because `sqlx`'s `Type::compatible` for PostgreSQL is
/// checked against the column's exact OID (verified in
/// `sqlx-postgres-0.8.6/src/types/{bool,str,bytes}.rs`: e.g. `bool` only
/// matches the real `BOOL` oid, `Vec<u8>`/`String` only match `BYTEA`/
/// text-family oids respectively, never both), so no two candidates here
/// can both claim the same real column. A cell that still fails every
/// candidate (an exotic type this function doesn't special-case, e.g.
/// `MONEY` or a non-text array) falls back to JSON `null` rather than
/// erroring the whole query — losing one cell's value beats losing the
/// entire result set. `NUMERIC` decodes to a `Decimal` and is emitted as a
/// string, not `f64`: a monetary amount silently rounded by float
/// conversion is worse than one rendered as text.
fn decode_pg_value(row: &sqlx::postgres::PgRow, i: usize) -> serde_json::Value {
    if let Ok(Some(v)) = row.try_get::<Option<bool>, _>(i) {
        return serde_json::Value::Bool(v);
    }
    if let Ok(Some(v)) = row.try_get::<Option<i16>, _>(i) {
        return serde_json::json!(v);
    }
    if let Ok(Some(v)) = row.try_get::<Option<i32>, _>(i) {
        return serde_json::json!(v);
    }
    if let Ok(Some(v)) = row.try_get::<Option<i64>, _>(i) {
        return serde_json::json!(v);
    }
    if let Ok(Some(v)) = row.try_get::<Option<f32>, _>(i) {
        return serde_json::json!(v as f64);
    }
    if let Ok(Some(v)) = row.try_get::<Option<f64>, _>(i) {
        return serde_json::json!(v);
    }
    if let Ok(Some(v)) = row.try_get::<Option<Decimal>, _>(i) {
        return serde_json::Value::String(v.to_string());
    }
    if let Ok(Some(v)) = row.try_get::<Option<Uuid>, _>(i) {
        return serde_json::Value::String(v.to_string());
    }
    if let Ok(Some(v)) = row.try_get::<Option<DateTime<Utc>>, _>(i) {
        return serde_json::Value::String(v.to_rfc3339());
    }
    if let Ok(Some(v)) = row.try_get::<Option<NaiveDateTime>, _>(i) {
        return serde_json::Value::String(v.to_string());
    }
    if let Ok(Some(v)) = row.try_get::<Option<NaiveDate>, _>(i) {
        return serde_json::Value::String(v.to_string());
    }
    if let Ok(Some(v)) = row.try_get::<Option<NaiveTime>, _>(i) {
        return serde_json::Value::String(v.to_string());
    }
    if let Ok(Some(v)) = row.try_get::<Option<String>, _>(i) {
        return serde_json::Value::String(v);
    }
    if let Ok(Some(v)) = row.try_get::<Option<serde_json::Value>, _>(i) {
        return v;
    }
    if let Ok(Some(v)) = row.try_get::<Option<Vec<u8>>, _>(i) {
        return serde_json::Value::String(hex_encode(&v));
    }
    // Best-effort for arrays: only the common text-array case (e.g.
    // `text[]`/`varchar[]`). Arrays of any other element type (int[],
    // numeric[], ...) fall through to `null` below rather than growing this
    // into a full per-element-type array decoder.
    if let Ok(Some(v)) = row.try_get::<Option<Vec<String>>, _>(i) {
        return serde_json::Value::Array(v.into_iter().map(serde_json::Value::String).collect());
    }
    serde_json::Value::Null
}

/// Decodes one MySQL cell — same cascading-candidate approach as
/// [`decode_pg_value`], but the candidate order matters *more* here:
/// MySQL's `Type::compatible` (verified in `sqlx-mysql-0.8.6/src/types/
/// {bytes,str,json,bool}.rs`) is based on the wire type *family*, not an
/// exact match, and several checks overlap on purpose:
/// - `Vec<u8>`'s check accepts any text-or-blob-family column regardless of
///   the binary flag, while `String`'s check additionally requires the
///   binary flag to be *absent*. Trying `Vec<u8>` first would render every
///   ordinary text column as hex. `String` is tried first here so it claims
///   all non-binary text columns before `Vec<u8>` ever sees them; only real
///   binary blobs (which fail the `String` attempt) reach `Vec<u8>`.
/// - MySQL's `Json<T>`/`JsonValue` check accepts a real `JSON` column *or*
///   anything `String`/`Vec<u8>`-compatible. Tried after `String`, so it
///   only ever actually reaches real `JSON` columns in practice.
/// - `bool`'s check accepts *any* integer-family column (MySQL has no
///   native boolean — `BOOLEAN` is an alias for `TINYINT(1)`, and the
///   `compatible()` check doesn't verify the `(1)` width), so a genuine
///   `INT`/`BIGINT` column would just as happily "decode" as a `bool`.
///   Deliberately not attempted here at all: an ordinary integer shown as
///   `0`/`1` is correct; a `TINYINT(1)` shown as `0`/`1` instead of `true`/
///   `false` is an acceptable simplification, but a normal integer column
///   silently rendered as a boolean would not be.
fn decode_mysql_value(row: &sqlx::mysql::MySqlRow, i: usize) -> serde_json::Value {
    if let Ok(Some(v)) = row.try_get::<Option<i64>, _>(i) {
        return serde_json::json!(v);
    }
    if let Ok(Some(v)) = row.try_get::<Option<u64>, _>(i) {
        return serde_json::json!(v);
    }
    if let Ok(Some(v)) = row.try_get::<Option<f32>, _>(i) {
        return serde_json::json!(v as f64);
    }
    if let Ok(Some(v)) = row.try_get::<Option<f64>, _>(i) {
        return serde_json::json!(v);
    }
    if let Ok(Some(v)) = row.try_get::<Option<Decimal>, _>(i) {
        return serde_json::Value::String(v.to_string());
    }
    if let Ok(Some(v)) = row.try_get::<Option<NaiveDateTime>, _>(i) {
        return serde_json::Value::String(v.to_string());
    }
    if let Ok(Some(v)) = row.try_get::<Option<NaiveDate>, _>(i) {
        return serde_json::Value::String(v.to_string());
    }
    if let Ok(Some(v)) = row.try_get::<Option<NaiveTime>, _>(i) {
        return serde_json::Value::String(v.to_string());
    }
    if let Ok(Some(v)) = row.try_get::<Option<String>, _>(i) {
        return serde_json::Value::String(v);
    }
    if let Ok(Some(v)) = row.try_get::<Option<serde_json::Value>, _>(i) {
        return v;
    }
    if let Ok(Some(v)) = row.try_get::<Option<Vec<u8>>, _>(i) {
        return serde_json::Value::String(hex_encode(&v));
    }
    serde_json::Value::Null
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
