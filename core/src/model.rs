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

/// Which SQL wire protocol a [`SqlConnection`] speaks — see `crate::sql`.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SqlEngine {
    Mysql,
    Postgres,
}

/// A saved MySQL/PostgreSQL connection — deliberately **not** a `Host`/
/// `HostKind` variant: unlike SSH/Docker exec/K8s exec/RDP, a SQL connection
/// has no shell and isn't a fleet target, so folding it into `HostKind`
/// would force every one of those (fleet, adaptive snippets, tab restore…)
/// to grow a "this kind has no shell" branch. It can still *reference* a
/// saved `Host` via `tunnel_host_id`, purely to reach a database that isn't
/// directly reachable from this machine.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlConnection {
    pub id: SqlConnectionId,
    pub label: String,
    pub engine: SqlEngine,
    /// `None`: connect directly to `address`/`port`. `Some(host_id)`: open
    /// an SSH connection to that saved host first and reach `address`/
    /// `port` through an ephemeral local port forward (see
    /// `crate::sql::connect`) — for a database that's only reachable from
    /// that host (bound to loopback server-side, a private subnet, etc.),
    /// not necessarily "the database runs on that host".
    #[serde(default)]
    pub tunnel_host_id: Option<HostId>,
    /// The database server's address — reachable directly from this
    /// machine when `tunnel_host_id` is `None`, or reachable *from*
    /// `tunnel_host_id` otherwise (often `127.0.0.1`, for a database bound
    /// to loopback on that host).
    pub address: String,
    pub port: u16,
    pub username: String,
    /// Initial database to connect to. Required in practice for
    /// PostgreSQL (a connection always targets exactly one database, and
    /// never switches without reconnecting — see `crate::sql`'s module
    /// docs); optional for MySQL (a database can be selected, or switched,
    /// per query).
    #[serde(default)]
    pub database: Option<String>,
    #[serde(default)]
    pub group_id: Option<GroupId>,
    #[serde(default)]
    pub tags: Vec<String>,
}

impl SqlConnection {
    pub fn new(label: impl Into<String>, engine: SqlEngine, address: impl Into<String>, username: impl Into<String>) -> Self {
        Self {
            id: Uuid::new_v4(),
            label: label.into(),
            engine,
            tunnel_host_id: None,
            address: address.into(),
            port: match engine {
                SqlEngine::Mysql => 3306,
                SqlEngine::Postgres => 5432,
            },
            username: username.into(),
            database: None,
            group_id: None,
            tags: Vec::new(),
        }
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
