import { useEffect, useRef, useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { api } from "../lib/api";
import type { DockerContainer, Group, GroupId, Host, HostId, Workspace } from "../lib/types";
import { HostIcon } from "./icons";
import { hostKindMeta } from "../lib/hostKinds";
import { ramColor } from "../lib/facts";
import { formatRelativeTime } from "../lib/format";
import { ConnectionPickerModal } from "./ConnectionPickerModal";
import {
  IconHosts, IconSearch, IconPlus, IconKeyboard, IconFlash,
  IconFolder, IconChevronDown, IconChevronRight,
  IconDotsVertical, IconEdit,
  IconUpload, IconDownload, IconTransfer,
} from "./ui-icons";

// Example-only pods for the Kubernetes picker — k8sExec has no backend yet,
// see HostKind's doc comment in lib/types.ts.
const K8S_MOCK_PODS = [
  { id: "api-7d9f8b6c-x2kq9", name: "api-7d9f8b6c-x2kq9", meta: "default", up: true },
  { id: "worker-5c7d8f9b-p4m2n", name: "worker-5c7d8f9b-p4m2n", meta: "default", up: true },
  { id: "migration-job-8f2a1", name: "migration-job-8f2a1", meta: "batch · Completed", up: false },
];

interface HostsPanelProps {
  workspace: Workspace;
  activeHostId?: HostId | null;
  onConnect: (host: Host) => void;
  onConnectDocker: (host: Host, containerId: string) => void;
  onConnectRdpView: (host: Host) => void;
  onOpenTransfer: (host: Host) => void;
  onOpenLocalTerminal: (shell?: string) => void;
  onNewHost: () => void;
  onEditHost: (host: Host) => void;
  onNewGroup: () => void;
  onNewHostInGroup: (groupId: GroupId) => void;
  onNewGroupUnder: (parentId: GroupId) => void;
  onEditGroup: (group: Group) => void;
  onQuickSSH: (cmd: string) => void;
  onWorkspaceUpdate?: (ws: Workspace) => void;
  onError?: (msg: string) => void;
}

function parseSSHInput(raw: string): { username: string; address: string; port: number } | null {
  const str = raw.trim().replace(/^ssh\s+/, "");
  const m = str.match(/^([^@\s]+)@([^:\s]+)(?::(\d+))?$/);
  if (!m) return null;
  const port = m[3] ? parseInt(m[3], 10) : 22;
  if (!port || port < 1 || port > 65535) return null;
  return { username: m[1], address: m[2], port };
}

function LocalTerminalButton({ onOpen }: { onOpen: (shell?: string) => void }) {
  const [open, setOpen] = useState(false);
  const [shells, setShells] = useState<{ id: string; label: string }[] | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    window.addEventListener("mousedown", onDocDown);
    return () => window.removeEventListener("mousedown", onDocDown);
  }, [open]);

  const togglePicker = () => {
    setOpen((v) => !v);
    if (!shells) api.listLocalShells().then(setShells).catch(() => setShells([]));
  };

  return (
    <div ref={ref} className="relative flex shrink-0">
      <button
        onClick={() => onOpen()}
        title="Ouvrir un terminal local (shell par défaut)"
        className="flex items-center justify-center rounded-l-xl border border-r-0 border-white/5 bg-[var(--c-bg3)] px-3 py-2 text-[var(--c-text-muted)] hover:border-[var(--c-accent)] hover:text-[var(--c-accent-text)]"
      >
        <IconKeyboard size={15} />
      </button>
      <button
        onClick={togglePicker}
        title="Choisir un shell"
        className="flex items-center justify-center rounded-r-xl border border-white/5 bg-[var(--c-bg3)] px-1 text-[var(--c-text-muted)] hover:border-[var(--c-accent)] hover:text-[var(--c-accent-text)]"
      >
        <IconChevronDown size={11} />
      </button>
      {open && (
        <div className="absolute right-0 top-full z-20 mt-1 w-52 overflow-hidden rounded-md border border-[var(--c-border)] bg-[var(--c-bg2)] py-1 shadow-[var(--shadow-lg)]">
          {shells === null && <p className="px-3 py-2 text-[12px] text-[var(--c-text-muted)]">Recherche des shells…</p>}
          {shells?.length === 0 && <p className="px-3 py-2 text-[12px] text-[var(--c-text-muted)]">Aucun shell détecté</p>}
          {shells?.map((s) => (
            <button
              key={s.id}
              onClick={() => { onOpen(s.id); setOpen(false); }}
              className="flex w-full items-center px-3 py-1.5 text-left text-[13px] text-[var(--c-text-secondary)] hover:bg-white/5 hover:text-[var(--c-text)]"
            >
              {s.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function HostsPanel({
  workspace, activeHostId, onConnect, onConnectDocker, onConnectRdpView, onOpenTransfer, onOpenLocalTerminal,
  onNewHost, onEditHost, onNewGroup, onNewHostInGroup, onNewGroupUnder,
  onEditGroup, onQuickSSH, onWorkspaceUpdate, onError,
}: HostsPanelProps) {
  const [search, setSearch] = useState("");
  const [collapsed, setCollapsed] = useState<Set<GroupId>>(new Set());
  const [openMenuHostId, setOpenMenuHostId] = useState<HostId | null>(null);
  const [showAddMenu, setShowAddMenu] = useState(false);
  const [hostStatus, setHostStatus] = useState<Record<string, boolean>>({});
  const [containerCounts, setContainerCounts] = useState<Record<string, number | null>>({});
  const [exportPendingHost, setExportPendingHost] = useState<Host | null>(null);
  const [dockerPickerHost, setDockerPickerHost] = useState<Host | null>(null);
  const [dockerContainers, setDockerContainers] = useState<DockerContainer[] | null>(null);
  const [dockerPickerError, setDockerPickerError] = useState<string | null>(null);
  const [k8sPickerHost, setK8sPickerHost] = useState<Host | null>(null);

  const hostIdsKey = workspace.hosts.map((h) => h.id).join(",");
  useEffect(() => {
    let cancelled = false;
    const poll = () => {
      for (const host of workspace.hosts) {
        if ((host.kind ?? "ssh") !== "ssh") continue;
        api.checkHostStatus(host.id)
          .then((online) => { if (!cancelled) setHostStatus((prev) => ({ ...prev, [host.id]: online })); })
          .catch(() => { if (!cancelled) setHostStatus((prev) => ({ ...prev, [host.id]: false })); });
      }
    };
    poll();
    const interval = setInterval(poll, 30000);
    return () => { cancelled = true; clearInterval(interval); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostIdsKey]);

  // Live "N actifs" count shown right in the list for Docker hosts, so the
  // daemon's state is visible before ever opening the container picker.
  useEffect(() => {
    let cancelled = false;
    const dockerHosts = workspace.hosts.filter((h) => h.kind === "dockerExec");
    const poll = () => {
      for (const host of dockerHosts) {
        api.listDockerContainers(host.id)
          .then((containers) => {
            if (cancelled) return;
            const running = containers.filter((c) => c.state === "running").length;
            setContainerCounts((prev) => ({ ...prev, [host.id]: running }));
          })
          .catch(() => { if (!cancelled) setContainerCounts((prev) => ({ ...prev, [host.id]: null })); });
      }
    };
    poll();
    const interval = setInterval(poll, 30000);
    return () => { cancelled = true; clearInterval(interval); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostIdsKey]);

  const openDockerPicker = (host: Host) => {
    setDockerPickerHost(host);
    setDockerContainers(null);
    setDockerPickerError(null);
    api.listDockerContainers(host.id)
      .then(setDockerContainers)
      .catch((e) => setDockerPickerError(String(e)));
  };

  const handleConnect = (host: Host) => {
    const kind = host.kind ?? "ssh";
    if (kind === "ssh") { onConnect(host); return; }
    if (kind === "dockerExec") { openDockerPicker(host); return; }
    if (kind === "k8sExec") { setK8sPickerHost(host); return; }
    // rdp: the embedded preview is the default click, same as any other
    // host kind — the system client launcher (mstsc.exe/xfreerdp, fully
    // interactive but not view-only) moved to the "…" menu, see below.
    onConnectRdpView(host);
  };

  const quickSSH = parseSSHInput(search);

  const handleQuickConnect = () => {
    if (!quickSSH) return;
    const { username, address, port } = quickSSH;
    const cmd = port === 22 ? `ssh ${username}@${address}` : `ssh -p ${port} ${username}@${address}`;
    onQuickSSH(cmd);
    setSearch("");
  };

  const query = search.trim().toLowerCase();
  const matches = (host: Host) =>
    !query || host.label.toLowerCase().includes(query) || host.address.toLowerCase().includes(query) ||
    host.username.toLowerCase().includes(query) || host.tags.some((t) => t.toLowerCase().includes(query));

  const childGroups = (parentId: GroupId | null) =>
    workspace.groups.filter((g) => g.parentId === parentId).sort((a, b) => a.name.localeCompare(b.name));
  const hostsIn = (groupId: GroupId | null) =>
    workspace.hosts.filter((h) => h.groupId === groupId && matches(h)).sort((a, b) => a.label.localeCompare(b.label));
  const isExpanded = (id: GroupId) => (query ? true : !collapsed.has(id));

  function groupHasMatches(groupId: GroupId): boolean {
    if (hostsIn(groupId).length > 0) return true;
    return childGroups(groupId).some((g) => groupHasMatches(g.id));
  }

  const toggleGroup = (id: GroupId) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const fileFilters = [{ name: "JSON", extensions: ["json"] }];

  /// Whether `host` authenticates with a keychain-stored private key — the only
  /// case where an export can carry actual key material (see `doExportHost`).
  const hostUsesKeychainKey = (host: Host) =>
    typeof host.auth === "object" && "privateKey" in host.auth && host.auth.privateKey.keyId !== null;

  const doExportHost = async (host: Host, includeKeyMaterial: boolean) => {
    try {
      const safeName = host.label.replace(/[^a-zA-Z0-9_-]/g, "_");
      const path = await save({ title: "Exporter l'hôte", defaultPath: `${safeName}.json`, filters: fileFilters });
      if (path) await api.exportHost(host.id, path, includeKeyMaterial);
    } catch (e) { onError?.(String(e)); }
  };

  const handleExportHost = (host: Host) => {
    if (hostUsesKeychainKey(host)) {
      setExportPendingHost(host);
    } else {
      doExportHost(host, false);
    }
  };

  const handleImportHost = async () => {
    try {
      const path = await open({ title: "Importer un hôte", multiple: false, filters: fileFilters });
      if (path && typeof path === "string") {
        const ws = await api.importHostFromFile(path);
        onWorkspaceUpdate?.(ws);
      }
    } catch (e) { onError?.(String(e)); }
  };

  // ── Host card ────────────────────────────────────────────────────────────
  const renderHost = (host: Host, depth: number) => {
    const menuOpen = openMenuHostId === host.id;
    const isActive = host.id === activeHostId;
    const kind = host.kind ?? "ssh";
    const { label: kindLabel, Icon: KindIcon } = hostKindMeta(kind);
    const subtitle =
      kind === "dockerExec" ? host.address :
      kind === "k8sExec" ? `Contexte : ${host.address}` :
      kind === "rdp" ? `${host.username}@${host.address}${host.port !== 3389 ? `:${host.port}` : ""}` :
      `${host.username}@${host.address}${host.port !== 22 ? `:${host.port}` : ""}`;
    const runningCount = kind === "dockerExec" ? containerCounts[host.id] : undefined;
    return (
      <div
        key={host.id}
        style={{ marginLeft: depth * 14 }}
        className={`group rounded-xl border bg-[var(--c-bg3)] transition-all ${
          isActive
            ? "glow-ring border-transparent"
            : menuOpen
              ? "border-white/15"
              : "border-transparent hover:border-white/15"
        }`}
      >
        {/* Header row */}
        <div className="flex items-stretch">
          {/* Connect zone */}
          <button
            onClick={() => handleConnect(host)}
            className="flex min-w-0 flex-1 items-center gap-2.5 p-3 text-left"
            title={kind === "ssh" ? `Connecter — ${subtitle}` : kind === "rdp" ? `Aperçu intégré — ${subtitle}` : kindLabel}
          >
            <div className="relative flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-[var(--c-accent-dim)]">
              {host.icon
                ? <HostIcon iconId={host.icon} customIcons={workspace.customIcons} size={24} />
                : <IconHosts size={18} className="text-[var(--c-accent-text)]" />
              }
              {kind !== "ssh" && (
                <span
                  title={kindLabel}
                  className="absolute -left-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full border-2 border-[var(--c-bg3)] bg-[var(--c-bg2)] text-[var(--c-text-secondary)]"
                >
                  <KindIcon size={9} />
                </span>
              )}
              {hostStatus[host.id] !== undefined && (
                <span
                  title={hostStatus[host.id] ? "En ligne" : "Hors ligne"}
                  className={`absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-[var(--c-bg2)] ${
                    hostStatus[host.id] ? "bg-emerald-500" : "bg-[var(--c-text-faint)]"
                  }`}
                />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="truncate text-[14px] font-medium text-[var(--c-text)]">{host.label}</span>
                {runningCount != null && (
                  <span className="shrink-0 rounded-full bg-sky-500/15 px-1.5 py-0.5 text-[9.5px] font-semibold text-sky-300">
                    {runningCount} actif{runningCount === 1 ? "" : "s"}
                  </span>
                )}
              </div>
              <div className="truncate font-mono text-[11px] text-[var(--c-text-muted)]">{subtitle}</div>
              {kind === "ssh" && host.lastFacts && (
                <div className="mt-0.5 space-y-0.5 text-[10.5px]">
                  {(host.lastFacts.osName || host.lastFacts.osId) && (
                    <div className="truncate text-[var(--c-text-faint)]">{host.lastFacts.osName || host.lastFacts.osId}</div>
                  )}
                  <div className="flex items-center gap-2 truncate">
                    {host.lastFacts.memUsedPct != null && (
                      <span className="shrink-0 font-medium" style={{ color: ramColor(host.lastFacts.memUsedPct) }}>
                        RAM {Math.round(host.lastFacts.memUsedPct)}%
                      </span>
                    )}
                    {host.lastFactsAtMs != null && (
                      <span className="truncate text-[var(--c-text-faint)]">état {formatRelativeTime(host.lastFactsAtMs)}</span>
                    )}
                  </div>
                </div>
              )}
            </div>
          </button>
          {/* Menu toggle */}
          <button
            onClick={(e) => { e.stopPropagation(); setOpenMenuHostId(menuOpen ? null : host.id); }}
            className={`flex shrink-0 items-center px-2 transition-all focus-visible:opacity-100 ${
              menuOpen
                ? "text-[var(--c-text-secondary)]"
                : "text-[var(--c-text-faint)] opacity-0 hover:text-[var(--c-text-secondary)] group-hover:opacity-100 group-focus-within:opacity-100"
            }`}
            title="Options"
          >
            <IconDotsVertical size={14} />
          </button>
        </div>

        {/* Tags */}
        {host.tags.length > 0 && (
          <div className="flex flex-wrap gap-1 px-3 pb-2.5">
            {host.tags.map((tag) => (
              <span key={tag} className="rounded-full bg-[var(--c-bg2)] px-1.5 py-0.5 text-[10px] text-[var(--c-text-secondary)]">
                {tag}
              </span>
            ))}
          </div>
        )}

        {/* Expanded actions */}
        {menuOpen && (
          <div className="flex flex-wrap gap-1 p-2 pt-0">
            <button
              onClick={() => { onEditHost(host); setOpenMenuHostId(null); }}
              className="flex flex-1 basis-[80px] items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-[var(--c-text-secondary)] hover:bg-white/5"
            >
              <IconEdit size={12} /> Éditer
            </button>
            <button
              onClick={() => { handleExportHost(host); setOpenMenuHostId(null); }}
              className="flex flex-1 basis-[80px] items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-[var(--c-text-secondary)] hover:bg-white/5"
            >
              <IconUpload size={12} /> Exporter
            </button>
            {kind === "rdp" && (
              <button
                onClick={() => { onOpenTransfer(host); setOpenMenuHostId(null); }}
                title="Ouvre l'aperçu intégré avec un panneau de fichiers à gauche — glisser un fichier/dossier dessus l'envoie et le colle automatiquement dans la session distante"
                className="flex flex-1 basis-[80px] items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-[var(--c-text-secondary)] hover:bg-white/5"
              >
                <IconTransfer size={12} /> Transférer des fichiers
              </button>
            )}
          </div>
        )}
      </div>
    );
  };

  // ── Group row ────────────────────────────────────────────────────────────
  const renderGroup = (group: Group, depth: number) => {
    if (query && !groupHasMatches(group.id)) return null;
    const expanded = isExpanded(group.id);
    return (
      <div key={group.id} className="space-y-1">
        <div
          style={{ marginLeft: depth * 14 }}
          className="group flex items-center gap-0.5 rounded-md px-1 py-1 hover:bg-white/5"
        >
          <button onClick={() => toggleGroup(group.id)} className="flex w-4 shrink-0 items-center justify-center text-[var(--c-text-muted)]">
            {expanded ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
          </button>
          <span className="flex min-w-0 flex-1 items-center gap-1.5 truncate text-[13px] font-medium text-[var(--c-text-secondary)]">
            {group.icon ? (
              <HostIcon iconId={group.icon} customIcons={workspace.customIcons} size={20} />
            ) : (
              <IconFolder size={18} className="text-[var(--c-text-muted)]" />
            )}
            {group.name}
          </span>
          <button
            onClick={() => onNewHostInGroup(group.id)}
            title="Nouvel hôte dans ce dossier"
            className="flex items-center p-1 text-[var(--c-text-muted)] opacity-0 hover:text-[var(--c-accent-text)] focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"
          >
            <IconHosts size={12} />
          </button>
          <button
            onClick={() => onNewGroupUnder(group.id)}
            title="Nouveau sous-dossier"
            className="flex items-center p-1 text-[var(--c-text-muted)] opacity-0 hover:text-[var(--c-accent-text)] focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"
          >
            <IconFolder size={12} />
          </button>
          <button
            onClick={() => onEditGroup(group)}
            title="Modifier ce dossier"
            className="flex items-center p-1 text-[var(--c-text-muted)] opacity-0 hover:text-[var(--c-text-secondary)] focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"
          >
            <IconEdit size={12} />
          </button>
        </div>
        {expanded && (
          <div className="space-y-1">
            {hostsIn(group.id).map((h) => renderHost(h, depth + 1))}
            {childGroups(group.id).map((g) => renderGroup(g, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="flex h-full min-w-0 flex-col gap-2">
      {/* Search — first for discoverability */}
      <div className="relative">
        <div className="pointer-events-none absolute inset-y-0 left-3 flex items-center">
          <IconSearch size={13} className="text-[var(--c-text-muted)]" />
        </div>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && quickSSH) handleQuickConnect(); }}
          placeholder="Rechercher ou ssh user@hôte…"
          className="w-full rounded-xl border border-white/5 bg-[var(--c-bg3)] pl-8 pr-3 py-2 text-[13px] text-[var(--c-text)] placeholder:text-[var(--c-text-muted)] focus:border-transparent focus:outline-none focus:ring-2 focus:ring-[var(--c-accent)]"
        />
      </div>

      {/* Action buttons */}
      <div className="flex gap-1.5">
        <div className="relative flex-1">
          {showAddMenu && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setShowAddMenu(false)} />
              <div className="absolute left-0 right-0 top-full z-20 mt-1 overflow-hidden rounded-xl border border-white/5 bg-[var(--c-bg2)] py-1 shadow-[var(--shadow-lg)]">
                <button
                  onClick={() => { onNewHost(); setShowAddMenu(false); }}
                  className="flex w-full items-center gap-2 px-3 py-2 text-[13px] text-[var(--c-text-secondary)] hover:bg-[var(--c-bg3)]"
                >
                  <IconPlus size={14} /> Nouvel hôte
                </button>
                <button
                  onClick={() => { onNewGroup(); setShowAddMenu(false); }}
                  className="flex w-full items-center gap-2 px-3 py-2 text-[13px] text-[var(--c-text-secondary)] hover:bg-[var(--c-bg3)]"
                >
                  <IconFolder size={14} /> Nouveau dossier
                </button>
                <div className="my-1 border-t border-[var(--c-border)]" />
                <button
                  onClick={() => { handleImportHost(); setShowAddMenu(false); }}
                  className="flex w-full items-center gap-2 px-3 py-2 text-[13px] text-[var(--c-text-secondary)] hover:bg-[var(--c-bg3)]"
                >
                  <IconDownload size={14} /> Importer un hôte
                </button>
              </div>
            </>
          )}
          <button
            onClick={() => setShowAddMenu((v) => !v)}
            className={`accent-surface flex w-full items-center justify-center gap-1.5 rounded-xl border py-2 text-xs font-semibold transition-all ${
              showAddMenu ? "ring-2 ring-white/25" : ""
            }`}
          >
            <IconPlus size={13} />
            Ajouter…
          </button>
        </div>
        <LocalTerminalButton onOpen={onOpenLocalTerminal} />
      </div>

      {/* Host list */}
      <div className="sidebar-scroll min-h-0 min-w-0 flex-1 space-y-1 overflow-y-auto pb-2 pl-2 pt-2">
        {quickSSH && (
          <button
            onClick={handleQuickConnect}
            className="accent-surface-hover flex w-full items-center gap-2 rounded-xl border border-[var(--c-accent-dim)] bg-[var(--c-accent-dim)] px-3 py-2 text-left text-[13px] text-[var(--c-accent-text)] hover:text-white"
          >
            <IconFlash size={13} className="shrink-0" />
            <span className="min-w-0 truncate font-mono">
              <span className="font-medium">{quickSSH.username}@{quickSSH.address}</span>
              {quickSSH.port !== 22 && <span className="opacity-70">:{quickSSH.port}</span>}
            </span>
            <span className="ml-auto shrink-0 text-[10px] opacity-60">Entrée pour se connecter</span>
          </button>
        )}
        {hostsIn(null).map((h) => renderHost(h, 0))}
        {childGroups(null).map((g) => renderGroup(g, 0))}
        {!quickSSH && workspace.hosts.length === 0 && workspace.groups.length === 0 && (
          <p className="px-1 py-4 text-center text-[13px] text-[var(--c-text-muted)]">Aucun hôte enregistré</p>
        )}
      </div>

      {exportPendingHost && (
        <>
          <div className="fixed inset-0 z-30 bg-black/50" onClick={() => setExportPendingHost(null)} />
          <div className="fixed left-1/2 top-1/2 z-40 w-[420px] max-w-[90vw] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-lg bg-[var(--c-bg2)] shadow-[var(--shadow-lg)]">
            <div className="border-b border-[var(--c-border)] px-4 py-3">
              <p className="text-[14px] font-medium text-[var(--c-text)]">Exporter « {exportPendingHost.label} »</p>
              <p className="mt-0.5 text-[11px] text-[var(--c-text-muted)]">
                Cet hôte utilise une clé du trousseau. Faut-il l'inclure dans le fichier exporté ?
              </p>
            </div>
            <div className="p-3">
              <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-2 text-[12px] text-amber-200">
                La clé privée serait écrite en clair, non chiffrée, dans le fichier JSON. Ne la partagez qu'avec des personnes de confiance, sur un canal sûr.
              </p>
            </div>
            <div className="flex gap-1.5 border-t border-[var(--c-border)] p-2">
              <button
                onClick={() => { const h = exportPendingHost; setExportPendingHost(null); doExportHost(h, false); }}
                className="accent-surface flex-1 rounded-md border py-1.5 text-xs font-medium"
              >
                Exporter sans la clé
              </button>
              <button
                onClick={() => { const h = exportPendingHost; setExportPendingHost(null); doExportHost(h, true); }}
                className="flex-1 rounded-md bg-rose-900/40 py-1.5 text-xs font-medium text-rose-200 hover:bg-rose-900/60"
              >
                Inclure la clé privée
              </button>
            </div>
          </div>
        </>
      )}

      {dockerPickerHost && (
        <ConnectionPickerModal
          title={`Conteneurs Docker — ${dockerPickerHost.label}`}
          loading={dockerContainers === null && !dockerPickerError}
          error={dockerPickerError}
          items={(dockerContainers ?? []).map((c) => ({
            id: c.id,
            name: c.name || c.id.slice(0, 12),
            meta: `${c.image} · ${c.status}`,
            up: c.state === "running",
          }))}
          onPick={(containerId) => { onConnectDocker(dockerPickerHost, containerId); setDockerPickerHost(null); }}
          onClose={() => setDockerPickerHost(null)}
        />
      )}

      {k8sPickerHost && (
        <ConnectionPickerModal
          title={`Pods Kubernetes — ${k8sPickerHost.label}`}
          warning="Aperçu avec des données d'exemple — le backend Kubernetes n'est pas encore implémenté."
          loading={false}
          items={K8S_MOCK_PODS}
          onPick={() => { setK8sPickerHost(null); onError?.("Aperçu uniquement — l'exécution Kubernetes n'est pas encore implémentée."); }}
          onClose={() => setK8sPickerHost(null)}
        />
      )}
    </div>
  );
}
