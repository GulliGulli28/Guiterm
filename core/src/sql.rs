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
//! **SQLite is a third, structurally different engine.** MySQL/PostgreSQL
//! are servers this module dials over TCP (optionally through an SSH
//! tunnel); SQLite is an embedded single-file engine with no server or wire
//! protocol at all. A [`SqlConnection`] with `engine: Sqlite` uses `path`/
//! `sqlite_host_id` instead of `address`/`port`/`username`/`database` (see
//! those fields' doc comments): a local file is opened directly, a file on a
//! saved host's filesystem is fetched whole over SFTP into a local temp copy
//! at [`connect`] time and — since there's no way to run SQL against it
//! remotely — queried entirely against that copy, written back to the
//! original path only on a clean [`SqlSession::close`] (see [`connect_sqlite`]).
//! [`list_schemas`] reflects SQLite's single implicit schema as one `"main"`
//! entry, so the same tree UI that browses MySQL databases/PostgreSQL
//! schemas works unmodified.
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
//! - A remote-hosted SQLite file's changes only reach the origin host if the
//!   session is closed cleanly — an app crash/kill between `connect` and
//!   `close` loses them (same accepted tradeoff `SqlSession`'s doc comment
//!   already states for the MySQL/PostgreSQL tunnel case).
use crate::model::{PortForward, PortForwardKind, SqlConnection, SqlEngine, Workspace};
use crate::port_forward::{self, ActiveForward};
use crate::sftp::SftpClient;
use crate::ssh::{self, Connection};
use crate::vault::{self, SecretKind};
use futures_util::TryStreamExt;
use serde::Serialize;
use sqlx::mysql::{MySqlPool, MySqlPoolOptions};
use sqlx::postgres::{PgPool, PgPoolOptions};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePool, SqlitePoolOptions};
use sqlx::types::chrono::{DateTime, NaiveDate, NaiveDateTime, NaiveTime, Utc};
use sqlx::types::{Decimal, Uuid};
use sqlx::{Column, Row};
use std::sync::Arc;
use std::sync::atomic::AtomicBool;

/// The live pool behind a [`SqlSession`] — see this module's doc comment for
/// why this is a real per-engine pool rather than `sqlx::AnyPool`.
#[derive(Clone)]
pub enum SqlPool {
    Postgres(PgPool),
    Mysql(MySqlPool),
    Sqlite(SqlitePool),
}

impl SqlPool {
    pub async fn close(self) {
        match self {
            SqlPool::Postgres(pool) => pool.close().await,
            SqlPool::Mysql(pool) => pool.close().await,
            SqlPool::Sqlite(pool) => pool.close().await,
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

/// Held only for a `Sqlite` [`SqlSession`] whose file lives on a saved
/// host's filesystem rather than locally — keeps the SSH connection alive
/// for the whole session (the SFTP channel needs it) purely so
/// [`SqlSession::close`] can write the local temp copy (queried against for
/// the entire session — see this module's doc comment) back to
/// `remote_path` before it's deleted. `snapshot_hash` exists solely so
/// `close()` can tell (a) whether the local copy was actually touched during
/// the session at all, and (b) whether the origin file changed on the host
/// in the meantime — see `close()`'s doc comment for why both checks matter
/// (a real data-loss bug this module used to have: a read-only session still
/// unconditionally re-uploaded its untouched local copy, silently clobbering
/// whatever had changed on the host since connect time). A content hash
/// rather than size/mtime: SQLite files are page-aligned (a tiny edit often
/// doesn't change the file's length at all) and mtime alone can collide
/// within the same wall-clock second on some filesystems — neither is
/// reliable enough for a check whose entire purpose is not silently losing
/// data.
struct SqliteRemote {
    _connection: Arc<Connection>,
    client: SftpClient,
    remote_path: String,
    local_path: std::path::PathBuf,
    snapshot_hash: u64,
}

/// Cheap non-cryptographic content hash (`SipHash` via `DefaultHasher`) —
/// only ever used to detect incidental change vs. no change on our own
/// fetched files, never anything security-sensitive, so collision-resistance
/// against a deliberate adversary doesn't matter here.
async fn hash_file(path: &std::path::Path) -> std::io::Result<u64> {
    use std::hash::{Hash, Hasher};
    let bytes = tokio::fs::read(path).await?;
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    bytes.hash(&mut hasher);
    Ok(hasher.finish())
}

/// `true` when `remote`'s local temp copy has been touched since it was
/// downloaded (or couldn't even be hashed — treated conservatively as "yes,
/// assume changed": a spurious sync is much cheaper than a spurious
/// overwrite). Shared by [`SqlSession::close`] and [`SqlSession::resync`] —
/// both need to know this before deciding whether there's anything to push.
async fn local_copy_changed(remote: &SqliteRemote) -> bool {
    match hash_file(&remote.local_path).await {
        Ok(hash) => hash != remote.snapshot_hash,
        Err(_) => true,
    }
}

/// Re-downloads the origin file fresh into `dest` and returns its content
/// hash — `None` covers every "couldn't check" case alike: gone/renamed on
/// the host, or some I/O step along the way failing. Callers that only need
/// a yes/no compare the result against `remote.snapshot_hash` themselves;
/// [`SqlSession::resync`] additionally reuses `dest`'s freshly-downloaded
/// bytes directly when the hash *doesn't* match, rather than downloading a
/// third time just to adopt what it already just fetched.
async fn fetch_remote_hash(remote: &SqliteRemote, parent_dir: &str, file_name: &str, dest: &std::path::Path) -> Option<u64> {
    let entries = remote.client.list(parent_dir).await.ok()?;
    let entry = entries.into_iter().find(|e| e.name == file_name)?;
    let cancel = AtomicBool::new(false);
    remote.client.download(&remote.remote_path, dest, entry.size, &cancel, |_, _| {}).await.ok()?;
    hash_file(dest).await.ok()
}

/// A live SQL connection: the pool, plus — when tunnelled (MySQL/PostgreSQL)
/// or backed by a remote file (SQLite, see [`SqliteRemote`]) — whatever's
/// needed to keep that alive for as long as the pool is. Dropping this
/// without calling [`close`](SqlSession::close) first leaves the tunnel's
/// accept loop running detached (`ActiveForward` has no `Drop`-based
/// teardown by design, see its doc comment) and/or a modified SQLite file
/// never written back to its origin host — `close()` must be called
/// explicitly, exactly like `commands::forward::stop_forward` already has to
/// for a persisted tunnel.
pub struct SqlSession {
    pub pool: SqlPool,
    /// The database `pool` is actually scoped to — `None` only in the
    /// PostgreSQL "no database configured" case, where `pool` is connected
    /// to a bootstrap database (see [`connect`]) purely so [`list_databases`]
    /// can enumerate real ones; the frontend shows a database picker instead
    /// of a schema tree until [`SqlSession::replace_pool`] is called via the
    /// `switch_sql_database` command. Always `Some` for MySQL (it lists
    /// every database up front regardless — see this module's doc comment),
    /// for PostgreSQL connections with an explicit database configured, and
    /// for `Sqlite` (always `Some("main")`).
    pub database: Option<String>,
    dial: DialTarget,
    tunnel: Option<(Arc<Connection>, ActiveForward)>,
    sqlite_remote: Option<SqliteRemote>,
}

impl SqlSession {
    /// Closes the pool and tears down whatever kept it reachable. For a
    /// `Sqlite` session backed by a remote file, this is also the *only*
    /// point where the local copy is written back to the origin host — and
    /// only when there's actually something to write back:
    ///
    /// 1. If the local copy hashes the same as what was downloaded (a
    ///    read-only browsing session — nothing in `sql::execute_query` ever
    ///    ran, or only `SELECT`s did), nothing is uploaded at all. Without
    ///    this check, closing *any* session — even one that only ever
    ///    browsed the schema — would re-upload the untouched local copy and
    ///    silently overwrite whatever had changed on the host since connect
    ///    time (a real bug this module used to have).
    /// 2. If the local copy *was* modified, the origin file is downloaded
    ///    again (to a throwaway scratch path) and hashed against the same
    ///    snapshot. If it no longer matches (someone/something else wrote to
    ///    it on the host while this session was open), the upload is refused
    ///    rather than blindly overwritten — this is a whole-file
    ///    download/upload round trip, not a merge, so there's no safe way to
    ///    reconcile two independent sets of changes. The local temp copy is
    ///    deliberately left in place in that case (path included in the
    ///    error) rather than discarding the only copy of whatever changed
    ///    locally.
    pub async fn close(self) -> anyhow::Result<()> {
        self.pool.close().await;
        if let Some((connection, active)) = self.tunnel {
            active.stop(&connection).await;
        }
        if let Some(remote) = self.sqlite_remote {
            if !local_copy_changed(&remote).await {
                let _ = tokio::fs::remove_file(&remote.local_path).await;
                return Ok(());
            }

            let (parent_dir, file_name) = split_remote_path(&remote.remote_path)?;
            let scratch = std::env::temp_dir().join(format!("guiterm-sqlite-check-{}.db", uuid::Uuid::new_v4()));
            let remote_unchanged = fetch_remote_hash(&remote, &parent_dir, &file_name, &scratch).await == Some(remote.snapshot_hash);
            let _ = tokio::fs::remove_file(&scratch).await;
            if !remote_unchanged {
                return Err(anyhow::anyhow!(
                    "le fichier « {} » a changé sur l'hôte distant depuis l'ouverture de cette connexion — vos modifications locales n'ont pas été renvoyées, pour ne pas écraser un changement distant concurrent (copie locale conservée dans {})",
                    remote.remote_path,
                    remote.local_path.display(),
                ));
            }

            let cancel = AtomicBool::new(false);
            match remote.client.upload(&remote.local_path, &remote.remote_path, &cancel, |_, _| {}).await {
                Ok(()) => { let _ = tokio::fs::remove_file(&remote.local_path).await; }
                Err(e) => {
                    return Err(anyhow::anyhow!(
                        "échec du renvoi du fichier SQLite modifié vers « {} » : {e} (copie locale conservée dans {})",
                        remote.remote_path,
                        remote.local_path.display(),
                    ));
                }
            }
        }
        Ok(())
    }

    /// The "actualiser l'arborescence" button's backing action, for the one
    /// engine where the tree's own data can otherwise go stale without any
    /// query ever running: a `Sqlite` session backed by a remote file only
    /// ever reflects whatever was true on the host at *connect* time — the
    /// tree for every other case (MySQL/PostgreSQL, or a local SQLite file)
    /// always queries live, so a no-op here is exactly right for them
    /// (`sqlite_remote` is `None`) and the frontend can call this
    /// unconditionally before re-fetching the tree regardless of engine.
    ///
    /// Deliberately *not* pushed after every mutating query instead of only
    /// here: that would mean a full upload-then-download-to-verify round
    /// trip over SFTP per query (this same conflict check, just far more
    /// often) — fine for an occasional explicit "sync now", not for every
    /// keystroke's worth of typing a query.
    ///
    /// - Local copy unmodified since connect (or since the last `resync`):
    ///   pulls in whatever's now on the host, if anything — swapping in a
    ///   fresh local copy and reopening the pool only if it actually
    ///   changed, a no-op otherwise.
    /// - Local copy modified: tries to push it back, with the exact same
    ///   conflict check `close()` uses (refuses rather than overwrites a
    ///   remote file that also changed independently) — on success, the
    ///   pushed copy becomes the new baseline for future syncs/close.
    pub async fn resync(&mut self) -> anyhow::Result<()> {
        let Some(remote) = self.sqlite_remote.as_ref() else { return Ok(()) };
        let (parent_dir, file_name) = split_remote_path(&remote.remote_path)?;

        if local_copy_changed(remote).await {
            let scratch = std::env::temp_dir().join(format!("guiterm-sqlite-check-{}.db", uuid::Uuid::new_v4()));
            let remote_unchanged = fetch_remote_hash(remote, &parent_dir, &file_name, &scratch).await == Some(remote.snapshot_hash);
            let _ = tokio::fs::remove_file(&scratch).await;
            if !remote_unchanged {
                anyhow::bail!(
                    "le fichier « {} » a changé sur l'hôte distant depuis l'ouverture de cette connexion — vos modifications locales n'ont pas été renvoyées, pour ne pas écraser un changement distant concurrent (copie locale conservée dans {})",
                    remote.remote_path,
                    remote.local_path.display(),
                );
            }
            let cancel = AtomicBool::new(false);
            remote.client.upload(&remote.local_path, &remote.remote_path, &cancel, |_, _| {}).await.map_err(|e| {
                anyhow::anyhow!("échec du renvoi du fichier SQLite modifié vers « {} » : {e} (copie locale conservée dans {})", remote.remote_path, remote.local_path.display())
            })?;
            // The just-uploaded local copy is now, by construction, exactly
            // what's on the host — no need to re-download it back.
            let new_hash = hash_file(&remote.local_path).await?;
            self.sqlite_remote.as_mut().expect("checked Some above").snapshot_hash = new_hash;
            return Ok(());
        }

        // Local copy untouched — see if the host has moved on without us.
        let fresh_path = std::env::temp_dir().join(format!("guiterm-sqlite-{}.db", uuid::Uuid::new_v4()));
        crate::secure_file::create_private(&fresh_path)?;
        let Some(fresh_hash) = fetch_remote_hash(remote, &parent_dir, &file_name, &fresh_path).await else {
            let _ = tokio::fs::remove_file(&fresh_path).await;
            anyhow::bail!("impossible de vérifier l'état du fichier « {} » sur l'hôte distant", remote.remote_path);
        };
        if fresh_hash == remote.snapshot_hash {
            // Nothing changed on the host either — the fresh download was
            // redundant, nothing to swap in.
            let _ = tokio::fs::remove_file(&fresh_path).await;
            return Ok(());
        }

        // Something new is there — reopen the pool against the fresh copy
        // before touching anything else, so a failure here leaves the
        // session exactly as it was (still usable against the old copy).
        let options = SqliteConnectOptions::new().filename(&fresh_path).create_if_missing(false);
        let new_pool = match SqlitePoolOptions::new().max_connections(4).connect_with(options).await {
            Ok(pool) => pool,
            Err(e) => {
                let _ = tokio::fs::remove_file(&fresh_path).await;
                return Err(e.into());
            }
        };
        let old_local_path = remote.local_path.clone();
        let old_pool = std::mem::replace(&mut self.pool, SqlPool::Sqlite(new_pool));
        old_pool.close().await;
        let _ = tokio::fs::remove_file(&old_local_path).await;
        let remote_mut = self.sqlite_remote.as_mut().expect("checked Some above");
        remote_mut.local_path = fresh_path;
        remote_mut.snapshot_hash = fresh_hash;
        Ok(())
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

/// Never actually called with `SqlEngine::Sqlite` — `open_database` bails
/// before reaching `build_url` for it (SQLite has no TCP scheme/URL to
/// build), but the match still has to be exhaustive.
fn scheme(engine: SqlEngine) -> &'static str {
    match engine {
        SqlEngine::Mysql => "mysql",
        SqlEngine::Postgres => "postgres",
        SqlEngine::Sqlite => "sqlite",
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
///
/// `Sqlite` is dispatched to [`connect_sqlite`] instead — an embedded
/// single-file engine has no TCP dial/tunnel to set up here at all (see this
/// module's doc comment).
pub async fn connect(workspace: &Workspace, conn: &SqlConnection) -> anyhow::Result<SqlSession> {
    if conn.engine == SqlEngine::Sqlite {
        return connect_sqlite(workspace, conn).await;
    }
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

    Ok(SqlSession { pool, database: requested_database, dial, tunnel, sqlite_remote: None })
}

/// Opens a fresh pool for `database` against an already-resolved dial
/// target — either the initial connection ([`connect`]) or a later switch
/// to a different PostgreSQL database via the same tunnel
/// (`commands::sql::switch_sql_database`), which PostgreSQL requires since a
/// single connection can't change database once established (unlike
/// MySQL's `USE`, which is why MySQL never needs this function at all).
/// Never called for `Sqlite` — nothing in the frontend ever triggers a
/// database switch for it (`SqlSession::database` is always `Some` from the
/// start, see its doc comment), so this only needs to fail loudly if it ever
/// somehow were.
pub async fn open_database(dial: &DialTarget, database: &str) -> anyhow::Result<SqlPool> {
    // Checked before `build_url` (which has no meaningful "sqlite" scheme to
    // build a URL for in the first place) rather than after.
    if dial.engine == SqlEngine::Sqlite {
        anyhow::bail!("switch_sql_database ne s'applique pas à SQLite");
    }
    let url = build_url(dial.engine, &dial.host, dial.port, &dial.username, dial.password.as_deref(), Some(database))?;
    match dial.engine {
        SqlEngine::Postgres => Ok(SqlPool::Postgres(PgPoolOptions::new().max_connections(4).connect(url.as_str()).await?)),
        SqlEngine::Mysql => Ok(SqlPool::Mysql(MySqlPoolOptions::new().max_connections(4).connect(url.as_str()).await?)),
        SqlEngine::Sqlite => unreachable!("returned above"),
    }
}

/// The `main` schema every SQLite connection has implicitly — used by
/// [`list_schemas`]/[`connect_sqlite`] so a single-file database still fits
/// the "list of schemas, each with tables" tree shape the frontend already
/// renders for MySQL/PostgreSQL, without a real multi-schema concept behind
/// it (SQLite's `ATTACH DATABASE` could add more, but a plain single-file
/// connection never does).
const SQLITE_MAIN_SCHEMA: &str = "main";

/// Splits an absolute remote POSIX path into `(parent_dir, file_name)` — used
/// by [`connect_sqlite`]/[`SqlSession::close`] to `list()` the parent
/// directory and look up the file's own entry (size/mtime), since
/// `RemoteFileClient` has no single-file `stat`, only directory listing.
fn split_remote_path(path: &str) -> anyhow::Result<(String, String)> {
    let trimmed = path.trim_end_matches('/');
    let idx = trimmed.rfind('/').ok_or_else(|| anyhow::anyhow!("chemin distant invalide (doit être absolu) : {path:?}"))?;
    let name = trimmed[idx + 1..].to_string();
    if name.is_empty() {
        anyhow::bail!("chemin distant invalide : {path:?}");
    }
    let parent = if idx == 0 { "/".to_string() } else { trimmed[..idx].to_string() };
    Ok((parent, name))
}

/// Connects a `Sqlite` [`SqlConnection`] — see this module's doc comment.
/// `conn.path` is required; `conn.sqlite_host_id`, if set, means it lives on
/// that saved host's filesystem rather than locally, fetched whole over SFTP
/// into a fresh private local temp file first (the SSH connection and SFTP
/// client are kept alive on the returned session purely so `close()` can
/// write the file back to `conn.path` on that host afterward).
async fn connect_sqlite(workspace: &Workspace, conn: &SqlConnection) -> anyhow::Result<SqlSession> {
    let remote_path = conn.path.clone().filter(|p| !p.is_empty()).ok_or_else(|| anyhow::anyhow!("chemin du fichier SQLite manquant"))?;

    let (local_path, sqlite_remote) = match conn.sqlite_host_id {
        None => (std::path::PathBuf::from(&remote_path), None),
        Some(host_id) => {
            let connection = Arc::new(ssh::connect(workspace, host_id).await?);
            let client = SftpClient::open(&connection).await?;
            let (parent_dir, file_name) = split_remote_path(&remote_path)?;
            let source_entry = client
                .list(&parent_dir)
                .await?
                .into_iter()
                .find(|e| e.name == file_name)
                .ok_or_else(|| anyhow::anyhow!("fichier introuvable sur l'hôte : {remote_path}"))?;
            let local_path = std::env::temp_dir().join(format!("guiterm-sqlite-{}.db", uuid::Uuid::new_v4()));
            // Pre-created 0600 so the fetched database is never briefly
            // world-readable in a shared temp dir — same reasoning as
            // `transfer::download_client_to_fresh_temp`.
            crate::secure_file::create_private(&local_path)?;
            let cancel = AtomicBool::new(false);
            // `download` already removes its own partial output on failure.
            client.download(&remote_path, &local_path, source_entry.size, &cancel, |_, _| {}).await?;
            let snapshot_hash = hash_file(&local_path).await?;
            let remote = SqliteRemote {
                _connection: connection,
                client,
                remote_path: remote_path.clone(),
                local_path: local_path.clone(),
                snapshot_hash,
            };
            (local_path, Some(remote))
        }
    };

    let options = SqliteConnectOptions::new().filename(&local_path).create_if_missing(false);
    let pool = match SqlitePoolOptions::new().max_connections(4).connect_with(options).await {
        Ok(pool) => pool,
        Err(e) => {
            // Only ever remove `local_path` here when it's our own fetched
            // temp copy (`sqlite_remote.is_some()`) — for a local connection
            // it's the user's real file, never ours to delete.
            if sqlite_remote.is_some() {
                let _ = tokio::fs::remove_file(&local_path).await;
            }
            return Err(e.into());
        }
    };

    let dial = DialTarget { engine: SqlEngine::Sqlite, host: String::new(), port: 0, username: String::new(), password: None };
    Ok(SqlSession {
        pool: SqlPool::Sqlite(pool),
        database: Some(SQLITE_MAIN_SCHEMA.to_string()),
        dial,
        tunnel: None,
        sqlite_remote,
    })
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
        SqlPool::Sqlite(_) => anyhow::bail!("list_databases ne s'applique pas à SQLite — un fichier n'a qu'une seule base implicite"),
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
        // Always exactly one entry — see `SQLITE_MAIN_SCHEMA`'s doc comment.
        SqlPool::Sqlite(_) => Ok(vec![SQLITE_MAIN_SCHEMA.to_string()]),
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
        // `schema` is always `SQLITE_MAIN_SCHEMA` here (the only one
        // `list_schemas` ever returns) — `sqlite_master` has no schema
        // column to filter by in the first place. `sqlite_%` entries are
        // SQLite's own bookkeeping tables (e.g. `sqlite_sequence`), not
        // user data.
        SqlPool::Sqlite(pool) => sqlx::query("SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name")
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
        // No `information_schema` in SQLite — `PRAGMA table_info` is the
        // native equivalent. It takes a bare/quoted identifier, not a bind
        // parameter, but `table` always comes from our own `list_tables`
        // output (see `quote_pg_identifier`'s doc comment for the same
        // trusted-input reasoning applied to `schema` there). `notnull` is
        // 1 when the column is `NOT NULL`, the inverse of `nullable`.
        SqlPool::Sqlite(pool) => {
            sqlx::query(&format!("PRAGMA table_info({})", quote_sqlite_identifier(table)))
                .fetch_all(pool)
                .await?
                .iter()
                .map(|r| ColumnInfo {
                    name: r.try_get(1).unwrap_or_default(),
                    data_type: r.try_get(2).unwrap_or_default(),
                    nullable: r.try_get::<i64, _>(3).unwrap_or_default() == 0,
                })
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
///
/// `schema`, when given (the tree's current selection — see
/// `commands::sql::run_sql_query`), is applied as query *context* so
/// unqualified table names resolve there (`SELECT * FROM customers` instead
/// of `SELECT * FROM demo.customers`) — `SET search_path` for PostgreSQL,
/// `USE` for MySQL. Fully-qualified references in `sql` are unaffected
/// either way. This explicitly acquires one connection (`pool.acquire()`)
/// and runs both statements on it, rather than sending them as separate
/// `fetch(pool)` calls: a `Pool` hands out whichever idle connection is
/// available per call, so two separate pool-level calls could easily land
/// on two *different* physical connections — the context-setting statement
/// would then have no effect on the one that runs the real query.
pub async fn execute_query(pool: &SqlPool, schema: Option<&str>, sql: &str) -> anyhow::Result<QueryResult> {
    match pool {
        SqlPool::Postgres(pool) => {
            let mut conn = pool.acquire().await?;
            if let Some(schema) = schema {
                sqlx::query(&format!("SET search_path TO {}", quote_pg_identifier(schema))).execute(&mut *conn).await?;
            }
            let mut stream = sqlx::query(sql).fetch(&mut *conn);
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
            let mut conn = pool.acquire().await?;
            if let Some(schema) = schema {
                sqlx::query(&format!("USE {}", quote_mysql_identifier(schema))).execute(&mut *conn).await?;
            }
            let mut stream = sqlx::query(sql).fetch(&mut *conn);
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
        // No context statement needed: SQLite has a single implicit schema
        // (`SQLITE_MAIN_SCHEMA`), so `schema` is ignored here rather than
        // faking a `USE`/`SET search_path` equivalent that wouldn't do
        // anything real.
        SqlPool::Sqlite(pool) => {
            let mut conn = pool.acquire().await?;
            let mut stream = sqlx::query(sql).fetch(&mut *conn);
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
                rows.push((0..row.columns().len()).map(|i| decode_sqlite_value(&row, i)).collect());
            }
            Ok(QueryResult { columns, rows, truncated })
        }
    }
}

/// Quotes `name` as a PostgreSQL identifier (double quotes, doubling any
/// embedded quote) — `schema` always comes from our own `list_schemas`
/// output, never raw user input, but quoting it properly costs nothing and
/// avoids ever building a `SET search_path`/`USE` statement by naive string
/// interpolation.
fn quote_pg_identifier(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

fn quote_mysql_identifier(name: &str) -> String {
    format!("`{}`", name.replace('`', "``"))
}

/// SQLite accepts the same double-quoted identifier syntax as PostgreSQL
/// (it's the SQL standard form) — `table` always comes from our own
/// `list_tables` output, same trusted-input reasoning as `quote_pg_identifier`.
fn quote_sqlite_identifier(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

fn quote_identifier(engine: SqlEngine, name: &str) -> String {
    match engine {
        SqlEngine::Postgres => quote_pg_identifier(name),
        SqlEngine::Mysql => quote_mysql_identifier(name),
        SqlEngine::Sqlite => quote_sqlite_identifier(name),
    }
}

/// Single-quoted SQL string literal for [`sql_literal`]/[`dump_tables`].
/// **Not** the same escaping for every engine: PostgreSQL/SQLite treat `\`
/// as a plain character inside a `'...'` literal (`standard_conforming_strings`,
/// on by default since PostgreSQL 9.1), so only doubling `'` is needed —
/// doubling `\` there too would insert extra backslashes into the restored
/// data. MySQL, unless `NO_BACKSLASH_ESCAPES` is set (not assumed here),
/// treats `\` as an escape character in string literals, so a literal
/// backslash in the data must itself be escaped as `\\` or it would escape
/// whatever character follows it on re-import.
fn quote_sql_string(engine: SqlEngine, s: &str) -> String {
    match engine {
        SqlEngine::Mysql => format!("'{}'", s.replace('\\', "\\\\").replace('\'', "\\'")),
        SqlEngine::Postgres | SqlEngine::Sqlite => format!("'{}'", s.replace('\'', "''")),
    }
}

/// Renders one already-decoded cell (see `decode_pg_value`/`decode_mysql_value`/
/// `decode_sqlite_value`) as a SQL literal for [`write_insert_batch`]. Only
/// booleans differ by engine below — MySQL/SQLite have no boolean literal —
/// everything else has the same textual form across all three.
fn sql_literal(engine: SqlEngine, value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::Null => "NULL".to_string(),
        serde_json::Value::Bool(b) => match engine {
            SqlEngine::Postgres => if *b { "TRUE" } else { "FALSE" }.to_string(),
            SqlEngine::Mysql | SqlEngine::Sqlite => if *b { "1" } else { "0" }.to_string(),
        },
        serde_json::Value::Number(n) => n.to_string(),
        serde_json::Value::String(s) => quote_sql_string(engine, s),
        // JSON(B) columns and the best-effort text-array case (see
        // `decode_pg_value`) — re-serialized as a quoted JSON string, which is
        // valid input for a real JSON(B) column on both engines and at least a
        // faithful (if flattened) round trip for anything else.
        serde_json::Value::Array(_) | serde_json::Value::Object(_) => quote_sql_string(engine, &value.to_string()),
    }
}

/// Reconstructs (MySQL/SQLite: fetches verbatim) the `CREATE TABLE` statement
/// for `schema.table` — used by [`dump_tables`] so an exported dump recreates
/// the table's structure, not just its rows.
async fn table_ddl(pool: &SqlPool, schema: &str, table: &str) -> anyhow::Result<String> {
    match pool {
        SqlPool::Mysql(pool) => {
            let row = sqlx::query(&format!("SHOW CREATE TABLE {}.{}", quote_mysql_identifier(schema), quote_mysql_identifier(table)))
                .fetch_one(pool)
                .await?;
            Ok(row.try_get::<String, _>(1)?)
        }
        SqlPool::Postgres(pool) => postgres_table_ddl(pool, schema, table).await,
        // SQLite already keeps the original `CREATE TABLE` text verbatim in
        // `sqlite_master` — nothing to reconstruct.
        SqlPool::Sqlite(pool) => {
            let row = sqlx::query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
                .bind(table)
                .fetch_one(pool)
                .await?;
            Ok(row.try_get::<String, _>(0)?)
        }
    }
}

/// PostgreSQL has no built-in equivalent of MySQL's `SHOW CREATE TABLE`, so
/// this reconstructs one from `pg_catalog` directly rather than
/// `information_schema`: `format_type(atttypid, atttypmod)` returns the exact
/// type PostgreSQL itself would print — including length/precision (e.g.
/// `character varying(255)`, `numeric(10,2)`) — sidestepping having to
/// manually recombine `information_schema.columns`' separate
/// `character_maximum_length`/`numeric_precision`/`numeric_scale` fields by
/// hand. Primary key columns (if any) are looked up separately via
/// `pg_index`/`pg_attribute` and appended as a table-level `PRIMARY KEY (...)`
/// constraint — the one piece of structure `list_columns` deliberately
/// doesn't carry (see this module's doc comment on that limitation).
async fn postgres_table_ddl(pool: &PgPool, schema: &str, table: &str) -> anyhow::Result<String> {
    let cols = sqlx::query(
        "SELECT a.attname, format_type(a.atttypid, a.atttypmod), a.attnotnull, pg_get_expr(d.adbin, d.adrelid) \
         FROM pg_attribute a \
         JOIN pg_class c ON a.attrelid = c.oid \
         JOIN pg_namespace n ON c.relnamespace = n.oid \
         LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum \
         WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped \
         ORDER BY a.attnum",
    )
    .bind(schema)
    .bind(table)
    .fetch_all(pool)
    .await?;
    if cols.is_empty() {
        anyhow::bail!("table introuvable : {schema}.{table}");
    }

    // `quote_ident` here is PostgreSQL's own built-in function (via `$1`/`$2`
    // binds, not string interpolation) — needed so the `::regclass` cast
    // resolves a schema/table pair correctly regardless of case or reserved
    // words, exactly like a hand-written `"schema"."table"` would.
    let pk_rows = sqlx::query(
        "SELECT a.attname FROM pg_index i \
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey) \
         WHERE i.indrelid = (quote_ident($1) || '.' || quote_ident($2))::regclass AND i.indisprimary \
         ORDER BY array_position(i.indkey, a.attnum)",
    )
    .bind(schema)
    .bind(table)
    .fetch_all(pool)
    .await?;
    let pk_cols: Vec<String> = pk_rows.iter().filter_map(|r| r.try_get::<String, _>(0).ok()).collect();

    let mut lines: Vec<String> = cols
        .iter()
        .map(|r| {
            let name: String = r.try_get(0).unwrap_or_default();
            let data_type: String = r.try_get(1).unwrap_or_default();
            let not_null: bool = r.try_get(2).unwrap_or_default();
            let default_expr: Option<String> = r.try_get(3).ok();
            let mut line = format!("  {} {}", quote_pg_identifier(&name), data_type);
            if not_null {
                line.push_str(" NOT NULL");
            }
            if let Some(default) = default_expr {
                line.push_str(&format!(" DEFAULT {default}"));
            }
            line
        })
        .collect();
    if !pk_cols.is_empty() {
        let quoted = pk_cols.iter().map(|c| quote_pg_identifier(c)).collect::<Vec<_>>().join(", ");
        lines.push(format!("  PRIMARY KEY ({quoted})"));
    }
    Ok(format!("CREATE TABLE {} (\n{}\n)", quote_pg_identifier(table), lines.join(",\n")))
}

/// Row batch size for the `INSERT INTO ... VALUES (...), (...), ...`
/// statements [`dump_tables`] writes — large enough to keep the output
/// reasonably compact, small enough that one statement's text doesn't grow
/// unbounded for a huge table.
const DUMP_INSERT_BATCH: usize = 500;

/// Streams `DROP TABLE IF EXISTS` + `CREATE TABLE` + batched `INSERT`
/// statements for every table in `tables` (all within `schema`) to `writer` —
/// the backing action of the SQL tab's "Exporter" tab
/// (`commands::sql::export_sql_dump`), for both a local file and (via a local
/// temp file uploaded over SFTP afterward) a path on a saved SSH host.
///
/// Unlike [`execute_query`], row fetching here is never capped at
/// [`MAX_RESULT_ROWS`]: a dump's whole point is *every* row, and rows are
/// streamed straight to `writer` rather than buffered as a [`QueryResult`] in
/// memory, so an arbitrarily large table doesn't need to fit in RAM at once.
///
/// `DROP TABLE IF EXISTS` is written before each `CREATE TABLE` — matching
/// `mysqldump`'s default behavior — so running the generated file back
/// against a database that already has same-named tables replaces them
/// rather than erroring; this makes the file a "restore/replace" script, not
/// an additive merge into whatever's already there.
pub async fn dump_tables(pool: &SqlPool, schema: &str, tables: &[String], writer: &mut (impl tokio::io::AsyncWrite + Unpin)) -> anyhow::Result<()> {
    use tokio::io::AsyncWriteExt;
    let engine = match pool {
        SqlPool::Postgres(_) => SqlEngine::Postgres,
        SqlPool::Mysql(_) => SqlEngine::Mysql,
        SqlPool::Sqlite(_) => SqlEngine::Sqlite,
    };
    for table in tables {
        let ddl = table_ddl(pool, schema, table).await?;
        writer.write_all(format!("-- Table: {table}\n").as_bytes()).await?;
        writer.write_all(format!("DROP TABLE IF EXISTS {};\n", quote_identifier(engine, table)).as_bytes()).await?;
        writer.write_all(ddl.trim_end().as_bytes()).await?;
        writer.write_all(b";\n\n").await?;
        dump_table_rows(pool, engine, schema, table, writer).await?;
        writer.write_all(b"\n").await?;
    }
    writer.flush().await?;
    Ok(())
}

/// Streams every row of `schema.table` and writes it out as batched `INSERT`
/// statements via [`write_insert_batch`] — one branch per engine, same
/// context-setting (`SET search_path`/`USE`) and single-acquired-connection
/// approach as [`execute_query`], and the same per-engine cell decoder
/// (`decode_pg_value`/`decode_mysql_value`/`decode_sqlite_value`) so a dumped
/// value matches exactly what the "Data"/"Query" tabs would show for it.
async fn dump_table_rows(pool: &SqlPool, engine: SqlEngine, schema: &str, table: &str, writer: &mut (impl tokio::io::AsyncWrite + Unpin)) -> anyhow::Result<()> {
    match pool {
        SqlPool::Postgres(pg) => {
            let mut conn = pg.acquire().await?;
            sqlx::query(&format!("SET search_path TO {}", quote_pg_identifier(schema))).execute(&mut *conn).await?;
            let select_sql = format!("SELECT * FROM {}", quote_pg_identifier(table));
            let mut stream = sqlx::query(&select_sql).fetch(&mut *conn);
            let mut columns: Vec<String> = Vec::new();
            let mut batch: Vec<Vec<serde_json::Value>> = Vec::new();
            while let Some(row) = stream.try_next().await? {
                if columns.is_empty() {
                    columns = row.columns().iter().map(|c| c.name().to_string()).collect();
                }
                batch.push((0..row.columns().len()).map(|i| decode_pg_value(&row, i)).collect());
                if batch.len() >= DUMP_INSERT_BATCH {
                    write_insert_batch(writer, engine, table, &columns, &batch).await?;
                    batch.clear();
                }
            }
            write_insert_batch(writer, engine, table, &columns, &batch).await
        }
        SqlPool::Mysql(my) => {
            let mut conn = my.acquire().await?;
            sqlx::query(&format!("USE {}", quote_mysql_identifier(schema))).execute(&mut *conn).await?;
            let select_sql = format!("SELECT * FROM {}", quote_mysql_identifier(table));
            let mut stream = sqlx::query(&select_sql).fetch(&mut *conn);
            let mut columns: Vec<String> = Vec::new();
            let mut batch: Vec<Vec<serde_json::Value>> = Vec::new();
            while let Some(row) = stream.try_next().await? {
                if columns.is_empty() {
                    columns = row.columns().iter().map(|c| c.name().to_string()).collect();
                }
                batch.push((0..row.columns().len()).map(|i| decode_mysql_value(&row, i)).collect());
                if batch.len() >= DUMP_INSERT_BATCH {
                    write_insert_batch(writer, engine, table, &columns, &batch).await?;
                    batch.clear();
                }
            }
            write_insert_batch(writer, engine, table, &columns, &batch).await
        }
        SqlPool::Sqlite(lite) => {
            let mut conn = lite.acquire().await?;
            let select_sql = format!("SELECT * FROM {}", quote_sqlite_identifier(table));
            let mut stream = sqlx::query(&select_sql).fetch(&mut *conn);
            let mut columns: Vec<String> = Vec::new();
            let mut batch: Vec<Vec<serde_json::Value>> = Vec::new();
            while let Some(row) = stream.try_next().await? {
                if columns.is_empty() {
                    columns = row.columns().iter().map(|c| c.name().to_string()).collect();
                }
                batch.push((0..row.columns().len()).map(|i| decode_sqlite_value(&row, i)).collect());
                if batch.len() >= DUMP_INSERT_BATCH {
                    write_insert_batch(writer, engine, table, &columns, &batch).await?;
                    batch.clear();
                }
            }
            write_insert_batch(writer, engine, table, &columns, &batch).await
        }
    }
}

/// Writes one `INSERT INTO ... VALUES (...), (...), ...;` statement covering
/// `rows` — a no-op when `rows` is empty (the trailing flush in
/// `dump_table_rows` for a table whose row count is an exact multiple of
/// [`DUMP_INSERT_BATCH`], or an empty table), so an empty table's dump is just
/// its `CREATE TABLE` with no dangling `INSERT`.
async fn write_insert_batch(
    writer: &mut (impl tokio::io::AsyncWrite + Unpin),
    engine: SqlEngine,
    table: &str,
    columns: &[String],
    rows: &[Vec<serde_json::Value>],
) -> anyhow::Result<()> {
    use tokio::io::AsyncWriteExt;
    if rows.is_empty() {
        return Ok(());
    }
    let cols = columns.iter().map(|c| quote_identifier(engine, c)).collect::<Vec<_>>().join(", ");
    let mut sql = format!("INSERT INTO {} ({}) VALUES\n", quote_identifier(engine, table), cols);
    for (i, row) in rows.iter().enumerate() {
        let values = row.iter().map(|v| sql_literal(engine, v)).collect::<Vec<_>>().join(", ");
        sql.push_str(&format!("  ({values})"));
        sql.push_str(if i + 1 == rows.len() { ";\n" } else { ",\n" });
    }
    writer.write_all(sql.as_bytes()).await?;
    Ok(())
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

/// Decodes one SQLite cell. Much simpler than the Postgres/MySQL cascades
/// above: SQLite has dynamic per-cell typing (any column can hold any of its
/// 5 storage classes regardless of the declared column type), and `sqlx`'s
/// `SqliteValue` already exposes exactly that same 5-way shape, so there's no
/// "wire type doesn't map to a Rust type" ambiguity to resolve by trying
/// candidates in order — each `try_get` below either is the cell's actual
/// storage class or fails outright, never a false positive.
fn decode_sqlite_value(row: &sqlx::sqlite::SqliteRow, i: usize) -> serde_json::Value {
    if let Ok(Some(v)) = row.try_get::<Option<i64>, _>(i) {
        return serde_json::json!(v);
    }
    if let Ok(Some(v)) = row.try_get::<Option<f64>, _>(i) {
        return serde_json::json!(v);
    }
    if let Ok(Some(v)) = row.try_get::<Option<String>, _>(i) {
        return serde_json::Value::String(v);
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

    /// Unlike the Postgres/MySQL paths above (reasoned about, no live
    /// server to test against here), a local SQLite file needs nothing but
    /// the filesystem — exercised for real end to end: connect, create a
    /// table, insert a row, and read back the same schema/table/column/query
    /// introspection the frontend's tree actually calls.
    #[tokio::test]
    async fn sqlite_local_file_round_trips_schema_and_query() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.sqlite");
        // A zero-byte file is a valid (empty) SQLite database — `create_if_missing(false)`
        // only needs the path to already exist, not to already be a real database.
        std::fs::File::create(&path).unwrap();

        let workspace = Workspace::default();
        let mut conn = SqlConnection::new("test", SqlEngine::Sqlite, "", "");
        conn.path = Some(path.to_string_lossy().to_string());

        let session = connect(&workspace, &conn).await.unwrap();
        assert_eq!(session.database.as_deref(), Some("main"));

        execute_query(&session.pool, None, "CREATE TABLE greetings (id INTEGER PRIMARY KEY, message TEXT NOT NULL)").await.unwrap();
        execute_query(&session.pool, None, "INSERT INTO greetings (message) VALUES ('bonjour')").await.unwrap();

        assert_eq!(list_schemas(&session.pool).await.unwrap(), vec![SQLITE_MAIN_SCHEMA.to_string()]);

        let tables = list_tables(&session.pool, SQLITE_MAIN_SCHEMA).await.unwrap();
        assert_eq!(tables.len(), 1);
        assert_eq!(tables[0].name, "greetings");
        assert_eq!(tables[0].kind, "table");

        let columns = list_columns(&session.pool, SQLITE_MAIN_SCHEMA, "greetings").await.unwrap();
        assert_eq!(columns.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), vec!["id", "message"]);
        assert!(!columns[1].nullable);

        let result = execute_query(&session.pool, None, "SELECT id, message FROM greetings").await.unwrap();
        assert_eq!(result.columns, vec!["id".to_string(), "message".to_string()]);
        assert_eq!(result.rows, vec![vec![serde_json::json!(1), serde_json::json!("bonjour")]]);

        session.close().await.unwrap();
    }

    /// Exercises `dump_tables` end to end against real SQLite databases: dumps
    /// a table containing values that stress the trickiest parts of
    /// `sql_literal`/`quote_sql_string` (an embedded `'`, a `NULL`, a
    /// negative number), then replays the generated SQL against a second,
    /// empty database and checks the restored rows match exactly — proving
    /// the dump is actually re-importable, not just "looks like SQL".
    #[tokio::test]
    async fn dump_tables_round_trips_through_a_second_database() {
        let dir = tempfile::tempdir().unwrap();
        let source_path = dir.path().join("source.sqlite");
        std::fs::File::create(&source_path).unwrap();
        let workspace = Workspace::default();
        let mut source_conn = SqlConnection::new("source", SqlEngine::Sqlite, "", "");
        source_conn.path = Some(source_path.to_string_lossy().to_string());
        let source = connect(&workspace, &source_conn).await.unwrap();

        execute_query(&source.pool, None, "CREATE TABLE widgets (id INTEGER PRIMARY KEY, name TEXT, qty INTEGER)").await.unwrap();
        execute_query(&source.pool, None, "INSERT INTO widgets (name, qty) VALUES ('O''Brien''s gadget', -3)").await.unwrap();
        execute_query(&source.pool, None, "INSERT INTO widgets (name, qty) VALUES (NULL, 0)").await.unwrap();

        let mut dump: Vec<u8> = Vec::new();
        dump_tables(&source.pool, SQLITE_MAIN_SCHEMA, &["widgets".to_string()], &mut dump).await.unwrap();
        let dump_text = String::from_utf8(dump).unwrap();
        assert!(dump_text.contains("DROP TABLE IF EXISTS \"widgets\""));
        assert!(dump_text.contains("CREATE TABLE"));
        assert!(dump_text.contains("INSERT INTO"));

        let dest_path = dir.path().join("dest.sqlite");
        std::fs::File::create(&dest_path).unwrap();
        let mut dest_conn = SqlConnection::new("dest", SqlEngine::Sqlite, "", "");
        dest_conn.path = Some(dest_path.to_string_lossy().to_string());
        let dest = connect(&workspace, &dest_conn).await.unwrap();
        for statement in dump_text.split(";\n").map(str::trim).filter(|s| !s.is_empty()) {
            execute_query(&dest.pool, None, statement).await.unwrap();
        }

        let result = execute_query(&dest.pool, None, "SELECT id, name, qty FROM widgets ORDER BY id").await.unwrap();
        assert_eq!(
            result.rows,
            vec![
                vec![serde_json::json!(1), serde_json::json!("O'Brien's gadget"), serde_json::json!(-3)],
                vec![serde_json::json!(2), serde_json::Value::Null, serde_json::json!(0)],
            ]
        );

        source.close().await.unwrap();
        dest.close().await.unwrap();
    }
}
