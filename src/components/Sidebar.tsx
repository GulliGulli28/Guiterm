import type { Group, GroupId, Host, HostId, KeyAlgorithm, KeyId, PortForwardId, PortForwardKind, SnippetId, VaultStatus, Workspace } from "../lib/types";
import type { AppPreferences } from "../lib/preferences";
import type { ComponentType } from "react";
import { HostsPanel } from "./HostsPanel";
import { KeychainPanel } from "./KeychainPanel";
import { KnownHostsPanel } from "./KnownHostsPanel";
import { SettingsPanel } from "./SettingsPanel";
import { SnippetsPanel } from "./SnippetsPanel";
import { SftpPanel } from "./SftpPanel";
import { TunnelsPanel } from "./TunnelsPanel";
import { IconHosts, IconSnippets, IconTunnels, IconKeychain, IconSettings, IconTransfer, IconShield } from "./ui-icons";

export type SidebarPanelKind = "knownHosts" | "hosts" | "sftp" | "snippets" | "tunnels" | "keychain" | "settings";

interface SidebarProps {
  workspace: Workspace;
  panel: SidebarPanelKind;
  onPanelChange: (panel: SidebarPanelKind) => void;
  activeHostId?: HostId | null;
  onConnect: (host: Host) => void;
  onConnectDocker: (host: Host, containerId: string) => void;
  onConnectRdpView: (host: Host) => void;
  onOpenTransfer: (host: Host, containerId?: string) => void;
  onOpenLocalTerminal: (shell?: string) => void;
  onQuickSSH: (cmd: string) => void;
  onNewHost: () => void;
  onEditHost: (host: Host) => void;
  onNewGroup: () => void;
  onNewHostInGroup: (groupId: GroupId) => void;
  onNewGroupUnder: (parentId: GroupId) => void;
  onEditGroup: (group: Group) => void;
  onAddSnippet: (name: string, command: string) => void;
  onUpdateSnippet: (id: SnippetId, name: string, command: string) => void;
  onDeleteSnippet: (id: SnippetId) => void;
  onRunSnippet: (command: string, targetTabIds?: string[]) => void;
  openTerminals: { id: string; label: string }[];
  onAddForward: (input: { hostId: HostId; kind: PortForwardKind; bindAddress: string; bindPort: number; destAddress: string; destPort: number }) => void;
  onDeleteForward: (id: PortForwardId) => void;
  onAddKey: (name: string, path: string, passphrase: string | null) => void;
  onGenerateKey: (name: string, algorithm: KeyAlgorithm, passphrase: string | null) => void;
  onDeleteKey: (id: KeyId) => void;
  onRenameKey: (id: KeyId, name: string) => void;
  onWorkspaceUpdate: (ws: Workspace) => void;
  onError: (message: string) => void;
  preferences: AppPreferences;
  onPreferencesChange: (p: AppPreferences) => void;
  vaultStatus: VaultStatus | null;
  onVaultStatusChange: () => void;
}

const TABS: { key: Exclude<SidebarPanelKind, "settings">; label: string; Icon: ComponentType<{ size?: number }> }[] = [
  { key: "knownHosts", label: "Known Hosts", Icon: IconShield  },
  { key: "hosts",      label: "Hôtes",       Icon: IconHosts    },
  { key: "sftp",       label: "SFTP",        Icon: IconTransfer },
  { key: "snippets",   label: "Snippets",    Icon: IconSnippets },
  { key: "tunnels",    label: "Tunnels",     Icon: IconTunnels  },
  { key: "keychain",   label: "Clés",        Icon: IconKeychain },
];

export function Sidebar(props: SidebarProps) {
  const { workspace, panel, onPanelChange } = props;

  return (
    <aside className="flex min-w-0 flex-1 overflow-hidden">
      {/* Vertical nav strip — fixed 44px, never overflows regardless of sidebar width */}
      <nav className="relative flex w-11 shrink-0 flex-col items-center border-r border-[var(--c-border)] bg-[var(--c-bg)] py-2 gap-0.5">
        {TABS.map((t) => {
          const active = panel === t.key;
          return (
            <button
              key={t.key}
              onClick={() => onPanelChange(t.key)}
              title={t.label}
              className={`relative flex h-9 w-9 items-center justify-center rounded-lg border transition-all duration-150 ${
                active
                  ? "accent-surface"
                  : "border-transparent text-[var(--c-text-faint)] hover:bg-white/5 hover:text-[var(--c-text-secondary)]"
              }`}
            >
              <t.Icon size={16} />
            </button>
          );
        })}
        <div className="mt-auto">
          <button
            onClick={() => onPanelChange(panel === "settings" ? "hosts" : "settings")}
            title="Paramètres"
            className={`relative flex h-9 w-9 items-center justify-center rounded-lg border transition-all duration-150 ${
              panel === "settings"
                ? "accent-surface"
                : "border-transparent text-[var(--c-text-faint)] hover:bg-white/5 hover:text-[var(--c-text-secondary)]"
            }`}
          >
            <IconSettings size={16} />
          </button>
        </div>
      </nav>

      {/* Panel content */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-[var(--c-bg2)]">
        <div className="min-h-0 min-w-0 flex-1 overflow-hidden p-2">
          {panel === "knownHosts" && (
            <KnownHostsPanel onWorkspaceUpdate={props.onWorkspaceUpdate} onError={props.onError} />
          )}
          {panel === "hosts" && (
            <HostsPanel
              workspace={workspace}
              activeHostId={props.activeHostId}
              onConnect={props.onConnect}
              onConnectDocker={props.onConnectDocker}
              onConnectRdpView={props.onConnectRdpView}
              onOpenTransfer={props.onOpenTransfer}
              onOpenLocalTerminal={props.onOpenLocalTerminal}
              onQuickSSH={props.onQuickSSH}
              onNewHost={props.onNewHost}
              onEditHost={props.onEditHost}
              onNewGroup={props.onNewGroup}
              onNewHostInGroup={props.onNewHostInGroup}
              onNewGroupUnder={props.onNewGroupUnder}
              onEditGroup={props.onEditGroup}
              onWorkspaceUpdate={props.onWorkspaceUpdate}
              onError={props.onError}
            />
          )}
          {panel === "sftp" && (
            <SftpPanel workspace={workspace} onOpenTransfer={props.onOpenTransfer} />
          )}
          {panel === "snippets" && (
            <SnippetsPanel
              workspace={workspace}
              onAddSnippet={props.onAddSnippet}
              onUpdateSnippet={props.onUpdateSnippet}
              onDeleteSnippet={props.onDeleteSnippet}
              onRunSnippet={props.onRunSnippet}
              openTerminals={props.openTerminals}
            />
          )}
          {panel === "tunnels" && (
            <TunnelsPanel
              workspace={workspace}
              onAddForward={props.onAddForward}
              onDeleteForward={props.onDeleteForward}
              onError={props.onError}
            />
          )}
          {panel === "keychain" && (
            <KeychainPanel
              workspace={workspace}
              onAddKey={props.onAddKey}
              onGenerateKey={props.onGenerateKey}
              onDeleteKey={props.onDeleteKey}
              onRenameKey={props.onRenameKey}
            />
          )}
          {panel === "settings" && (
            <SettingsPanel
              workspace={workspace}
              onWorkspaceUpdate={props.onWorkspaceUpdate}
              onError={props.onError}
              preferences={props.preferences}
              onPreferencesChange={props.onPreferencesChange}
              vaultStatus={props.vaultStatus}
              onVaultStatusChange={props.onVaultStatusChange}
            />
          )}
        </div>
      </div>
    </aside>
  );
}
