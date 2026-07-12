import { Channel, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { AuthMethod, DockerContainer, EnvVar, Entry, GroupId, HostId, HostKind, ImportSelection, KeyAlgorithm, KeyId, KnownHostEntry, PaneListed, PaneOpened, PaneSource, PortForwardId, PortForwardKind, RdpClientMessage, RdpFrame, SnippetId, SshConfigHost, TransferProgressEvent, VaultStatus, Workspace } from "./types";

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
  importWorkspace: (path: string, replace: boolean) => invoke<Workspace>("import_workspace", { path, replace }),
  exportHost: (hostId: HostId, path: string, includeKeyMaterial: boolean) => invoke<void>("export_host", { hostId, path, includeKeyMaterial }),
  importHostFromFile: (path: string) => invoke<Workspace>("import_host_from_file", { path }),
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

  connectTerminal: (hostId: HostId) => invoke<string>("connect_terminal", { hostId }),
  listDockerContainers: (hostId: HostId) => invoke<DockerContainer[]>("list_docker_containers", { hostId }),
  connectDockerExec: (hostId: HostId, containerId: string) => invoke<string>("connect_docker_exec", { hostId, containerId }),
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

  openLocalTerminal: (shell: string | null = null) => invoke<string>("open_local_terminal", { shell }),
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
  paneRemove: (paneId: string, cwd: string, entry: Entry) => invoke<PaneListed>("pane_remove", { paneId, cwd, entry }),
  paneChmod: (paneId: string, cwd: string, name: string, mode: number) => invoke<PaneListed>("pane_chmod", { paneId, cwd, name, mode }),
  readPaneFile: (paneId: string, cwd: string, name: string) => invoke<string>("read_pane_file", { paneId, cwd, name }),
  writePaneFile: (paneId: string, cwd: string, name: string, content: string) => invoke<void>("write_pane_file", { paneId, cwd, name, content }),
  uploadPaths: (paneId: string, cwd: string, localPaths: string[]) => invoke<string[]>("upload_paths", { paneId, cwd, localPaths }),
  cancelTransfer: (transferId: string) => invoke<void>("cancel_transfer", { transferId }),
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

export function onTerminalData(handler: (id: string, data: string) => void): Promise<UnlistenFn> {
  return listen<{ id: string; data: string }>("terminal-data", (event) => handler(event.payload.id, event.payload.data));
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

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function base64ToBytes(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
