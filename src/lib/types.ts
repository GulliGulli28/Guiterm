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

/** Which SQL wire protocol a `SqlConnection` speaks. */
export type SqlEngine = "mysql" | "postgres";

/** A saved MySQL/PostgreSQL connection — deliberately not a `Host`/
 * `HostKind` (see `core::model::SqlConnection`'s doc comment): no shell, not
 * a fleet target. Can still reference a saved SSH `Host` via
 * `tunnelHostId`, purely to reach a database that isn't directly reachable
 * from this machine — `null`/absent connects directly to `address`/`port`. */
export interface SqlConnection {
  id: SqlConnectionId;
  label: string;
  engine: SqlEngine;
  tunnelHostId?: HostId | null;
  address: string;
  port: number;
  username: string;
  /** Required in practice for PostgreSQL (a connection always targets one
   * database); optional for MySQL. */
  database?: string | null;
  groupId?: GroupId | null;
  tags: string[];
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

