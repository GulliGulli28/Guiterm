export type HostId = string;
export type GroupId = string;
export type SnippetId = string;
export type PortForwardId = string;

export type KeyId = string;
export type SqlConnectionId = string;

export interface PrivateKey {
  id: KeyId;
  name: string;
  path: string;
  content?: string;
}

export type KeyAlgorithm = "ed25519" | "rsa";

export interface CustomIcon {
  id: string;
  name: string;
  dataUrl: string;
}

/** `keyboardInteractive` is RFC 4256 — how servers drive MFA/OTP. Unlike the
 * others it can't be resolved from stored settings: the server asks questions
 * during the handshake, relayed by the `ssh-auth-prompt` event (see
 * `onSshAuthPrompt`). A stored password, if any, answers the first hidden
 * prompt automatically so only the second factor has to be typed. */
export type AuthMethod = "password" | "agent" | "keyboardInteractive" | { privateKey: { path: string; keyId: KeyId | null } };

/** One question from the server during a keyboard-interactive exchange.
 * Mirrors `core::interactive_auth::PromptField`. */
export interface AuthPromptField {
  /** The server's own wording, shown verbatim — it's what tells the user
   * which factor is being asked for, and it varies by deployment. */
  prompt: string;
  /** Whether typed characters may be displayed. `false` for password-like
   * input; an OTP often comes with `true` since it's single-use. */
  echo: boolean;
}

/** A round of questions. One authentication may go through several. */
export interface SshAuthPrompt {
  /** Correlates the answer with the waiting handshake — several hosts can be
   * authenticating at once. */
  id: string;
  hostLabel: string;
  request: {
    /** Server-supplied title; often empty. */
    name: string;
    /** Server-supplied explanation; often empty. */
    instructions: string;
    prompts: AuthPromptField[];
  };
}

export interface EnvVar {
  key: string;
  value: string;
}

/** What kind of target a `Host` describes. `ssh` uses every field with its
 * literal meaning; the others repurpose a subset of the same fields instead
 * of growing dedicated ones (see `core::model::HostKind`):
 * - `dockerExec`: `address` is the Docker daemon socket or host (e.g.
 *   `unix:///var/run/docker.sock`, `tcp://10.0.4.12:2375`) — unless
 *   `dockerViaHostId` is set, in which case `address` is ignored and the
 *   daemon is reached by tunnelling through that other (SSH) host instead.
 * - `k8sExec`: `address` is a kubeconfig context, `username` is the default
 *   namespace pods are listed/exec'd in — see `core::k8s`.
 * - `rdp`: `address`/`port`/`username` keep their literal meaning; `auth` is
 *   restricted to `password` in the UI. */
export type HostKind = "ssh" | "dockerExec" | "k8sExec" | "rdp";

export interface Host {
  id: HostId;
  label: string;
  kind?: HostKind;
  address: string;
  port: number;
  username: string;
  auth: AuthMethod;
  /** `dockerExec` only — see `HostKind`'s doc comment above. */
  dockerViaHostId?: HostId | null;
  groupId: GroupId | null;
  jumpVia: HostId[];
  /** Reach this host by running a local helper and speaking SSH over its
   * stdin/stdout instead of connecting to `address` — OpenSSH `ProxyCommand`,
   * `%h`/`%p`/`%r` tokens included. How a cloud VM with no public IP and no
   * inbound SSH is reached (AWS SSM, GCP IAP, Azure Bastion, cloudflared).
   * Mutually exclusive with `jumpVia`. */
  proxyCommand?: string | null;
  tags: string[];
  startupSnippets: SnippetId[];
  envVars: EnvVar[];
  icon?: string;
  keepaliveIntervalSecs?: number | null;
  agentForward?: boolean;
  /** Most recent state collected by a fleet facts-collection run (`collect_facts`)
   * — `null`/absent until at least one such run has included this host. Read-only:
   * only that path ever writes it, never the host edit form. */
  lastFacts?: HostFacts | null;
  /** Unix epoch milliseconds of `lastFacts`'s collection. */
  lastFactsAtMs?: number | null;
}

export interface DockerContainer {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
}

/** One pod in a K8s exec host's default namespace. Mirrors
 * `termius_core::k8s::PodSummary`. `containers`: every container name in
 * the pod's spec — more than one means a picker needs to ask which one to
 * exec into (the API defaults to "the only container" otherwise). */
export interface K8sPod {
  name: string;
  namespace: string;
  containers: string[];
  phase: string;
  ready: boolean;
}

/** A pod name never contains `/` (DNS-1123 label), so `podName/containerName`
 * safely round-trips through `ConnectionPickerModal`'s flat `id` list —
 * used only when a pod has more than one container. Shared by every K8s pod
 * picker (`HostsPanel.tsx`, `SplitPane.tsx`, `TransferTab.tsx`). */
export function podPickerId(podName: string, containerName?: string): string {
  return containerName ? `${podName}/${containerName}` : podName;
}

export function parsePodPickerId(id: string): { podName: string; containerName: string | null } {
  const slash = id.indexOf("/");
  return slash === -1 ? { podName: id, containerName: null } : { podName: id.slice(0, slash), containerName: id.slice(slash + 1) };
}

/** Mirrors `rdp_ipc::ClientMessage` — mouse/keyboard forwarded to an
 * embedded RDP session (`RdpTab.tsx` / `send_rdp_view_input`). `button` is
 * the raw DOM `MouseEvent.button` value; `code` is `KeyboardEvent.code`. */
export type RdpClientMessage =
  | { type: "mouseMove"; x: number; y: number }
  | { type: "mouseButton"; x: number; y: number; button: number; pressed: boolean }
  | { type: "mouseWheel"; x: number; y: number; deltaY: number }
  | { type: "key"; code: string; pressed: boolean }
  | { type: "releaseAll" }
  | { type: "resize"; width: number; height: number }
  /** Types `text` into the remote session as Unicode keyboard events — no
   * shell/PTY on an RDP session, so this is how snippets/broadcast commands
   * run there (see `RdpTab.tsx`'s imperative handle). `\n`/`\r` become a
   * real Enter keypress rather than literal characters. */
  | { type: "typeText"; text: string };

/** One embedded-RDP framebuffer update, delivered over a dedicated
 * `tauri::ipc::Channel` (see `connect_rdp_view` in `commands/rdp_view.rs`)
 * as raw bytes rather than a JSON event — `pixels` is a zero-copy view into
 * the received `ArrayBuffer`, parsed by `parseRdpFrame` in `lib/api.ts`.
 * `canvasWidth`/`canvasHeight`: the session's current full desktop size
 * (repeats on most frames — the `<canvas>` should only be resized when it
 * actually changes). `x`/`y`/`width`/`height`/`pixels`: the rectangle to
 * paint, usually just the dirty region a single update touched. */
export interface RdpFrame {
  canvasWidth: number;
  canvasHeight: number;
  x: number;
  y: number;
  width: number;
  height: number;
  pixels: Uint8Array<ArrayBuffer>;
}

export interface Snippet {
  id: SnippetId;
  name: string;
  /** Classic snippet: the literal command. Adaptive snippet (`adaptive: true`):
   * a program in the adaptive engine's small text DSL — see
   * `src/lib/operations.ts` for a syntax cheat-sheet. Either way may contain
   * `{{variables}}`, filled in the same way before use. */
  command: string;
  tags: string[];
  /** Whether `command` is a DSL program (resolved per-host, per platform)
   * rather than a literal command run everywhere as-is. */
  adaptive?: boolean;
}

export type PortForwardKind = "local" | "remote" | "dynamic";

export interface PortForward {
  id: PortForwardId;
  hostId: HostId;
  kind: PortForwardKind;
  bindAddress: string;
  bindPort: number;
  destAddress: string;
  destPort: number;
}

export interface Group {
  id: GroupId;
  name: string;
  parentId: GroupId | null;
  icon?: string;
  color?: string | null;
}

/** Which SQL engine a `SqlConnection` speaks. Unlike MySQL/PostgreSQL,
 * `sqlite` has no server/wire protocol — a connection uses `path`/
 * `sqliteHostId` instead of `address`/`port`/`username`/`database`. `redis`
 * reuses `address`/`port`/`username`/`database` (as a DB index 0-15) but
 * renders through `RedisTab`, not `SqlTab` — a key-value store has no
 * schema/table tree or SQL query language to browse. `mongodb` connects via
 * `connectionString` instead (see its doc comment) and renders through
 * `MongoTab`, for the same reason. */
export type SqlEngine = "mysql" | "postgres" | "sqlite" | "redis" | "mongodb";

export function sqlEngineLabel(engine: SqlEngine): string {
  switch (engine) {
    case "mysql": return "MySQL";
    case "postgres": return "PostgreSQL";
    case "sqlite": return "SQLite";
    case "redis": return "Redis";
    case "mongodb": return "MongoDB";
  }
}

/** A saved MySQL/PostgreSQL/SQLite/Redis/MongoDB connection — deliberately
 * not a `Host`/`HostKind` (see `core::model::SqlConnection`'s doc comment):
 * no shell, not a fleet target. Can still reference a saved SSH `Host` via
 * `tunnelHostId`/`sqliteHostId`, purely to reach a database that isn't
 * directly reachable from this machine — `null`/absent connects directly
 * (`address`/`port` for MySQL/PostgreSQL/Redis, a local file for SQLite, a
 * full URI in `connectionString` for MongoDB). */
/** How to reach a database server that speaks a discrete
 * address/port/credentials protocol — MySQL, PostgreSQL and Redis all do.
 * Mirrors `core::model::ServerConfig`. */
export interface SqlServerConfig {
  /** Unset: connect directly to `address`/`port`. Set: reach them through an
   * ephemeral SSH local port forward via that saved host first — for a
   * database only reachable from there (bound to loopback server-side, a
   * private subnet…), not necessarily "the database runs on that host". */
  tunnelHostId?: HostId | null;
  address: string;
  port: number;
  /** For `redis`, an optional Redis 6+ ACL username — empty means legacy
   * `requirepass`-only auth, still the common case. */
  username: string;
  /** MySQL/PostgreSQL: required in practice for PostgreSQL (a connection
   * always targets one database); optional for MySQL. `redis`: the numbered
   * database index (0-15 by default) as a string, e.g. `"0"` — empty/absent
   * defaults to `0`. */
  database?: string | null;
  /** Encrypt the connection. Only `redis` reads it today (`rediss://`) —
   * MySQL and PostgreSQL negotiate TLS through the driver's own defaults.
   * Set automatically when importing an ElastiCache group that has
   * encryption in transit enabled. */
  tls?: boolean;
}

/** Which engine a connection speaks, plus everything needed to dial it — a
 * discriminated union on `engine`, mirroring `core::model::EngineConfig` (an
 * internally-tagged enum flattened into the struct, so this is exactly the
 * JSON shape the backend sends and accepts).
 *
 * Narrow on `engine` before reading engine-specific fields — that's the
 * point: it's no longer possible to read `port` off a SQLite connection or
 * `path` off a MySQL one, which the previous all-fields-optional shape
 * allowed silently. */
export type SqlEngineConfig =
  | ({ engine: "mysql" } & SqlServerConfig)
  | ({ engine: "postgres" } & SqlServerConfig)
  | ({ engine: "redis" } & SqlServerConfig)
  | {
      engine: "sqlite";
      /** The file's absolute path, local to this machine when `sqliteHostId`
       * is unset, or a path on that host's filesystem otherwise. */
      path: string;
      /** Unset: `path` is a local file. Set: `path` lives on that saved host
       * instead, fetched over SFTP into a local temp copy when the connection
       * is opened and written back on a clean close — deliberately separate
       * from `tunnelHostId` (an SSH *tunnel to a TCP port* and an SFTP *file
       * fetch* are genuinely different things). */
      sqliteHostId?: HostId | null;
    }
  | {
      engine: "mongodb";
      /** A full `mongodb://`/`mongodb+srv://` connection string (e.g. pasted
       * from Atlas) — a single address/port pair can't describe a replica set,
       * and `+srv` has no discrete port at all. */
      connectionString: string;
      /** Injected into `connectionString` at connect time if it doesn't
       * already carry its own credentials — left empty if it does, or none
       * are needed. */
      username: string;
      /** Only honored for a plain single-host `mongodb://host:port/...`
       * string — rejected for `mongodb+srv://` or a multi-host string
       * (neither can be tunnelled through one TCP forward). */
      tunnelHostId?: HostId | null;
      /** Require TLS — DocumentDB accepts nothing else. */
      tls?: boolean;
      /** PEM bundle to verify the server against, when the system trust store
       * isn't enough (a DocumentDB cluster still on the private Amazon RDS
       * authority). Empty uses the system store. */
      tlsCaFile?: string | null;
      /** Skip certificate verification. Needed only to combine TLS with an
       * SSH tunnel, where the certificate can't match the tunnel's local
       * address — see `core::model::MongoConfig::tls_insecure`. */
      tlsInsecure?: boolean;
    };

/** A saved database connection — deliberately not a `Host`/`HostKind` (see
 * `core::model::SqlConnection`'s doc comment). */
export type SqlConnection = {
  id: SqlConnectionId;
  label: string;
  groupId?: GroupId | null;
  tags: string[];
} & SqlEngineConfig;

/** The saved host this connection reaches through, whichever way it does so —
 * an SSH tunnel for the server engines and MongoDB, an SFTP file fetch for
 * SQLite. Mirrors `EngineConfig::via_host_id`, so callers that just want to
 * show "via <host>" don't each have to narrow on `engine` themselves. */
export function sqlConnectionViaHostId(conn: SqlConnection): HostId | null {
  return (conn.engine === "sqlite" ? conn.sqliteHostId : conn.tunnelHostId) ?? null;
}

/** One-line "where does this point at" summary, for the connections list. */
export function sqlConnectionTarget(conn: SqlConnection): string {
  switch (conn.engine) {
    case "sqlite": return conn.path;
    case "mongodb": return conn.connectionString;
    case "redis": return `${conn.address}:${conn.port}/${conn.database || "0"}`;
    case "mysql":
    case "postgres": return `${conn.address}:${conn.port}`;
  }
}

/** One database (MySQL) or schema (PostgreSQL) to browse — see
 * `core::sql`'s module doc comment for why the two share this one level. */
export interface TableInfo {
  name: string;
  kind: "table" | "view";
}

export interface ColumnInfo {
  name: string;
  dataType: string;
  nullable: boolean;
}

/** A decoded cell value — `string | number | boolean | null` for ordinary
 * columns, but a nested object/array for JSON(B) columns and (best-effort)
 * text arrays: `core::sql::decode_pg_value`/`decode_mysql_value` pass a
 * JSON(B) column's value through as real JSON rather than re-stringifying
 * it. */
export type SqlCellValue = string | number | boolean | null | SqlCellValue[] | { [key: string]: SqlCellValue };

/** Result of `runSqlQuery`. `rows[i][j]` corresponds to `columns[j]`.
 * `truncated`: more than the server-side row cap matched, only the first N
 * are here — see `core::sql::MAX_RESULT_ROWS`. */
export interface QueryResult {
  columns: string[];
  rows: SqlCellValue[][];
  truncated: boolean;
}

/** Where `exportSqlDump` writes the generated dump — see
 * `commands::sql::SqlExportDestination`'s doc comment for why `hostId`
 * (not `host_id`) actually needs `rename_all_fields` on the Rust side. */
export type SqlExportDestination =
  | { kind: "local"; path: string }
  | { kind: "remoteHost"; hostId: HostId; path: string };

/** One schema/database's worth of tables to include in `exportSqlDump` — a
 * single export can span several of these (e.g. every database on a MySQL
 * connection), concatenated into one file. See
 * `commands::sql::SqlExportGroup`. */
export interface SqlExportGroup {
  schema: string;
  tables: string[];
}

/** One entry in the "Clés" list — `keyType` is the raw Redis `TYPE` reply
 * ("string"/"hash"/"list"/"set"/"zset"/…), `ttlSecs` is `null` for both "no
 * expiry" and "key doesn't exist" (see `core::redis_client::ttl_from_raw`). */
export interface RedisKeyEntry {
  key: string;
  keyType: string;
  ttlSecs: number | null;
}

/** Result of `scanRedisKeys` — `cursor` is `0` once the keyspace (or
 * everything matching the search pattern) has been fully iterated; the
 * frontend's "charger plus" button hides once this comes back `0`. */
export interface ScanPage {
  keys: RedisKeyEntry[];
  cursor: number;
}

/** A key's type-rendered value — see `core::redis_client::RedisValue`'s doc
 * comment for why this needs `rename_all_fields` (not just `rename_all`) on
 * the Rust side for `entries`/`members`/`typeName` to actually come through
 * camelCase. `unsupported` covers streams and module types (RedisJSON, Bloom
 * filters, …) the "Valeur" tab doesn't render structurally — reachable via
 * the Console tab's raw commands instead. */
export type RedisValue =
  | { kind: "string"; value: string }
  | { kind: "hash"; entries: [string, string][]; truncated: boolean }
  | { kind: "list"; items: string[]; truncated: boolean }
  | { kind: "set"; members: string[]; truncated: boolean }
  | { kind: "sortedSet"; members: [string, number][]; truncated: boolean }
  | { kind: "unsupported"; typeName: string };

export interface RedisKeyDetail {
  keyType: string;
  ttlSecs: number | null;
  value: RedisValue;
}

/** A generic RESP reply, rendered by the Console tab — `null`/a bare
 * number/a bare string/a bare array for the ordinary cases, `{ error }` is
 * the one shape that needs to stay distinguishable from a plain string
 * reply. See `core::redis_client::RedisReply`'s doc comment. */
export type RedisReply = null | number | string | RedisReply[] | { error: string };

/** One database's collection, or view, or timeseries — mirrors `TableInfo`,
 * see `core::mongo_client::CollectionInfo`'s doc comment for why. */
export interface CollectionInfo {
  name: string;
  kind: "collection" | "view" | "timeseries";
}

/** Result of `findMongoDocuments` — backs both the "Données" tab (no
 * filter) and the "Requête" tab (a JSON filter), see
 * `core::mongo_client::find_documents`'s doc comment. Each document is
 * rendered as relaxed MongoDB Extended JSON (`$oid`/`$date`-style wrapper
 * objects only where JSON can't represent the BSON type directly). */
export interface MongoQueryResult {
  documents: unknown[];
  truncated: boolean;
}

export interface Workspace {
  groups: Group[];
  hosts: Host[];
  snippets: Snippet[];
  portForwards: PortForward[];
  keychain: PrivateKey[];
  customIcons: CustomIcon[];
  sqlConnections: SqlConnection[];
}

export interface KnownHostEntry {
  identity: string;
  label: string;
  publicKey: string;
}

/** State of the optional master-password vault. `enabled` = a master password
 * is configured; `unlocked` = the secrets are decryptable this session. */
export interface VaultStatus {
  enabled: boolean;
  unlocked: boolean;
}

/** Outcome of trying a proxy command out, from `test_proxy_command`.
 * `reached` is the only good one: it means the helper carried us all the way
 * to something that answered with an SSH identification string. */
export type ProxyProbe =
  | { kind: "reached"; banner: string }
  | { kind: "silent" }
  | { kind: "failed"; message: string; hint: string | null };

/** One EC2 instance as `discover_aws_instances` reports it. `ssmOnline` is
 * what decides whether it can be imported: without SSM there is no way in. */
export interface AwsInstance {
  instanceId: string;
  name: string | null;
  privateIp: string | null;
  publicIp: string | null;
  state: string;
  platform: string | null;
  ssmOnline: boolean;
  /** Tag key/value pairs, straight from EC2. */
  tags: [string, string][];
  /** Conventional login for the AMI family — a guess, editable afterwards. */
  defaultUsername: string;
}

/** A profile from `~/.aws/config`, as `list_aws_profiles` reports it. */
export interface AwsProfile {
  name: string;
  /** The `sso_session` it logs in through — the unit of `aws sso login`, so
   * profiles sharing one expire together. `null` for static credentials. */
  ssoSession: string | null;
  accountId: string | null;
  roleName: string | null;
  region: string | null;
}

/** SSH credentials applied to every host of one import. */
export interface AwsImportAuth {
  auth: AuthMethod;
  secret: string | null;
}

/** A managed AWS database, as `discover_aws_databases` reports it.
 * `supportedEngine` null means it cannot be imported and `unsupportedReason`
 * says why — shown rather than hidden, so the gap is actionable. */
export interface AwsDatabase {
  identifier: string;
  service: string;
  engine: string;
  engineVersion: string | null;
  address: string;
  port: number;
  username: string;
  initialDatabase: string | null;
  status: string;
  supportedEngine: SqlEngine | null;
  unsupportedReason: string | null;
  /** ElastiCache with encryption in transit — dialled as `rediss://`. */
  tls: boolean;
}

export interface AwsDatabaseSelection {
  label: string;
  engine: SqlEngine;
  address: string;
  port: number;
  username: string;
  initialDatabase: string | null;
  tls: boolean;
}

export interface AwsImportSelection {
  instanceId: string;
  label: string;
  username: string;
  groupId: GroupId | null;
  tags: string[];
}

export interface SshConfigHost {
  alias: string;
  hostname: string | null;
  user: string | null;
  port: number | null;
  identityFile: string | null;
  proxyJump: string | null;
  proxyCommand: string | null;
}

export interface ImportSelection {
  alias: string;
  hostname: string;
  user: string;
  port: number;
  groupId: GroupId | null;
  /** Carried over from the entry`s ProxyCommand so an SSM/IAP-only host stays
   * reachable after import instead of becoming a direct connection. */
  proxyCommand: string | null;
}

export interface Entry {
  name: string;
  isDir: boolean;
  isSymlink: boolean;
  size: number;
  modified?: number;
  permissions?: number | null;
}

export interface TransferProgressEvent {
  transferId: string;
  bytesDone: number;
  bytesTotal: number;
}

export type PaneSource =
  | { kind: "local" }
  | { kind: "remote"; hostId: HostId }
  /** A Docker exec host's container filesystem — no SFTP subsystem exists
   * for `docker exec`, so this drives `core::docker_pane::DockerPaneClient`
   * (shell-based listing/mkdir/rename/remove/chmod, container-archive tar
   * endpoints for read/write/upload/download) instead of a real SFTP
   * session. `containerId` picked the same way `connectDockerExec` picks
   * one — see `TransferTab.tsx`'s Docker container picker. */
  | { kind: "docker"; hostId: HostId; containerId: string }
  /** A K8s exec host's pod filesystem — same idea as `docker` above, but
   * driven by `core::k8s_pane::K8sPaneClient` (shell-based listing/mkdir/
   * rename/remove/chmod, `tar`-over-`exec` for read/write/upload/download —
   * Kubernetes has no container-archive endpoint equivalent). `podName`/
   * `containerName` picked the same way `connectK8sExec` picks them. */
  | { kind: "k8s"; hostId: HostId; podName: string; containerName: string | null };

export interface PaneOpened {
  paneId: string;
  cwd: string;
  entries: Entry[];
}

export interface PaneListed {
  cwd: string;
  entries: Entry[];
}

/** A remote file currently open in the user's own editor, via a private local
 * copy — see `termius_core::remote_edit`. Distinct from the quick-edit modal,
 * which reads and writes the file in place with no copy involved. */
/** Lifecycle action on a container. Mirrors
 * `termius_core::docker::ContainerAction` — removal is deliberately absent,
 * deleting a container isn't undoable and doesn't belong behind the same
 * one-click affordance as stopping one. */
export type DockerContainerAction = "start" | "stop" | "restart";

export interface RemoteEditListed {
  id: string;
  remotePath: string;
  name: string;
  /** Where the copy the editor has open lives, so a user whose push-back
   * failed can still recover their work by hand. */
  localPath: string;
}

/** `"unchanged"`: the editor hasn't saved since the last sync.
 * `"pushed"`: local changes reached the host. */
export type RemoteEditOutcome = "unchanged" | "pushed";

/** One edit's sync result. Reported per edit rather than aggregated: with
 * several files open, "one conflicted" has to say which one. */
export interface RemoteEditSync {
  id: string;
  name: string;
  outcome: RemoteEditOutcome | null;
  error: string | null;
}

export interface PaneState {
  source: PaneSource;
  status: "connecting" | "open" | "failed";
  paneId: string | null;
  cwd: string;
  entries: Entry[];
  error?: string;
}

export type TabMeta =
  | {
      id: string;
      kind: "terminal" | "transfer" | "rdp-view";
      hostId: HostId;
      label: string;
      status?: "connected" | "placeholder";
      dockerContainerId?: string;
      k8sPodName?: string;
      k8sContainerName?: string | null;
    }
  | { id: string; kind: "local-terminal"; label: string; initialCommand?: string; shell?: string | null; status?: "connected" | "placeholder" }
  | { id: string; kind: "fleet"; label: string; status?: "connected" | "placeholder" }
  | { id: string; kind: "sql"; label: string; sqlConnectionId: SqlConnectionId; status?: "connected" | "placeholder" };

/** A single fleet run target — an SSH host, a specific Docker exec
 * container, a specific K8s exec pod/container, or the local machine.
 * Mirrors `termius_core::fleet::FleetTarget`. RDP isn't representable here
 * (no shell) — the UI never offers it as a fleet target. */
export type FleetTarget =
  | { kind: "ssh"; hostId: HostId }
  | { kind: "docker"; hostId: HostId; containerId: string }
  | { kind: "k8s"; hostId: HostId; podName: string; containerName: string | null }
  | { kind: "local" };

/** Stable string key for a `FleetTarget`, used as the React selection/results
 * state key (Sets/Maps need a primitive, not the target object itself). */
export function fleetTargetKey(t: FleetTarget): string {
  switch (t.kind) {
    case "ssh":
      return `ssh:${t.hostId}`;
    case "docker":
      return `docker:${t.hostId}:${t.containerId}`;
    case "k8s":
      return `k8s:${t.hostId}:${t.podName}:${t.containerName ?? ""}`;
    case "local":
      return "local";
  }
}

/** One target's result in a fleet run (`run_fleet_command` → `fleet-run-outcome`).
 * Mirrors `termius_core::fleet::HostOutcome`. `exitCode === 0 && error === null`
 * is success; a non-zero `exitCode` ran but failed; `error` means it never ran
 * (unreachable, auth, unsupported kind…). */
export interface FleetOutcome {
  target: FleetTarget;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  error: string | null;
}

/** Live host state collected by `collect_facts`. Mirrors
 * `termius_core::facts::HostFacts` — every field is best-effort (`null` when it
 * couldn't be read). */
export interface HostFacts {
  hostname: string | null;
  osId: string | null;
  osName: string | null;
  kernel: string | null;
  arch: string | null;
  cpus: number | null;
  load1: number | null;
  uptimeSecs: number | null;
  memTotalMb: number | null;
  memUsedMb: number | null;
  memUsedPct: number | null;
}

/** One host's facts result: `facts` when the probe ran, else `error`. */
export interface FactsOutcome {
  hostId: HostId;
  facts: HostFacts | null;
  error: string | null;
}

/** Result of `collect_facts`: per-host outcomes (including errors, for hosts
 * the probe couldn't reach) plus the workspace, already persisted server-side
 * with successful outcomes written into each host's `lastFacts`. */
export interface CollectFactsResult {
  outcomes: FactsOutcome[];
  workspace: Workspace;
}

/** A recorded fleet run (audit trail). Mirrors `termius_core::fleet_history::FleetRun`. */
export interface FleetRun {
  id: string;
  startedAtMs: number;
  /** Literal command for a classic run; natural-language intent for an
   * adaptive run (see `perHostCommands` for what actually ran). */
  command: string;
  targets: FleetTarget[];
  outcomes: FleetOutcome[];
  /** Set only for an adaptive run — the actual command dispatched to each
   * host, grouped by platform. Absent/null for a classic run. */
  perHostCommands?: Record<HostId, string> | null;
}

/** One platform group's compiled plan — see `core::adaptive::PlatformGroup`. */
/** One group of hosts that would all run the exact same thing (or all hit
 * the exact same "nothing to do" outcome) when a DSL program is evaluated —
 * see `core::adaptive::preview`. */
export interface ExecutionGroup {
  /** `null` when nothing in the program applies/renders for this group of
   * hosts — see `note`, and exclude this group when executing. */
  command: string | null;
  hostIds: HostId[];
  note: string | null;
}

/** A single target's translated command — see `core::adaptive::ComposeResult`.
 * Used for a local terminal, Docker exec, or K8s exec target
 * (`composeAdaptiveForLocal`/`composeAdaptiveForDocker`/`composeAdaptiveForK8s`),
 * which never need `ExecutionGroup`'s per-host grouping since there's only
 * ever one target. */
export interface ComposeResult {
  command: string | null;
  note: string | null;
}

export type Tab =
  | { id: string; kind: "terminal"; hostId: HostId; label: string; sessionId: string | null; status: "connecting" | "open" | "failed"; error?: string }
  | { id: string; kind: "transfer"; hostId: HostId; label: string; left: PaneState; right: PaneState };

