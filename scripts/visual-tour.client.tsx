// Monte l'application **entière** dans un navigateur ordinaire, avec une
// couche Tauri factice : `window.__TAURI_INTERNALS__` répond à chaque
// `invoke(...)` avec des données plausibles (un espace de travail peuplé, un
// terminal qui affiche une invite, un panneau de transfert qui liste des
// fichiers) au lieu de parler à Rust.
//
// Ce que ça sert : regarder l'interface. `visual-tour.mjs` parcourt les écrans
// et en prend des captures — la seule façon de juger une refonte visuelle
// sans monter un vrai `sshd`. Ce que ça ne prouve pas : que les commandes
// existent côté Rust (c'est `lib/tauriCommands.test.ts`) ni qu'elles marchent
// (c'est `npm run test:e2e`).
//
// La couche factice est posée **avant** d'importer `App` : `TitleBar` appelle
// `getCurrentWindow()` au chargement du module, qui lit
// `__TAURI_INTERNALS__.metadata` aussitôt.
import type { Entry, Group, GroupId, Host, HostId, Workspace } from "../src/lib/types";

type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

const groups: Group[] = [
  { id: "g-prod" as GroupId, name: "Production", parentId: null, color: "rose" },
  { id: "g-web" as GroupId, name: "Frontaux web", parentId: "g-prod" as GroupId },
  { id: "g-data" as GroupId, name: "Données", parentId: "g-prod" as GroupId },
  { id: "g-staging" as GroupId, name: "Préproduction", parentId: null, color: "amber" },
  { id: "g-lab" as GroupId, name: "Labo", parentId: null, color: "teal" },
];

function host(
  id: string,
  label: string,
  address: string,
  username: string,
  groupId: string | null,
  tags: string[],
  extra: Partial<Host> = {},
): Host {
  return {
    id: id as HostId,
    label,
    address,
    port: 22,
    username,
    auth: "agent",
    groupId: groupId as GroupId | null,
    jumpVia: [],
    tags,
    startupSnippets: [],
    envVars: [],
    ...extra,
  } as Host;
}

const facts = (osName: string, memUsedPct: number, load1: number): Partial<Host> => ({
  lastFacts: {
    hostname: null, osId: null, osName, kernel: "6.8.0", arch: "x86_64",
    cpus: 4, load1, uptimeSecs: 86400 * 12, memTotalMb: 16384,
    memUsedMb: Math.round(16384 * memUsedPct / 100), memUsedPct,
  },
  lastFactsAtMs: Date.now() - 1000 * 60 * 42,
});

const hosts: Host[] = [
  host("h-web-01", "web-01", "203.0.113.10", "deploy", "g-web", ["nginx", "ubuntu"], facts("Ubuntu 24.04", 61, 0.42)),
  host("h-web-02", "web-02", "203.0.113.11", "deploy", "g-web", ["nginx", "ubuntu"], facts("Ubuntu 24.04", 58, 0.31)),
  host("h-db-01", "pg-primary", "10.0.4.20", "postgres", "g-data", ["postgres", "debian"], facts("Debian 12", 87, 1.9)),
  host("h-docker", "docker-host", "10.0.4.12", "ops", "g-staging", ["docker"], { kind: "ssh", persistentShell: "tmux" }),
  host("h-app", "app-container", "10.0.4.12", "root", "g-staging", ["docker"], { kind: "dockerExec", dockerViaHostId: "h-docker" as HostId }),
  host("h-k8s", "prod-cluster", "prod-eu-west", "—", "g-lab", ["k8s"], { kind: "k8sExec" }),
  host("h-win", "workstation-win", "192.168.1.42", "alice", "g-lab", ["rdp", "windows"], { kind: "rdp", port: 3389 }),
  host("h-bastion", "bastion", "bastion.exemple.fr", "jump", null, ["bastion"], { auth: { privateKey: { path: "~/.ssh/id_ed25519", keyId: "k-1", certificatePath: null } } as Host["auth"] }),
];

const workspace: Workspace = {
  groups,
  hosts,
  snippets: [
    { id: "s-1", name: "Espace disque", command: "df -h --output=source,size,used,avail,pcent / /var", tags: ["disque"] },
    { id: "s-2", name: "Journal nginx", command: "sudo tail -n 200 /var/log/nginx/error.log", tags: ["nginx", "logs"] },
    { id: "s-3", name: "Redémarrer {{service}}", command: "sudo systemctl restart {{service}} && systemctl status {{service}} --no-pager", tags: ["systemd"] },
    { id: "s-4", name: "Mise à jour paquets", command: "when os = ubuntu: sudo apt-get update && sudo apt-get upgrade -y\nwhen os = debian: sudo apt-get update && sudo apt-get upgrade -y", tags: ["maintenance"], adaptive: true },
  ],
  portForwards: [
    { id: "f-1", hostId: "h-db-01" as HostId, kind: "local", bindAddress: "127.0.0.1", bindPort: 5432, destAddress: "127.0.0.1", destPort: 5432 },
    { id: "f-2", hostId: "h-bastion" as HostId, kind: "dynamic", bindAddress: "127.0.0.1", bindPort: 1080, destAddress: "", destPort: 0 },
  ],
  keychain: [
    { id: "k-1", name: "id_ed25519 (perso)", path: "~/.ssh/id_ed25519" },
    { id: "k-2", name: "deploy-prod", path: "~/.ssh/deploy_prod" },
  ],
  customIcons: [],
  sqlConnections: [
    { id: "sql-1", label: "Catalogue (prod)", engine: "postgres", address: "10.0.4.20", port: 5432, username: "app", database: "catalogue", tunnel: null } as Workspace["sqlConnections"][number],
    { id: "sql-2", label: "Cache sessions", engine: "redis", address: "10.0.4.21", port: 6379, username: "", database: "0", tunnel: null } as Workspace["sqlConnections"][number],
  ],
  runbooks: [
    { id: "rb-1", name: "Déploiement web", description: "Bascule des frontaux un par un.", steps: [] },
  ],
  // Des entités rangées dans les vaults GuiVault partagés : chaque panneau
  // doit les montrer sous le dossier de leur vault.
  vaultBindings: { "h-web-01": "v-infra", "h-db-01": "v-infra", "g-web": "v-infra", "s-2": "v-infra", "k-2": "v-lect", "sql-1": "v-infra" },
};

const entries = (names: [string, boolean, number][]): Entry[] =>
  names.map(([name, isDir, size]) => ({ name, isDir, isSymlink: false, size, modified: Date.now() / 1000 - 3600 * 24 * 3, permissions: isDir ? 0o755 : 0o644 }));

const remoteEntries = entries([
  ["etc", true, 4096], ["home", true, 4096], ["opt", true, 4096], ["srv", true, 4096], ["var", true, 4096],
  ["docker-compose.yml", false, 2140], ["README.md", false, 8_912], ["deploy.sh", false, 1_204], ["backup-2026-09-12.tar.gz", false, 184_202_331],
]);
const localEntries = entries([
  ["Documents", true, 4096], ["Downloads", true, 4096], ["projets", true, 4096],
  [".bashrc", false, 3771], ["notes.txt", false, 1_024], ["rapport-q3.pdf", false, 2_402_112],
]);

const PROMPT = "\x1b[1;32mdeploy@web-01\x1b[0m:\x1b[1;34m~\x1b[0m$ ";
const banner = [
  "Welcome to Ubuntu 24.04.1 LTS (GNU/Linux 6.8.0-45-generic x86_64)\r\n",
  "\r\n",
  "  System load:  0.42               Processes:             211\r\n",
  "  Usage of /:   61.3% of 78.62GB   Users logged in:       1\r\n",
  "  Memory usage: 61%                IPv4 address for eth0: 203.0.113.10\r\n",
  "\r\n",
  "Last login: Sun Sep 14 09:12:44 2026 from 192.168.1.20\r\n",
  PROMPT, "ls -la /srv/app\r\n",
  "total 32\r\n",
  "drwxr-xr-x 5 deploy deploy 4096 Sep 12 18:04 \x1b[1;34m.\x1b[0m\r\n",
  "drwxr-xr-x 3 root   root   4096 Aug  2 10:21 \x1b[1;34m..\x1b[0m\r\n",
  "-rw-r--r-- 1 deploy deploy 2140 Sep 12 18:04 docker-compose.yml\r\n",
  "-rwxr-xr-x 1 deploy deploy 1204 Sep 12 18:04 \x1b[1;32mdeploy.sh\x1b[0m\r\n",
  "drwxr-xr-x 8 deploy deploy 4096 Sep 12 18:04 \x1b[1;34mreleases\x1b[0m\r\n",
  PROMPT,
].join("");

const callbacks = new Map<number, (x: unknown) => void>();
let nextCallback = 1;

function feedChannel(channel: unknown, text: string) {
  const ch = channel as { onmessage: (buffer: ArrayBuffer) => void } | undefined;
  if (!ch) return;
  const bytes = new TextEncoder().encode(text);
  setTimeout(() => ch.onmessage(bytes.buffer as ArrayBuffer), 30);
}

const responses: Record<string, Invoke> = {
  get_workspace: async () => workspace,
  master_password_status: async () => ({ enabled: false, unlocked: false }),
  list_aws_session_alerts: async () => [],
  list_aws_sso_sessions: async () => [],
  list_aws_sso_status: async () => [],
  list_aws_profiles: async () => [],
  list_known_hosts: async () => [
    { identity: "203.0.113.10:22", label: "web-01", publicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGx0d2Vic2VydmVyMDF0ZXN0a2V5" },
    { identity: "10.0.4.20:22", label: "pg-primary", publicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHBnLXByaW1hcnl0ZXN0a2V5MDE" },
  ],
  list_local_shells: async () => [{ id: "bash", label: "bash" }, { id: "zsh", label: "zsh" }],
  running_forwards: async () => ["f-1"],
  list_activity: async () => [],
  get_local_history: async () => ["ls -la", "git status", "docker compose up -d"],
  get_ssh_history: async () => ["sudo systemctl status nginx", "df -h", "journalctl -u nginx -n 100"],
  get_sql_history: async () => [],
  get_fleet_history: async () => [],
  get_runbook_history: async () => [],
  recording_session_ids: async () => [],
  // GuiVault : un compte connecté, un vault partagé avec deux membres, une
  // invitation en attente — de quoi voir chaque ligne du panneau.
  guivault_status: async () => ({
    configured: true, unlocked: true, serverUrl: "https://vault.example.com", email: "alice@example.com",
    userId: "u-alice", fingerprint: "3f2a-91c0-77de-0b4e-aa12-5c6d-e8f9-1a2b", deviceName: "Guiterm sur poste-alice",
    autoSyncSecs: 300, persistUnlock: true, lastSyncAt: new Date().toISOString(), viewLocal: false,
    vaults: [
      { id: "v-perso", name: "Personnel", kind: "personal", role: "owner", revision: 12 },
      { id: "v-infra", name: "Équipe infra", kind: "shared", role: "owner", revision: 40 },
      { id: "v-lect", name: "Lecture seule — prod bancaire", kind: "shared", role: "reader", revision: 3 },
    ],
    accounts: [{ userId: "u-alice", email: "alice@example.com", serverUrl: "https://vault.example.com", lastUsedAt: new Date().toISOString() }],
  }),
  guivault_my_invitations: async () => [
    { id: "inv-1", vaultId: "v-x", vaultName: null, inviterEmail: "bob.martin@example.com", inviteeEmail: "alice@example.com", inviteePublicKey: null, inviteeFingerprint: null, inviteeTrust: null, role: "writer", status: "pending", hasKey: true, createdAt: new Date().toISOString(), expiresAt: new Date().toISOString() },
  ],
  guivault_members: async () => [
    { userId: "u-alice", email: "alice@example.com", fingerprint: "3f2a-91c0-77de-0b4e-aa12-5c6d-e8f9-1a2b", role: "owner", trust: { kind: "pinned" }, isMe: true },
    { userId: "u-bob", email: "bob.martin@example.com", fingerprint: "9c1d-40aa-2e2e-b7f0-0c0c-d1d1-e2e2-f3f3", role: "writer", trust: { kind: "unknown" }, isMe: false },
    { userId: "u-carol", email: "carol.dupont-lefebvre@example.com", fingerprint: "1111-2222-3333-4444-5555-6666-7777-8888", role: "reader", trust: { kind: "changed", previous: "0000-0000-0000-0000-0000-0000-0000-0000" }, isMe: false },
  ],
  guivault_vault_invitations: async () => [
    { id: "inv-2", vaultId: "v-infra", vaultName: "Équipe infra", inviterEmail: "alice@example.com", inviteeEmail: "dave@example.com", inviteePublicKey: "AA==", inviteeFingerprint: "abcd-ef01-2345-6789-abcd-ef01-2345-6789", inviteeTrust: { kind: "unknown" }, role: "writer", status: "awaiting_key", hasKey: false, createdAt: new Date().toISOString(), expiresAt: new Date().toISOString() },
  ],
  // Le contenu des vaults, tel que `transfer::list` le rend : dossiers avec
  // leur `parentId`, hôtes et connexions dedans, clés et snippets à part —
  // de quoi voir l'arborescence à cocher, dans le vault et dans « Ajouter ».
  guivault_list_entities: async (_cmd, args) => {
    const a = args as { scope?: string } | undefined;
    if (a?.scope === "local") return [
      { id: "l-1", kind: "host", name: "nas-maison", path: "", parentId: null, vaultId: null },
      { id: "l-2", kind: "snippet", name: "maj système", path: "", parentId: null, vaultId: null },
      { id: "l-3", kind: "group", name: "Maison", path: "", parentId: null, vaultId: null },
      { id: "l-4", kind: "host", name: "raspberry", path: "Maison", parentId: "l-3", vaultId: null },
    ];
    return [
      { id: "e-1", kind: "group", name: "Production", path: "", parentId: null, vaultId: "v-infra" },
      { id: "e-6", kind: "group", name: "Bases", path: "Production", parentId: "e-1", vaultId: "v-infra" },
      { id: "e-2", kind: "host", name: "web-01", path: "Production", parentId: "e-1", vaultId: "v-infra" },
      { id: "e-3", kind: "host", name: "pg-primary-replica-longue-etiquette", path: "Production / Bases", parentId: "e-6", vaultId: "v-infra" },
      { id: "e-7", kind: "sql-connection", name: "Catalogue (prod)", path: "Production / Bases", parentId: "e-6", vaultId: "v-infra" },
      { id: "e-4", kind: "key", name: "deploy-ed25519", path: "", parentId: null, vaultId: "v-infra" },
      { id: "e-8", kind: "snippet", name: "Journal nginx", path: "", parentId: null, vaultId: "v-infra" },
      { id: "e-5", kind: "host", name: "labo-1", path: "Labo", parentId: null, vaultId: null },
      { id: "e-9", kind: "key", name: "id_ed25519 (perso)", path: "", parentId: null, vaultId: null },
      { id: "e-10", kind: "host", name: "core-banking-01", path: "", parentId: null, vaultId: "v-lect" },
    ];
  },
  guivault_transfer_entities: async (_cmd, args) => ((args as { ids?: string[] })?.ids ?? []).length,
  // Ce qui suivrait un transfert : un dossier obligatoire, une clé, une
  // icône et un bastion proposés — de quoi voir les deux niveaux.
  guivault_transfer_plan: async () => ({
    followers: [
      { entity: { id: "e-1", kind: "group", name: "Production", path: "", parentId: null, vaultId: "v-infra" }, reason: "dossier de « web-01 »", required: true },
      { entity: { id: "e-4", kind: "key", name: "deploy-ed25519", path: "", parentId: null, vaultId: "v-infra" }, reason: "clé de « web-01 »", required: false },
      { entity: { id: "i-1", kind: "icon", name: "logo-nginx", path: "", parentId: null, vaultId: "v-infra" }, reason: "icône de « web-01 »", required: false },
      { entity: { id: "e-11", kind: "host", name: "bastion-infra", path: "Accès", parentId: null, vaultId: "v-infra" }, reason: "bastion de « web-01 »", required: false },
    ],
  }),
  guivault_delete_entities: async () => workspace,
  guivault_sessions: async () => [
    { id: "s-1", deviceName: "Guiterm sur poste-alice", createdAt: new Date().toISOString(), lastUsedAt: new Date().toISOString(), current: true },
    { id: "s-2", deviceName: "Guiterm sur portable", createdAt: new Date().toISOString(), lastUsedAt: new Date().toISOString(), current: false },
  ],
  guivault_totp_status: async () => false,
  has_anthropic_api_key: async () => false,
  list_remote_edits: async () => [],
  check_host_status: async () => ({ reachable: true }),
  list_persistent_sessions: async () => ({ tmuxAvailable: true, sessions: [] }),
  list_docker_containers: async () => [
    { id: "a1b2c3", name: "api", image: "exemple/api:1.4.2", state: "running", status: "Up 3 days" },
    { id: "d4e5f6", name: "worker", image: "exemple/worker:1.4.2", state: "running", status: "Up 3 days" },
  ],
  connect_terminal: async (_cmd, args) => {
    feedChannel(args?.channel, banner);
    return { sessionId: "sess-1", sessionKey: null, persistence: "off", readOnly: false, cols: 120, rows: 30 };
  },
  open_local_terminal: async (_cmd, args) => {
    feedChannel(args?.channel, "\x1b[1;36mglorin@station\x1b[0m:\x1b[1;34m~/projets\x1b[0m$ ");
    return "local-1";
  },
  open_pane: async (_cmd, args) => {
    const source = args?.source as { kind: string };
    return source.kind === "local"
      ? { paneId: "pane-local", cwd: "/home/glorin", entries: localEntries }
      : { paneId: "pane-remote", cwd: "/srv/app", entries: remoteEntries };
  },
  list_pane: async (_cmd, args) => ({
    cwd: args?.path,
    entries: args?.paneId === "pane-local" ? localEntries : remoteEntries,
  }),
  pane_disk_space: async () => ({ totalBytes: 84_000_000_000, freeBytes: 32_500_000_000 }),
  open_sql_session: async () => ({ sessionId: "sql-sess-1" }),
  list_sql_databases: async () => ["catalogue", "postgres"],
  list_sql_schemas: async () => ["public"],
  list_sql_tables: async () => [{ name: "produits", kind: "table" }, { name: "commandes", kind: "table" }, { name: "clients", kind: "table" }],
};

const internals = {
  metadata: {
    currentWindow: { label: "main" },
    currentWebview: { label: "main", windowLabel: "main" },
    windows: [{ label: "main" }],
    webviews: [{ label: "main", windowLabel: "main" }],
  },
  transformCallback(callback: (x: unknown) => void) {
    const id = nextCallback++;
    callbacks.set(id, callback);
    return id;
  },
  unregisterCallback(id: number) { callbacks.delete(id); },
  convertFileSrc: (p: string) => p,
  async invoke(cmd: string, args?: Record<string, unknown>) {
    const handler = responses[cmd];
    if (handler) return handler(cmd, args);
    // Plugins : fenêtre, événements, presse-papiers… Rien ne s'y passe, mais
    // rien ne doit non plus échouer : `isMaximized` attend un booléen, `listen`
    // un identifiant.
    if (cmd.startsWith("plugin:")) {
      if (cmd.includes("is_maximized") || cmd.includes("is_fullscreen")) return false;
      if (cmd.includes("|listen")) return nextCallback++;
      if (cmd.includes("updater|check")) return null;
      return null;
    }
    if (cmd.startsWith("list_") || cmd.startsWith("get_") || cmd.startsWith("scan_")) return [];
    if (cmd.startsWith("save_") || cmd.startsWith("delete_") || cmd.startsWith("update_") || cmd.startsWith("add_")) return workspace;
    return null;
  },
};

(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = internals;
(window as unknown as { __TAURI_EVENT_PLUGIN_INTERNALS__: unknown }).__TAURI_EVENT_PLUGIN_INTERNALS__ = {
  unregisterListener: () => {},
};
(window as unknown as { __TOUR_WORKSPACE__: Workspace }).__TOUR_WORKSPACE__ = workspace;

// Un état local propre à chaque tour : les préférences vivent en
// `localStorage`, et un thème choisi lors d'un passage précédent fausserait
// les captures du suivant.
// `?keep=1` : garder ce que le passage précédent a laissé en `localStorage`
// — pour vérifier ce qui doit justement survivre à un rechargement.
if (!new URLSearchParams(location.search).has("keep")) localStorage.clear();
// `?mode=light` : le tour en thème clair, décidé avant que l'app ne lise ses
// préférences — même clé que `lib/preferences.ts`.
const mode = new URLSearchParams(location.search).get("mode");
if (mode === "light") localStorage.setItem("gui-termius-prefs", JSON.stringify({ colorMode: "light" }));

await import("../src/main");
