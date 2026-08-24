import { assertNever } from "./exhaustive";

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
export type AuthMethod =
  | "password"
  | "agent"
  | "keyboardInteractive"
  | {
      privateKey: {
        path: string;
        keyId: KeyId | null;
        /** An OpenSSH certificate presented alongside the key, for servers that
         * trust a CA rather than listing keys. A *path*, re-read at every
         * connection: certificates from a CA live hours by design, so whatever
         * refreshes the file just works. `null` when the key authenticates on
         * its own, which is the ordinary case. */
        certPath: string | null;
      };
    };

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
  /** Empty when `secret` is set and the value is already stored: the form never
   * shows a stored secret back, so an empty value means "unchanged". */
  value: string;
  /** Keep the value in the vault instead of `workspace.json`. Optional so a
   * workspace written before this existed still parses. */
  secret?: boolean;
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

/** Miroir de `termius_core::model::PersistentShellMode`.
 *
 * `"tmux"` est du « au mieux » : un hôte sans tmux ouvre un shell ordinaire et
 * le dit, il n'échoue pas. C'est pour ça qu'il n'y a pas de troisième mode
 * « auto » — il ferait exactement la même chose. */
export type PersistentShellMode = "off" | "tmux";

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
  /** Est-ce qu'un terminal sur cet hôte tourne dans une session qui survit à
   * la connexion ? Optionnel côté TypeScript parce qu'un `workspace.json`
   * écrit avant cette fonctionnalité n'a pas le champ — même raison que les
   * autres `?` de ce struct. Absent vaut `"off"`. */
  persistentShell?: PersistentShellMode;
  /** Most recent state collected by a fleet facts-collection run (`collect_facts`)
   * — `null`/absent until at least one such run has included this host. Read-only:
   * only that path ever writes it, never the host edit form. */
  lastFacts?: HostFacts | null;
  /** Unix epoch milliseconds of `lastFacts`'s collection. */
  lastFactsAtMs?: number | null;
  /** Where this host was imported from, when it was. Recorded so a re-import
   * refreshes it instead of adding a copy — matched on `id`, which for an
   * Ansible import is the inventory name rather than the address (the address
   * is exactly what an inventory edits when a machine moves). Absent for a
   * host made by hand, and for EC2 imports, which match on their address. */
  source?: HostSource | null;
}

/** Provenance of an imported host. Not a union: an unknown `kind` read from a
 * newer or older `workspace.json` must stay readable rather than break it. */
export interface HostSource {
  kind: string;
  id: string;
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
/** How a database connection reaches its server when this machine can't dial
 * it directly. Mirrors `core::model::DbTunnel` — a discriminated union rather
 * than a set of optional fields, so "through an SSH host *and* through SSM"
 * has no spelling. Narrow on `kind`, and close the dispatch with `assertNever`
 * so a fourth mode can't be added without deciding how it renders. */
export type DbTunnel =
  | { kind: "direct" }
  /** Through an ephemeral SSH local port forward via that saved host — for a
   * database only reachable from there (bound to loopback server-side, a
   * private subnet…), not necessarily "the database runs on that host". */
  | { kind: "sshHost"; hostId: HostId }
  /** Through AWS Session Manager port forwarding. Removes the *bastion*, not
   * the relay: `target` is still an SSM-registered instance the traffic goes
   * through, but it needs no sshd, no key, and no inbound port. */
  | { kind: "ssm"; target: string; profile?: string | null; region?: string | null };

/** The tunnel an older `workspace.json` spelled as `tunnelHostId`, for the one
 * place that still has to read it. The backend migrates on load (see
 * `core::model::ServerConfigWire`), so this only appears on data that never
 * went through it. */
export const DIRECT_TUNNEL: DbTunnel = { kind: "direct" };

/** How to reach a database server that speaks a discrete
 * address/port/credentials protocol — MySQL, PostgreSQL and Redis all do.
 * Mirrors `core::model::ServerConfig`. */
export interface SqlServerConfig {
  /** How to get to `address`/`port` at all. Absent on connections saved before
   * this field existed — the backend migrates those, so an absent value here
   * means the same thing as `{ kind: "direct" }`. */
  tunnel?: DbTunnel | null;
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
       * from `tunnel` (a *tunnel to a TCP port* and an SFTP *file fetch* are
       * genuinely different things). It is also why SQLite has no `tunnel`:
       * there is no port to forward. */
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
       * (neither can be tunnelled through one TCP forward). That restriction
       * comes from forwarding a single port, so it applies to every
       * non-`direct` kind alike. */
      tunnel?: DbTunnel | null;
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

/** How this connection reaches its server, for the engines that dial a port.
 * `null` for SQLite, which has no port to forward. Mirrors
 * `EngineConfig::tunnel`. */
export function sqlConnectionTunnel(conn: SqlConnection): DbTunnel {
  return (conn.engine === "sqlite" ? null : conn.tunnel) ?? DIRECT_TUNNEL;
}

/** The saved host this connection reaches through, whichever way it does so —
 * a tunnel for the server engines and MongoDB, an SFTP file fetch for SQLite.
 * Mirrors `EngineConfig::via_host_id`, so callers that just want to show
 * "via <host>" don't each have to narrow on `engine` themselves.
 *
 * `null` for an SSM tunnel, which goes through no saved host at all — a
 * caller describing *every* way a connection is reached wants
 * `sqlConnectionTunnel` instead. */
export function sqlConnectionViaHostId(conn: SqlConnection): HostId | null {
  if (conn.engine === "sqlite") return conn.sqliteHostId ?? null;
  const tunnel = sqlConnectionTunnel(conn);
  return tunnel.kind === "sshHost" ? tunnel.hostId : null;
}

/** What the connections list shows after the address: what this connection
 * goes *through*, or `null` when it goes straight there.
 *
 * Exists because `sqlConnectionViaHostId` can only name a saved host, so an
 * SSM tunnel rendered as no tunnel at all — a connection that visibly goes
 * through AWS looking identical to a direct one. Closed on `assertNever`, so a
 * fourth tunnel kind can't be added without deciding how it reads here. */
export function sqlConnectionVia(conn: SqlConnection, hosts: Host[]): string | null {
  const hostLabel = (id: HostId) => hosts.find((h) => h.id === id)?.label ?? "hôte inconnu";
  // "sur" for SQLite: the file lives there, it isn't tunnelled through it.
  if (conn.engine === "sqlite") return conn.sqliteHostId ? `sur ${hostLabel(conn.sqliteHostId)}` : null;

  const tunnel = sqlConnectionTunnel(conn);
  switch (tunnel.kind) {
    case "direct":
      return null;
    case "sshHost":
      return `via ${hostLabel(tunnel.hostId)}`;
    case "ssm":
      return `via SSM ${tunnel.target}`;
    default:
      return assertNever(tunnel, "tunnel de connexion SQL");
  }
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

/** Outcome of trying an SSM tunnel out, from `test_ssm_tunnel`. Mirrors
 * `core::ssm_tunnel::SsmProbe`.
 *
 * Three outcomes, not two, because the middle one is a real state worth
 * separating: `opened` means AWS let us in (CLI, credentials, IAM and the SSM
 * agent all fine) but the instance can't reach the database — a wrong endpoint
 * or a security group, not a credential to go re-check. */
export type SsmProbe =
  | { kind: "reached"; localPort: number }
  | { kind: "opened"; localPort: number; detail: string }
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

/** An `[sso-session]` block from `~/.aws/config` — everything a reconnection
 * needs to replay. */
export interface AwsSsoSession {
  name: string;
  startUrl: string;
  region: string;
}

/** One account an SSO session grants access to, with its roles. */
export interface AwsSsoAccount {
  accountId: string;
  name: string;
  email: string | null;
  roles: string[];
}

/** A profile to write into `~/.aws/config` for one (account, role) pair. */
export interface AwsSsoProfileSpec {
  name: string;
  session: string;
  accountId: string;
  roleName: string;
  region: string;
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

/** Whether an SSO session can be used right now.
 *
 * A tagged union rather than a couple of booleans: the three cases have
 * genuinely different remedies (sign in, sign in again, nothing), and the
 * rendering closes on `assertNever` so a fourth one can't slip through. Mirrors
 * `SsoSessionState` in `core/src/aws_sso.rs`. */
export type AwsSsoState =
  | { kind: "neverLoggedIn" }
  /** Access token lapsed, refresh token cached: the CLI mints a new one by
   * itself. Access tokens last an hour and sessions last a day, so this is the
   * ordinary state of a working session — not a dead one. */
  | { kind: "renewable"; expiresAt: string }
  | { kind: "expired"; expiresAt: string }
  /** `expiresAt`/`secondsLeft` are null when the cache carried no readable
   * expiry — usable, just without a countdown. */
  | { kind: "valid"; expiresAt: string | null; secondsLeft: number | null };

/** An `[sso-session]` block plus its current sign-in state, as
 * `list_aws_sso_status` reports it. */
export interface AwsSsoSessionStatus {
  name: string;
  startUrl: string;
  region: string;
  state: AwsSsoState;
}

/** Why a session is worth interrupting someone for.
 *
 * Only these two: `renewable` renews itself with no browser, and
 * `neverLoggedIn` has nothing to lose — see `aws_sso::alerts` for why turning
 * either into a badge makes the badge worthless. */
export type AwsAlertSeverity =
  | { kind: "expiring"; secondsLeft: number }
  | { kind: "expired" };

/** A session that carries work and is about to stop carrying it, as
 * `list_aws_session_alerts` reports it. `hosts` is never empty. */
export interface AwsSessionAlert {
  session: string;
  severity: AwsAlertSeverity;
  /** Labels of the hosts that stop being reachable — a session name is
   * abstract, a host name is not. */
  hosts: string[];
}

/** Who a profile resolves to, from `sts get-caller-identity`. */
export interface AwsCallerIdentity {
  account: string;
  arn: string;
  userId: string;
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
  /** Ce qui est en train de passer — absent des vieux événements, présent
   * pour les copies entre panneaux et les dépôts depuis l'Explorateur. */
  label?: string | null;
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

/** Résultat d'une recherche récursive dans un panneau — miroir de
 * `termius_core::pane_ops::FindOutcome`. `truncated` dit que la limite a été
 * atteinte : la liste est réelle mais incomplète, et le panneau le montre
 * plutôt que de la présenter comme exhaustive. */
export interface PaneFindOutcome {
  paths: string[];
  truncated: boolean;
}

/** Une ligne d'un diff de contenu — miroir de
 * `termius_core::file_diff::DiffLine`. Les numéros commencent à 1 et l'un des
 * deux manque selon le côté : une ligne supprimée n'existe pas à droite. */
/** Un fichier désigné pour une comparaison de contenu : son panneau et son
 * chemin relatif au dossier affiché par ce panneau. Les deux côtés d'une
 * comparaison sont deux `DiffPick` indépendants — même nom, même panneau et
 * même dossier ne sont jamais exigés. */
export interface DiffPick {
  side: "left" | "right";
  path: string;
}

/** Un morceau de ligne : `emphasis` marque ce qui a réellement changé quand
 * la ligne existe des deux côtés sous une forme voisine. */
export interface DiffSegment {
  text: string;
  emphasis: boolean;
}

export interface DiffLine {
  kind: "equal" | "deleted" | "inserted";
  leftNo?: number | null;
  rightNo?: number | null;
  text: string;
  /** Vide pour une ligne de contexte, et pour une ligne qui a changé de bout
   * en bout : il n'y a alors rien à souligner dedans. */
  segments: DiffSegment[];
}

/** Un passage modifié avec son contexte. Les zones identiques trop longues
 * séparent deux blocs au lieu d'être affichées. */
export interface DiffHunk {
  lines: DiffLine[];
}

/** Le résultat d'une comparaison de contenu — miroir de
 * `termius_core::file_diff::FileDiff`. */
export interface FileDiff {
  hunks: DiffHunk[];
  identical: boolean;
  truncated: boolean;
  leftLines: number;
  rightLines: number;
}

/** Un fichier vu par l'inventaire d'un panneau — miroir de
 * `termius_core::pane_ops::FileFacts`. `path` est relatif à la racine
 * comparée, toujours séparé par `/`. */
export interface PaneFileFacts {
  path: string;
  size: number;
  modified: number;
}

/** Pourquoi deux arborescences diffèrent sur un fichier — miroir de
 * `termius_core::pane_sync::DifferenceKind`. `sizeDiffers` est à part : même
 * date des deux côtés mais pas la même taille, donc aucun « plus récent » à
 * proposer — souvent une copie interrompue. */
export type SyncDifferenceKind = "onlyLeft" | "onlyRight" | "newerLeft" | "newerRight" | "sizeDiffers";

export interface SyncDifference {
  path: string;
  kind: SyncDifferenceKind;
  left?: PaneFileFacts | null;
  right?: PaneFileFacts | null;
}

/** Le résultat d'une comparaison — miroir de
 * `termius_core::pane_sync::Comparison`. Ne contient que les différences :
 * les fichiers identiques sont comptés, pas listés. */
export interface PaneComparison {
  differences: SyncDifference[];
  identical: number;
  /** Un des deux inventaires a été plafonné : la comparaison ne couvre pas
   * tout, et l'interface le dit — sans quoi une synchronisation partielle
   * passerait pour terminée. */
  truncated: boolean;
}

/** Un fichier à synchroniser. La taille et la date viennent de la
 * comparaison déjà affichée ; elles ne servent qu'à graduer la barre de
 * progression et à reporter la date à l'arrivée. */
export interface SyncItem {
  path: string;
  size: number;
  modified?: number | null;
}

/** Espace du système de fichiers d'un panneau — miroir de
 * `termius_core::pane_ops::DiskSpace`. `null` quand la mesure n'aboutit pas
 * (chemin disparu, `df` absent d'un conteneur minimal) : l'interface
 * n'affiche alors rien. */
export interface PaneDiskSpace {
  totalBytes: number;
  freeBytes: number;
}

/** Ce que l'utilisateur choisit quand un nom est déjà pris à destination —
 * miroir de `commands::sftp::ConflictPolicy`. Ne concerne que les entrées
 * désignées : plus profond, un dossier recopié par-dessus un autre fusionne. */
export type ConflictPolicy = "overwrite" | "keepBoth" | "skip";

/** Une entrée dont le nom existe déjà à destination. */
export interface CopyConflict {
  name: string;
  isDir: boolean;
}

/** Format d'archive du bouton « Archiver » — miroir de
 * `termius_core::pane_ops::ArchiveFormat`. `tarGz` marche partout ; `zip`
 * dépend de la commande `zip`, souvent absente d'un serveur minimal ou d'un
 * conteneur (l'erreur le dit alors explicitement). */
export type ArchiveFormat = "tarGz" | "zip";

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

/** Une session persistante qui tourne sur un hôte. Miroir de
 * `termius_core::persistent_shell::RunningSession`. */
export interface RunningSession {
  /** Le nom tmux, qui est aussi la clé qu'un onglet garde. */
  key: string;
  /** `null` quand tmux ne l'a pas rendue — inconnu, pas 1970. */
  createdAtMs: number | null;
  windows: number;
  /** Nombre de clients attachés. `0` = personne ne la regarde, ce qui
   * distingue une session oubliée d'un onglet ouvert ailleurs. */
  attached: number;
  /** Taille de la fenêtre active, en cellules. Pas décoratif : s'attacher avec
   * un pty d'une autre taille redimensionne la session pour tout le monde,
   * même en lecture seule. `null` si tmux ne l'a pas rendue. */
  width: number | null;
  height: number | null;
}

/** Ce qu'un hôte répond quand on lui demande ses sessions.
 *
 * `tmuxAvailable` existe pour ne pas confondre « aucune session » avec « je ne
 * peux pas savoir » — même distinction que les trois verdicts de la dérive. */
export interface SessionListing {
  tmuxAvailable: boolean;
  sessions: RunningSession[];
}

/** Ce qu'est devenue la session persistante demandée à l'ouverture d'un
 * terminal. Miroir de `commands::terminal::PersistenceOutcome`. */
export type PersistenceOutcome = "off" | "unavailable" | "created" | "resumed";

/** Ce que rend `connect_terminal`. C'était un simple identifiant de session ;
 * la clé s'y est ajoutée parce que **c'est le frontend qui la retient** — elle
 * ne vaut que si elle survit au processus, et l'onglet est déjà ce qui est
 * persisté d'un lancement à l'autre. */
export interface TerminalOpened {
  sessionId: string;
  /** `null` quand ce terminal n'est pas persistant. Pas forcément la clé
   * demandée : une clé inutilisable est remplacée, pas refusée. */
  sessionKey: string | null;
  persistence: PersistenceOutcome;
  /** Ce terminal observe une session sans pouvoir y taper. */
  readOnly: boolean;
  /** La taille demandée pour le pty. En observation, c'est celle de la
   * *session* : l'onglet s'y conforme au lieu de s'ajuster à sa fenêtre. */
  cols: number;
  rows: number;
}

export type TabMeta =
  | {
      id: string;
      kind: "terminal" | "transfer" | "rdp-view";
      hostId: HostId;
      label: string;
      status?: "connected" | "placeholder";
      /** Envoyée une fois la session ouverte — un `cd` quand l'onglet a été
       * ouvert depuis un panneau de transfert (« Terminal ici »). Même
       * mécanisme que `local-terminal` plus bas. */
      initialCommand?: string;
      dockerContainerId?: string;
      k8sPodName?: string;
      k8sContainerName?: string | null;
      /** La session persistante de cet onglet (`kind: "terminal"` seulement),
       * telle que le backend l'a nommée à la première connexion. Persistée
       * avec l'onglet : c'est ce qui fait qu'un redémarrage de l'app retrouve
       * l'écran laissé, et pas seulement un onglet au bon nom. */
      sessionKey?: string;
      /** Cet onglet **observe** la session sans pouvoir y taper (`kind:
       * "terminal"` seulement). Persisté avec l'onglet : rouvrir une fenêtre
       * d'observation ne doit pas rendre la main sur la session de quelqu'un
       * d'autre. */
      readOnly?: boolean;
    }
  | { id: string; kind: "local-terminal"; label: string; initialCommand?: string; shell?: string | null; status?: "connected" | "placeholder" }
  | { id: string; kind: "fleet"; label: string; status?: "connected" | "placeholder" }
  | { id: string; kind: "activity"; label: string; status?: "connected" | "placeholder" }
  | {
      id: string;
      kind: "netdiag";
      label: string;
      /** Preselected source, when the tab was opened from a host's menu —
       * that entry has always meant "probe *from* this host". `null` (the
       * palette's way in) preselects this machine instead, which is the other
       * half of the question during an incident. */
      sourceHostId?: HostId | null;
      status?: "connected" | "placeholder";
    }
  | { id: string; kind: "sql"; label: string; sqlConnectionId: SqlConnectionId; status?: "connected" | "placeholder" };

/** Tabs bound to a saved host — the ones carrying a `hostId`.
 *
 * Written as the list of kinds that *have* a host, not as negations of the
 * ones that don't. Three call sites used to spell
 * `kind !== "local-terminal" && kind !== "fleet" && kind !== "sql"`, so every
 * new global tab meant finding all three and adding a fourth negation — miss
 * one and it reads `tab.hostId` off a tab that has none. This way a new global
 * tab needs no change here at all. */
export function isHostBoundTab(tab: TabMeta): tab is Extract<TabMeta, { hostId: HostId }> {
  return tab.kind === "terminal" || tab.kind === "transfer" || tab.kind === "rdp-view";
}

/** Which trail an activity event came from. Mirrors
 * `termius_core::activity::ActivityKind`. */
export type ActivityKind = "fleetRun" | "command" | "recording";

/** One entry in the unified activity timeline. Mirrors
 * `termius_core::activity::ActivityEvent` — a flat shape on purpose: the
 * table, the filters and the export all want the same columns. */
/** Une entrée d'historique de commandes — miroir de
 * `termius_core::command_history::CommandEntry`.
 *
 * Utilisée pour l'historique de requêtes SQL. Les deux historiques de shell
 * passent, eux, par des `string[]` : leur unique lecteur est le ghost-text, qui
 * n'a besoin ni de la date ni de la cible. */
export interface CommandEntry {
  command: string;
  /** Millisecondes epoch de la dernière exécution. `null` pour une entrée
   * migrée de l'ancien format, qui n'a réellement aucune date. */
  atMs: number | null;
  /** Libellé — de l'hôte pour l'historique SSH, de la connexion pour le SQL.
   * `null` quand la cible n'a pas de nom (terminal local, entrée migrée). */
  host: string | null;
}

export interface ActivityEvent {
  kind: ActivityKind;
  /** Unix epoch milliseconds. `null` for command entries migrated from the
   * format that predates timestamps — they genuinely have no date, and the UI
   * says "date inconnue" rather than placing them at the epoch. */
  atMs: number | null;
  summary: string;
  target: string;
  hostIds: HostId[];
  detail: string;
  /** A failed fleet run, or a recording whose file has gone. */
  failed: boolean;
}

/** What to include in the timeline. Every field optional: an omitted filter is
 * "everything", which is what the tab opens on. */
export interface ActivityFilter {
  kinds?: ActivityKind[];
  sinceMs?: number | null;
  untilMs?: number | null;
  hostId?: HostId | null;
  search?: string | null;
}

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

/** Search on a host's filesystem: by file name, or by what's inside.
 * Mirrors `termius_core::remote_search::SearchMode`. */
export type RemoteSearchMode = "name" | "content";

/** One hit. `line`/`excerpt` are only set for a content search. */
export interface RemoteSearchHit {
  path: string;
  line: number | null;
  excerpt: string | null;
}

/** A search's results, plus whether they are the whole story — a partial list
 * presented as complete would make "it isn't there" a wrong answer. */
export interface RemoteSearchOutcome {
  hits: RemoteSearchHit[];
  truncated: boolean;
  timedOut: boolean;
}

/** What a reachability probe found. Mirrors
 * `termius_core::reachability::Verdict`.
 *
 * A tagged union rather than a boolean, because the failures have four
 * different remedies — and telling `refused` (something answered "no": port
 * closed, service down) from `filtered` (nothing answered: firewall, security
 * group, missing route) is the entire reason the feature exists. */
export type ReachabilityVerdict =
  | { kind: "open"; via: string }
  | { kind: "refused"; via: string }
  | { kind: "filtered"; via: string }
  | { kind: "unknownHost"; via: string }
  | { kind: "unreachable"; via: string }
  /** Neither `bash`+`timeout`, `nc` nor `curl` on the source host. */
  | { kind: "noTool" }
  | { kind: "failed"; message: string };

/** One source's answer about one destination (`probe_reachability`). */
export interface ReachabilityOutcome {
  target: FleetTarget;
  verdict: ReachabilityVerdict;
  durationMs: number;
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
  /** The DSL program this run came from — what makes it undoable. Absent for a
   * free-command run and for anything recorded before rollback existed;
   * `perHostCommands` can't stand in for it, being rendered shell. */
  programText?: string | null;
}

/** One edit applied to several hosts at once (`bulk_edit_hosts`).
 *
 * Every field is optional and **absent means untouched** — a bulk edit is not
 * a bulk overwrite, and a write across fifty hosts is not something anyone
 * puts back by hand. `groupId` is deliberately three-valued: absent leaves the
 * group alone, `null` moves the hosts out of every group. */
export interface BulkEdit {
  username?: string;
  port?: number;
  groupId?: GroupId | null;
  auth?: AuthMethod;
  /** Added, never replacing: imports write the provider's own labels, and
   * `target tag:` in the adaptive language runs on them. */
  addTags?: string[];
  removeTags?: string[];
}

/** One network diagnostic to run (`run_netdiag`). */
export type DiagTool =
  | { kind: "tcp"; port: number }
  | { kind: "dns" }
  | { kind: "http"; secure: boolean; port: number | null; path: string }
  | { kind: "ping"; count: number }
  | { kind: "traceroute"; maxHops: number };

/** What one tool found on one target.
 *
 * Seven variants rather than a boolean and a message, because seven different
 * things to do next: a closed port is not a filtered one, a name that doesn't
 * resolve is not a network problem, and a missing tool is not a failed test. */
export type DiagVerdict =
  | { kind: "ok"; summary: string }
  | { kind: "refused"; summary: string }
  | { kind: "silent"; summary: string }
  /** The tool ran but doesn't settle the question — traceroute's normal
   * outcome, since most of the internet drops its probes. */
  | { kind: "inconclusive"; summary: string }
  | { kind: "unknownHost" }
  | { kind: "unreachable" }
  | { kind: "unavailable"; tool: string }
  | { kind: "failed"; message: string };

/** Which row of the grid an answer belongs to.
 *
 * The two directions put different things on the rows: running *from* hosts
 * makes each source a row, running *toward* hosts makes each probed host one. */
export type DiagRow =
  | { kind: "from"; target: FleetTarget }
  | { kind: "to"; hostId: HostId };

/** One cell of the diagnostic grid, streamed as it completes. */
export interface NetdiagOutcome {
  /** Echoed from the request so a slow result from a replaced run can be
   * dropped instead of landing in the new grid. */
  runId: string;
  row: DiagRow;
  tool: DiagTool;
  verdict: DiagVerdict;
  durationMs: number;
  /** What the tool printed, so a cell can be unfolded. Traceroute is why. */
  raw: string;
}

/** One host as an Ansible inventory describes it. */
export interface InventoryHost {
  /** The inventory name — the identity a re-import matches on. Not necessarily
   * reachable: `ansible_host` overrides it. */
  name: string;
  address: string;
  username: string | null;
  port: number | null;
  /** Every group it belongs to, parents included. Imported as tags, so
   * `target tag: webservers` reaches them straight away. */
  groups: string[];
}

/** An entry the parser deliberately didn't import, with the reason — listed
 * rather than dropped, so a half-imported file doesn't look complete. */
export interface SkippedInventoryEntry {
  entry: string;
  reason: string;
}

export interface Inventory {
  hosts: InventoryHost[];
  skipped: SkippedInventoryEntry[];
}

/** One host ticked in the import panel. */
export interface InventorySelection {
  name: string;
  label: string;
  address: string;
  username: string;
  port: number;
  groupId: GroupId | null;
  tags: string[];
}

/** One Azure VM or GCP instance, as an import panel shows it
 * (`discover_azure_vms`, `discover_gcp_instances`). One shape for both: the
 * panels render the same table, and a type per provider would push the
 * difference into rendering code where `assertNever` couldn't help. */
export interface CloudInstance {
  /** The provider's resource id — the identity a re-import matches on: the
   * full ARM id on Azure, the numeric instance id on GCP. Never the name or
   * the address, both of which change under a machine. */
  id: string;
  name: string;
  privateIp: string | null;
  publicIp: string | null;
  /** Region (Azure) or zone (GCP). */
  location: string;
  /** Resource group (Azure) or zone (GCP) — whatever situates the machine. */
  scope: string;
  /** The provider's own wording: `VM running`, `TERMINATED`… */
  state: string;
  /** Whether that state means it's up. Typed by the backend rather than
   * matched on strings here. */
  running: boolean;
  osType: string | null;
  /** The login the provider records, when it records one (Azure only). */
  username: string | null;
  tags: [string, string][];
}

/** What a provider listing says about the hosts already imported from it
 * (`diff_azure_inventory`, `diff_gcp_inventory`). */
export interface InventoryDiff {
  /** `[hostId, label]` for hosts of this scope whose instance is gone. */
  gone: [HostId, string][];
  /** Instance ids in the listing that no host carries yet. */
  notImported: string[];
  /** Hosts of this provider whose scope is unknown or different — counted,
   * never judged: "not in this listing" says nothing about whether they still
   * exist, and calling them gone would invite deleting live machines. */
  unattributed: number;
}

/** A scope picked before listing: an Azure subscription or a GCP project. */
export interface CloudScope {
  id: string;
  name: string;
  isDefault: boolean;
}

/** One cloud instance ticked in an import panel. */
export interface CloudSelection {
  id: string;
  label: string;
  address: string;
  username: string;
  port: number;
  groupId: GroupId | null;
  tags: string[];
}

/** Why a provider CLI call failed. Typed rather than a string so the panel can
 * offer the matching remedy — notably telling "nobody is logged in" (one
 * command away) apart from "you aren't allowed" (not fixable from here). */
export type CloudCliError =
  | { kind: "cliMissing"; program: string; installHint: string }
  | { kind: "notLoggedIn"; program: string; message: string; loginHint: string }
  | { kind: "refused"; message: string }
  | { kind: "unreadable"; message: string };

/** What a rejected cloud command carries: the typed reason plus text to show. */
export interface CloudFailure {
  reason: CloudCliError;
  message: string;
}

/** What one drift check found. Three cases, never two: "we couldn't look" is
 * not "it's fine", and folding the two together would report a fleet as
 * compliant because nobody could actually check. */
export type DriftVerdict =
  | { kind: "matches" }
  | { kind: "drifted" }
  | { kind: "unknown"; reason: string };

/** One line of the wanted state, and the host's answer to it. */
export interface DriftCheck {
  /** The DSL line as written (`install-package nginx`) — what the user
   * recognises, not the shell it became. */
  operation: string;
  verdict: DriftVerdict;
}

/** One host's answer to the whole described state. */
export interface HostDrift {
  hostId: HostId;
  checks: DriftCheck[];
  /** Set when the host couldn't be reached or the probe failed outright. */
  error?: string | null;
}

/** One operation a rollback will not put back, and why. */
export interface UnreversedOperation {
  /** The DSL function name, as it was written. */
  function: string;
  reason: string;
}

/** What undoing a past run would do, before anything is undone. */
export interface RollbackPlan {
  /** The inverse program in DSL form — operations, not shell, because that is
   * what tells someone at a glance whether "annuler" means what they think. */
  programText: string;
  groups: ExecutionGroup[];
  /** Never hidden: a partial rollback shown as a complete one is worse than
   * no rollback at all. */
  unreversed: UnreversedOperation[];
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

