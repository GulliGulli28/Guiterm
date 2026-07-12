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

export type KeyAlgorithm = "ed25519" | "rsa";

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

/** What kind of target a `Host` describes. `ssh` uses every field with its
 * literal meaning; the others repurpose a subset of the same fields instead
 * of growing dedicated ones (see `core::model::HostKind`):
 * - `dockerExec`: `address` is the Docker daemon socket or host (e.g.
 *   `unix:///var/run/docker.sock`, `tcp://10.0.4.12:2375`) — unless
 *   `dockerViaHostId` is set, in which case `address` is ignored and the
 *   daemon is reached by tunnelling through that other (SSH) host instead.
 * - `k8sExec`: `address` is a kubeconfig context, `username` is the default
 *   namespace. UI-only for now — no backend yet.
 * - `rdp`: `address`/`port`/`username` keep their literal meaning; `auth` is
 *   restricted to `password` in the UI. UI-only for now — no backend yet. */
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
  tags: string[];
  startupSnippets: SnippetId[];
  envVars: EnvVar[];
  icon?: string;
  keepaliveIntervalSecs?: number | null;
  agentForward?: boolean;
}

export interface DockerContainer {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
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
  command: string;
  tags: string[];
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

/** State of the optional master-password vault. `enabled` = a master password
 * is configured; `unlocked` = the secrets are decryptable this session. */
export interface VaultStatus {
  enabled: boolean;
  unlocked: boolean;
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

export type PaneSource =
  | { kind: "local" }
  | { kind: "remote"; hostId: HostId }
  /** A Docker exec host's container filesystem — no SFTP subsystem exists
   * for `docker exec`, so this drives `core::docker_pane::DockerPaneClient`
   * (shell-based listing/mkdir/rename/remove/chmod, container-archive tar
   * endpoints for read/write/upload/download) instead of a real SFTP
   * session. `containerId` picked the same way `connectDockerExec` picks
   * one — see `TransferTab.tsx`'s Docker container picker. */
  | { kind: "docker"; hostId: HostId; containerId: string };

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
  | { id: string; kind: "terminal" | "transfer" | "rdp-view"; hostId: HostId; label: string; status?: "connected" | "placeholder"; dockerContainerId?: string }
  | { id: string; kind: "local-terminal"; label: string; initialCommand?: string; shell?: string | null; status?: "connected" | "placeholder" };

export type Tab =
  | { id: string; kind: "terminal"; hostId: HostId; label: string; sessionId: string | null; status: "connecting" | "open" | "failed"; error?: string }
  | { id: string; kind: "transfer"; hostId: HostId; label: string; left: PaneState; right: PaneState };

