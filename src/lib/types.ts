export type HostId = string;
export type GroupId = string;
export type SnippetId = string;
export type PortForwardId = string;

export type KeyId = string;

export interface PrivateKey {
  id: KeyId;
  name: string;
  path: string;
  content?: string;
}

export interface CustomIcon {
  id: string;
  name: string;
  dataUrl: string;
}

export type AuthMethod = "password" | "agent" | { privateKey: { path: string; keyId: KeyId | null } };

export interface EnvVar {
  key: string;
  value: string;
}

export interface Host {
  id: HostId;
  label: string;
  address: string;
  port: number;
  username: string;
  auth: AuthMethod;
  groupId: GroupId | null;
  jumpVia: HostId[];
  tags: string[];
  startupSnippets: SnippetId[];
  envVars: EnvVar[];
  icon?: string;
  keepaliveIntervalSecs?: number | null;
  agentForward?: boolean;
}

export interface Snippet {
  id: SnippetId;
  name: string;
  command: string;
  tags: string[];
}

export type PortForwardKind = "local" | "remote";

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

export interface Workspace {
  groups: Group[];
  hosts: Host[];
  snippets: Snippet[];
  portForwards: PortForward[];
  keychain: PrivateKey[];
  customIcons: CustomIcon[];
}

export interface KnownHostEntry {
  identity: string;
  label: string;
  publicKey: string;
}

export interface SshConfigHost {
  alias: string;
  hostname: string | null;
  user: string | null;
  port: number | null;
  identityFile: string | null;
  proxyJump: string | null;
}

export interface ImportSelection {
  alias: string;
  hostname: string;
  user: string;
  port: number;
  groupId: GroupId | null;
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

export type PaneSource = { kind: "local" } | { kind: "remote"; hostId: HostId };

export interface PaneOpened {
  paneId: string;
  cwd: string;
  entries: Entry[];
}

export interface PaneListed {
  cwd: string;
  entries: Entry[];
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
  | { id: string; kind: "terminal" | "transfer"; hostId: HostId; label: string; status?: "connected" | "placeholder" }
  | { id: string; kind: "local-terminal"; label: string; initialCommand?: string; shell?: string | null; status?: "connected" | "placeholder" };

export type Tab =
  | { id: string; kind: "terminal"; hostId: HostId; label: string; sessionId: string | null; status: "connecting" | "open" | "failed"; error?: string }
  | { id: string; kind: "transfer"; hostId: HostId; label: string; left: PaneState; right: PaneState };

