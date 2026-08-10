import { Channel, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { ActivityEvent, ActivityFilter, AuthMethod, DiagTool, NetdiagOutcome, AwsCallerIdentity, AwsDatabase, AwsDatabaseSelection, AwsImportAuth, AwsImportSelection, AwsInstance, AwsProfile, AwsSessionAlert, AwsSsoAccount, AwsSsoProfileSpec, AwsSsoSession, AwsSsoSessionStatus, CloudInstance, CloudScope, CloudSelection, CollectionInfo, ColumnInfo, CollectFactsResult, ComposeResult, DbTunnel, DockerContainer, DockerContainerAction, EnvVar, Entry, ExecutionGroup, FleetOutcome, FleetRun, FleetTarget, GroupId, HostDrift, HostId, HostKind, ImportSelection, Inventory, InventorySelection, K8sPod, KeyAlgorithm, KeyId, KnownHostEntry, MongoQueryResult, PaneListed, PaneOpened, PaneSource, PortForwardId, PortForwardKind, ProxyProbe, QueryResult, RdpClientMessage, RdpFrame, ReachabilityOutcome, RedisKeyDetail, RemoteSearchMode, RemoteSearchOutcome, RedisReply, RemoteEditListed, RemoteEditOutcome, RemoteEditSync, RollbackPlan, ScanPage, SnippetId, SqlConnectionId, SqlEngineConfig, SqlExportDestination, SqlExportGroup, SshAuthPrompt, SshConfigHost, SsmProbe, TableInfo, TransferProgressEvent, VaultStatus, Workspace } from "./types";

/** Mirrors the 12-byte little-endian header `commands::rdp_view::connect_rdp_view`
 * writes ahead of each frame's raw RGBA8 pixels (see its doc comment for why
 * this bypasses JSON/base64). `pixels` is a view into `buffer`, not a copy. */
function parseRdpFrame(buffer: ArrayBuffer): RdpFrame {
  const view = new DataView(buffer);
  return {
    canvasWidth: view.getUint16(0, true),
    canvasHeight: view.getUint16(2, true),
    x: view.getUint16(4, true),
    y: view.getUint16(6, true),
    width: view.getUint16(8, true),
    height: view.getUint16(10, true),
    pixels: new Uint8Array(buffer, 12),
  };
}

/** Header name the Rust side reads the session id from — must match
 * `commands::terminal::SESSION_ID_HEADER`. */
const SESSION_ID_HEADER = "x-session-id";

/** Sends `bytes` as the raw request body rather than a JSON argument.
 *
 * Terminal writes are the most frequent call in the app — one per keystroke,
 * and one per chunk when pasting. Passing them as a base64 string meant
 * building that string a character at a time in JS, serialising it as JSON,
 * and decoding it back to bytes in Rust: three conversions and ~33% more
 * bytes, for data that is already a `Uint8Array`. Terminal *output* has
 * always avoided this by using a `Channel`; this is the same idea for input.
 *
 * The body being the payload, there is no JSON object left to carry the
 * session id — hence the header. */
function writeBytes(command: string, sessionId: string, bytes: Uint8Array): Promise<void> {
  return invoke<void>(command, bytes, { headers: { [SESSION_ID_HEADER]: sessionId } });
}

export const api = {
  getWorkspace: () => invoke<Workspace>("get_workspace"),

  saveHost: (input: {
    id: HostId | null;
    label: string;
    kind: HostKind;
    address: string;
    port: number;
    username: string;
    auth: AuthMethod;
    dockerViaHostId: HostId | null;
    jumpVia: HostId[];
    proxyCommand: string | null;
    groupId: GroupId | null;
    tags: string[];
    startupSnippets: SnippetId[];
    envVars: EnvVar[];
    icon: string | null;
    secret: string | null;
    keepaliveIntervalSecs: number | null;
    agentForward: boolean;
  }) => invoke<Workspace>("save_host", { input }),

  deleteHost: (hostId: HostId) => invoke<Workspace>("delete_host", { hostId }),
  testProxyCommand: (command: string, address: string, port: number, username: string) =>
    invoke<ProxyProbe>("test_proxy_command", { command, address, port, username }),

  /** Opens an SSM tunnel to `address`/`port` through `target`, tries one
   * connection through it, and tears it down. Sends no credential to the
   * database — a bare TCP connect, so it can be run against production
   * without showing up as a failed login. */
  testSsmTunnel: (
    target: string,
    profile: string | null,
    region: string | null,
    address: string,
    port: number,
  ) => invoke<SsmProbe>("test_ssm_tunnel", { target, profile, region, address, port }),

  /** The `<clé>-cert.pub` next to a private key, when that file exists — what
   * the host form offers as a prefill. `null` rather than a guess otherwise. */
  suggestCertificatePath: (keyPath: string) =>
    invoke<string | null>("suggest_certificate_path", { keyPath }),

  listAwsProfiles: () => invoke<AwsProfile[]>("list_aws_profiles"),
  listAwsSsoSessions: () => invoke<AwsSsoSession[]>("list_aws_sso_sessions"),
  /** Account id → name, for profile labels. Best effort: a session whose
   * token has expired contributes nothing rather than failing. */
  listAwsAccountNames: () => invoke<Record<string, string>>("list_aws_account_names"),
  saveAwsSsoSession: (name: string, startUrl: string, region: string) =>
    invoke<void>("save_aws_sso_session", { name, startUrl, region }),
  /** Long-lived on purpose: resolves only once the browser authentication has
   * completed. Progress arrives meanwhile through `onAwsSsoOutput`. */
  awsSsoLogin: (session: string) => invoke<void>("aws_sso_login", { session }),
  listAwsSsoAccounts: (startUrl: string, region: string, session: string) =>
    invoke<AwsSsoAccount[]>("list_aws_sso_accounts", { startUrl, region, session }),
  saveAwsSsoProfiles: (profiles: AwsSsoProfileSpec[]) =>
    invoke<void>("save_aws_sso_profiles", { profiles }),
  /** Sessions with their sign-in state. Local files only — instant, and still
   * answers when the machine is offline. */
  listAwsSsoStatus: () => invoke<AwsSsoSessionStatus[]>("list_aws_sso_status"),
  /** The sessions about to lapse that hosts actually depend on. Polled while
   * the app runs, so it reads local files only — never the `aws` CLI. */
  listAwsSessionAlerts: () => invoke<AwsSessionAlert[]>("list_aws_session_alerts"),
  /** Resolves a profile to the identity AWS grants it right now — the cheapest
   * "does this still work" there is. */
  checkAwsIdentity: (profile: string) => invoke<AwsCallerIdentity>("check_aws_identity", { profile }),
  /** Removes the profile from `~/.aws/config` and `~/.aws/credentials`. */
  deleteAwsProfile: (name: string) => invoke<void>("delete_aws_profile", { name }),
  /** Removes the `[sso-session]` block. Profiles pointing at it are left as
   * they are — the panel warns how many that is. */
  deleteAwsSsoSession: (name: string) => invoke<void>("delete_aws_sso_session", { name }),
  discoverAwsInstances: (profile: string, region: string) =>
    invoke<AwsInstance[]>("discover_aws_instances", { profile, region }),
  /** Instances already imported are refreshed rather than duplicated — matched
   * on the instance id, which is the host's address. */
  importAwsInstances: (selections: AwsImportSelection[], profile: string, region: string, credentials: AwsImportAuth) =>
    invoke<Workspace>("import_aws_instances", { selections, profile, region, credentials }),
  /** Profile name → labels of the hosts whose proxy command pins it. The
   * profile lives inside that command, so nothing else can answer it. */
  listAwsProfileUsage: () => invoke<Record<string, string[]>>("list_aws_profile_usage"),
  /** Points every host pinning `from` at `to`, leaving the rest of each
   * command byte for byte. */
  reassignAwsProfile: (from: string, to: string) =>
    invoke<Workspace>("reassign_aws_profile", { from, to }),
  discoverAwsDatabases: (profile: string, region: string) =>
    invoke<AwsDatabase[]>("discover_aws_databases", { profile, region }),
  /** `tunnel` applies to every selection: a managed database normally sits in
   * a private subnet with no route from this machine. */
  importAwsDatabases: (selections: AwsDatabaseSelection[], tunnel: DbTunnel, password: string | null) =>
    invoke<Workspace>("import_aws_databases", { selections, tunnel, password }),
  checkHostStatus: (hostId: HostId) => invoke<boolean>("check_host_status", { hostId }),

  saveGroup: (input: { id: GroupId | null; name: string; parentId: GroupId | null; icon: string | null; color: string | null }) => invoke<Workspace>("save_group", { input }),
  deleteGroup: (groupId: GroupId) => invoke<Workspace>("delete_group", { groupId }),

  addSnippet: (name: string, command: string) => invoke<Workspace>("add_snippet", { name, command }),
  updateSnippet: (snippetId: SnippetId, name: string, command: string) => invoke<Workspace>("update_snippet", { snippetId, name, command }),
  deleteSnippet: (snippetId: SnippetId) => invoke<Workspace>("delete_snippet", { snippetId }),

  addForward: (input: { hostId: HostId; kind: PortForwardKind; bindAddress: string; bindPort: number; destAddress: string; destPort: number }) =>
    invoke<Workspace>("add_forward", { input }),
  deleteForward: (forwardId: PortForwardId) => invoke<Workspace>("delete_forward", { forwardId }),

  /** `input` carries the engine tag plus that engine's own settings,
   * flattened — the same shape `SqlConnection` itself has (see
   * `SqlEngineConfig`), which is exactly what `save_sql_connection`
   * deserialises on the Rust side. */
  saveSqlConnection: (input: {
    id: SqlConnectionId | null;
    label: string;
    groupId: GroupId | null;
    tags: string[];
    secret: string | null;
  } & SqlEngineConfig) => invoke<Workspace>("save_sql_connection", { input }),
  deleteSqlConnection: (connectionId: SqlConnectionId) => invoke<Workspace>("delete_sql_connection", { connectionId }),
  /** Opens a pool (directly, or through an ephemeral SSH tunnel invisible to
   * the Tunnels panel — see `core::sql::connect`) and returns an opaque
   * session id to pass to every `listSql*`/`runSqlQuery` call below, until
   * `closeSqlSession`. `database`: `null` only for a PostgreSQL connection
   * with no database configured — call `listSqlDatabases`/`switchSqlDatabase`
   * first in that case rather than `listSqlSchemas` directly (PostgreSQL has
   * no server-wide schema list the way MySQL does — see `core::sql`'s module
   * doc comment). */
  openSqlSession: (connectionId: SqlConnectionId) => invoke<{ sessionId: string; database: string | null }>("open_sql_session", { connectionId }),
  closeSqlSession: (sessionId: string) => invoke<void>("close_sql_session", { sessionId }),
  /** Backing action for the tree's "actualiser" button — a no-op for every
   * case but a SQLite connection backed by a remote host's file (see
   * `core::sql::SqlSession::resync`'s doc comment): pushes local changes
   * back if the origin file hasn't changed independently in the meantime,
   * or pulls in the origin's new content otherwise. Call this first, then
   * re-run whichever `listSql*` calls match what's currently visible in the
   * tree — safe/cheap to call unconditionally regardless of engine. */
  resyncSqlSession: (sessionId: string) => invoke<void>("resync_sql_session", { sessionId }),
  /** PostgreSQL only, and only when `openSqlSession` returned `database:
   * null` — the real list of databases on the server, via a bootstrap
   * connection to the `postgres` maintenance database. */
  listSqlDatabases: (sessionId: string) => invoke<string[]>("list_sql_databases", { sessionId }),
  /** Reconnects the session in place to `database` (PostgreSQL can't switch
   * database on an open connection) — same `sessionId` afterward, now scoped
   * to it; call `listSqlSchemas` next. */
  switchSqlDatabase: (sessionId: string, database: string) => invoke<void>("switch_sql_database", { sessionId, database }),
  /** One database (MySQL) or schema (PostgreSQL) per entry — see
   * `TableInfo`'s doc comment for why the two share this one call. */
  listSqlSchemas: (sessionId: string) => invoke<string[]>("list_sql_schemas", { sessionId }),
  listSqlTables: (sessionId: string, schema: string) => invoke<TableInfo[]>("list_sql_tables", { sessionId, schema }),
  listSqlColumns: (sessionId: string, schema: string, table: string) => invoke<ColumnInfo[]>("list_sql_columns", { sessionId, schema, table }),
  /** `schema`: the tree's current selection, if any — applied as query
   * context (`SET search_path`/`USE`) so an unqualified table name in `sql`
   * resolves there instead of needing `schema.table`. See
   * `core::sql::execute_query`'s doc comment. */
  runSqlQuery: (sessionId: string, sql: string, schema?: string | null) => invoke<QueryResult>("run_sql_query", { sessionId, sql, schema: schema ?? null }),
  /** The "Exporter" tab's backing action — dumps `DROP TABLE IF EXISTS` +
   * `CREATE TABLE` + `INSERT` statements for every table in every group of
   * `groups` (each spanning one schema/database — a single export can cover
   * several) to `destination`, either a local file or a path on a saved SSH
   * host (uploaded over SFTP). See `core::sql::dump_tables`'s doc comment. */
  exportSqlDump: (sessionId: string, groups: SqlExportGroup[], destination: SqlExportDestination) =>
    invoke<void>("export_sql_dump", { sessionId, groups, destination }),

  /** Opens a connection (directly, or through an ephemeral SSH tunnel — see
   * `core::redis_client::connect`) and returns an opaque session id to pass
   * to every `scanRedisKeys`/`getRedisValue`/`runRedisCommand` call below,
   * until `closeRedisSession`. */
  openRedisSession: (connectionId: SqlConnectionId) => invoke<{ sessionId: string; database: number }>("open_redis_session", { connectionId }),
  closeRedisSession: (sessionId: string) => invoke<void>("close_redis_session", { sessionId }),
  /** `cursor`: `0` to start a fresh scan (also what "Rafraîchir" passes);
   * otherwise the previous call's returned cursor, for "charger plus".
   * `pattern`: a plain substring search unless it already contains a glob
   * metacharacter — see `core::redis_client::scan_keys`'s doc comment. */
  scanRedisKeys: (sessionId: string, cursor: number, pattern?: string | null) =>
    invoke<ScanPage>("scan_redis_keys", { sessionId, cursor, pattern: pattern ?? null }),
  getRedisValue: (sessionId: string, key: string) => invoke<RedisKeyDetail | null>("get_redis_value", { sessionId, key }),
  /** The Console tab's backing action — no command blocklist, see
   * `core::redis_client::run_command`'s doc comment. */
  runRedisCommand: (sessionId: string, command: string) => invoke<RedisReply>("run_redis_command", { sessionId, command }),

  /** Opens a connection (directly, or through an ephemeral SSH tunnel — see
   * `core::mongo_client::connect`) and returns an opaque session id to pass
   * to every `listMongoDatabases`/`listMongoCollections`/`findMongoDocuments`
   * call below, until `closeMongoSession`. */
  openMongoSession: (connectionId: SqlConnectionId) => invoke<string>("open_mongo_session", { connectionId }),
  closeMongoSession: (sessionId: string) => invoke<void>("close_mongo_session", { sessionId }),
  listMongoDatabases: (sessionId: string) => invoke<string[]>("list_mongo_databases", { sessionId }),
  listMongoCollections: (sessionId: string, database: string) => invoke<CollectionInfo[]>("list_mongo_collections", { sessionId, database }),
  /** `filter`: a JSON filter typed into the "Requête" tab, or omitted for
   * the "Données" tab's unfiltered listing — see
   * `core::mongo_client::find_documents`'s doc comment. */
  findMongoDocuments: (sessionId: string, database: string, collection: string, filter?: string | null) =>
    invoke<MongoQueryResult>("find_mongo_documents", { sessionId, database, collection, filter: filter ?? null }),

  addPrivateKey: (name: string, path: string, passphrase: string | null) => invoke<Workspace>("add_private_key", { name, path, passphrase }),
  deletePrivateKey: (keyId: KeyId) => invoke<Workspace>("delete_private_key", { keyId }),
  renamePrivateKey: (keyId: KeyId, name: string) => invoke<Workspace>("rename_private_key", { keyId, name }),
  generatePrivateKey: (name: string, algorithm: KeyAlgorithm, passphrase: string | null) =>
    invoke<Workspace>("generate_private_key", { name, algorithm, passphrase }),
  getPublicKey: (keyId: KeyId) => invoke<string>("get_public_key", { keyId }),
  deployPublicKey: (hostId: HostId, keyId: KeyId) => invoke<void>("deploy_public_key", { hostId, keyId }),
  addCustomIcon: (name: string, dataUrl: string) => invoke<Workspace>("add_custom_icon", { name, dataUrl }),
  deleteCustomIcon: (iconId: string) => invoke<Workspace>("delete_custom_icon", { iconId }),
  readIconFile: (path: string) => invoke<string>("read_icon_file", { path }),

  exportWorkspace: (path: string, includeKeyMaterial: boolean) => invoke<void>("export_workspace", { path, includeKeyMaterial }),
  /** `keepAutomation`: false (the default a caller should offer) strips
   * `startupSnippets`/`envVars` from every imported host server-side — both
   * run automatically on first connect with no review step, so an untrusted
   * file could otherwise smuggle in commands that just run. See
   * `commands::export::strip_automation`'s doc comment. */
  importWorkspace: (path: string, replace: boolean, keepAutomation: boolean) =>
    invoke<Workspace>("import_workspace", { path, replace, keepAutomation }),
  exportHost: (hostId: HostId, path: string, includeKeyMaterial: boolean) => invoke<void>("export_host", { hostId, path, includeKeyMaterial }),
  /** See `importWorkspace`'s `keepAutomation` doc — same reasoning, single-host import. */
  importHostFromFile: (path: string, keepAutomation: boolean) => invoke<Workspace>("import_host_from_file", { path, keepAutomation }),
  exportText: (path: string, content: string) => invoke<void>("export_text", { path, content }),
  /** Absolute path of the app's diagnostic log directory — shown in
   * Paramètres so a user reporting a problem can retrieve the logs. */
  diagnosticsDirectory: () => invoke<string>("diagnostics_directory"),

  /** Answers a pending `ssh-auth-prompt` (MFA/OTP). `answers` must line up
   * with the round's `prompts`, in order. The values are one-time
   * credentials: they go straight into the handshake, never to disk. */
  submitSshAuthPrompt: (id: string, answers: string[]) => invoke<void>("submit_ssh_auth_prompt", { id, answers }),
  /** Abandons a pending prompt — fails that authentication now rather than
   * leaving the handshake waiting out its timeout. */
  cancelSshAuthPrompt: (id: string) => invoke<void>("cancel_ssh_auth_prompt", { id }),
  startForward: (forwardId: PortForwardId) => invoke<void>("start_forward", { forwardId }),
  stopForward: (forwardId: PortForwardId) => invoke<void>("stop_forward", { forwardId }),
  runningForwards: () => invoke<PortForwardId[]>("running_forwards"),

  // Master-password vault (opt-in encrypted secret store).
  masterPasswordStatus: () => invoke<VaultStatus>("master_password_status"),
  setMasterPassword: (password: string) => invoke<void>("set_master_password", { password }),
  unlockVault: (password: string) => invoke<void>("unlock_vault", { password }),
  lockVault: () => invoke<void>("lock_vault"),
  changeMasterPassword: (current: string, next: string) => invoke<void>("change_master_password", { current, new: next }),
  disableMasterPassword: (current: string) => invoke<void>("disable_master_password", { current }),

  listKnownHosts: () => invoke<KnownHostEntry[]>("list_known_hosts"),
  revokeKnownHost: (identity: string) => invoke<void>("revoke_known_host", { identity }),
  previewSshConfigImport: (path: string | null) => invoke<SshConfigHost[]>("preview_ssh_config_import", { path }),
  importSshConfigHosts: (selections: ImportSelection[]) => invoke<Workspace>("import_ssh_config_hosts", { selections }),

  /** `onData`: called with each raw output chunk over a dedicated
   * `tauri::ipc::Channel` created just for this session — same reasoning as
   * `connectRdpView`'s frame channel: terminal output is the single most
   * frequent event in the app, so it skips JSON-stringify + base64 on the
   * way out (and back on this side) rather than going through a global
   * `terminal-data` event filtered by session id. */
  connectTerminal: (hostId: HostId, onData: (chunk: Uint8Array) => void) => {
    const channel = new Channel<ArrayBuffer>();
    channel.onmessage = (buffer) => onData(new Uint8Array(buffer));
    return invoke<string>("connect_terminal", { hostId, channel });
  },
  listDockerContainers: (hostId: HostId) => invoke<DockerContainer[]>("list_docker_containers", { hostId }),
  /** Tail of a container's log, stdout and stderr interleaved. Bounded, not
   * followed — see `termius_core::docker::container_logs`. */
  dockerContainerLogs: (hostId: HostId, containerId: string, tail: number) =>
    invoke<string>("docker_container_logs", { hostId, containerId, tail }),
  /** Starts/stops/restarts a container and resolves to the refreshed list —
   * the caller's next move is always to re-render it. */
  dockerContainerAction: (hostId: HostId, containerId: string, action: DockerContainerAction) =>
    invoke<DockerContainer[]>("docker_container_action", { hostId, containerId, action }),
  connectDockerExec: (hostId: HostId, containerId: string, onData: (chunk: Uint8Array) => void) => {
    const channel = new Channel<ArrayBuffer>();
    channel.onmessage = (buffer) => onData(new Uint8Array(buffer));
    return invoke<string>("connect_docker_exec", { hostId, containerId, channel });
  },
  listK8sPods: (hostId: HostId) => invoke<K8sPod[]>("list_k8s_pods", { hostId }),
  /** `kubectl logs` equivalent — `containerName` picks one container in a
   * multi-container pod, `null` lets the API server choose. */
  k8sPodLogs: (hostId: HostId, podName: string, containerName: string | null, tail: number) =>
    invoke<string>("k8s_pod_logs", { hostId, podName, containerName, tail }),
  connectK8sExec: (hostId: HostId, podName: string, containerName: string | null, onData: (chunk: Uint8Array) => void) => {
    const channel = new Channel<ArrayBuffer>();
    channel.onmessage = (buffer) => onData(new Uint8Array(buffer));
    return invoke<string>("connect_k8s_exec", { hostId, podName, containerName, channel });
  },
  connectRdpView: (hostId: HostId, width: number, height: number, onFrame: (frame: RdpFrame) => void) => {
    const channel = new Channel<ArrayBuffer>();
    channel.onmessage = (buffer) => onFrame(parseRdpFrame(buffer));
    return invoke<string>("connect_rdp_view", { hostId, width, height, channel });
  },
  sendRdpViewInput: (sessionId: string, message: RdpClientMessage) => invoke<void>("send_rdp_view_input", { sessionId, message }),
  closeRdpView: (sessionId: string) => invoke<void>("close_rdp_view", { sessionId }),
  /** Pushes `entries` (files and/or whole folders, from any pane kind —
   * remote ones are downloaded to a temp file first) onto an embedded RDP
   * session's clipboard — the sidecar simulates a Ctrl+V right after (see
   * `paste_key_sequence` in `rdp-sidecar/src/main.rs`), so this pastes
   * automatically rather than requiring the user to press Ctrl+V. See
   * `RdpTab.tsx`'s drop handling in `TransferTab.tsx`. */
  pushRdpViewClipboardEntries: (sessionId: string, sourcePaneId: string, sourceCwd: string, entries: Entry[]) =>
    invoke<void>("push_rdp_view_clipboard_entries", { sessionId, sourcePaneId, sourceCwd, entries }),
  /** Same as `pushRdpViewClipboardEntries`, but for paths dropped straight
   * from the OS (Explorer → the embedded RDP view) rather than entries
   * picked from one of this app's own transfer panes — see
   * `TransferTab.tsx`'s `onDragDropEvent` handler. */
  pushRdpViewClipboardPaths: (sessionId: string, paths: string[]) =>
    invoke<void>("push_rdp_view_clipboard_paths", { sessionId, paths }),
  /** Sends keystrokes as the request body itself, not as a base64 string in a
   * JSON argument — see `writeBytes`. */
  writeTerminal: (sessionId: string, data: Uint8Array) => writeBytes("write_terminal", sessionId, data),
  /** Starts writing this session's output to `path` as an asciicast file.
   * Distinct from `exportText` of the scrollback: that snapshots what xterm
   * still holds, this records every byte as it arrives, with timing, and
   * survives both scrollback overflow and a crash. Only output is recorded,
   * never keystrokes — see `termius_core::session_record`. */
  /** `host` is the label being recorded, `null` for the local terminal — kept
   * only so the recording is findable again in the activity journal. */
  startSessionRecording: (sessionId: string, path: string, cols: number, rows: number, host: string | null) =>
    invoke<void>("start_session_recording", { sessionId, path, cols, rows, host }),
  stopSessionRecording: (sessionId: string) => invoke<void>("stop_session_recording", { sessionId }),
  recordingSessionIds: () => invoke<string[]>("recording_session_ids"),
  resizeTerminal: (sessionId: string, cols: number, rows: number) => invoke<void>("resize_terminal", { sessionId, cols, rows }),
  closeTerminal: (sessionId: string) => invoke<void>("close_terminal", { sessionId }),

  openLocalTerminal: (shell: string | null, onData: (chunk: Uint8Array) => void) => {
    const channel = new Channel<ArrayBuffer>();
    channel.onmessage = (buffer) => onData(new Uint8Array(buffer));
    return invoke<string>("open_local_terminal", { shell, channel });
  },
  listLocalShells: () => invoke<{ id: string; label: string }[]>("list_local_shells"),
  writeLocalTerminal: (sessionId: string, data: Uint8Array) => writeBytes("write_local_terminal", sessionId, data),
  resizeLocalTerminal: (sessionId: string, cols: number, rows: number) => invoke<void>("resize_local_terminal", { sessionId, cols, rows }),
  closeLocalTerminal: (sessionId: string) => invoke<void>("close_local_terminal", { sessionId }),

  getLocalHistory: () => invoke<string[]>("get_local_history"),
  appendLocalHistory: (command: string) => invoke<void>("append_local_history", { command }),
  getSshHistory: () => invoke<string[]>("get_ssh_history"),
  /** `host` is the label the command ran on, recorded for the activity
   * journal. Ghost-text never sees it — `getSshHistory` still returns plain
   * strings, which is what kept the suggestion engine untouched. */
  appendSshHistory: (command: string, host: string | null = null) =>
    invoke<void>("append_ssh_history", { command, host }),

  /** The merged activity timeline, most recent first. An omitted filter means
   * everything. */
  listActivity: (filter?: ActivityFilter) => invoke<ActivityEvent[]>("list_activity", { filter }),
  /** Writes the *filtered* timeline to `path`. Returns how many events were
   * written. */
  exportActivity: (path: string, format: "csv" | "json", filter?: ActivityFilter) =>
    invoke<number>("export_activity", { path, format, filter }),

  openPane: (source: PaneSource) => invoke<PaneOpened>("open_pane", { source }),
  closePane: (paneId: string) => invoke<void>("close_pane", { paneId }),
  listPane: (paneId: string, path: string) => invoke<PaneListed>("list_pane", { paneId, path }),
  copyEntry: (sourcePaneId: string, sourceCwd: string, entry: Entry, destPaneId: string, destCwd: string) =>
    invoke<PaneListed>("copy_entry", { sourcePaneId, sourceCwd, entry, destPaneId, destCwd }),
  paneMkdir: (paneId: string, cwd: string, name: string) => invoke<PaneListed>("pane_mkdir", { paneId, cwd, name }),
  paneRename: (paneId: string, cwd: string, oldName: string, newName: string) => invoke<PaneListed>("pane_rename", { paneId, cwd, oldName, newName }),
  paneRemove: (paneId: string, cwd: string, entries: Entry[]) => invoke<PaneListed>("pane_remove", { paneId, cwd, entries }),
  paneChmod: (paneId: string, cwd: string, name: string, mode: number) => invoke<PaneListed>("pane_chmod", { paneId, cwd, name, mode }),
  readPaneFile: (paneId: string, cwd: string, name: string) => invoke<string>("read_pane_file", { paneId, cwd, name }),
  writePaneFile: (paneId: string, cwd: string, name: string, content: string) => invoke<void>("write_pane_file", { paneId, cwd, name, content }),
  /** Fetches a remote file into a private temp copy and hands that copy to
   * whatever the OS opens it with. Resolves to `null` for a *local* pane,
   * where the real file is opened directly and there is nothing to track.
   * See `termius_core::remote_edit` for why the push-back is not automatic. */
  openRemoteFileInEditor: (paneId: string, cwd: string, name: string) =>
    invoke<RemoteEditListed | null>("open_remote_file_in_editor", { paneId, cwd, name }),
  listRemoteEdits: () => invoke<RemoteEditListed[]>("list_remote_edits"),
  /** Pushes back every edit whose local copy changed — called when the app
   * regains focus, and from the explicit "Tout renvoyer" action. */
  syncRemoteEdits: () => invoke<RemoteEditSync[]>("sync_remote_edits"),
  /** Final sync, then forget the edit. Rejects — and keeps the edit — when
   * the push-back fails, so nothing typed is lost to a conflict. */
  endRemoteEdit: (id: string) => invoke<RemoteEditOutcome>("end_remote_edit", { id }),
  /** Drops an edit and its temp copy without pushing back: the only way to
   * abandon local changes. */
  discardRemoteEdit: (id: string) => invoke<void>("discard_remote_edit", { id }),
  uploadPaths: (paneId: string, cwd: string, localPaths: string[]) => invoke<string[]>("upload_paths", { paneId, cwd, localPaths }),
  cancelTransfer: (transferId: string) => invoke<void>("cancel_transfer", { transferId }),

  /** Runs `command` on every target in `targets` (an SSH host, a Docker exec
   * container, or the local machine — see `FleetTarget`) off any PTY.
   * Resolves once every target has reported; per-target results stream in
   * via `onFleetOutcome`, followed by `onFleetDone`. `runId` (mint with
   * `crypto.randomUUID()`) tells concurrent runs apart on the shared events. */
  runFleetCommand: (runId: string, targets: FleetTarget[], command: string) =>
    invoke<void>("run_fleet_command", { runId, targets, command }),

  /** Asks every target whether it reaches `host:port`. Batch, not streamed:
   * the probe is bounded on each target and they run concurrently, so the
   * whole answer takes about as long as the slowest one. */
  probeReachability: (targets: FleetTarget[], host: string, port: number) =>
    invoke<ReachabilityOutcome[]>("probe_reachability", { targets, host, port }),

  /** `find`/`grep -rn` on a host, bounded in depth, results and time — the
   * outcome says when it was cut short. SSH hosts only. */
  searchRemoteFiles: (hostId: HostId, mode: RemoteSearchMode, root: string, pattern: string) =>
    invoke<RemoteSearchOutcome>("search_remote_files", { hostId, mode, root, pattern }),

  /** Collects live state (OS, kernel, CPU, load, memory) for `hostIds` (SSH
   * only), concurrently. Batch: resolves once every host has reported.
   * Successful outcomes are persisted onto each host as `lastFacts` — the
   * returned `workspace` already reflects that and is the source of truth
   * to render from; `outcomes` additionally carries per-host errors. */
  collectFacts: (hostIds: HostId[]) => invoke<CollectFactsResult>("collect_facts", { hostIds }),

  /** The persisted fleet run history (audit trail), newest first. */
  getFleetHistory: () => invoke<FleetRun[]>("get_fleet_history"),

/** Asks the AI to write (`existingText: ""`) or extend a DSL program
   * implementing `intent` — see `src/lib/operations.ts` for the syntax.
   * The response is validated server-side before being returned; an
   * invalid response rejects with a clear error rather than being handed
   * back as-is. */
  generateAdaptiveProgram: (existingText: string, intent: string) =>
    invoke<string>("generate_adaptive_program", { existingText, intent }),

  /** Parses `programText` and evaluates it against every host in `hostIds`
   * (using each host's last collected facts), grouping hosts by the exact
   * command they'd run. Purely deterministic — no AI call, no execution. */
  previewAdaptiveProgram: (hostIds: HostId[], programText: string) =>
    invoke<ExecutionGroup[]>("preview_adaptive_program", { hostIds, programText }),

  /** Translates `programText` for a local-terminal tab's shell — a native
   * Windows shell (PowerShell/cmd) resolves instantly (no probing, the
   * platform is simply whatever OS Guiterm runs on); any other shell (a
   * real POSIX shell, WSL) is probed for real, locally. `shell` should be
   * the tab's configured shell (`TabMeta`'s local-terminal variant),
   * `null`/unset falls back to the same default `open_local_terminal` uses. */
  composeAdaptiveForLocal: (programText: string, shell: string | null) =>
    invoke<ComposeResult>("compose_adaptive_for_local", { programText, shell }),

  /** Translates `programText` for a Docker exec terminal's container —
   * probed fresh on every call (a `dockerExec` host isn't tied to one
   * container, so there's nothing to cache facts against). */
  composeAdaptiveForDocker: (programText: string, hostId: HostId, containerId: string) =>
    invoke<ComposeResult>("compose_adaptive_for_docker", { programText, hostId, containerId }),

  /** Translates `programText` for a K8s exec terminal's pod — probed fresh
   * on every call, same reasoning as `composeAdaptiveForDocker` (a
   * `k8sExec` host isn't tied to one pod). */
  composeAdaptiveForK8s: (programText: string, hostId: HostId, podName: string, containerName: string | null) =>
    invoke<ComposeResult>("compose_adaptive_for_k8s", { programText, hostId, podName, containerName }),

  /** Executes a reviewed preview — flattens `groups` into a per-host
   * command dispatch, streamed the same way as `runFleetCommand` (same
   * `onFleetOutcome`/`onFleetDone` events, same `runId` convention). Only
   * pass groups that have a `command` — see `ExecutionGroup`. */
  runAdaptivePlan: (
    runId: string,
    intent: string,
    groups: { hostIds: HostId[]; command: string }[],
    /** The DSL source the preview came from. Recorded with the run so it can be
     * undone later — omit it and the run is permanently un-undoable. */
    programText: string | null,
  ) => invoke<void>("run_adaptive_plan", { runId, intent, groups, programText }),

  /** Runs every tool against `destination`, from every target.
   *
   * Resolves as soon as the work is scheduled — results arrive on
   * {@link onNetdiagOutcome} and the run closes with {@link onNetdiagDone}.
   * Streamed rather than batched because a run is a grid of tools × targets,
   * and tranche 2's traceroute alone takes tens of seconds. */
  runNetdiag: (runId: string, targets: FleetTarget[], destination: string, tools: DiagTool[]) =>
    invoke<void>("run_netdiag", { runId, targets, destination, tools }),

  /** Reads and parses an Ansible inventory file. Read-only — the import is a
   * separate step, so the panel can show what the file holds first. */
  readAnsibleInventory: (path: string) => invoke<Inventory>("read_ansible_inventory", { path }),
  /** Creates the ticked hosts, refreshing the ones already imported instead of
   * duplicating them. Matched on the inventory name, not the address. */
  importAnsibleHosts: (selections: InventorySelection[], auth: AuthMethod, secret: string | null) =>
    invoke<Workspace>("import_ansible_hosts", { selections, auth, secret }),

  /** The Azure subscriptions the `az` CLI is signed in to. Disabled ones are
   * left out — picking one only produces a confusing refusal. */
  listAzureSubscriptions: () => invoke<CloudScope[]>("list_azure_subscriptions"),
  /** The VMs of a subscription (the CLI's default one when `null`), with their
   * addresses resolved. Rejects with a `CloudFailure`. */
  discoverAzureVms: (subscription: string | null) =>
    invoke<CloudInstance[]>("discover_azure_vms", { subscription }),
  /** Signs in to Azure. Resolves when the browser round trip is over, so the
   * caller can reload its subscriptions; the lines printed meanwhile arrive
   * through {@link onAzureLoginOutput}. `deviceCode` swaps the browser
   * hand-off for a code, the only way through where no browser can open. */
  azureLogin: (tenant: string | null, deviceCode: boolean) =>
    invoke<void>("azure_login", { tenant, deviceCode }),
  /** Signs out, so the next sign-in can reach a different tenant instead of
   * silently reusing the cached account. */
  azureLogout: () => invoke<void>("azure_logout"),
  /** Creates the ticked VMs as hosts, refreshing the ones already imported
   * instead of duplicating them. Matched on the ARM resource id. */
  importAzureHosts: (selections: CloudSelection[], auth: AuthMethod, secret: string | null) =>
    invoke<Workspace>("import_azure_hosts", { selections, auth, secret }),

  /** The GCP projects the `gcloud` CLI can see, the configured one flagged. */
  listGcpProjects: () => invoke<CloudScope[]>("list_gcp_projects"),
  /** The Compute Engine instances of a project (the CLI's default one when
   * `null`). Rejects with a `CloudFailure`. */
  discoverGcpInstances: (project: string | null) =>
    invoke<CloudInstance[]>("discover_gcp_instances", { project }),
  /** Creates the ticked instances as hosts, matched on the numeric instance id
   * — GCP reuses names freely, so matching on one would let a new machine
   * inherit an old host's credentials. */
  importGcpHosts: (selections: CloudSelection[], auth: AuthMethod, secret: string | null) =>
    invoke<Workspace>("import_gcp_hosts", { selections, auth, secret }),

  /** Reads a DSL program as wanted state and reports which hosts have drifted.
   * Read-only on every host: asking changes nothing. On demand only — nothing
   * polls this. */
  checkDrift: (hostIds: HostId[], programText: string) =>
    invoke<HostDrift[]>("check_drift", { hostIds, programText }),

  /** What undoing a recorded run would do, without undoing anything. Rejects
   * for a run with no DSL program: inferring operations back from rendered
   * shell is exactly what must not be guessed at. */
  previewRollback: (runId: string) => invoke<RollbackPlan>("preview_rollback", { runId }),

  /** Creates (`snippetId: null`) or updates an adaptive snippet — `command`
   * is the DSL program text verbatim. */
  saveAdaptiveSnippet: (snippetId: SnippetId | null, name: string, command: string) =>
    invoke<Workspace>("save_adaptive_snippet", { snippetId, name, command }),

  setAnthropicApiKey: (key: string) => invoke<void>("set_anthropic_api_key", { key }),
  clearAnthropicApiKey: () => invoke<void>("clear_anthropic_api_key"),
  /** Never returns the key itself — only whether one is configured. */
  hasAnthropicApiKey: () => invoke<boolean>("has_anthropic_api_key"),
};

export function onTransferProgress(handler: (e: TransferProgressEvent) => void): Promise<UnlistenFn> {
  return listen<TransferProgressEvent>("transfer-progress", (event) => handler(event.payload));
}

export function onTransferDone(handler: (transferId: string) => void): Promise<UnlistenFn> {
  return listen<{ transferId: string }>("transfer-done", (event) => handler(event.payload.transferId));
}

export function onTransferError(handler: (transferId: string, message: string) => void): Promise<UnlistenFn> {
  return listen<{ transferId: string; message: string }>("transfer-error", (event) => handler(event.payload.transferId, event.payload.message));
}

/** Fires when a server asks for MFA/OTP input mid-handshake. The SSH
 * connection is parked waiting for `submitSshAuthPrompt` (or
 * `cancelSshAuthPrompt`) with the same `id` — see
 * `commands::interactive_auth`. */
/** Each line `aws sso login` prints while it waits for the browser — the
 * verification URL and code among them, which is the only way through when no
 * browser opens. */
export function onAwsSsoOutput(handler: (line: string) => void) {
  return listen<string>("aws-sso-output", (event) => handler(event.payload));
}

/** Each line `az login` prints while it waits for the browser — the
 * verification URL, and the code when the device flow is used. Same reason as
 * the AWS one: it is the only way through when no browser opens. */
export function onAzureLoginOutput(handler: (line: string) => void) {
  return listen<string>("azure-login-output", (event) => handler(event.payload));
}

/** One cell of the diagnostic grid, as it completes. */
export function onNetdiagOutcome(handler: (outcome: NetdiagOutcome) => void): Promise<UnlistenFn> {
  return listen<NetdiagOutcome>("netdiag-outcome", (event) => handler(event.payload));
}

/** Closes a diagnostic run — every cell that was going to answer has. */
export function onNetdiagDone(handler: (runId: string) => void): Promise<UnlistenFn> {
  return listen<{ runId: string }>("netdiag-done", (event) => handler(event.payload.runId));
}

export function onSshAuthPrompt(handler: (prompt: SshAuthPrompt) => void): Promise<UnlistenFn> {
  return listen<SshAuthPrompt>("ssh-auth-prompt", (event) => handler(event.payload));
}

export function onTerminalClosed(handler: (id: string) => void): Promise<UnlistenFn> {
  return listen<{ id: string }>("terminal-closed", (event) => handler(event.payload.id));
}

export function onRdpViewError(handler: (id: string, message: string) => void): Promise<UnlistenFn> {
  return listen<{ id: string; message: string }>("rdp-view-error", (event) => handler(event.payload.id, event.payload.message));
}

export function onRdpViewClosed(handler: (id: string) => void): Promise<UnlistenFn> {
  return listen<{ id: string }>("rdp-view-closed", (event) => handler(event.payload.id));
}

export function onFleetOutcome(handler: (runId: string, outcome: FleetOutcome) => void): Promise<UnlistenFn> {
  return listen<{ runId: string; outcome: FleetOutcome }>("fleet-run-outcome", (event) => handler(event.payload.runId, event.payload.outcome));
}

export function onFleetDone(handler: (runId: string) => void): Promise<UnlistenFn> {
  return listen<{ runId: string }>("fleet-run-done", (event) => handler(event.payload.runId));
}

