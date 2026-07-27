use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub type HostId = Uuid;
pub type GroupId = Uuid;
pub type SnippetId = Uuid;
pub type PortForwardId = Uuid;
pub type KeyId = Uuid;
pub type SqlConnectionId = Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct EnvVar {
    pub key: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum AuthMethod {
    #[default]
    Password,
    PrivateKey {
        path: String,
        /// If set, the passphrase is stored in the vault under this key's ID
        /// rather than under the host's ID.
        #[serde(default)]
        key_id: Option<KeyId>,
    },
    Agent,
    /// Keyboard-interactive (RFC 4256) — how servers drive MFA/OTP. The server
    /// asks a series of questions during the handshake rather than taking one
    /// credential up front, so this is the only method that needs a live
    /// exchange with the user (see [`crate::interactive_auth`]).
    ///
    /// A stored password, if there is one, is offered automatically for the
    /// first non-echoed prompt — servers overwhelmingly ask for the password
    /// first and the second factor after, so this keeps the usual case to a
    /// single OTP entry instead of retyping the password every connection.
    KeyboardInteractive,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrivateKey {
    pub id: KeyId,
    pub name: String,
    pub path: String,
    /// PEM content of the key file, read at import time so the original file is no longer required.
    #[serde(default)]
    pub content: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomIcon {
    pub id: String,
    pub name: String,
    pub data_url: String,
}

/// Deserialises `jumpVia` from old configs that stored a single UUID (or null)
/// as well as the new array format.
fn deser_jump_via<'de, D>(d: D) -> Result<Vec<HostId>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Compat {
        One(HostId),
        Many(Vec<HostId>),
    }
    Ok(match Option::<Compat>::deserialize(d)? {
        None => Vec::new(),
        Some(Compat::One(id)) => vec![id],
        Some(Compat::Many(ids)) => ids,
    })
}

/// What kind of target `Host` describes. `Ssh` uses every field with its
/// literal meaning; the other kinds repurpose a subset of the same fields
/// rather than growing dedicated ones, to keep this a UI/data-model
/// evolution instead of a schema rewrite:
/// - `DockerExec`: `address` is the Docker daemon socket or host (e.g.
///   `unix:///var/run/docker.sock`, `tcp://10.0.4.12:2375`). `port`,
///   `username`, `auth` and the SSH-only fields below are unused — unless
///   `docker_via_host_id` is set, in which case `address` is ignored
///   entirely and the daemon is reached by tunnelling through that other
///   (SSH) host instead (see `Host::docker_via_host_id`).
/// - `K8sExec`: `address` is a kubeconfig context name, `username` is the
///   default namespace pods are listed/exec'd in — see `crate::k8s`.
/// - `Rdp`: `address`/`port`/`username` keep their literal meaning; `auth`
///   is restricted to `Password` in the UI. UI-only for now — no backend yet.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum HostKind {
    #[default]
    Ssh,
    DockerExec,
    K8sExec,
    Rdp,
}

/// Live state read off a host by [`crate::facts::collect`] — OS/kernel/CPU/
/// load/memory, best-effort (a field that couldn't be read is simply `None`,
/// never an error; see `crate::facts`'s module docs). Defined here rather
/// than in `facts` because [`Host::last_facts`] persists the most recent
/// snapshot as part of the workspace — `facts` (the collection logic) is a
/// consumer of this type, not its owner.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostFacts {
    pub hostname: Option<String>,
    /// `/etc/os-release` `ID` — e.g. `ubuntu`, `debian`, `centos`, `alpine`.
    pub os_id: Option<String>,
    /// `/etc/os-release` `PRETTY_NAME` — e.g. `Ubuntu 22.04.3 LTS`.
    pub os_name: Option<String>,
    /// `uname -sr` — e.g. `Linux 6.5.0-14-generic`.
    pub kernel: Option<String>,
    pub arch: Option<String>,
    pub cpus: Option<u32>,
    pub load1: Option<f64>,
    pub uptime_secs: Option<u64>,
    pub mem_total_mb: Option<u64>,
    pub mem_used_mb: Option<u64>,
    /// Percentage of RAM in use (0–100), from `MemTotal`/`MemAvailable`.
    pub mem_used_pct: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Host {
    pub id: HostId,
    pub label: String,
    #[serde(default)]
    pub kind: HostKind,
    pub address: String,
    pub port: u16,
    pub username: String,
    pub auth: AuthMethod,
    /// `DockerExec` only: reach this host's Docker daemon by tunnelling
    /// through the referenced (SSH) host rather than connecting to `address`
    /// directly — see [`docker::connect_via_ssh`](crate::docker::connect_via_ssh).
    /// `None` (the default) keeps the direct-connection behavior every other
    /// `HostKind` already has.
    #[serde(default)]
    pub docker_via_host_id: Option<HostId>,
    pub group_id: Option<GroupId>,
    /// Ordered list of bastion / jump hosts to traverse before reaching this host.
    /// `jump_via[0]` is the first hop, `jump_via[n-1]` is the last before the target.
    #[serde(default, deserialize_with = "deser_jump_via")]
    pub jump_via: Vec<HostId>,
    pub tags: Vec<String>,
    /// Snippets to execute automatically right after the shell opens, in order.
    #[serde(default)]
    pub startup_snippets: Vec<SnippetId>,
    /// Environment variables exported into the shell at startup.
    #[serde(default)]
    pub env_vars: Vec<EnvVar>,
    #[serde(default)]
    pub icon: Option<String>,
    /// SSH keepalive interval in seconds (`None` or `0` disables it). Sent as
    /// `keepalive@openssh.com` channel requests by the underlying `russh` client
    /// to keep idle connections (e.g. behind NAT/firewalls) from being dropped.
    #[serde(default)]
    pub keepalive_interval_secs: Option<u32>,
    /// Forwards the local SSH agent to this host so it can, in turn, authenticate
    /// onward (e.g. to a Git server or another bastion) using local keys, without
    /// those keys ever leaving the client. Security-sensitive: only enable for
    /// hosts you trust, since a compromised remote could abuse the forwarded
    /// agent for as long as the session is open. Unix-only, requires `auth: Agent`.
    #[serde(default)]
    pub agent_forward: bool,
    /// Most recent state collected by a fleet facts-collection run (see
    /// `crate::facts::collect`) — `None` until at least one such run has
    /// included this host. Written only by that path, never by the host
    /// edit form: this is observed state, not configuration, same
    /// distinction as `crate::fleet_history`'s run records vs `workspace.json`.
    #[serde(default)]
    pub last_facts: Option<HostFacts>,
    /// Unix epoch milliseconds of `last_facts`'s collection, so the UI can
    /// show how stale it is.
    #[serde(default)]
    pub last_facts_at_ms: Option<u64>,
}

impl Host {
    pub fn new(
        label: impl Into<String>,
        address: impl Into<String>,
        username: impl Into<String>,
    ) -> Self {
        Self {
            id: Uuid::new_v4(),
            label: label.into(),
            kind: HostKind::default(),
            address: address.into(),
            port: 22,
            username: username.into(),
            auth: AuthMethod::Agent,
            docker_via_host_id: None,
            group_id: None,
            jump_via: Vec::new(),
            tags: Vec::new(),
            startup_snippets: Vec::new(),
            env_vars: Vec::new(),
            icon: None,
            keepalive_interval_secs: None,
            agent_forward: false,
            last_facts: None,
            last_facts_at_ms: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Group {
    pub id: GroupId,
    pub name: String,
    pub parent_id: Option<GroupId>,
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub color: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snippet {
    pub id: SnippetId,
    pub name: String,
    /// For a classic snippet: the literal shell command (possibly with
    /// `{{variables}}`). For an adaptive snippet (`adaptive: true`): a
    /// program in the adaptive engine's small text DSL (also allowed to
    /// contain `{{variables}}`, filled in the same way before use) — see
    /// `crate::adaptive`'s module docs for the grammar. Re-parsed and
    /// evaluated on demand each time it's used; nothing about it is cached,
    /// since evaluation is pure and deterministic (only *writing*/extending
    /// it via AI costs a network call).
    pub command: String,
    pub tags: Vec<String>,
    /// Whether `command` is a DSL program (resolved per-host, per platform)
    /// rather than a literal command run everywhere as-is.
    #[serde(default)]
    pub adaptive: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PortForwardKind {
    /// Listen locally, forward into the remote network.
    Local,
    /// Listen remotely, forward into the local network.
    Remote,
    /// Listen locally as a SOCKS5 proxy; destination is chosen per-connection
    /// by the client instead of being fixed ahead of time. `dest_address` /
    /// `dest_port` on the owning [`PortForward`] are unused for this kind.
    Dynamic,
}

impl std::fmt::Display for PortForwardKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            PortForwardKind::Local => "Local (-L)",
            PortForwardKind::Remote => "Distant (-R)",
            PortForwardKind::Dynamic => "SOCKS dynamique (-D)",
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortForward {
    pub id: PortForwardId,
    pub host_id: HostId,
    pub kind: PortForwardKind,
    pub bind_address: String,
    pub bind_port: u16,
    pub dest_address: String,
    pub dest_port: u16,
}

/// Which engine a [`SqlConnection`] speaks — see `crate::sql`. This is only
/// the discriminant; what a connection actually needs in order to *dial* that
/// engine lives in [`EngineConfig`], which this enum mirrors variant for
/// variant ([`EngineConfig::engine`] maps one to the other).
///
/// Kept as a standalone `Copy` enum rather than being read off `EngineConfig`
/// everywhere because plenty of code only cares "which engine is this?"
/// without touching connection details: picking the frontend tab component,
/// the icon and label, `quote_identifier`/`quote_literal`'s per-dialect
/// branches, and `SqlPool`'s reverse mapping.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SqlEngine {
    Mysql,
    Postgres,
    Sqlite,
    /// See `crate::redis_client`'s module doc comment — reuses this same
    /// `SqlConnection`/`SqlEngine`/panel rather than a separate entity, but
    /// renders through `RedisTab` (frontend), not `SqlTab`: a key-value store
    /// has no schema/table tree or SQL query language to browse.
    Redis,
    /// See `crate::mongo_client`'s module doc comment — same reasoning as
    /// `Redis` above (renders through `MongoTab`, not `SqlTab`), but connects
    /// via a connection string rather than discrete `address`/`port` fields
    /// (see [`MongoConfig`] for why MongoDB doesn't fit [`ServerConfig`]).
    Mongodb,
}

/// Reads a field that may be present-but-`null` as its default.
///
/// `#[serde(default)]` alone is not enough: it only applies when a field is
/// *absent*, and fails outright on an explicit `null`. That distinction
/// matters here because the flat `SqlConnection` these configs replaced
/// declared `path`/`connection_string` as `Option<String>` and therefore wrote
/// `"path": null` into every `workspace.json` where they weren't set. Without
/// this, loading one of those files fails, `store::load_resilient` moves it
/// aside as corrupt, and the user's saved connections vanish from the UI.
fn null_to_default<'de, D, T>(deserializer: D) -> Result<T, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de> + Default,
{
    Ok(Option::<T>::deserialize(deserializer)?.unwrap_or_default())
}

/// How to reach a database server that speaks a discrete
/// address/port/credentials protocol — MySQL, PostgreSQL and Redis all do.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ServerConfig {
    /// `None`: connect directly to `address`/`port`. `Some(host_id)`: open an
    /// SSH connection to that saved host first and reach `address`/`port`
    /// through an ephemeral local port forward (see
    /// `crate::sql::connect`/`crate::redis_client::connect`) — for a database
    /// that's only reachable from that host (bound to loopback server-side, a
    /// private subnet, etc.), not necessarily "the database runs on that host".
    #[serde(default)]
    pub tunnel_host_id: Option<HostId>,
    /// Reachable directly from this machine when `tunnel_host_id` is `None`,
    /// or reachable *from* `tunnel_host_id` otherwise (often `127.0.0.1`, for
    /// a database bound to loopback on that host).
    #[serde(default, deserialize_with = "null_to_default")]
    pub address: String,
    #[serde(default, deserialize_with = "null_to_default")]
    pub port: u16,
    /// An optional Redis 6+ ACL username for `SqlEngine::Redis` — empty means
    /// legacy `requirepass`-only auth, still the common case.
    #[serde(default, deserialize_with = "null_to_default")]
    pub username: String,
    /// MySQL/PostgreSQL: initial database to connect to. Required in practice
    /// for PostgreSQL (a connection always targets exactly one database, and
    /// never switches without reconnecting — see `crate::sql`'s module docs);
    /// optional for MySQL (a database can be selected, or switched, per
    /// query). `Redis`: the numbered database index (0–15 by default), stored
    /// as a string, e.g. `Some("0")` — `None`/empty defaults to `0` at
    /// connect time.
    #[serde(default)]
    pub database: Option<String>,
}

/// How to reach a SQLite database — an embedded single-file engine with no
/// server or wire protocol at all, so none of [`ServerConfig`]'s fields apply.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SqliteConfig {
    /// The file's absolute path. Local to this machine when `sqlite_host_id`
    /// is `None`; otherwise a path on that host's own filesystem, fetched over
    /// SFTP into a local temp copy at connect time and written back on a clean
    /// `close()` (see `crate::sql::connect`'s doc comment).
    #[serde(default, deserialize_with = "null_to_default")]
    pub path: String,
    /// `None`: `path` is a local file. `Some(host_id)`: `path` lives on that
    /// saved host instead — deliberately a separate field from
    /// [`ServerConfig::tunnel_host_id`] rather than reusing it, since the two
    /// mean genuinely different things (an SSH *tunnel to a TCP port* vs. an
    /// SFTP *file fetch*, with no persistent connection kept open for the
    /// latter beyond what's needed to write the file back on close).
    #[serde(default)]
    pub sqlite_host_id: Option<HostId>,
}

/// How to reach a MongoDB deployment. Unlike [`ServerConfig`], a single
/// address/port pair can't describe one: a replica set is a *set* of hosts,
/// and `mongodb+srv://` has no discrete port at all (the driver resolves
/// members via DNS SRV).
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MongoConfig {
    /// A full `mongodb://`/`mongodb+srv://` connection string.
    #[serde(default, deserialize_with = "null_to_default")]
    pub connection_string: String,
    /// Injected into `connection_string` at connect time (with the password
    /// pulled from the vault, same as every other engine) if the string
    /// doesn't already carry its own credentials — left empty if it already
    /// does, or the deployment needs none.
    #[serde(default, deserialize_with = "null_to_default")]
    pub username: String,
    /// Only honored for a plain single-host `mongodb://host:port/...`
    /// `connection_string` — `crate::mongo_client::connect` rejects it
    /// outright for `mongodb+srv://` or a comma-joined multi-host string,
    /// since neither can be transparently tunnelled through one TCP forward
    /// (SRV does its own multi-host discovery; a replica set's driver-side
    /// failover assumes it can reach every member directly).
    #[serde(default)]
    pub tunnel_host_id: Option<HostId>,
}

/// Everything a [`SqlConnection`] needs to dial its engine, as a sum type so
/// that only the fields which actually apply to an engine exist on it.
///
/// **Why this isn't one flat struct.** It used to be: every field for every
/// engine, side by side, each documented with which engines it applied to
/// ("`Sqlite` only", "`0` for `Sqlite`", "unused for this engine"…). That
/// shape let the type system express connections that can't exist — a SQLite
/// connection with a port, a MongoDB one with an address — so `crate::sql`
/// grew six `unreachable!()` arms whose only job was to assert combinations
/// the type permitted but the code never produced.
///
/// **Wire format.** Internally tagged on `engine`, and `#[serde(flatten)]`ed
/// into [`SqlConnection`], so the JSON is byte-for-byte what the old flat
/// struct wrote for the fields that *do* apply — `{"engine": "mysql",
/// "address": "…", "port": 3306, …}`. Existing `workspace.json` files
/// therefore load unchanged: serde ignores the leftover fields that no longer
/// belong to the matched variant (`"path": null` on a MySQL connection, say),
/// and every field is `#[serde(default)]` so one written by an older version
/// that predates it is tolerated too. Covered by
/// `deserializes_legacy_flat_sql_connections` below — a roundtrip test would
/// prove nothing about the real on-disk shape, per CLAUDE.md's serde pitfall.
///
/// Note these are *newtype* variants, not struct variants: `rename_all_fields`
/// (the fix for the internally-tagged-enum trap this project has hit six
/// times) doesn't apply, because each payload struct carries its own
/// `rename_all = "camelCase"` instead.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "engine", rename_all = "camelCase")]
pub enum EngineConfig {
    Mysql(ServerConfig),
    Postgres(ServerConfig),
    Sqlite(SqliteConfig),
    Redis(ServerConfig),
    Mongodb(MongoConfig),
}

impl EngineConfig {
    /// The engine discriminant for this config — the two enums are kept in
    /// one-to-one correspondence.
    pub fn engine(&self) -> SqlEngine {
        match self {
            EngineConfig::Mysql(_) => SqlEngine::Mysql,
            EngineConfig::Postgres(_) => SqlEngine::Postgres,
            EngineConfig::Sqlite(_) => SqlEngine::Sqlite,
            EngineConfig::Redis(_) => SqlEngine::Redis,
            EngineConfig::Mongodb(_) => SqlEngine::Mongodb,
        }
    }

    /// The TCP-server settings for the engines that have them (MySQL,
    /// PostgreSQL, Redis), `None` for SQLite/MongoDB — which is exactly the
    /// question `crate::sql::connect`'s tunnel setup needs to ask.
    pub fn server(&self) -> Option<&ServerConfig> {
        match self {
            EngineConfig::Mysql(c) | EngineConfig::Postgres(c) | EngineConfig::Redis(c) => Some(c),
            EngineConfig::Sqlite(_) | EngineConfig::Mongodb(_) => None,
        }
    }

    /// The saved host this connection reaches through, whichever way it does
    /// so — an SSH tunnel for the server engines and MongoDB, an SFTP fetch
    /// for SQLite (see [`SqliteConfig::sqlite_host_id`]). Used by the UI to
    /// show "via <host>" without caring which mechanism is involved.
    pub fn via_host_id(&self) -> Option<HostId> {
        match self {
            EngineConfig::Mysql(c) | EngineConfig::Postgres(c) | EngineConfig::Redis(c) => c.tunnel_host_id,
            EngineConfig::Sqlite(c) => c.sqlite_host_id,
            EngineConfig::Mongodb(c) => c.tunnel_host_id,
        }
    }

    /// The default port for an engine dialled over TCP, used when creating a
    /// connection before the user has typed one.
    pub fn default_port(engine: SqlEngine) -> u16 {
        match engine {
            SqlEngine::Mysql => 3306,
            SqlEngine::Postgres => 5432,
            SqlEngine::Redis => 6379,
            SqlEngine::Sqlite | SqlEngine::Mongodb => 0,
        }
    }
}

/// A saved MySQL/PostgreSQL/SQLite/Redis/MongoDB connection — deliberately
/// **not** a `Host`/`HostKind` variant: unlike SSH/Docker exec/K8s exec/RDP,
/// a SQL connection has no shell and isn't a fleet target, so folding it
/// into `HostKind` would force every one of those (fleet, adaptive snippets,
/// tab restore…) to grow a "this kind has no shell" branch. It can still
/// *reference* a saved `Host` via `tunnel_host_id`/`sqlite_host_id`, purely
/// to reach a database that isn't directly reachable from this machine.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlConnection {
    pub id: SqlConnectionId,
    pub label: String,
    /// Which engine, and everything needed to dial it. Flattened, so the
    /// engine tag and its config's fields sit directly on this struct in JSON
    /// exactly as they did when they were declared here — see
    /// [`EngineConfig`]'s doc comment.
    #[serde(flatten)]
    pub config: EngineConfig,
    #[serde(default)]
    pub group_id: Option<GroupId>,
    #[serde(default)]
    pub tags: Vec<String>,
}

impl SqlConnection {
    pub fn new(label: impl Into<String>, config: EngineConfig) -> Self {
        Self {
            id: Uuid::new_v4(),
            label: label.into(),
            config,
            group_id: None,
            tags: Vec::new(),
        }
    }

    /// Shorthand for the engines dialled over TCP, filling in that engine's
    /// default port. Panics on `Sqlite`/`Mongodb`, which have no
    /// address/port shape at all — construct those with their own config
    /// ([`SqliteConfig`]/[`MongoConfig`]) instead.
    pub fn new_server(
        label: impl Into<String>,
        engine: SqlEngine,
        address: impl Into<String>,
        username: impl Into<String>,
    ) -> Self {
        let server = ServerConfig {
            address: address.into(),
            port: EngineConfig::default_port(engine),
            username: username.into(),
            ..Default::default()
        };
        let config = match engine {
            SqlEngine::Mysql => EngineConfig::Mysql(server),
            SqlEngine::Postgres => EngineConfig::Postgres(server),
            SqlEngine::Redis => EngineConfig::Redis(server),
            SqlEngine::Sqlite | SqlEngine::Mongodb => {
                panic!("new_server is only for TCP-dialled engines, not {engine:?}")
            }
        };
        Self::new(label, config)
    }

    /// Shorthand for a SQLite connection to a file on this machine.
    pub fn new_sqlite_local(label: impl Into<String>, path: impl Into<String>) -> Self {
        Self::new(
            label,
            EngineConfig::Sqlite(SqliteConfig { path: path.into(), sqlite_host_id: None }),
        )
    }

    /// The engine this connection speaks — shorthand for `self.config.engine()`.
    pub fn engine(&self) -> SqlEngine {
        self.config.engine()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub groups: Vec<Group>,
    pub hosts: Vec<Host>,
    pub snippets: Vec<Snippet>,
    pub port_forwards: Vec<PortForward>,
    #[serde(default)]
    pub keychain: Vec<PrivateKey>,
    #[serde(default)]
    pub custom_icons: Vec<CustomIcon>,
    #[serde(default)]
    pub sql_connections: Vec<SqlConnection>,
}

impl Workspace {
    pub fn host(&self, id: HostId) -> Option<&Host> {
        self.hosts.iter().find(|h| h.id == id)
    }

    pub fn sql_connection(&self, id: SqlConnectionId) -> Option<&SqlConnection> {
        self.sql_connections.iter().find(|c| c.id == id)
    }

    /// Resolves the bastion chain for a host: bastions first (in order), target last.
    pub fn jump_chain(&self, id: HostId) -> anyhow::Result<Vec<&Host>> {
        let target = self
            .host(id)
            .ok_or_else(|| anyhow::anyhow!("host {id} not found"))?;
        let mut chain: Vec<&Host> = Vec::with_capacity(target.jump_via.len() + 1);
        let mut seen = std::collections::HashSet::new();
        seen.insert(id);
        for &jid in &target.jump_via {
            if !seen.insert(jid) {
                anyhow::bail!("duplicate bastion in chain");
            }
            chain.push(
                self.host(jid)
                    .ok_or_else(|| anyhow::anyhow!("bastion {jid} not found"))?,
            );
        }
        chain.push(target);
        Ok(chain)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every `SqlConnection` saved before `EngineConfig` existed is one flat
    /// struct carrying *all* engines' fields at once, with the inapplicable
    /// ones left null/empty. Loading one must still work — otherwise
    /// `store::load_resilient` sees an unparseable `workspace.json`, moves it
    /// aside, and the user's saved connections silently vanish.
    ///
    /// Written as literal JSON on purpose: a Rust-to-Rust roundtrip would
    /// prove nothing about the actual on-disk casing/shape (CLAUDE.md's serde
    /// pitfall — hit six times in this project).
    #[test]
    fn deserializes_legacy_flat_sql_connections() {
        let legacy = r#"{
            "id": "6f1a9d2e-0000-4000-8000-000000000001",
            "label": "prod-db",
            "engine": "postgres",
            "tunnelHostId": "6f1a9d2e-0000-4000-8000-000000000002",
            "address": "127.0.0.1",
            "port": 5432,
            "username": "app",
            "database": "shop",
            "path": null,
            "sqliteHostId": null,
            "connectionString": null,
            "groupId": null,
            "tags": ["prod"]
        }"#;

        let conn: SqlConnection = serde_json::from_str(legacy).expect("legacy MySQL/PG shape must load");

        assert_eq!(conn.label, "prod-db");
        assert_eq!(conn.engine(), SqlEngine::Postgres);
        assert_eq!(conn.tags, vec!["prod".to_string()]);
        let EngineConfig::Postgres(server) = &conn.config else {
            panic!("expected a Postgres config, got {:?}", conn.config);
        };
        assert_eq!(server.address, "127.0.0.1");
        assert_eq!(server.port, 5432);
        assert_eq!(server.username, "app");
        assert_eq!(server.database.as_deref(), Some("shop"));
        assert!(server.tunnel_host_id.is_some(), "the tunnel host must survive the migration");
    }

    /// Same as above for SQLite, whose legacy rows carry `address: ""` /
    /// `port: 0` alongside the `path` that actually matters.
    #[test]
    fn deserializes_legacy_flat_sqlite_connection() {
        let legacy = r#"{
            "id": "6f1a9d2e-0000-4000-8000-000000000003",
            "label": "local.db",
            "engine": "sqlite",
            "tunnelHostId": null,
            "address": "",
            "port": 0,
            "username": "",
            "database": null,
            "path": "/home/u/app.db",
            "sqliteHostId": "6f1a9d2e-0000-4000-8000-000000000004",
            "connectionString": null,
            "groupId": null,
            "tags": []
        }"#;

        let conn: SqlConnection = serde_json::from_str(legacy).expect("legacy SQLite shape must load");

        assert_eq!(conn.engine(), SqlEngine::Sqlite);
        let EngineConfig::Sqlite(sqlite) = &conn.config else {
            panic!("expected a SQLite config, got {:?}", conn.config);
        };
        assert_eq!(sqlite.path, "/home/u/app.db");
        assert!(sqlite.sqlite_host_id.is_some());
        // `via_host_id` abstracts over "tunnel" vs "file fetch" — for SQLite
        // it has to read `sqlite_host_id`, not `tunnel_host_id`.
        assert_eq!(conn.config.via_host_id(), sqlite.sqlite_host_id);
    }

    /// A legacy SQLite row written before the user filled the path in has
    /// `"path": null`. `path` is a plain `String` now, so without
    /// `#[serde(default)]` this would fail to parse and take the whole
    /// workspace file down with it.
    #[test]
    fn tolerates_legacy_sqlite_connection_with_null_path() {
        let legacy = r#"{
            "id": "6f1a9d2e-0000-4000-8000-000000000005",
            "label": "unset",
            "engine": "sqlite",
            "address": "",
            "port": 0,
            "username": "",
            "path": null
        }"#;

        let conn: SqlConnection = serde_json::from_str(legacy).expect("a null path must not be fatal");
        let EngineConfig::Sqlite(sqlite) = &conn.config else {
            panic!("expected a SQLite config");
        };
        assert_eq!(sqlite.path, "");
    }

    /// Same explicit-`null` trap as the SQLite case above, for the other field
    /// the old flat struct declared as `Option<String>`.
    #[test]
    fn tolerates_legacy_mongodb_connection_with_null_connection_string() {
        let legacy = r#"{
            "id": "6f1a9d2e-0000-4000-8000-000000000007",
            "label": "unset",
            "engine": "mongodb",
            "username": "",
            "connectionString": null
        }"#;

        let conn: SqlConnection = serde_json::from_str(legacy).expect("a null connection string must not be fatal");
        let EngineConfig::Mongodb(mongo) = &conn.config else {
            panic!("expected a MongoDB config");
        };
        assert_eq!(mongo.connection_string, "");
    }

    /// The on-disk shape this writes must stay flat (engine tag + that
    /// engine's own fields at the top level), both so older builds can still
    /// read what a newer one wrote and because the frontend reads
    /// `connection.engine`/`connection.address` directly.
    #[test]
    fn serializes_flat_with_engine_tag() {
        let conn = SqlConnection::new_server("cache", SqlEngine::Redis, "10.0.0.9", "acl-user");

        let value: serde_json::Value = serde_json::to_value(&conn).unwrap();

        assert_eq!(value["engine"], "redis");
        assert_eq!(value["address"], "10.0.0.9");
        assert_eq!(value["port"], 6379, "the engine default port must be applied");
        assert_eq!(value["username"], "acl-user");
        // Fields belonging to other engines must not be emitted at all.
        assert!(value.get("path").is_none(), "a Redis connection must not carry SQLite's path");
        assert!(value.get("connectionString").is_none(), "a Redis connection must not carry MongoDB's connection string");
    }

    /// MongoDB's config shares no field with the TCP engines beyond
    /// `username`, so it gets its own check that the tag routes correctly.
    #[test]
    fn roundtrips_mongodb_connection_string_shape() {
        let json = r#"{
            "id": "6f1a9d2e-0000-4000-8000-000000000006",
            "label": "atlas",
            "engine": "mongodb",
            "connectionString": "mongodb+srv://cluster0.example.net/app",
            "username": "reader"
        }"#;

        let conn: SqlConnection = serde_json::from_str(json).unwrap();
        assert_eq!(conn.engine(), SqlEngine::Mongodb);
        let EngineConfig::Mongodb(mongo) = &conn.config else {
            panic!("expected a MongoDB config");
        };
        assert_eq!(mongo.connection_string, "mongodb+srv://cluster0.example.net/app");
        assert_eq!(mongo.username, "reader");
        // No TCP settings to expose — this is what drives `sql::connect`'s
        // tunnel branch, replacing an `unreachable!()` arm.
        assert!(conn.config.server().is_none());
    }
}
