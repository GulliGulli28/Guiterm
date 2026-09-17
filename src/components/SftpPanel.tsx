import { useMemo, useRef, useState } from "react";
import { api } from "../lib/api";
import type { Group, GroupId, Host, Workspace } from "../lib/types";
import { HostIcon, hasIcon } from "./icons";
import { hostKindMeta } from "../lib/hostKinds";
import { buildHostTree } from "../lib/hostTree";
import { sectionRoleLabel, splitTreeByVault, type VaultSection } from "../lib/vaultSections";
import { IconSearch, IconFolder, IconTransfer, IconVault } from "./ui-icons";
import { EntityRow, EntityMono, EntityTags, GroupRow } from "./EntityRow";
import { usePolledHostStat } from "../hooks/usePolledHostStat";
import { useContainerPicker } from "../hooks/useContainerPicker";
import { useHostTreeMemory } from "../hooks/useHostTreeMemory";

interface SftpPanelProps {
  workspace: Workspace;
  /** Les vaults du compte affiché : chacun est un dossier de premier niveau,
   * comme dans le panneau Hôtes. Absent = arbre à plat. */
  vaultSections?: VaultSection[] | null;
  onOpenTransfer: (host: Host, dockerContainerId?: string, k8sPodName?: string, k8sContainerName?: string | null) => void;
}

export function SftpPanel({ workspace, vaultSections: sections, onOpenTransfer }: SftpPanelProps) {
  const [search, setSearch] = useState("");
  const [collapsedVaults, setCollapsedVaults] = useState<Set<string>>(new Set());
  const listRef = useRef<HTMLDivElement>(null);
  const { collapsed, toggle: toggleGroup, onScroll: onListScroll } = useHostTreeMemory("sftp", workspace.groups, listRef);
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
  const transferable = useMemo(() => workspace.hosts.filter(supportsTransfer), [workspace.hosts]);

  // Le même arbre que le panneau Hôtes (`buildHostTree`) : un hôte dont le
  // dossier n'est pas ici — reçu d'un vault partagé sans son dossier — se
  // range à la racine au lieu de disparaître (ce panneau filtrait sur
  // `groupId === …` et perdait ces hôtes, bug du 2026-09-18), et un compte
  // affiché découpe l'arbre par vault.
  type Tree = ReturnType<typeof buildHostTree>;
  const flat = useMemo(() => buildHostTree(transferable, workspace.groups, query), [transferable, workspace.groups, query]);
  const byVault = useMemo(() => {
    if (!sections) return null;
    return splitTreeByVault(transferable, workspace.groups, workspace.vaultBindings, sections).map(({ section, hosts, groups }) => (
      { section, tree: buildHostTree(hosts, groups, query), total: hosts.length }
    ));
  }, [sections, transferable, workspace.groups, workspace.vaultBindings, query]);
  const childGroups = (parentId: GroupId | null, tree: Tree = flat) => tree.groupsByParent.get(parentId) ?? [];
  const hostsIn = (groupId: GroupId | null, tree: Tree = flat) => tree.hostsByGroup.get(groupId) ?? [];
  const isExpanded = (id: GroupId) => (query ? true : !collapsed.has(id));


  const renderHost = (host: Host, depth: number) => {
    const kind = host.kind ?? "ssh";
    const isDocker = kind === "dockerExec";
    const isK8s = kind === "k8sExec";
    const { label: kindLabel, Icon: KindIcon } = hostKindMeta(kind);
    const subtitle = isDocker || isK8s ? host.address : `${host.username}@${host.address}${host.port !== 22 ? `:${host.port}` : ""}`;
    const online = hostStatus[host.id];
    return (
      <EntityRow
        key={host.id}
        depth={depth}
        icon={
          <>
            {hasIcon(host.icon, workspace.customIcons)
              ? <span className="host-icon flex"><HostIcon iconId={host.icon} customIcons={workspace.customIcons} size={16} /></span>
              : <KindIcon size={13} />}
            {online !== undefined && (
              <span
                title={online ? "En ligne" : "Hors ligne"}
                className={`dot absolute -bottom-0.5 -right-0.5 ring-2 ring-[var(--c-bg2)] ${online ? "dot-ok" : ""}`}
              />
            )}
          </>
        }
        title={host.label}
        title_={isDocker || isK8s ? kindLabel : `Transférer — ${subtitle}`}
        secondary={<><EntityMono>{subtitle}</EntityMono><EntityTags tags={host.tags} /></>}
        onClick={() => (isDocker ? openDockerPicker(host) : isK8s ? openK8sPicker(host) : onOpenTransfer(host))}
        actions={<span className="flex h-6 w-6 items-center justify-center text-[var(--c-text-muted)]"><IconTransfer size={13} /></span>}
      />
    );
  };

  const renderGroup = (group: Group, depth: number, tree: Tree = flat) => {
    if (query && !tree.matchingGroups.has(group.id)) return null;
    const expanded = isExpanded(group.id);
    return (
      <div key={group.id}>
        <GroupRow
          depth={depth}
          expanded={expanded}
          onToggle={() => toggleGroup(group.id)}
          icon={hasIcon(group.icon, workspace.customIcons)
            ? <HostIcon iconId={group.icon} customIcons={workspace.customIcons} size={15} />
            : <IconFolder size={14} />}
          name={group.name}
          count={hostsIn(group.id, tree).length}
        />
        {expanded && (
          <div>
            {hostsIn(group.id, tree).map((h) => renderHost(h, depth + 1))}
            {childGroups(group.id, tree).map((g) => renderGroup(g, depth + 1, tree))}
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
      <div ref={listRef} onScroll={onListScroll} className="sidebar-scroll -mx-1 mt-1 min-h-0 min-w-0 flex-1 overflow-y-auto px-1 pb-2">
        {byVault ? byVault.map(({ section: sec, tree, total }) => {
          const key = sec.id ?? "personal";
          const expanded = query ? true : !collapsedVaults.has(key);
          if (query && hostsIn(null, tree).length === 0 && childGroups(null, tree).every((g) => !tree.matchingGroups.has(g.id))) return null;
          const roleLabel = sectionRoleLabel(sec);
          return (
            <div key={key} data-vault-section={sec.name}>
              <GroupRow
                depth={0}
                expanded={expanded}
                onToggle={() => setCollapsedVaults((c) => { const n = new Set(c); if (n.has(key)) n.delete(key); else n.add(key); return n; })}
                icon={<IconVault size={14} />}
                name={sec.name}
                count={total}
                badge={roleLabel ? <span className="tag" title="Vous ne faites que lire ce vault">{roleLabel}</span> : undefined}
              />
              {expanded && (
                <div className="pl-2">
                  {total === 0 && childGroups(null, tree).length === 0 && <p className="px-2 py-1.5 text-[11.5px] text-[var(--c-text-muted)]">Vide.</p>}
                  {hostsIn(null, tree).map((h) => renderHost(h, 1))}
                  {childGroups(null, tree).map((g) => renderGroup(g, 1, tree))}
                </div>
              )}
            </div>
          );
        }) : (
          <>
            {hostsIn(null).map((h) => renderHost(h, 0))}
            {childGroups(null).map((g) => renderGroup(g, 0))}
          </>
        )}
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
