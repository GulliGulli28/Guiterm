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
    /// Empty on disk when [`Self::secret`] is set — the value then lives in the
    /// vault, under `{host_id}:env:{key}`.
    pub value: String,
    /// Keep this value out of `workspace.json` and in the vault instead.
    ///
    /// Opt-in per variable rather than for all of them: most are `LANG` or
    /// `EDITOR`, which nobody wants to unlock a vault for. But `env_vars` was
    /// the one place left where the app wrote a value the user considers
    /// sensitive — an API token — in clear next to their hosts.
    ///
    /// `#[serde(default)]`, so every `workspace.json` written before this
    /// existed still reads: those variables are simply not secret.
    #[serde(default)]
    pub secret: bool,
}

/// Separates what a host's env vars keep in `workspace.json` from what has to
/// go to the vault.
///
/// Returns the variables as they should be persisted — secret values blanked —
/// and the `(name, value)` pairs to store. Split from the storing itself so the
/// promise that matters ("a secret value never reaches the file") is a pure
/// function anyone can test, rather than something only observable by reading
/// the user's real workspace afterwards.
///
/// An empty value for a secret variable means *unchanged*: the form never
/// shows a stored secret, so it cannot send one back, and treating that as
/// "erase it" would lose the value on every unrelated edit of the host.
pub fn split_env_secrets(vars: Vec<EnvVar>) -> (Vec<EnvVar>, Vec<(String, String)>) {
    let mut kept = Vec::with_capacity(vars.len());
    let mut to_store = Vec::new();
    for mut var in vars {
        if var.secret {
            if !var.value.is_empty() {
                to_store.push((var.key.clone(), std::mem::take(&mut var.value)));
            }
            var.value.clear();
        }
        kept.push(var);
    }
    (kept, to_store)
}

// `rename_all` renames *variants* only — it has never touched the fields of a
// struct variant, which is why `key_id` was still `key_id` in the JSON while
// every frontend type said `keyId`. Unknown fields are ignored and this one
// has a default, so a keychain-backed key silently arrived as `None`: no
// error, on either side. `rename_all_fields` is the attribute that covers
// struct-variant fields (see the same trap listed in CLAUDE.md).
//
// The `alias` keeps `workspace.json` files written before this readable —
// they contain `key_id`, and without it every already-configured keychain key
// would quietly detach on upgrade, which is the exact bug being fixed.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum AuthMethod {
    #[default]
    Password,
    PrivateKey {
        path: String,
        /// If set, the passphrase is stored in the vault under this key's ID
        /// rather than under the host's ID.
        #[serde(default, alias = "key_id")]
        key_id: Option<KeyId>,
        /// An OpenSSH certificate to present alongside the key, for servers
        /// that trust a CA instead of listing keys (`TrustedUserCAKeys`).
        ///
        /// A **path**, deliberately, where the key itself may be stored by
        /// content: a CA signs certificates that live hours, which is the whole
        /// point of using one. Snapshotting the bytes would mean re-importing
        /// every morning, whereas re-reading the file each connection means
        /// whatever refreshes it — `ssh-keygen`, a vault agent, a login script
        /// — just works with no action here.
        ///
        /// `None` is the ordinary case: the key authenticates on its own.
        #[serde(default, alias = "cert_path")]
        cert_path: Option<String>,
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

/// Whether a terminal opened on a host runs inside a *named, server-side*
/// session that survives the SSH connection carrying it.
///
/// Two variants and not three: an "auto" mode that meant "use tmux when it is
/// there" would be exactly [`Self::Tmux`], which is already best-effort — a
/// host without tmux falls back to the ordinary shell rather than failing to
/// connect. See [`crate::persistent_shell`].
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PersistentShellMode {
    /// A fresh shell per connection — what every host did before this existed.
    #[default]
    Off,
    /// `tmux new-session -A` on a key kept with the tab, so a dropped
    /// connection, a closed app or a reboot all reattach to the same screen.
    Tmux,
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
    /// Reach this host by running a local helper program and speaking SSH over
    /// its stdin/stdout, instead of opening a TCP connection to `address` —
    /// OpenSSH's `ProxyCommand`, tokens and all (see
    /// [`crate::proxy_command`]). This is how a cloud VM with no public IP and
    /// no inbound SSH is reached: AWS SSM, GCP IAP, Azure Bastion,
    /// `cloudflared`, Teleport.
    ///
    /// Mutually exclusive with `jump_via`, for the same reason OpenSSH treats
    /// `ProxyCommand` and `ProxyJump` as alternatives: both replace the
    /// transport, and only one can.
    #[serde(default)]
    pub proxy_command: Option<String>,
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
    /// Whether a terminal on this host runs inside a session that outlives the
    /// connection — see [`crate::persistent_shell`]. Defaults to
    /// [`PersistentShellMode::Off`], and that default matters more than most:
    /// a `#[serde(default)]` on a `Host` field applies to every host already
    /// saved on every user's disk, so anything but `Off` would silently change
    /// how existing hosts behave on upgrade.
    #[serde(default)]
    pub persistent_shell: PersistentShellMode,
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
    /// Where this host was imported from, when it was imported at all.
    ///
    /// Recorded so a re-import refreshes the host instead of adding a second
    /// copy — see [`crate::ansible_inventory`] for why the inventory *name* is
    /// the identity rather than the address. `None` for a host made by hand,
    /// and for every EC2 import, which matches on its address instead (that
    /// path predates this field, and changing it would duplicate every
    /// instance already in a user's workspace).
    #[serde(default)]
    pub source: Option<HostSource>,
}

/// Which importer owns a host, and under what identity there.
///
/// Lived in `ansible_inventory` while that was its only user; moved here once
/// [`crate::cloud_inventory`] gave it a second and third, since it is a field
/// of [`Host`] and not a detail of any one source. The JSON is unchanged —
/// it is the same two strings in the same place — so workspaces already on
/// disk keep parsing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostSource {
    /// `"ansible"`, `"azure"`, `"gcp"`. Deliberately **not** an enum: an
    /// unknown source read from an older or newer `workspace.json` must stay
    /// readable rather than make the whole file fail to parse — and a file
    /// that fails to parse is a user whose hosts have vanished.
    pub kind: String,
    /// The identity within that source: the inventory name for Ansible, the
    /// ARM resource id for Azure, the numeric instance id for GCP. Always
    /// something the provider keeps stable across a rename or a move.
    pub id: String,
    /// Which listing this host came out of — an Azure subscription, a GCP
    /// project.
    ///
    /// **Needed to tell "deleted" from "belongs to another scope".** A GCP
    /// instance id is a bare number carrying no project, so without this,
    /// checking project A would report every host of project B as gone. Azure
    /// could be parsed back out of its ARM id, but recording it keeps the two
    /// providers on one rule.
    ///
    /// `#[serde(default)]`, so hosts imported before this existed stay
    /// readable — they simply carry `None`, and the staleness check leaves
    /// them alone rather than guessing.
    #[serde(default)]
    pub scope: Option<String>,
}

impl HostSource {
    pub fn new(kind: impl Into<String>, id: impl Into<String>) -> Self {
        Self { kind: kind.into(), id: id.into(), scope: None }
    }

    /// The same source, attributed to the listing it came from.
    pub fn in_scope(mut self, scope: impl Into<String>) -> Self {
        self.scope = Some(scope.into());
        self
    }

    pub fn ansible(name: impl Into<String>) -> Self {
        Self::new("ansible", name)
    }
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
            proxy_command: None,
            tags: Vec::new(),
            startup_snippets: Vec::new(),
            env_vars: Vec::new(),
            icon: None,
            keepalive_interval_secs: None,
            agent_forward: false,
            persistent_shell: PersistentShellMode::default(),
            source: None,
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

/// How a database connection reaches its server when this machine can't dial
/// it directly.
///
/// **A sum type rather than more optional fields.** This used to be a single
/// `tunnel_host_id: Option<HostId>`; adding SSM beside it as another
/// `Option<String>` would make "tunnelled through an SSH host *and* through
/// SSM" representable, and every dial site would then have to decide what that
/// combination means. Here it has no spelling at all — the same reasoning that
/// produced [`EngineConfig`] itself, and the same one recorded in
/// `docs/backlog.md` for this feature.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum DbTunnel {
    /// Dial the server's own address from this machine.
    #[default]
    Direct,
    /// Open an SSH connection to a saved host first, and reach the server
    /// through an ephemeral local port forward (see `crate::db_tunnel::open`)
    /// — for a database only reachable *from* that host (bound to loopback
    /// server-side, sitting in a private subnet it can route to), not
    /// necessarily "the database runs on that host".
    SshHost { host_id: HostId },
    /// Reach the server through AWS Session Manager's port forwarding, with no
    /// SSH server anywhere in the path.
    ///
    /// **This removes the bastion, not the relay.** `target` is still an
    /// instance registered with SSM and the traffic still goes through it —
    /// but it needs no sshd, no key of ours, and no inbound port open, which
    /// is the entire difference and what the form has to say plainly. See
    /// [`crate::ssm_tunnel`].
    Ssm {
        /// The SSM-registered instance the session runs through: an EC2
        /// instance id (`i-…`) or a managed instance (`mi-…`).
        target: String,
        /// `--profile`, when the CLI's default isn't the right account.
        #[serde(default)]
        profile: Option<String>,
        /// `--region`, when the profile doesn't already pin one.
        #[serde(default)]
        region: Option<String>,
    },
}

impl DbTunnel {
    pub fn is_direct(&self) -> bool {
        matches!(self, DbTunnel::Direct)
    }

    /// The saved host this reaches through, when it reaches through one at
    /// all. `None` for `Ssm` as well as `Direct`: an SSM target is an AWS
    /// instance id, not a `Host` in this workspace.
    pub fn host_id(&self) -> Option<HostId> {
        match self {
            DbTunnel::SshHost { host_id } => Some(*host_id),
            DbTunnel::Direct | DbTunnel::Ssm { .. } => None,
        }
    }
}

/// How to reach a database server that speaks a discrete
/// address/port/credentials protocol — MySQL, PostgreSQL and Redis all do.
///
/// Read from and written as [`ServerConfigWire`], which is what carries the
/// backward compatibility with the `tunnelHostId` field this struct used to
/// have — see that type.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(from = "ServerConfigWire", into = "ServerConfigWire")]
pub struct ServerConfig {
    /// How to get to `address`/`port` at all.
    pub tunnel: DbTunnel,
    /// Reachable directly from this machine when `tunnel` is
    /// [`DbTunnel::Direct`], or reachable *from the far end of the tunnel*
    /// otherwise (often `127.0.0.1` for a database bound to loopback on an
    /// SSH host; the provider endpoint for an SSM tunnel, which resolves it
    /// from inside the VPC).
    pub address: String,
    pub port: u16,
    /// An optional Redis 6+ ACL username for `SqlEngine::Redis` — empty means
    /// legacy `requirepass`-only auth, still the common case.
    pub username: String,
    /// MySQL/PostgreSQL: initial database to connect to. Required in practice
    /// for PostgreSQL (a connection always targets exactly one database, and
    /// never switches without reconnecting — see `crate::sql`'s module docs);
    /// optional for MySQL (a database can be selected, or switched, per
    /// query). `Redis`: the numbered database index (0–15 by default), stored
    /// as a string, e.g. `Some("0")` — `None`/empty defaults to `0` at
    /// connect time.
    pub database: Option<String>,
    /// Encrypt the connection to this server.
    ///
    /// A property of the *transport*, so it belongs on the config every
    /// TCP-dialled engine shares rather than on one engine's own — but only
    /// `Redis` reads it today (`rediss://`, see
    /// [`crate::redis_client::connect`]). MySQL and PostgreSQL negotiate TLS
    /// through `sqlx`'s own defaults and have never needed a switch here.
    ///
    /// Set automatically when importing an ElastiCache group that has
    /// encryption in transit enabled.
    pub tls: bool,
}

/// [`ServerConfig`]'s on-disk shape, which has to read two generations of it.
///
/// Every `workspace.json` written before [`DbTunnel`] existed spells the
/// tunnel as `"tunnelHostId": "<uuid>"` (or an explicit `null`). Those files
/// are on users' disks, and `store::load_resilient` moves aside a
/// `workspace.json` it can't parse — so failing to read one doesn't degrade,
/// it makes every saved connection disappear. Both spellings are therefore
/// accepted, `tunnel` winning when both are present.
///
/// **`tunnelHostId` is still *written*** for [`DbTunnel::SshHost`], on top of
/// the new field. It costs one duplicated uuid and buys a safe downgrade: a
/// user who rolls back to an older build keeps their tunnelled connections
/// instead of silently getting direct dials to an address that isn't
/// reachable. Nothing equivalent is possible for `Ssm`, which an older build
/// has no way to honour.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ServerConfigWire {
    #[serde(default, skip_serializing_if = "DbTunnel::is_direct")]
    tunnel: DbTunnel,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    tunnel_host_id: Option<HostId>,
    #[serde(default, deserialize_with = "null_to_default")]
    address: String,
    #[serde(default, deserialize_with = "null_to_default")]
    port: u16,
    #[serde(default, deserialize_with = "null_to_default")]
    username: String,
    #[serde(default)]
    database: Option<String>,
    #[serde(default)]
    tls: bool,
}

impl From<ServerConfigWire> for ServerConfig {
    fn from(wire: ServerConfigWire) -> Self {
        Self {
            tunnel: resolve_tunnel(wire.tunnel, wire.tunnel_host_id),
            address: wire.address,
            port: wire.port,
            username: wire.username,
            database: wire.database,
            tls: wire.tls,
        }
    }
}

impl From<ServerConfig> for ServerConfigWire {
    fn from(config: ServerConfig) -> Self {
        Self {
            tunnel_host_id: config.tunnel.host_id(),
            tunnel: config.tunnel,
            address: config.address,
            port: config.port,
            username: config.username,
            database: config.database,
            tls: config.tls,
        }
    }
}

/// Picks between the two generations of tunnel spelling on disk.
///
/// A file written by a current build carries `tunnel`; one written before
/// [`DbTunnel`] existed carries only `tunnelHostId`; one written by a current
/// build with an SSH tunnel carries *both*, deliberately (see
/// [`ServerConfigWire`]). `tunnel` therefore wins whenever it says anything,
/// and the legacy field is only consulted when it doesn't.
fn resolve_tunnel(tunnel: DbTunnel, legacy_host_id: Option<HostId>) -> DbTunnel {
    match (tunnel, legacy_host_id) {
        (DbTunnel::Direct, Some(host_id)) => DbTunnel::SshHost { host_id },
        (tunnel, _) => tunnel,
    }
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
    /// [`ServerConfig::tunnel`] rather than reusing it, since the two mean
    /// genuinely different things (a *tunnel to a TCP port* vs. an SFTP *file
    /// fetch*, with no persistent connection kept open for the latter beyond
    /// what's needed to write the file back on close). It is also why SQLite
    /// has no [`DbTunnel`]: there is no port to forward.
    #[serde(default)]
    pub sqlite_host_id: Option<HostId>,
}

/// How to reach a MongoDB deployment. Unlike [`ServerConfig`], a single
/// address/port pair can't describe one: a replica set is a *set* of hosts,
/// and `mongodb+srv://` has no discrete port at all (the driver resolves
/// members via DNS SRV).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(from = "MongoConfigWire", into = "MongoConfigWire")]
pub struct MongoConfig {
    /// A full `mongodb://`/`mongodb+srv://` connection string.
    pub connection_string: String,
    /// Injected into `connection_string` at connect time (with the password
    /// pulled from the vault, same as every other engine) if the string
    /// doesn't already carry its own credentials — left empty if it already
    /// does, or the deployment needs none.
    pub username: String,
    /// Only honored for a plain single-host `mongodb://host:port/...`
    /// `connection_string` — `crate::mongo_client::connect` rejects anything
    /// else outright, for `mongodb+srv://` or a comma-joined multi-host
    /// string, since neither can be transparently tunnelled through one TCP
    /// forward (SRV does its own multi-host discovery; a replica set's
    /// driver-side failover assumes it can reach every member directly). That
    /// restriction is a property of the single forwarded port, not of SSH, so
    /// it applies to [`DbTunnel::Ssm`] identically.
    pub tunnel: DbTunnel,
    /// Require TLS. DocumentDB accepts nothing else by default, and a plain
    /// `mongodb://` dial to it hangs rather than failing.
    pub tls: bool,
    /// A PEM bundle to verify the server against, when the system trust store
    /// isn't enough.
    ///
    /// Empty is the right answer for MongoDB Atlas and for DocumentDB clusters
    /// whose certificates chain to a public root — the system store covers
    /// those. It is *not* enough for clusters still presenting the private
    /// Amazon RDS authority, and that is the case this field exists for:
    /// download `global-bundle.pem` from AWS and point here. Deliberately a
    /// path rather than a bundle shipped inside the app, which would make
    /// Guiterm responsible for keeping a certificate store current.
    pub tls_ca_file: Option<String>,
    /// Connect over TLS without verifying the server's certificate.
    ///
    /// Exists for one situation, and is off unless asked for. Through a tunnel
    /// the driver dials `127.0.0.1`, which no server certificate carries — the
    /// name it was issued for is on the far side of the forward. The Rust
    /// driver has no "skip the *name* check only" option (unlike `mongosh
    /// --tlsAllowInvalidHostnames`), so the only way through is to skip
    /// verification entirely.
    ///
    /// What that costs is bounded but real: the tunnel's far end is already
    /// chosen and authenticated (by SSH, or by IAM and the SSM agent) and the
    /// leg from there to the database stays inside the provider's network —
    /// but a certificate is no longer proof of anything on that leg. Which is
    /// why nothing sets this on the user's behalf.
    pub tls_insecure: bool,
}

/// [`MongoConfig`]'s on-disk shape. Same two-generation job as
/// [`ServerConfigWire`], for MongoDB's own `tunnelHostId` — which was a
/// separate field from the server engines' one and so needs its own migration.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MongoConfigWire {
    #[serde(default, deserialize_with = "null_to_default")]
    connection_string: String,
    #[serde(default, deserialize_with = "null_to_default")]
    username: String,
    #[serde(default, skip_serializing_if = "DbTunnel::is_direct")]
    tunnel: DbTunnel,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    tunnel_host_id: Option<HostId>,
    #[serde(default)]
    tls: bool,
    #[serde(default)]
    tls_ca_file: Option<String>,
    #[serde(default)]
    tls_insecure: bool,
}

impl From<MongoConfigWire> for MongoConfig {
    fn from(wire: MongoConfigWire) -> Self {
        Self {
            connection_string: wire.connection_string,
            username: wire.username,
            tunnel: resolve_tunnel(wire.tunnel, wire.tunnel_host_id),
            tls: wire.tls,
            tls_ca_file: wire.tls_ca_file,
            tls_insecure: wire.tls_insecure,
        }
    }
}

impl From<MongoConfig> for MongoConfigWire {
    fn from(config: MongoConfig) -> Self {
        Self {
            connection_string: config.connection_string,
            username: config.username,
            tunnel_host_id: config.tunnel.host_id(),
            tunnel: config.tunnel,
            tls: config.tls,
            tls_ca_file: config.tls_ca_file,
            tls_insecure: config.tls_insecure,
        }
    }
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
    ///
    /// `None` for an SSM tunnel, which goes through no saved host at all —
    /// callers that need to describe *every* way a connection is reached want
    /// [`Self::tunnel`] instead.
    pub fn via_host_id(&self) -> Option<HostId> {
        match self {
            EngineConfig::Sqlite(c) => c.sqlite_host_id,
            other => other.tunnel().and_then(DbTunnel::host_id),
        }
    }

    /// How this connection reaches its server, for the engines that dial a
    /// port. `None` for SQLite, which has no port to forward.
    pub fn tunnel(&self) -> Option<&DbTunnel> {
        match self {
            EngineConfig::Mysql(c) | EngineConfig::Postgres(c) | EngineConfig::Redis(c) => Some(&c.tunnel),
            EngineConfig::Mongodb(c) => Some(&c.tunnel),
            EngineConfig::Sqlite(_) => None,
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

/// Which hosts depend on each keychain key, by label.
///
/// The transposition of [`crate::aws_inventory::hosts_by_profile`], and it
/// exists for the same reason its doc comment gives: **something has to answer
/// "what breaks if this stops working" before a deletion is offered**.
/// `delete_private_key` used to remove a key with no such check, so every host
/// authenticating with it broke silently — and nothing said which ones.
///
/// Only keys referenced *by id* count. A host pointing at a key by path holds
/// its own copy of that path and keeps working after the keychain entry goes,
/// so counting it would overstate the damage.
pub fn hosts_by_key(workspace: &Workspace) -> std::collections::HashMap<KeyId, Vec<String>> {
    let mut usage: std::collections::HashMap<KeyId, Vec<String>> = std::collections::HashMap::new();
    for host in &workspace.hosts {
        if let AuthMethod::PrivateKey { key_id: Some(key_id), .. } = &host.auth {
            usage.entry(*key_id).or_default().push(host.label.clone());
        }
    }
    usage
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
            .ok_or_else(|| anyhow::anyhow!("hôte {id} introuvable"))?;
        let mut chain: Vec<&Host> = Vec::with_capacity(target.jump_via.len() + 1);
        let mut seen = std::collections::HashSet::new();
        seen.insert(id);
        for &jid in &target.jump_via {
            if !seen.insert(jid) {
                anyhow::bail!("duplicate bastion in chain");
            }
            chain.push(
                self.host(jid)
                    .ok_or_else(|| anyhow::anyhow!("bastion {jid} introuvable"))?,
            );
        }
        chain.push(target);
        Ok(chain)
    }
}

#[cfg(test)]
mod auth_method_json {
    use super::*;

    /// The exact payload `HostForm.tsx` and `AwsImportPanel.tsx` send.
    ///
    /// Written by hand rather than produced by serialising a Rust value: a
    /// Rust round trip agrees with itself whatever the casing is, which is
    /// precisely why this went unnoticed. The frontend says `keyId`; if Rust
    /// ever stops reading that, a keychain-backed key silently becomes "no
    /// key" — no error at either end, and the connection fails much later
    /// with a misleading message about a key file.
    #[test]
    fn reads_the_camel_cased_key_id_the_frontend_sends() {
        let json = r#"{"privateKey":{"path":"","keyId":"11111111-2222-3333-4444-555555555555"}}"#;
        let parsed: AuthMethod = serde_json::from_str(json).expect("doit se désérialiser");
        match parsed {
            AuthMethod::PrivateKey { key_id, .. } => {
                assert_eq!(
                    key_id.map(|id| id.to_string()).as_deref(),
                    Some("11111111-2222-3333-4444-555555555555"),
                    "le keyId envoyé par le frontend doit arriver jusqu'au modèle"
                );
            }
            other => panic!("variante inattendue : {other:?}"),
        }
    }

    /// ...and it must go back out under the same name, or the host form would
    /// load with no key selected even though one is stored.
    #[test]
    fn writes_the_key_id_back_as_camel_case() {
        let auth = AuthMethod::PrivateKey {
            path: "/home/u/.ssh/id_ed25519".to_string(),
            key_id: Some(KeyId::nil()),
            cert_path: None,
        };
        let json = serde_json::to_value(&auth).unwrap();
        assert!(
            json["privateKey"].get("keyId").is_some(),
            "sérialisé en {json}, le frontend lit keyId"
        );
    }

    /// `workspace.json` files written before the rename contain `key_id`.
    /// Without the alias they would still parse — into `None` — and every
    /// already-configured keychain key would detach on upgrade.
    #[test]
    fn still_reads_the_snake_cased_form_already_on_disk() {
        let json = r#"{"privateKey":{"path":"/k","key_id":"11111111-2222-3333-4444-555555555555"}}"#;
        let parsed: AuthMethod = serde_json::from_str(json).expect("les anciens fichiers doivent rester lisibles");
        match parsed {
            AuthMethod::PrivateKey { key_id, .. } => assert!(key_id.is_some()),
            other => panic!("variante inattendue : {other:?}"),
        }
    }

    /// A key given by path carries no id, and that has to stay expressible.
    #[test]
    fn a_key_without_an_id_stays_none() {
        let json = r#"{"privateKey":{"path":"/home/u/.ssh/id_ed25519","keyId":null}}"#;
        let parsed: AuthMethod = serde_json::from_str(json).unwrap();
        assert_eq!(
            parsed,
            AuthMethod::PrivateKey {
                path: "/home/u/.ssh/id_ed25519".to_string(),
                key_id: None,
                cert_path: None,
            }
        );
    }

    /// A host written before imports recorded their provenance has no
    /// `source`. Same stakes as every other field added to this struct: a
    /// `workspace.json` that fails to parse makes an existing user's hosts
    /// disappear.
    #[test]
    fn a_host_written_before_provenance_still_loads() {
        let json = r#"{"id":"11111111-2222-3333-4444-555555555555","label":"web","address":"10.0.0.1","port":22,"username":"ubuntu","auth":"agent","groupId":null,"jumpVia":[],"tags":[],"startupSnippets":[],"envVars":[]}"#;
        let host: Host = serde_json::from_str(json).expect("les anciens hôtes doivent rester lisibles");
        assert_eq!(host.source, None);
        assert_eq!(host.label, "web");
    }

    /// And a host imported now round-trips its provenance — without it a
    /// re-import would add a second copy of every machine.
    #[test]
    fn provenance_survives_a_round_trip_in_camel_case() {
        let mut host = Host::new("web", "10.0.0.1", "ubuntu");
        host.source = Some(HostSource::ansible("web1.example.com"));

        let json = serde_json::to_value(&host).unwrap();
        assert_eq!(json["source"]["kind"], "ansible");
        assert_eq!(json["source"]["id"], "web1.example.com");

        let back: Host = serde_json::from_value(json).unwrap();
        assert_eq!(back.source, host.source);
    }

    /// Every `workspace.json` written before certificates existed has no
    /// `certPath`. Without the `default` it wouldn't parse at all — and a
    /// workspace that fails to load makes every host of every existing user
    /// disappear, which is the worst failure this file can produce.
    #[test]
    fn a_workspace_written_before_certificates_still_loads() {
        let json = r#"{"privateKey":{"path":"/home/u/.ssh/id_ed25519","keyId":null}}"#;
        let parsed: AuthMethod = serde_json::from_str(json).expect("les anciens fichiers doivent rester lisibles");
        match parsed {
            AuthMethod::PrivateKey { cert_path, .. } => assert_eq!(cert_path, None),
            other => panic!("variante inattendue : {other:?}"),
        }
    }

    /// And the frontend spells it `certPath`, like every other field it sends.
    #[test]
    fn reads_and_writes_the_camel_cased_cert_path() {
        let json = r#"{"privateKey":{"path":"/k","keyId":null,"certPath":"/k-cert.pub"}}"#;
        let parsed: AuthMethod = serde_json::from_str(json).expect("doit se désérialiser");
        match &parsed {
            AuthMethod::PrivateKey { cert_path, .. } => {
                assert_eq!(cert_path.as_deref(), Some("/k-cert.pub"));
            }
            other => panic!("variante inattendue : {other:?}"),
        }
        let back = serde_json::to_value(&parsed).unwrap();
        assert_eq!(back["privateKey"]["certPath"], "/k-cert.pub");
    }

    /// The other variants are plain strings on the wire; renaming fields must
    /// not have disturbed them.
    #[test]
    fn the_simple_variants_are_unchanged() {
        assert_eq!(serde_json::to_string(&AuthMethod::Agent).unwrap(), "\"agent\"");
        assert_eq!(
            serde_json::to_string(&AuthMethod::KeyboardInteractive).unwrap(),
            "\"keyboardInteractive\""
        );
        let parsed: AuthMethod = serde_json::from_str("\"password\"").unwrap();
        assert_eq!(parsed, AuthMethod::Password);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The safety check `delete_private_key` never had: a key in use has to be
    /// nameable before it is removed, or the hosts that authenticate with it
    /// break with nothing to explain why.
    #[test]
    fn hosts_using_a_key_can_be_named_before_it_is_deleted() {
        let key_id = KeyId::new_v4();
        let other_key = KeyId::new_v4();
        let mut workspace = Workspace::default();

        let mut web = Host::new("web-1", "10.0.0.1", "ubuntu");
        web.auth = AuthMethod::PrivateKey {
            path: "/k".to_string(),
            key_id: Some(key_id),
            cert_path: None,
        };
        let mut db = Host::new("db-1", "10.0.0.2", "ubuntu");
        db.auth = AuthMethod::PrivateKey {
            path: "/k".to_string(),
            key_id: Some(key_id),
            cert_path: None,
        };
        let mut lone = Host::new("autre", "10.0.0.3", "ubuntu");
        lone.auth = AuthMethod::PrivateKey {
            path: "/other".to_string(),
            key_id: Some(other_key),
            cert_path: None,
        };
        workspace.hosts = vec![web, db, lone];

        let usage = hosts_by_key(&workspace);
        assert_eq!(usage[&key_id], vec!["web-1".to_string(), "db-1".to_string()]);
        assert_eq!(usage[&other_key], vec!["autre".to_string()]);
    }

    /// A host pointing at a key *by path* holds its own copy of that path and
    /// keeps working once the keychain entry is gone. Counting it would
    /// overstate the damage and make people keep keys they don't need.
    #[test]
    fn a_key_referenced_only_by_path_is_not_counted() {
        let mut workspace = Workspace::default();
        let mut host = Host::new("web", "10.0.0.1", "ubuntu");
        host.auth = AuthMethod::PrivateKey {
            path: "/home/u/.ssh/id_ed25519".to_string(),
            key_id: None,
            cert_path: None,
        };
        let mut agent = Host::new("agent", "10.0.0.2", "ubuntu");
        agent.auth = AuthMethod::Agent;
        workspace.hosts = vec![host, agent];

        assert!(hosts_by_key(&workspace).is_empty());
    }

    /// The migration promise: every `workspace.json` written before secret
    /// variables existed has no `secret` field at all. Reading one must not
    /// fail — `store::load_resilient` would move the file aside and the user's
    /// hosts would silently vanish.
    #[test]
    fn an_env_var_written_before_secrets_existed_still_reads() {
        let var: EnvVar = serde_json::from_str(r#"{"key":"EDITOR","value":"vim"}"#).unwrap();
        assert_eq!(var.value, "vim");
        assert!(!var.secret, "une variable d'avant n'est pas secrète");
    }

    /// The promise the whole feature rests on: a value marked secret does not
    /// reach the struct that gets written to disk. Asserted on the serialised
    /// JSON rather than on the field, because the file is what leaks.
    #[test]
    fn a_secret_value_never_reaches_the_persisted_json() {
        let (kept, to_store) = split_env_secrets(vec![
            EnvVar { key: "EDITOR".to_string(), value: "vim".to_string(), secret: false },
            EnvVar { key: "API_TOKEN".to_string(), value: "sk-tres-secret".to_string(), secret: true },
        ]);
        let json = serde_json::to_string(&kept).unwrap();
        assert!(!json.contains("sk-tres-secret"), "le secret est dans le JSON : {json}");
        assert!(json.contains("vim"), "une variable ordinaire reste en clair");
        assert_eq!(to_store, vec![("API_TOKEN".to_string(), "sk-tres-secret".to_string())]);
    }

    /// An empty value on a secret variable means "unchanged" — the form never
    /// showed it, so it cannot send it back. Treating it as an erasure would
    /// wipe the token on every unrelated edit of the host.
    #[test]
    fn an_empty_secret_is_left_alone_rather_than_erased() {
        let (kept, to_store) = split_env_secrets(vec![EnvVar {
            key: "API_TOKEN".to_string(),
            value: String::new(),
            secret: true,
        }]);
        assert!(to_store.is_empty(), "rien à réécrire dans le coffre");
        assert_eq!(kept.len(), 1, "la variable reste déclarée sur l'hôte");
        assert!(kept[0].secret);
    }

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
        assert_eq!(
            server.tunnel,
            DbTunnel::SshHost { host_id: Uuid::parse_str("6f1a9d2e-0000-4000-8000-000000000002").unwrap() },
            "the legacy tunnelHostId must migrate into a DbTunnel, not be dropped"
        );
    }

    /// The second generation of that same migration: `tunnelHostId` becoming
    /// [`DbTunnel`]. Written as literal JSON for the same reason as the test
    /// above — a Rust roundtrip would happily agree with itself about a shape
    /// no user's disk actually holds.
    #[test]
    fn legacy_tunnel_host_id_migrates_to_a_db_tunnel() {
        let host_id = Uuid::parse_str("6f1a9d2e-0000-4000-8000-000000000002").unwrap();

        // A pre-DbTunnel file: only the legacy field.
        let legacy = r#"{"engine":"mysql","tunnelHostId":"6f1a9d2e-0000-4000-8000-000000000002","address":"127.0.0.1","port":3306}"#;
        let EngineConfig::Mysql(server) = serde_json::from_str::<EngineConfig>(legacy).expect("legacy shape must load") else {
            panic!("expected MySQL");
        };
        assert_eq!(server.tunnel, DbTunnel::SshHost { host_id });

        // An explicit `null`, which is what a direct connection was written as.
        let direct = r#"{"engine":"mysql","tunnelHostId":null,"address":"db","port":3306}"#;
        let EngineConfig::Mysql(server) = serde_json::from_str::<EngineConfig>(direct).expect("null must load") else {
            panic!("expected MySQL");
        };
        assert_eq!(server.tunnel, DbTunnel::Direct);

        // Both present — written by a current build for a downgrade's benefit.
        // `tunnel` wins; the two never disagree, but the rule has to be fixed.
        let both = r#"{"engine":"mysql","tunnel":{"kind":"sshHost","hostId":"6f1a9d2e-0000-4000-8000-000000000002"},"tunnelHostId":"6f1a9d2e-0000-4000-8000-000000000002","address":"127.0.0.1","port":3306}"#;
        let EngineConfig::Mysql(server) = serde_json::from_str::<EngineConfig>(both).expect("both spellings must load") else {
            panic!("expected MySQL");
        };
        assert_eq!(server.tunnel, DbTunnel::SshHost { host_id });
    }

    /// The casing of an internally-tagged enum's *struct variant fields* — the
    /// trap this project has hit six times, and which `rename_all` alone does
    /// not fix (`rename_all_fields` does). Asserted against hand-written JSON
    /// keys rather than a roundtrip, which is the only thing that proves the
    /// on-disk spelling.
    #[test]
    fn ssm_tunnel_field_names_are_camel_case_on_disk() {
        let config = EngineConfig::Postgres(ServerConfig {
            tunnel: DbTunnel::Ssm {
                target: "i-0abc123".to_string(),
                profile: Some("prod".to_string()),
                region: Some("eu-west-1".to_string()),
            },
            address: "db.eu-west-1.rds.amazonaws.com".to_string(),
            port: 5432,
            ..Default::default()
        });

        let json: serde_json::Value = serde_json::to_value(&config).expect("serialisable");
        assert_eq!(json["tunnel"]["kind"], "ssm");
        assert_eq!(json["tunnel"]["target"], "i-0abc123");
        assert_eq!(json["tunnel"]["profile"], "prod");
        assert_eq!(json["tunnel"]["region"], "eu-west-1");
        assert!(
            json.get("tunnelHostId").is_none(),
            "an SSM tunnel has no host to write into the legacy field: {json}"
        );

        let back: EngineConfig = serde_json::from_value(json).expect("must read back");
        assert_eq!(back.tunnel(), config.tunnel());
    }

    /// An SSH tunnel is written in *both* spellings, so rolling back to a
    /// build that predates [`DbTunnel`] keeps dialling through the tunnel
    /// instead of silently going direct to an address that isn't reachable.
    /// A direct connection writes neither, keeping the file as small as before.
    #[test]
    fn ssh_tunnel_is_written_in_both_spellings_and_direct_in_neither() {
        let host_id = Uuid::parse_str("6f1a9d2e-0000-4000-8000-000000000002").unwrap();
        let tunnelled = EngineConfig::Redis(ServerConfig {
            tunnel: DbTunnel::SshHost { host_id },
            address: "127.0.0.1".to_string(),
            port: 6379,
            ..Default::default()
        });

        let json: serde_json::Value = serde_json::to_value(&tunnelled).expect("serialisable");
        assert_eq!(json["tunnel"]["kind"], "sshHost");
        assert_eq!(json["tunnel"]["hostId"], host_id.to_string());
        assert_eq!(
            json["tunnelHostId"], host_id.to_string(),
            "the legacy field stays written so a downgrade keeps the tunnel"
        );

        let direct = EngineConfig::Redis(ServerConfig { address: "cache".to_string(), port: 6379, ..Default::default() });
        let json: serde_json::Value = serde_json::to_value(&direct).expect("serialisable");
        assert!(json.get("tunnel").is_none(), "a direct connection writes no tunnel: {json}");
        assert!(json.get("tunnelHostId").is_none(), "nor the legacy field: {json}");
    }

    /// MongoDB carried its own `tunnelHostId`, separate from the server
    /// engines' one, so it needs its own migration — and a DocumentDB
    /// connection is exactly the case this feature exists for.
    #[test]
    fn legacy_mongo_tunnel_host_id_migrates_too() {
        let legacy = r#"{
            "id": "6f1a9d2e-0000-4000-8000-000000000009",
            "label": "docdb",
            "engine": "mongodb",
            "connectionString": "mongodb://cluster.eu-west-1.docdb.amazonaws.com:27017/",
            "username": "app",
            "tunnelHostId": "6f1a9d2e-0000-4000-8000-000000000002",
            "tls": true,
            "groupId": null,
            "tags": []
        }"#;

        let conn: SqlConnection = serde_json::from_str(legacy).expect("legacy MongoDB shape must load");
        let EngineConfig::Mongodb(mongo) = &conn.config else {
            panic!("expected a MongoDB config, got {:?}", conn.config);
        };
        assert_eq!(
            mongo.tunnel,
            DbTunnel::SshHost { host_id: Uuid::parse_str("6f1a9d2e-0000-4000-8000-000000000002").unwrap() }
        );
        assert!(mongo.tls);
        assert_eq!(conn.config.via_host_id(), mongo.tunnel.host_id());
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

    /// A host saved before persistent sessions existed still loads, and loads
    /// as "off". This is the compatibility rule the whole feature rests on: a
    /// `#[serde(default)]` field is added to every host already on disk, so if
    /// its default were `Tmux` every existing host would silently change
    /// behaviour on upgrade. The JSON below is deliberately the shape a 3.1.1
    /// workspace really has — no `persistentShell` key at all.
    #[test]
    fn a_host_saved_before_persistent_sessions_loads_as_off() {
        let json = r#"{
            "id": "6f1a9d2e-0000-4000-8000-000000000007",
            "label": "web-1",
            "address": "10.0.0.1",
            "port": 22,
            "username": "ubuntu",
            "auth": "agent",
            "groupId": null,
            "jumpVia": [],
            "tags": [],
            "startupSnippets": [],
            "envVars": []
        }"#;

        let host: Host = serde_json::from_str(json).unwrap();
        assert_eq!(host.persistent_shell, PersistentShellMode::Off);
    }

    /// And the casing that reaches the frontend, checked on hand-written JSON
    /// rather than a Rust→Rust roundtrip — which would pass just as well with
    /// the wrong casing on both sides.
    #[test]
    fn the_persistent_shell_mode_is_camel_case_on_the_wire() {
        assert_eq!(serde_json::to_string(&PersistentShellMode::Off).unwrap(), "\"off\"");
        assert_eq!(serde_json::to_string(&PersistentShellMode::Tmux).unwrap(), "\"tmux\"");
        let parsed: PersistentShellMode = serde_json::from_str("\"tmux\"").unwrap();
        assert_eq!(parsed, PersistentShellMode::Tmux);
    }
}
