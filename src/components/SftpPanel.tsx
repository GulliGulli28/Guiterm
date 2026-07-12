import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type { DockerContainer, Group, GroupId, Host, Workspace } from "../lib/types";
import { HostIcon } from "./icons";
import { hostKindMeta } from "../lib/hostKinds";
import { ConnectionPickerModal } from "./ConnectionPickerModal";
import { IconSearch, IconHosts, IconFolder, IconTransfer, IconChevronDown, IconChevronRight } from "./ui-icons";

interface SftpPanelProps {
  workspace: Workspace;
  onOpenTransfer: (host: Host, containerId?: string) => void;
}

export function SftpPanel({ workspace, onOpenTransfer }: SftpPanelProps) {
  const [search, setSearch] = useState("");
  const [collapsed, setCollapsed] = useState<Set<GroupId>>(new Set());
  const [hostStatus, setHostStatus] = useState<Record<string, boolean>>({});
  // Docker exec repurposes a saved host as a daemon entry point — opening a
  // transfer tab against one needs a live container picked first, same as
  // `HostsPanel.tsx`'s `openDockerPicker`.
  const [dockerPickerHost, setDockerPickerHost] = useState<Host | null>(null);
  const [dockerContainers, setDockerContainers] = useState<DockerContainer[] | null>(null);
  const [dockerPickerError, setDockerPickerError] = useState<string | null>(null);
  const openDockerPicker = (host: Host) => {
    setDockerPickerHost(host);
    setDockerContainers(null);
    setDockerPickerError(null);
    api.listDockerContainers(host.id).then(setDockerContainers).catch((e) => setDockerPickerError(String(e)));
  };

  const hostIdsKey = workspace.hosts.map((h) => h.id).join(",");
  useEffect(() => {
    let cancelled = false;
    const poll = () => {
      for (const host of workspace.hosts) {
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

  const query = search.trim().toLowerCase();
  // rdp/k8sExec hosts have no file-listing backend — SFTP-shaped browsing
  // only applies to ssh/dockerExec (see `TransferTab.tsx`'s source picker,
  // filtered the same way).
  const supportsTransfer = (host: Host) => (host.kind ?? "ssh") === "ssh" || (host.kind ?? "ssh") === "dockerExec";
  const matches = (host: Host) =>
    supportsTransfer(host) &&
    (!query || host.label.toLowerCase().includes(query) || host.address.toLowerCase().includes(query) ||
    host.username.toLowerCase().includes(query) || host.tags.some((t) => t.toLowerCase().includes(query)));

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

  const renderHost = (host: Host, depth: number) => {
    const kind = host.kind ?? "ssh";
    const isDocker = kind === "dockerExec";
    const subtitle = isDocker ? host.address : `${host.username}@${host.address}${host.port !== 22 ? `:${host.port}` : ""}`;
    return (
    <div
      key={host.id}
      style={{ marginLeft: depth * 14 }}
      className="group rounded-xl border border-transparent bg-[var(--c-bg3)] transition-all hover:border-white/15"
    >
      <div className="flex items-stretch">
        <button
          onClick={() => (isDocker ? openDockerPicker(host) : onOpenTransfer(host))}
          className="flex min-w-0 flex-1 items-center gap-2.5 p-3 text-left"
          title={isDocker ? hostKindMeta(kind).label : `Transférer — ${subtitle}`}
        >
          <div className="relative flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-[var(--c-accent-dim)]">
            {host.icon
              ? <HostIcon iconId={host.icon} customIcons={workspace.customIcons} size={24} />
              : <IconHosts size={18} className="text-[var(--c-accent-text)]" />
            }
            {isDocker && (
              <span
                title={hostKindMeta(kind).label}
                className="absolute -left-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full border-2 border-[var(--c-bg3)] bg-[var(--c-bg2)] text-[var(--c-text-secondary)]"
              >
                {(() => { const { Icon } = hostKindMeta(kind); return <Icon size={9} />; })()}
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
            <div className="truncate text-[14px] font-medium text-[var(--c-text)]">{host.label}</div>
            <div className="truncate font-mono text-[11px] text-[var(--c-text-muted)]">{subtitle}</div>
          </div>
        </button>
        <div className="flex shrink-0 items-center px-2 text-[var(--c-text-faint)] opacity-0 transition-all focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100">
          <IconTransfer size={14} />
        </div>
      </div>

      {host.tags.length > 0 && (
        <div className="flex flex-wrap gap-1 px-3 pb-2.5">
          {host.tags.map((tag) => (
            <span key={tag} className="rounded-full bg-[var(--c-bg2)] px-1.5 py-0.5 text-[10px] text-[var(--c-text-secondary)]">
              {tag}
            </span>
          ))}
        </div>
      )}
    </div>
    );
  };

  const renderGroup = (group: Group, depth: number) => {
    if (query && !groupHasMatches(group.id)) return null;
    const expanded = isExpanded(group.id);
    return (
      <div key={group.id} className="space-y-1">
        <div
          style={{ marginLeft: depth * 14 }}
          className="flex items-center gap-0.5 rounded-md px-1 py-1 hover:bg-white/5"
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
      <div className="relative">
        <div className="pointer-events-none absolute inset-y-0 left-3 flex items-center">
          <IconSearch size={13} className="text-[var(--c-text-muted)]" />
        </div>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Rechercher un hôte…"
          className="w-full rounded-xl border border-white/5 bg-[var(--c-bg3)] pl-8 pr-3 py-2 text-[13px] text-[var(--c-text)] placeholder:text-[var(--c-text-muted)] focus:border-transparent focus:outline-none focus:ring-2 focus:ring-[var(--c-accent)]"
        />
      </div>
      <div className="sidebar-scroll min-h-0 min-w-0 flex-1 space-y-1 overflow-y-auto pb-2 pl-2 pt-2">
        {hostsIn(null).map((h) => renderHost(h, 0))}
        {childGroups(null).map((g) => renderGroup(g, 0))}
        {workspace.hosts.length === 0 && (
          <p className="px-1 py-4 text-center text-[13px] text-[var(--c-text-muted)]">Aucun hôte enregistré</p>
        )}
      </div>

      {dockerPickerHost && (
        <ConnectionPickerModal
          title={`Conteneurs Docker — ${dockerPickerHost.label}`}
          loading={dockerContainers === null && !dockerPickerError}
          error={dockerPickerError}
          items={(dockerContainers ?? []).map((c) => ({ id: c.id, name: c.name || c.id.slice(0, 12), meta: `${c.image} · ${c.status}`, up: c.state === "running" }))}
          onPick={(containerId) => { onOpenTransfer(dockerPickerHost, containerId); setDockerPickerHost(null); }}
          onClose={() => setDockerPickerHost(null)}
        />
      )}
    </div>
  );
}
