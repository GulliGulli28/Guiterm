import { useState } from "react";
import { api } from "../lib/api";
import type { Group, GroupId, Host, Workspace } from "../lib/types";
import { HostIcon } from "./icons";
import { hostKindMeta } from "../lib/hostKinds";
import { IconSearch, IconFolder, IconTransfer, IconChevronDown, IconChevronRight } from "./ui-icons";
import { usePolledHostStat } from "../hooks/usePolledHostStat";
import { useContainerPicker } from "../hooks/useContainerPicker";

interface SftpPanelProps {
  workspace: Workspace;
  onOpenTransfer: (host: Host, dockerContainerId?: string, k8sPodName?: string, k8sContainerName?: string | null) => void;
}

export function SftpPanel({ workspace, onOpenTransfer }: SftpPanelProps) {
  const [search, setSearch] = useState("");
  const [collapsed, setCollapsed] = useState<Set<GroupId>>(new Set());
  // Unlike HostsPanel's equivalent poll, this one isn't filtered to SSH
  // hosts only — kept as-is (pre-existing behavior, not changed here).
  const hostStatus = usePolledHostStat(workspace.hosts, () => true, (h) => api.checkHostStatus(h.id), false);

  // Docker exec repurposes a saved host as a daemon entry point — opening a
  // transfer tab against one needs a live container picked first, same as
  // `HostsPanel.tsx`'s `openDockerPicker`. Same idea for K8s exec, one level
  // deeper (a pod, and if it has more than one container, which container).
  const { openDockerPicker, openK8sPicker, pickerModal } = useContainerPicker(
    (host, containerId) => onOpenTransfer(host, containerId),
    (host, podName, containerName) => onOpenTransfer(host, undefined, podName, containerName),
  );

  const query = search.trim().toLowerCase();
  // rdp hosts have no file-listing backend — SFTP-shaped browsing only
  // applies to ssh/dockerExec/k8sExec (see `TransferTab.tsx`'s source
  // picker, filtered the same way).
  const supportsTransfer = (host: Host) => {
    const kind = host.kind ?? "ssh";
    return kind === "ssh" || kind === "dockerExec" || kind === "k8sExec";
  };
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
    const isK8s = kind === "k8sExec";
    const { label: kindLabel, Icon: KindIcon } = hostKindMeta(kind);
    const subtitle = isDocker || isK8s ? host.address : `${host.username}@${host.address}${host.port !== 22 ? `:${host.port}` : ""}`;
    const online = hostStatus[host.id];
    return (
      <div key={host.id} className="list-row group mb-0.5 min-h-11 py-1.5 pr-1.5" style={{ paddingLeft: 8 + depth * 14 }}>
        <button
          onClick={() => (isDocker ? openDockerPicker(host) : isK8s ? openK8sPicker(host) : onOpenTransfer(host))}
          className="flex min-w-0 flex-1 items-start gap-2.5 text-left"
          title={isDocker || isK8s ? kindLabel : `Transférer — ${subtitle}`}
        >
          <span className="relative mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-[var(--c-bg3)] text-[var(--c-text-secondary)]">
            {host.icon
              ? <HostIcon iconId={host.icon} customIcons={workspace.customIcons} size={16} />
              : <KindIcon size={13} />}
            {online !== undefined && (
              <span
                title={online ? "En ligne" : "Hors ligne"}
                className={`dot absolute -bottom-0.5 -right-0.5 ring-2 ring-[var(--c-bg2)] ${online ? "dot-ok" : ""}`}
              />
            )}
          </span>
          <span className="flex min-w-0 flex-1 flex-col justify-center gap-0.5 leading-tight">
            <span className="truncate text-[12.5px] font-medium text-[var(--c-text)]">{host.label}</span>
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="max-w-full break-all font-mono text-[10.5px] text-[var(--c-text-muted)]">{subtitle}</span>
              {host.tags.length > 0 && (
                <span className="flex flex-wrap gap-1">
                  {host.tags.map((tag) => <span key={tag} className="tag">{tag}</span>)}
                </span>
              )}
            </span>
          </span>
        </button>
        <span className="flex h-6 w-6 shrink-0 items-center justify-center text-[var(--c-text-muted)] opacity-0 transition-opacity group-hover:opacity-100">
          <IconTransfer size={13} />
        </span>
      </div>
    );
  };

  const renderGroup = (group: Group, depth: number) => {
    if (query && !groupHasMatches(group.id)) return null;
    const expanded = isExpanded(group.id);
    return (
      <div key={group.id}>
        <div
          style={{ paddingLeft: 4 + depth * 14 }}
          className="mt-1 flex h-7 items-center gap-1 rounded-md pr-1 hover:bg-[var(--c-hover)]"
        >
          <button
            onClick={() => toggleGroup(group.id)}
            aria-label={expanded ? `Replier ${group.name}` : `Déplier ${group.name}`}
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded-sm text-[var(--c-text-muted)] hover:text-[var(--c-text)]"
          >
            {expanded ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
          </button>
          <button onClick={() => toggleGroup(group.id)} className="flex min-w-0 flex-1 items-center gap-1.5 truncate text-left text-[12.5px] font-medium text-[var(--c-text-secondary)]">
            {group.icon ? (
              <HostIcon iconId={group.icon} customIcons={workspace.customIcons} size={15} />
            ) : (
              <IconFolder size={14} className="shrink-0 text-[var(--c-text-muted)]" />
            )}
            <span className="truncate">{group.name}</span>
          </button>
        </div>
        {expanded && (
          <div>
            {hostsIn(group.id).map((h) => renderHost(h, depth + 1))}
            {childGroups(group.id).map((g) => renderGroup(g, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className="relative shrink-0">
        <div className="pointer-events-none absolute inset-y-0 left-2.5 flex items-center">
          <IconSearch size={13} className="text-[var(--c-text-muted)]" />
        </div>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Rechercher un hôte…"
          className="input pl-8"
        />
      </div>
      <p className="eyebrow mt-3.5 pl-1">Ouvrir un transfert vers</p>
      <div className="sidebar-scroll -mx-1 mt-1 min-h-0 min-w-0 flex-1 overflow-y-auto px-1 pb-2">
        {hostsIn(null).map((h) => renderHost(h, 0))}
        {childGroups(null).map((g) => renderGroup(g, 0))}
        {workspace.hosts.length === 0 && (
          <div className="px-2 py-8 text-center">
            <p className="text-[12.5px] font-medium text-[var(--c-text-secondary)]">Aucun hôte enregistré</p>
            <p className="help-text mt-1">Les hôtes SSH, Docker et Kubernetes apparaissent ici pour ouvrir un panneau de fichiers.</p>
          </div>
        )}
      </div>

      {pickerModal}
    </div>
  );
}
