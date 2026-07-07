import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { AuthMethod, EnvVar, Entry, GroupId, HostId, ImportSelection, KeyId, KnownHostEntry, PaneListed, PaneOpened, PaneSource, PortForwardId, PortForwardKind, SnippetId, SshConfigHost, TransferProgressEvent, Workspace } from "./types";

export const api = {
  getWorkspace: () => invoke<Workspace>("get_workspace"),

  saveHost: (input: {
    id: HostId | null;
    label: string;
    address: string;
    port: number;
    username: string;
    auth: AuthMethod;
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

  listKnownHosts: () => invoke<KnownHostEntry[]>("list_known_hosts"),
  revokeKnownHost: (identity: string) => invoke<void>("revoke_known_host", { identity }),
  previewSshConfigImport: (path: string | null) => invoke<SshConfigHost[]>("preview_ssh_config_import", { path }),
  importSshConfigHosts: (selections: ImportSelection[]) => invoke<Workspace>("import_ssh_config_hosts", { selections }),

  connectTerminal: (hostId: HostId) => invoke<string>("connect_terminal", { hostId }),
  writeTerminal: (sessionId: string, data: string) => invoke<void>("write_terminal", { sessionId, data }),
  resizeTerminal: (sessionId: string, cols: number, rows: number) => invoke<void>("resize_terminal", { sessionId, cols, rows }),
  closeTerminal: (sessionId: string) => invoke<void>("close_terminal", { sessionId }),

  openLocalTerminal: (shell: string | null = null) => invoke<string>("open_local_terminal", { shell }),
  listLocalShells: () => invoke<{ id: string; label: string }[]>("list_local_shells"),
  writeLocalTerminal: (sessionId: string, data: string) => invoke<void>("write_local_terminal", { sessionId, data }),
  resizeLocalTerminal: (sessionId: string, cols: number, rows: number) => invoke<void>("resize_local_terminal", { sessionId, cols, rows }),
  closeLocalTerminal: (sessionId: string) => invoke<void>("close_local_terminal", { sessionId }),

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
