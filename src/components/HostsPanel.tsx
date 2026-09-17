import { useEffect, useMemo, useRef, useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { api } from "../lib/api";
import type { Group, GroupId, Host, HostId, SqlConnection, VaultId, Workspace } from "../lib/types";
import { sectionRoleLabel, type VaultSection } from "../lib/vaultSections";
import { attachmentCount, hasAttachments, hostAttachments } from "../lib/hostGraph";
import { HostIcon, hasIcon } from "./icons";
import { hostKindMeta } from "../lib/hostKinds";
import { ramColor } from "../lib/facts";
import { formatRelativeTime } from "../lib/format";
import { buildHostTree } from "../lib/hostTree";
import { usePolledHostStat } from "../hooks/usePolledHostStat";
import { useContainerPicker } from "../hooks/useContainerPicker";
import { useHostTreeMemory } from "../hooks/useHostTreeMemory";
import { BulkEditPanel } from "./BulkEditPanel";
import { EntityRow, EntityMono, EntityTags, GroupRow } from "./EntityRow";
import { PersistentSessionsModal } from "./PersistentSessionsModal";
import {
  IconHosts, IconSearch, IconPlus, IconKeyboard, IconFlash,
  IconFolder, IconChevronDown,
  IconDotsVertical, IconEdit,
  IconUpload, IconDownload, IconTransfer, IconTunnels, IconTerminal, IconChecklist, IconVault,
} from "./ui-icons";

/** Le sélecteur de profil en tête du panneau : quel workspace est affiché. */
export interface HostsProfile {
  /** Compte connecté (e-mail), ou `null` sans compte. */
  connectedEmail: string | null;
  /** Vrai quand le profil local est affiché alors qu'un compte est connecté. */
  viewLocal: boolean;
  /** Comptes connus sur cet appareil mais pas connectés. */
  otherAccounts: { userId: string; email: string }[];
  /** Les vaults du compte affiché (personnel, puis partagés) : chacun est un
   * dossier de premier niveau de l'arbre. `null` quand ce qu'on voit n'a
   * aucune affiliation (profil local). */
  sections: VaultSection[] | null;
}

interface HostsPanelProps {
  workspace: Workspace;
  activeHostId?: HostId | null;
  /** Absent : pas de compte GuiVault ici, pas de sélecteur. */
  profile?: HostsProfile | null;
  /** `"local"` / `"account"` basculent l'affichage ; un autre compte ouvre
   * le panneau GuiVault pour s'y connecter. */
  onSwitchProfile?: (target: "local" | "account" | { userId: string }) => void;
  onConnect: (host: Host) => void;
  onConnectDocker: (host: Host, containerId: string) => void;
  onConnectK8s: (host: Host, podName: string, containerName: string | null) => void;
  onConnectRdpView: (host: Host) => void;
  onOpenTransfer: (host: Host) => void;
  /** « Est-ce que cet hôte atteint telle adresse ? » — le panneau s'ouvre avec
   * cet hôte déjà coché comme source. */
  onProbeReachability: (host: Host) => void;
  /** « Où est ce fichier ? » — recherche par nom ou par contenu sur cet hôte. */
  onSearchFiles: (host: Host) => void;
  /** Reprendre une session persistante déjà en cours sur cet hôte — en
   * écriture, ou en simple observation. */
  onResumeSession: (host: Host, sessionKey: string, readOnly?: boolean) => void;
  /** Ouvrir une base atteinte à travers cet hôte, depuis la ligne de l'hôte. */
  onConnectSql: (connection: SqlConnection) => void;
  onOpenLocalTerminal: (shell?: string) => void;
  onNewHost: () => void;
  onEditHost: (host: Host) => void;
  onNewGroup: () => void;
  /** Opens the provider picker — AWS, Azure or GCP — rather than one menu
   * entry per provider, which pushed "Nouvel hôte" down a six-item list. */
  onImportCloud: () => void;
  onImportAnsible: () => void;
  onNewHostInGroup: (groupId: GroupId) => void;
  /** Depuis l'en-tête d'un vault : le formulaire s'ouvre dans ce vault. */
  onNewHostInVault?: (vaultId: VaultId | null) => void;
  /** Depuis l'en-tête d'un vault : son contenu et ses membres, dans le
   * panneau GuiVault. */
  onOpenVault?: (vaultId: VaultId | null) => void;
  onNewGroupUnder: (parentId: GroupId) => void;
  onEditGroup: (group: Group) => void;
  onQuickSSH: (cmd: string) => void;
  onWorkspaceUpdate?: (ws: Workspace) => void;
  onError?: (msg: string) => void;
  /** Success feedback — a bulk edit that says nothing looks like it failed. */
  onNotify?: (msg: string) => void;
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
        title="Ouvrir un terminal local (Ctrl+T)"
        aria-label="Ouvrir un terminal local"
        className="btn btn-secondary btn-icon rounded-r-none text-[var(--c-text-secondary)]"
      >
        <IconKeyboard size={15} />
      </button>
      <button
        onClick={togglePicker}
        title="Choisir un shell"
        aria-label="Choisir un shell"
        className="btn btn-secondary -ml-px w-5 rounded-l-none px-0 text-[var(--c-text-muted)]"
      >
        <IconChevronDown size={10} />
      </button>
      {open && (
        <div className="popover absolute right-0 top-full z-20 mt-1 w-52 py-1">
          {shells === null && <p className="px-3 py-2 text-[12px] text-[var(--c-text-muted)]">Recherche des shells…</p>}
          {shells?.length === 0 && <p className="px-3 py-2 text-[12px] text-[var(--c-text-muted)]">Aucun shell détecté</p>}
          {shells?.map((s) => (
            <button key={s.id} onClick={() => { onOpen(s.id); setOpen(false); }} className="menu-item">
              {s.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function HostsPanel({
  workspace, activeHostId, onConnect, onConnectDocker, onConnectK8s, onConnectRdpView, onOpenTransfer, onConnectSql,
  onProbeReachability, onSearchFiles, onResumeSession, onOpenLocalTerminal,
  onNewHost, onEditHost, onNewGroup, onImportCloud, onImportAnsible, onNewHostInGroup, onNewGroupUnder,
  onEditGroup, onQuickSSH, onWorkspaceUpdate, onError, onNotify, profile, onSwitchProfile, onNewHostInVault, onOpenVault,
}: HostsPanelProps) {
  const [search, setSearch] = useState("");
  // Compte affiché : l'arbre est découpé par vault (personnel, puis chaque
  // vault partagé), chacun un dossier de premier niveau avec ses dossiers
  // dedans. Replié ou non est un confort d'affichage, pas un état du
  // workspace.
  const [collapsedVaults, setCollapsedVaults] = useState<Set<string>>(new Set());
  /** Le menu « … » d'un en-tête de vault, et où l'accrocher. */
  const [vaultMenu, setVaultMenu] = useState<{ section: VaultSection; top: number; right: number } | null>(null);
  /** Selection mode, and what is ticked in it.
   *
   * A mode rather than always-on checkboxes: the ordinary case is connecting
   * to one machine, and a permanent column of boxes would sit between the eye
   * and the host name for it. Turned on from the header, and leaving it always
   * clears the selection so nothing lingers invisibly. */
  const [selecting, setSelecting] = useState(false);
  const [selectedHosts, setSelectedHosts] = useState<Set<HostId>>(new Set());
  const toggleSelected = (id: HostId) =>
    setSelectedHosts((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const leaveSelection = () => { setSelecting(false); setSelectedHosts(new Set()); };
  const [bulkEditOpen, setBulkEditOpen] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const { collapsed, toggle: toggleGroup, onScroll: onListScroll } = useHostTreeMemory("hosts", workspace.groups, listRef);
  const [openMenuHostId, setOpenMenuHostId] = useState<HostId | null>(null);
  /** Où accrocher le menu « … » : sous son bouton, aligné à droite. */
  const [menuAnchor, setMenuAnchor] = useState<{ top: number; right: number } | null>(null);
  const [showAddMenu, setShowAddMenu] = useState(false);
  const [exportPendingHost, setExportPendingHost] = useState<Host | null>(null);
  /** L'hôte dont on regarde les sessions persistantes, s'il y en a un. */
  const [sessionsHost, setSessionsHost] = useState<Host | null>(null);
  const { openDockerPicker, openK8sPicker, pickerModal } = useContainerPicker(onConnectDocker, onConnectK8s);

  const hostStatus = usePolledHostStat(
    workspace.hosts,
    (h) => (h.kind ?? "ssh") === "ssh",
    (h) => api.checkHostStatus(h.id),
    false,
  );

  // Live "N actifs" count shown right in the list for Docker hosts, so the
  // daemon's state is visible before ever opening the container picker.
  const containerCounts = usePolledHostStat(
    workspace.hosts,
    (h) => h.kind === "dockerExec",
    async (h) => (await api.listDockerContainers(h.id)).filter((c) => c.state === "running").length,
    null as number | null,
  );

  // Live "N prêts" count for K8s hosts, same spirit as the Docker container
  // count above — visible before ever opening the pod picker. Best-effort:
  // an unreachable/misconfigured context simply contributes no count rather
  // than blocking the rest of the panel.
  const podCounts = usePolledHostStat(
    workspace.hosts,
    (h) => h.kind === "k8sExec",
    async (h) => (await api.listK8sPods(h.id)).filter((p) => p.ready).length,
    null as number | null,
  );

  const handleConnect = (host: Host) => {
    const kind = host.kind ?? "ssh";
    if (kind === "ssh") { onConnect(host); return; }
    if (kind === "dockerExec") { openDockerPicker(host); return; }
    if (kind === "k8sExec") { openK8sPicker(host); return; }
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

  // Indexé une fois par changement d'hôtes/dossiers/recherche, au lieu d'être
  // refiltré et retrié à chaque dossier affiché — voir `buildHostTree`.
  // Nom du vault partagé de chaque hôte (compte affiché seulement) : un
  // critère de recherche de plus — « infra » retrouve les hôtes du vault
  // « Équipe infra », comme un tag.
  const sections = profile?.sections ?? null;
  const vaultNameOf = useMemo(() => {
    const names = new Map<string, string>();
    if (!sections) return names;
    const byId = new Map(sections.filter((v) => v.id !== null).map((v) => [v.id as string, v.name]));
    for (const [id, vaultId] of Object.entries(workspace.vaultBindings ?? {})) {
      const name = byId.get(vaultId);
      if (name) names.set(id, name);
    }
    return names;
  }, [sections, workspace.vaultBindings]);
  const { hostsByGroup, groupsByParent, matchingGroups } = useMemo(
    () => buildHostTree(workspace.hosts, workspace.groups, query, vaultNameOf),
    [workspace.hosts, workspace.groups, query, vaultNameOf],
  );

  // Un arbre par vault quand un compte est affiché. Un hôte affilié à un
  // vault que le compte ne liste plus (accès retiré ; la synchro suivante le
  // retirera) reste visible, sous une section « inaccessible » — le cacher
  // ferait croire qu'il est perdu, le glisser dans Personnel serait faux.
  type Tree = ReturnType<typeof buildHostTree>;
  const vaultSections = useMemo(() => {
    if (!sections) return null;
    const bindings = workspace.vaultBindings ?? {};
    const known = new Set(sections.map((s) => s.id));
    const stray = new Map<string, VaultSection>();
    for (const e of [...workspace.hosts, ...workspace.groups]) {
      const v = bindings[e.id];
      if (v && !known.has(v) && !stray.has(v)) stray.set(v, { id: v, name: "Vault inaccessible", kind: "shared", role: "reader" });
    }
    return [...sections, ...stray.values()].map((sec) => {
      const hosts = workspace.hosts.filter((h) => (bindings[h.id] ?? null) === sec.id);
      const groups = workspace.groups.filter((g) => (bindings[g.id] ?? null) === sec.id);
      return { section: sec, tree: buildHostTree(hosts, groups, query, vaultNameOf), total: hosts.length };
    });
  }, [sections, workspace.hosts, workspace.groups, workspace.vaultBindings, query, vaultNameOf]);

  const childGroups = (parentId: GroupId | null, tree?: Tree) => (tree ?? { groupsByParent }).groupsByParent.get(parentId) ?? [];
  const hostsIn = (groupId: GroupId | null, tree?: Tree) => (tree ?? { hostsByGroup }).hostsByGroup.get(groupId) ?? [];
  const isExpanded = (id: GroupId) => (query ? true : !collapsed.has(id));

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
        // Quick single-host import has no confirmation step to attach a
        // toggle to (unlike SettingsPanel's full import flow) — always
        // strip startup automation from the untrusted file, the safe
        // default. See api.importHostFromFile's doc comment.
        const ws = await api.importHostFromFile(path, false);
        onWorkspaceUpdate?.(ws);
      }
    } catch (e) { onError?.(String(e)); }
  };

  // ── Host row ─────────────────────────────────────────────────────────────
  // Une ligne de 40 px : libellé et mémoire d'un côté, adresse en mono et
  // tags de l'autre. Une carte par hôte montrait six machines par écran ; une
  // liste dense en montre vingt, et c'est ce qu'on parcourt du regard pour en
  // trouver une.
  const renderHost = (host: Host, depth: number) => {
    const menuOpen = openMenuHostId === host.id;
    const isActive = host.id === activeHostId;
    const kind = host.kind ?? "ssh";
    const { label: kindLabel, Icon: KindIcon } = hostKindMeta(kind);
    const subtitle =
      kind === "dockerExec" ? host.address :
      kind === "k8sExec" ? host.address :
      kind === "rdp" ? `${host.username}@${host.address}${host.port !== 3389 ? `:${host.port}` : ""}` :
      `${host.username}@${host.address}${host.port !== 22 ? `:${host.port}` : ""}`;
    const runningCount = kind === "dockerExec" ? containerCounts[host.id] : kind === "k8sExec" ? podCounts[host.id] : undefined;
    const online = hostStatus[host.id];
    const facts = kind === "ssh" ? host.lastFacts : null;
    const tooltip = [
      kind === "ssh" ? `Connecter — ${subtitle}` : kind === "rdp" ? `Aperçu intégré — ${subtitle}` : `${kindLabel} — ${subtitle}`,
      facts?.osName || facts?.osId,
      facts?.memUsedPct != null ? `RAM ${Math.round(facts.memUsedPct)} %` : null,
      host.lastFactsAtMs != null ? `état ${formatRelativeTime(host.lastFactsAtMs)}` : null,
    ].filter(Boolean).join("\n");
    return (
      <EntityRow
        key={host.id}
        dataAttrs={{ "data-host-row": host.label }}
        active={isActive}
        depth={depth}
        className={menuOpen ? "bg-[var(--c-hover)]" : ""}
        leading={selecting ? (
          <input
            type="checkbox"
            checked={selectedHosts.has(host.id)}
            onChange={() => toggleSelected(host.id)}
            aria-label={`Sélectionner ${host.label}`}
          />
        ) : undefined}
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
        title_={tooltip}
        badges={runningCount != null && <span className="tag tag-accent">{runningCount} actif{runningCount === 1 ? "" : "s"}</span>}
        meta={facts?.memUsedPct != null && (
          <span className="font-mono text-[10.5px] font-medium tabular-nums" style={{ color: ramColor(facts.memUsedPct) }}>
            {Math.round(facts.memUsedPct)}%
          </span>
        )}
        secondary={
          <>
            <EntityMono>{subtitle}</EntityMono>
            {(facts?.osName || facts?.osId) && <span className="text-[var(--c-text-faint)]">{facts.osName || facts.osId}</span>}
            <EntityTags tags={host.tags} />
          </>
        }
        onClick={() => (selecting ? toggleSelected(host.id) : handleConnect(host))}
        actions={
          <button
            onClick={(e) => {
              e.stopPropagation();
              if (menuOpen) { setOpenMenuHostId(null); return; }
              const rect = e.currentTarget.getBoundingClientRect();
              setMenuAnchor({ top: rect.bottom + 4, right: window.innerWidth - rect.right });
              setOpenMenuHostId(host.id);
            }}
            className={`btn btn-ghost btn-sm btn-icon ${menuOpen ? "bg-[var(--c-active)] text-[var(--c-text)]" : ""}`}
            title="Options"
            aria-label={`Options de ${host.label}`}
          >
            <IconDotsVertical size={14} />
          </button>
        }
      />
    );
  };

  // ── Host menu ────────────────────────────────────────────────────────────
  // Un menu flottant, ancré sur le bouton « … » de la ligne, plutôt qu'un
  // bloc déplié dans la liste : la liste ne bouge pas, et le menu ne se fait
  // pas couper par le défilement.
  const renderHostMenu = () => {
    const host = workspace.hosts.find((h) => h.id === openMenuHostId);
    if (!host || !menuAnchor) return null;
    const kind = host.kind ?? "ssh";
    const attached = hostAttachments(workspace, host.id);
    const close = () => setOpenMenuHostId(null);
    return (
      <>
        <div className="fixed inset-0 z-30" onMouseDown={close} />
        <div className="popover fixed z-40 w-60 py-1" style={{ top: menuAnchor.top, right: menuAnchor.right }} role="menu">
          <button onClick={() => { onEditHost(host); close(); }} className="menu-item"><IconEdit size={13} /> Modifier</button>
          {kind === "ssh" && (
            <button
              onClick={() => { onSearchFiles(host); close(); }}
              title="Chercher un fichier par son nom ou par son contenu ; un résultat s'ouvre directement dans ton éditeur"
              className="menu-item"
            >
              <IconSearch size={13} /> Rechercher des fichiers
            </button>
          )}
          {kind === "ssh" && (
            <button
              onClick={() => { onProbeReachability(host); close(); }}
              title="Est-ce que cet hôte atteint telle adresse, sur tel port ? Distingue un refus (le port est fermé) d'un silence (pare-feu ou route manquante)"
              className="menu-item"
            >
              <IconTunnels size={13} /> Joignabilité
            </button>
          )}
          {kind === "ssh" && (
            /* Proposé sur **tout** hôte SSH, pas seulement ceux réglés sur
               tmux : repasser le réglage à « désactivée » ne fait pas
               disparaître les sessions déjà ouvertes, et cacher l'entrée les
               rendrait définitivement inatteignables. */
            <button
              onClick={() => { setSessionsHost(host); close(); }}
              title="Ce qui tourne encore sur cet hôte dans une session persistante — le reprendre, ou le terminer"
              className="menu-item"
            >
              <IconTerminal size={13} /> Sessions persistantes
            </button>
          )}
          {kind === "rdp" && (
            <button
              onClick={() => { onOpenTransfer(host); close(); }}
              title="Ouvre l'aperçu intégré avec un panneau de fichiers à gauche — glisser un fichier/dossier dessus l'envoie et le colle automatiquement dans la session distante"
              className="menu-item"
            >
              <IconTransfer size={13} /> Transférer des fichiers
            </button>
          )}
          <button onClick={() => { handleExportHost(host); close(); }} className="menu-item"><IconUpload size={13} /> Exporter…</button>
          {hasAttachments(attached) && (
            /* Ce qui passe par cet hôte. Les liens existaient déjà dans le
               modèle — une base tunnelée porte l'id de son hôte, un hôte Docker
               celui de son relais — mais rien ne les lisait dans ce sens : on ne
               pouvait ni voir ce qui dépend d'une machine, ni sauter de l'une à
               l'autre. Voir `lib/hostGraph.ts`. */
            <>
              <div className="menu-sep" />
              <p className="eyebrow px-2.5 pb-1 pt-1.5">Passe par cet hôte ({attachmentCount(attached)})</p>
              {attached.relayedHosts.map((relayed) => (
                <button key={relayed.id} onClick={() => { handleConnect(relayed); close(); }} className="menu-item">
                  <IconHosts size={13} className="shrink-0 text-[var(--c-text-muted)]" />
                  <span className="truncate">{relayed.label}</span>
                  <span className="ml-auto shrink-0 text-[10.5px] text-[var(--c-text-muted)]">{hostKindMeta(relayed.kind ?? "ssh").label}</span>
                </button>
              ))}
              {attached.databases.map((db) => (
                <button key={db.id} onClick={() => { onConnectSql(db); close(); }} className="menu-item">
                  <IconFolder size={13} className="shrink-0 text-[var(--c-text-muted)]" />
                  <span className="truncate">{db.label}</span>
                  <span className="ml-auto shrink-0 text-[10.5px] text-[var(--c-text-muted)]">{db.engine}</span>
                </button>
              ))}
              {attached.forwards.map((forward) => (
                /* Listés sans lien : un tunnel se gère dans son propre panneau,
                   et le montrer ici sert à savoir ce qui casse si on retire
                   l'hôte — pas à l'ouvrir. */
                <p key={forward.id} className="flex items-center gap-2 px-2.5 py-1.5 font-mono text-[11px] text-[var(--c-text-muted)]">
                  <IconTunnels size={12} className="shrink-0" />
                  <span className="truncate">{forward.bindAddress}:{forward.bindPort} → {forward.destAddress}:{forward.destPort}</span>
                </p>
              ))}
            </>
          )}
        </div>
      </>
    );
  };

  // ── Group row ────────────────────────────────────────────────────────────
  const renderGroup = (group: Group, depth: number, tree?: Tree) => {
    if (query && !(tree ?? { matchingGroups }).matchingGroups.has(group.id)) return null;
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
          actions={
            <>
              <button onClick={() => onNewHostInGroup(group.id)} title="Nouvel hôte dans ce dossier" className="btn btn-ghost btn-sm btn-icon"><IconPlus size={12} /></button>
              <button onClick={() => onNewGroupUnder(group.id)} title="Nouveau sous-dossier" className="btn btn-ghost btn-sm btn-icon"><IconFolder size={12} /></button>
              <button onClick={() => onEditGroup(group)} title="Modifier ce dossier" className="btn btn-ghost btn-sm btn-icon"><IconEdit size={12} /></button>
            </>
          }
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

  const addMenuItem = "menu-item";

  const showProfile = !!profile && (profile.connectedEmail !== null || profile.otherAccounts.length > 0);
  const profileValue = profile?.connectedEmail && !profile.viewLocal ? "account" : "local";

  return (
    <div className="flex h-full min-w-0 flex-col">
      {showProfile && profile && (
        // Quel workspace on regarde : cet appareil, ou un compte GuiVault.
        // Un `<select>` natif, pas un `HostTreePicker` : ce sont des profils,
        // pas des hôtes.
        <select
          value={profileValue}
          onChange={(e) => {
            const v = e.target.value;
            if (v === "local" || v === "account") onSwitchProfile?.(v);
            else onSwitchProfile?.({ userId: v });
          }}
          title={profile.viewLocal ? "Profil local affiché — le compte continue de se synchroniser en arrière-plan" : "Profil affiché"}
          className={`input mb-2 w-full ${profile.viewLocal && profile.connectedEmail ? "border-[var(--c-warn)]" : ""}`}
        >
          <option value="local">Cet appareil (local)</option>
          {profile.connectedEmail && <option value="account">{profile.connectedEmail}</option>}
          {profile.otherAccounts.map((a) => (
            <option key={a.userId} value={a.userId}>{a.email} — se connecter…</option>
          ))}
        </select>
      )}
      {/* Search — first for discoverability */}
      <div className="relative shrink-0">
        <div className="pointer-events-none absolute inset-y-0 left-2.5 flex items-center">
          <IconSearch size={13} className="text-[var(--c-text-muted)]" />
        </div>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && quickSSH) handleQuickConnect(); }}
          placeholder="Rechercher, ou ssh user@hôte"
          className="input pl-8"
        />
      </div>

      {/* Action row */}
      <div className="mt-2.5 flex shrink-0 flex-wrap items-center gap-2">
        <div className="relative min-w-[9rem] flex-1">
          {showAddMenu && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setShowAddMenu(false)} />
              <div className="popover absolute left-0 top-full z-20 mt-1 w-full min-w-[15rem] py-1">
                <button onClick={() => { onNewHost(); setShowAddMenu(false); }} className={addMenuItem}><IconHosts size={14} /> Nouvel hôte</button>
                <button onClick={() => { onNewGroup(); setShowAddMenu(false); }} className={addMenuItem}><IconFolder size={14} /> Nouveau dossier</button>
                <div className="menu-sep" />
                <button onClick={() => { handleImportHost(); setShowAddMenu(false); }} className={addMenuItem}><IconDownload size={14} /> Importer un hôte (fichier)</button>
                <button onClick={() => { onImportCloud(); setShowAddMenu(false); }} className={addMenuItem}><IconDownload size={14} /> Importer depuis le cloud</button>
                <button onClick={() => { onImportAnsible(); setShowAddMenu(false); }} className={addMenuItem}><IconDownload size={14} /> Importer un inventaire Ansible</button>
              </div>
            </>
          )}
          <button
            onClick={() => setShowAddMenu((v) => !v)}
            className="btn btn-primary w-full"
            aria-haspopup="menu"
            aria-expanded={showAddMenu}
          >
            <IconPlus size={13} />
            Ajouter…
          </button>
        </div>
        <LocalTerminalButton onOpen={onOpenLocalTerminal} />
        {/* Selection mode: entering it, and acting on what's ticked. Offered
            only once there is more than one host — below that it is a mode with
            nothing to gain. */}
        {workspace.hosts.length > 1 && (
          <button
            onClick={() => (selecting ? leaveSelection() : setSelecting(true))}
            title={selecting ? "Quitter la sélection" : "Sélectionner plusieurs hôtes pour les modifier d'un coup"}
            aria-pressed={selecting}
            className={`btn btn-icon ${selecting ? "btn-toggled" : "btn-secondary text-[var(--c-text-muted)]"}`}
          >
            <IconChecklist size={14} />
          </button>
        )}
      </div>

      {selecting && (
        <div className="mt-2 flex shrink-0 items-center gap-2 rounded-md border border-[var(--c-border)] bg-[var(--c-bg3)] px-2 py-1 text-[11.5px]">
          <span className="text-[var(--c-text-secondary)]">
            {selectedHosts.size} sélectionné{selectedHosts.size > 1 ? "s" : ""}
          </span>
          <button onClick={() => setSelectedHosts(new Set(workspace.hosts.map((h) => h.id)))} className="text-[var(--c-accent-text)] hover:underline">Tout</button>
          <button onClick={() => setSelectedHosts(new Set())} className="text-[var(--c-text-muted)] hover:underline">Aucun</button>
          <button onClick={() => setBulkEditOpen(true)} disabled={selectedHosts.size === 0} className="btn btn-primary btn-sm ml-auto">
            Modifier…
          </button>
        </div>
      )}

      {/* Host list */}
      <div ref={listRef} onScroll={onListScroll} className="sidebar-scroll -mx-1 mt-3 min-h-0 min-w-0 flex-1 overflow-y-auto px-1 pb-2">
        {quickSSH && (
          <button
            onClick={handleQuickConnect}
            className="list-row mb-1 min-h-11 w-full border border-dashed border-[var(--c-accent)] text-[var(--c-accent-text)] hover:bg-[var(--c-accent-dim)]"
          >
            <IconFlash size={13} className="shrink-0" />
            <span className="min-w-0 truncate font-mono text-[12px]">
              <span className="font-medium">{quickSSH.username}@{quickSSH.address}</span>
              {quickSSH.port !== 22 && <span className="opacity-70">:{quickSSH.port}</span>}
            </span>
            <span className="kbd ml-auto shrink-0">Entrée</span>
          </button>
        )}
        {vaultSections ? vaultSections.map(({ section: sec, tree, total }) => {
          const key = sec.id ?? "personal";
          const expanded = query ? true : !collapsedVaults.has(key);
          const empty = total === 0 && childGroups(null, tree).length === 0;
          if (query && hostsIn(null, tree).length === 0 && childGroups(null, tree).every((g) => !tree.matchingGroups.has(g.id))) return null;
          const writable = sec.role !== "reader";
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
                actions={
                  <>
                    {writable && onNewHostInVault && (
                      <button onClick={() => onNewHostInVault(sec.id)} title="Nouvel hôte dans ce vault" aria-label={`Nouvel hôte dans ${sec.name}`} className="btn btn-ghost btn-sm btn-icon"><IconPlus size={12} /></button>
                    )}
                    <button
                      onClick={(e) => {
                        const rect = e.currentTarget.getBoundingClientRect();
                        setVaultMenu({ section: sec, top: rect.bottom + 4, right: window.innerWidth - rect.right });
                      }}
                      title="Options du vault"
                      aria-label={`Options de ${sec.name}`}
                      aria-haspopup="menu"
                      className="btn btn-ghost btn-sm btn-icon"
                    >
                      <IconDotsVertical size={13} />
                    </button>
                  </>
                }
              />
              {expanded && (
                <div className="pl-2">
                  {empty && (
                    <p className="px-2 py-1.5 text-[11.5px] text-[var(--c-text-muted)]">
                      {writable ? "Vide — « + » y crée un hôte, ou le menu du vault y range des entités existantes." : "Vide."}
                    </p>
                  )}
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
        {!quickSSH && workspace.hosts.length === 0 && workspace.groups.length === 0 && (
          <div className="px-2 py-8 text-center">
            <p className="text-[12.5px] font-medium text-[var(--c-text-secondary)]">Aucun hôte enregistré</p>
            <p className="mt-1 text-[11.5px] text-[var(--c-text-muted)]">Ajoutez-en un, ou tapez <span className="font-mono">ssh user@hôte</span> ci-dessus pour vous connecter tout de suite.</p>
          </div>
        )}
        {!quickSSH && query && workspace.hosts.length > 0 && hostsIn(null).length === 0 && childGroups(null).every((g) => !matchingGroups.has(g.id)) && (
          <p className="px-2 py-8 text-center text-[12px] text-[var(--c-text-muted)]">Aucun hôte ne correspond à « {search.trim()} ».</p>
        )}
      </div>

      {renderHostMenu()}
      {vaultMenu && (
        // Le menu « … » d'un vault : même ancrage flottant que celui d'un hôte.
        <>
          <div className="fixed inset-0 z-30" onMouseDown={() => setVaultMenu(null)} />
          <div className="popover fixed z-40 w-60 py-1" style={{ top: vaultMenu.top, right: vaultMenu.right }} role="menu">
            <p className="eyebrow px-2.5 pb-1 pt-1.5">{vaultMenu.section.name}</p>
            {vaultMenu.section.role !== "reader" && onNewHostInVault && (
              <button onClick={() => { onNewHostInVault(vaultMenu.section.id); setVaultMenu(null); }} className="menu-item" role="menuitem"><IconPlus size={13} /> Nouvel hôte ici</button>
            )}
            {onOpenVault && (
              <button
                onClick={() => { onOpenVault(vaultMenu.section.id); setVaultMenu(null); }}
                title="Le contenu du vault (à déplacer, copier, supprimer), ses membres et ses invitations"
                className="menu-item"
                role="menuitem"
              >
                <IconVault size={13} /> Ouvrir le vault
              </button>
            )}
          </div>
        </>
      )}

      {sessionsHost && (
        <PersistentSessionsModal
          host={sessionsHost}
          onResume={(sessionKey, readOnly) => onResumeSession(sessionsHost, sessionKey, readOnly)}
          onClose={() => setSessionsHost(null)}
          onError={onError}
          onNotify={onNotify}
        />
      )}

      {exportPendingHost && (
        <>
          <div className="fixed inset-0 z-30 bg-black/50" onClick={() => setExportPendingHost(null)} />
          <div className="modal fixed left-1/2 top-1/2 z-40 w-[420px] max-w-[90vw] -translate-x-1/2 -translate-y-1/2 overflow-hidden">
            <div className="px-4 pt-4">
              <p className="text-[14px] font-semibold text-[var(--c-text)]">Exporter « {exportPendingHost.label} »</p>
              <p className="mt-1 text-[12px] text-[var(--c-text-secondary)]">
                Cet hôte utilise une clé du trousseau. Faut-il l'inclure dans le fichier exporté ?
              </p>
            </div>
            <div className="p-4">
              <p className="callout callout-warn">
                La clé privée serait écrite en clair, non chiffrée, dans le fichier JSON. Ne la partagez qu'avec des personnes de confiance, sur un canal sûr.
              </p>
            </div>
            <div className="flex justify-end gap-2 border-t border-[var(--c-border)] px-4 py-3">
              <button
                onClick={() => { const h = exportPendingHost; setExportPendingHost(null); doExportHost(h, true); }}
                className="btn btn-danger"
              >
                Inclure la clé privée
              </button>
              <button
                onClick={() => { const h = exportPendingHost; setExportPendingHost(null); doExportHost(h, false); }}
                className="btn btn-primary"
              >
                Exporter sans la clé
              </button>
            </div>
          </div>
        </>
      )}

      {pickerModal}

      {bulkEditOpen && (
        <BulkEditPanel
          workspace={workspace}
          hosts={workspace.hosts.filter((h) => selectedHosts.has(h.id))}
          onWorkspaceUpdate={(ws) => onWorkspaceUpdate?.(ws)}
          onClose={() => setBulkEditOpen(false)}
          onError={(message) => onError?.(message)}
          // Leaves selection mode on success: the edit is done, and staying in
          // it with a stale tick list invites a second unintended write.
          onDone={(message) => { leaveSelection(); onNotify?.(message); }}
        />
      )}
    </div>
  );
}
