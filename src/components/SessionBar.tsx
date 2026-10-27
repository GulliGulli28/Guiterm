import { useEffect, useRef, useState, type ReactNode } from "react";
import { groupPath } from "../lib/hostTree";
import type { Host, TabMeta, VaultId, Workspace } from "../lib/types";
import { IconBroadcast, IconDotsVertical, IconDownload, IconSearch, IconSnippets, IconSplit, IconTransfer, IconVault } from "./ui-icons";

/** Un onglet qui porte un terminal : la barre de session ne s'affiche que
 * pour eux — les autres onglets (transfert, base, flotte…) ont leur propre
 * barre d'outils. */
export type TerminalLikeTab = Extract<TabMeta, { kind: "local-terminal" }> | (Extract<TabMeta, { hostId: unknown }> & { kind: "terminal" });

export function isTerminalLikeTab(tab: TabMeta | undefined): tab is TerminalLikeTab {
  return !!tab && (tab.kind === "local-terminal" || tab.kind === "terminal");
}

/** Ce qu'on affiche après le nom : où l'on est connecté, en mono. */
function hostTarget(host: Host, tab: Extract<TabMeta, { hostId: unknown }>, workspace: Workspace): string {
  if (tab.dockerContainerId || host.kind === "dockerExec") {
    const via = host.dockerViaHostId ? workspace.hosts.find((h) => h.id === host.dockerViaHostId)?.label : null;
    return via ? `conteneur via ${via}` : "conteneur Docker";
  }
  if (tab.k8sPodName) return `pod ${tab.k8sPodName}`;
  if (host.kind === "k8sExec") return "Kubernetes";
  const port = host.port && host.port !== 22 ? `:${host.port}` : "";
  return host.username ? `${host.username}@${host.address}${port}` : `${host.address}${port}`;
}

interface SessionBarProps {
  tab: TerminalLikeTab;
  workspace: Workspace;
  /** Les vaults du compte affiché, pour nommer celui de l'hôte. Vide en
   * profil local : le fil d'Ariane commence alors au dossier. */
  vaults: { id: VaultId; name: string }[];
  splitOpen: boolean;
  broadcastActive: boolean;
  vaultBrowserActive: boolean;
  recording: boolean;
  /** Absent quand l'onglet n'a pas de fichiers à ouvrir à côté. */
  onOpenFiles?: () => void;
  onOpenSnippets: () => void;
  onToggleSplit: () => void;
  onToggleBroadcast: () => void;
  onToggleVaultBrowser: () => void;
  onSearch: () => void;
  onExportScrollback: () => void;
  onToggleRecording: () => void;
}

/**
 * La barre en tête d'un terminal : **où** l'on est (vault, dossier, hôte,
 * `user@adresse`), puis ce qu'on peut y faire, avec des mots.
 *
 * Ces actions étaient quatre icônes muettes au bout de la barre d'onglets,
 * visibles même sur un onglet qui n'a pas de terminal. Elles portent sur la
 * session qu'on regarde : elles vivent au-dessus d'elle.
 */
export function SessionBar(props: SessionBarProps) {
  const { tab, workspace, vaults } = props;
  const host = tab.kind === "terminal" ? workspace.hosts.find((h) => h.id === tab.hostId) : undefined;
  const vaultId = host ? workspace.vaultBindings?.[host.id] ?? null : null;
  const vault = vaultId ? vaults.find((v) => v.id === vaultId) : undefined;
  const folders = host ? groupPath(workspace.groups, host.groupId) : [];

  return (
    <div data-session-bar="" className="session-bar flex h-11 shrink-0 items-center gap-1 border-b border-[var(--c-border)] bg-[var(--c-bg2)] pl-4 pr-2">
      <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden text-[12.5px] text-[var(--c-text-muted)]">
        {vault && <span className="crumb-path flex min-w-0 items-center gap-1.5"><span className="truncate">{vault.name}</span><span className="text-[var(--c-text-faint)]">/</span></span>}
        {folders.map((name, i) => (
          <span key={i} className="crumb-path flex min-w-0 items-center gap-1.5">
            <span className="truncate">{name}</span>
            <span className="text-[var(--c-text-faint)]">/</span>
          </span>
        ))}
        <span className="shrink-0 text-[13.5px] font-semibold text-[var(--c-text)]">{host?.label ?? tab.label}</span>
        {host && tab.kind === "terminal" && (
          <span className="crumb-target ml-1.5 truncate font-mono text-[12px]">{hostTarget(host, tab, workspace)}</span>
        )}
        {tab.kind === "local-terminal" && <span className="crumb-target ml-1.5 truncate font-mono text-[12px]">{tab.shell ?? "terminal local"}</span>}
      </div>

      {props.onOpenFiles && <BarButton icon={<IconTransfer size={14} />} label="Fichiers" onClick={props.onOpenFiles} />}
      <BarButton icon={<IconSnippets size={14} />} label="Snippets" onClick={props.onOpenSnippets} title="Exécuter un snippet dans ce terminal" />
      <BarButton icon={<IconSplit size={14} />} label="Diviser" pressed={props.splitOpen} onClick={props.onToggleSplit} title={props.splitOpen ? "Quitter l'écran divisé" : "Deux terminaux côte à côte"} />
      <BarButton icon={<IconBroadcast size={14} />} label="Diffuser" pressed={props.broadcastActive} onClick={props.onToggleBroadcast} title={props.broadcastActive ? "Quitter la diffusion" : "Taper dans plusieurs terminaux à la fois"} />
      <BarButton
        icon={<IconVault size={14} />}
        label="Coller depuis GuiVault"
        pressed={props.vaultBrowserActive}
        onClick={props.onToggleVaultBrowser}
        title={props.vaultBrowserActive ? "Fermer le panneau GuiVault (Ctrl+Maj+G)" : "Parcourir les vaults et coller un secret (Ctrl+Maj+G)"}
        dataVaultToggle
      />
      <MoreMenu
        recording={props.recording}
        onSearch={props.onSearch}
        onExportScrollback={props.onExportScrollback}
        onToggleRecording={props.onToggleRecording}
      />
    </div>
  );
}

function BarButton({ icon, label, onClick, pressed, title, dataVaultToggle }: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  pressed?: boolean;
  title?: string;
  /** Le point d'accroche du tour visuel sur le bouton GuiVault, repris de
   * l'ancienne barre d'onglets. */
  dataVaultToggle?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={label}
      aria-pressed={pressed}
      data-vault-browser-toggle={dataVaultToggle ? "" : undefined}
      className={`btn btn-sm shrink-0 ${pressed ? "btn-toggled" : "btn-ghost"}`}
    >
      {icon}
      <span className="bar-label">{label}</span>
    </button>
  );
}

function MoreMenu({ recording, onSearch, onExportScrollback, onToggleRecording }: {
  recording: boolean;
  onSearch: () => void;
  onExportScrollback: () => void;
  onToggleRecording: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const run = (action: () => void) => () => { setOpen(false); action(); };
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label="Plus d'actions sur la session"
        title="Plus d'actions"
        aria-expanded={open}
        className="btn btn-ghost btn-sm btn-icon"
      >
        <IconDotsVertical size={14} />
      </button>
      {open && (
        <div role="menu" className="popover absolute right-0 top-full z-30 mt-1 w-64 py-1">
          <button type="button" role="menuitem" className="menu-item" onClick={run(onSearch)}>
            <IconSearch size={13} /> Rechercher dans le terminal
          </button>
          <button type="button" role="menuitem" className="menu-item" onClick={run(onExportScrollback)}>
            <IconDownload size={13} /> Exporter l'historique affiché
          </button>
          <button type="button" role="menuitem" className="menu-item" onClick={run(onToggleRecording)}>
            <span className={`dot ${recording ? "dot-danger" : ""}`} /> {recording ? "Arrêter l'enregistrement" : "Enregistrer la session"}
          </button>
        </div>
      )}
    </div>
  );
}
