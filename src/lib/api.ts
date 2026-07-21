import { Channel, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { AuthMethod, ColumnInfo, CollectFactsResult, ComposeResult, DockerContainer, EnvVar, Entry, ExecutionGroup, FleetOutcome, FleetRun, FleetTarget, GroupId, HostId, HostKind, ImportSelection, K8sPod, KeyAlgorithm, KeyId, KnownHostEntry, PaneListed, PaneOpened, PaneSource, PortForwardId, PortForwardKind, QueryResult, RdpClientMessage, RdpFrame, SnippetId, SqlConnectionId, SqlEngine, SshConfigHost, TableInfo, TransferProgressEvent, VaultStatus, Workspace } from "./types";

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
  checkHostStatus: (hostId: HostId) => invoke<boolean>("check_host_status", { hostId }),

  saveGroup: (input: { id: GroupId | null; name: string; parentId: GroupId | null; icon: string | null; color: string | null }) => invoke<Workspace>("save_group", { input }),
  deleteGroup: (groupId: GroupId) => invoke<Workspace>("delete_group", { groupId }),

  addSnippet: (name: string, command: string) => invoke<Workspace>("add_snippet", { name, command }),
  updateSnippet: (snippetId: SnippetId, name: string, command: string) => invoke<Workspace>("update_snippet", { snippetId, name, command }),
  deleteSnippet: (snippetId: SnippetId) => invoke<Workspace>("delete_snippet", { snippetId }),

  addForward: (input: { hostId: HostId; kind: PortForwardKind; bindAddress: string; bindPort: number; destAddress: string; destPort: number }) =>
    invoke<Workspace>("add_forward", { input }),
  deleteForward: (forwardId: PortForwardId) => invoke<Workspace>("delete_forward", { forwardId }),

  saveSqlConnection: (input: {
    id: SqlConnectionId | null;
    label: string;
    engine: SqlEngine;
    tunnelHostId: HostId | null;
    address: string;
    port: number;
    username: string;
    database: string | null;
    groupId: GroupId | null;
    tags: string[];
    secret: string | null;
  }) => invoke<Workspace>("save_sql_connection", { input }),
  deleteSqlConnection: (connectionId: SqlConnectionId) => invoke<Workspace>("delete_sql_connection", { connectionId }),
  /** Opens a pool (directly, or through an ephemeral SSH tunnel invisible to
   * the Tunnels panel — see `core::sql::connect`) and returns an opaque
   * session id to pass to every `listSql*`/`runSqlQuery` call below, until
   * `closeSqlSession`. */
  openSqlSession: (connectionId: SqlConnectionId) => invoke<string>("open_sql_session", { connectionId }),
  closeSqlSession: (sessionId: string) => invoke<void>("close_sql_session", { sessionId }),
  /** One database (MySQL) or schema (PostgreSQL) per entry — see
   * `TableInfo`'s doc comment for why the two share this one call. */
  listSqlSchemas: (sessionId: string) => invoke<string[]>("list_sql_schemas", { sessionId }),
  listSqlTables: (sessionId: string, schema: string) => invoke<TableInfo[]>("list_sql_tables", { sessionId, schema }),
  listSqlColumns: (sessionId: string, schema: string, table: string) => invoke<ColumnInfo[]>("list_sql_columns", { sessionId, schema, table }),
  runSqlQuery: (sessionId: string, sql: string) => invoke<QueryResult>("run_sql_query", { sessionId, sql }),

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
  connectDockerExec: (hostId: HostId, containerId: string, onData: (chunk: Uint8Array) => void) => {
    const channel = new Channel<ArrayBuffer>();
    channel.onmessage = (buffer) => onData(new Uint8Array(buffer));
    return invoke<string>("connect_docker_exec", { hostId, containerId, channel });
  },
  listK8sPods: (hostId: HostId) => invoke<K8sPod[]>("list_k8s_pods", { hostId }),
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
  writeTerminal: (sessionId: string, data: string) => invoke<void>("write_terminal", { sessionId, data }),
  resizeTerminal: (sessionId: string, cols: number, rows: number) => invoke<void>("resize_terminal", { sessionId, cols, rows }),
  closeTerminal: (sessionId: string) => invoke<void>("close_terminal", { sessionId }),

  openLocalTerminal: (shell: string | null, onData: (chunk: Uint8Array) => void) => {
    const channel = new Channel<ArrayBuffer>();
    channel.onmessage = (buffer) => onData(new Uint8Array(buffer));
    return invoke<string>("open_local_terminal", { shell, channel });
  },
  listLocalShells: () => invoke<{ id: string; label: string }[]>("list_local_shells"),
  writeLocalTerminal: (sessionId: string, data: string) => invoke<void>("write_local_terminal", { sessionId, data }),
  resizeLocalTerminal: (sessionId: string, cols: number, rows: number) => invoke<void>("resize_local_terminal", { sessionId, cols, rows }),
  closeLocalTerminal: (sessionId: string) => invoke<void>("close_local_terminal", { sessionId }),

  getLocalHistory: () => invoke<string[]>("get_local_history"),
  appendLocalHistory: (command: string) => invoke<void>("append_local_history", { command }),
  getSshHistory: () => invoke<string[]>("get_ssh_history"),
  appendSshHistory: (command: string) => invoke<void>("append_ssh_history", { command }),

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
  uploadPaths: (paneId: string, cwd: string, localPaths: string[]) => invoke<string[]>("upload_paths", { paneId, cwd, localPaths }),
  cancelTransfer: (transferId: string) => invoke<void>("cancel_transfer", { transferId }),

  /** Runs `command` on every target in `targets` (an SSH host, a Docker exec
   * container, or the local machine — see `FleetTarget`) off any PTY.
   * Resolves once every target has reported; per-target results stream in
   * via `onFleetOutcome`, followed by `onFleetDone`. `runId` (mint with
   * `crypto.randomUUID()`) tells concurrent runs apart on the shared events. */
  runFleetCommand: (runId: string, targets: FleetTarget[], command: string) =>
    invoke<void>("run_fleet_command", { runId, targets, command }),

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
  runAdaptivePlan: (runId: string, intent: string, groups: { hostIds: HostId[]; command: string }[]) =>
    invoke<void>("run_adaptive_plan", { runId, intent, groups }),

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

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
