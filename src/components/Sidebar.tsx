import type { AwsSessionAlert, AwsSsoSession, Group, GroupId, Host, HostId, KeyAlgorithm, KeyId, PortForwardId, PortForwardKind, SnippetId, SqlConnection, VaultStatus, Workspace } from "../lib/types";
import type { AppPreferences } from "../lib/preferences";
import { lazy, Suspense, type ComponentType } from "react";
import { alertTone, describeAlert } from "../lib/awsIdentities";
import { SIDEBAR_BUTTONS, isSidebarButtonVisible, type SidebarButtonId } from "../lib/sidebarButtons";
import { HostsPanel } from "./HostsPanel";
import { IconHosts, IconSnippets, IconTunnels, IconKeychain, IconSettings, IconTransfer, IconShield, IconDatabase, IconFleet, IconCloud, IconNetDiag } from "./ui-icons";
import { TabLoadingFallback } from "./TabLoadingFallback";

// Lazy-loaded: "Hôtes" is the default panel shown on launch (stays eager),
// every other sidebar panel only needs to load once the user actually
// clicks that tab.
const KeychainPanel = lazy(() => import("./KeychainPanel").then((m) => ({ default: m.KeychainPanel })));
const KnownHostsPanel = lazy(() => import("./KnownHostsPanel").then((m) => ({ default: m.KnownHostsPanel })));
const SettingsPanel = lazy(() => import("./SettingsPanel").then((m) => ({ default: m.SettingsPanel })));
const SnippetsPanel = lazy(() => import("./SnippetsPanel").then((m) => ({ default: m.SnippetsPanel })));
const SftpPanel = lazy(() => import("./SftpPanel").then((m) => ({ default: m.SftpPanel })));
const TunnelsPanel = lazy(() => import("./TunnelsPanel").then((m) => ({ default: m.TunnelsPanel })));
const SqlConnectionsPanel = lazy(() => import("./SqlConnectionsPanel").then((m) => ({ default: m.SqlConnectionsPanel })));
const AwsIdentitiesPanel = lazy(() => import("./AwsIdentitiesPanel").then((m) => ({ default: m.AwsIdentitiesPanel })));

export type SidebarPanelKind = "knownHosts" | "hosts" | "sftp" | "snippets" | "tunnels" | "keychain" | "database" | "aws" | "settings";

interface SidebarProps {
  workspace: Workspace;
  panel: SidebarPanelKind;
  onPanelChange: (panel: SidebarPanelKind) => void;
  activeHostId?: HostId | null;
  onConnect: (host: Host) => void;
  onConnectDocker: (host: Host, containerId: string) => void;
  onConnectK8s: (host: Host, podName: string, containerName: string | null) => void;
  onConnectRdpView: (host: Host) => void;
  onOpenTransfer: (host: Host, dockerContainerId?: string, k8sPodName?: string, k8sContainerName?: string | null) => void;
  onProbeReachability: (host: Host) => void;
  /** Success feedback for actions in the hosts panel (a bulk edit, notably). */
  onNotify: (message: string) => void;
  onSearchFiles: (host: Host) => void;
  onOpenLocalTerminal: (shell?: string) => void;
  onQuickSSH: (cmd: string) => void;
  onNewHost: () => void;
  onEditHost: (host: Host) => void;
  onNewGroup: () => void;
  onImportCloud: () => void;
  onImportAnsible: () => void;
  onNewHostInGroup: (groupId: GroupId) => void;
  onNewGroupUnder: (parentId: GroupId) => void;
  onEditGroup: (group: Group) => void;
  onAddSnippet: (name: string, command: string) => void;
  onUpdateSnippet: (id: SnippetId, name: string, command: string) => void;
  onDeleteSnippet: (id: SnippetId) => void;
  onRunSnippet: (command: string, targetTabIds?: string[]) => void;
  onRunAdaptiveSnippet: (programText: string, targetTabIds?: string[]) => void;
  onSaveAdaptiveSnippet: (id: SnippetId | null, name: string, command: string) => void;
  openTerminals: { id: string; label: string }[];
  onAddForward: (input: { hostId: HostId; kind: PortForwardKind; bindAddress: string; bindPort: number; destAddress: string; destPort: number }) => void;
  onUpdateForward: (input: { id: PortForwardId; hostId: HostId; kind: PortForwardKind; bindAddress: string; bindPort: number; destAddress: string; destPort: number }) => Promise<unknown>;
  onDeleteForward: (id: PortForwardId) => void;
  onAddKey: (name: string, path: string, passphrase: string | null) => void;
  onGenerateKey: (name: string, algorithm: KeyAlgorithm, passphrase: string | null) => void;
  onDeleteKey: (id: KeyId) => void;
  onRenameKey: (id: KeyId, name: string) => void;
  onConnectSql: (conn: SqlConnection) => void;
  onNewSqlConnection: () => void;
  onImportAwsDatabases: () => void;
  /** AWS identities panel — the SSO modal it opens lives at the App level,
   * since the import panels open the very same one. */
  onConfigureSso: () => void;
  onReconnectSso: (session: AwsSsoSession) => void;
  onAddAwsProfiles: (session: AwsSsoSession) => void;
  /** Bumped whenever that modal wrote something, so the listing catches up. */
  awsRefreshToken: number;
  /** SSO sessions about to lapse that hosts depend on — polled at the App
   * level, since the point is to be seen without opening the panel. */
  awsAlerts: AwsSessionAlert[];
  onEditSqlConnection: (conn: SqlConnection) => void;
  onOpenFleet: () => void;
  /** Opens the network diagnostics tab. Lives in this strip rather than the
   * tab bar, where it went unnoticed. */
  onOpenNetDiag: () => void;
  onWorkspaceUpdate: (ws: Workspace) => void;
  onError: (message: string) => void;
  preferences: AppPreferences;
  onPreferencesChange: (p: AppPreferences) => void;
  vaultStatus: VaultStatus | null;
  onVaultStatusChange: () => void;
}

// L'ordre et les libellés vivent dans `lib/sidebarButtons` — partagés avec le
// réglage de masquage, qui doit se lire contre cette barre. Ici, seule
// l'icône. Le `Record` rend l'oubli impossible : ajouter un bouton sans son
// icône est une erreur `tsc`.
const BUTTON_ICONS: Record<SidebarButtonId, ComponentType<{ size?: number }>> = {
  knownHosts: IconShield,
  hosts:      IconHosts,
  sftp:       IconTransfer,
  snippets:   IconSnippets,
  tunnels:    IconTunnels,
  database:   IconDatabase,
  keychain:   IconKeychain,
  aws:        IconCloud,
  fleet:      IconFleet,
  netdiag:    IconNetDiag,
};

export function Sidebar(props: SidebarProps) {
  const { workspace, panel, onPanelChange, awsAlerts } = props;
  const tone = alertTone(awsAlerts);
  const hidden = props.preferences.hiddenSidebarButtons;

  // `fleet` et `netdiag` ouvrent un onglet au lieu de changer de panneau. Ils
  // vivent dans cette barre parce que c'est là qu'on cherche « ce que sait
  // faire l'app » — un bouton relégué dans la barre d'onglets ne se trouvait
  // pas.
  const activate = (id: SidebarButtonId) => {
    if (id === "fleet") return props.onOpenFleet();
    if (id === "netdiag") return props.onOpenNetDiag();
    onPanelChange(id);
  };

  return (
    <aside className="flex min-w-0 flex-1 overflow-hidden">
      {/* Vertical nav strip — fixed 44px, never overflows regardless of sidebar width */}
      <nav className="relative flex w-11 shrink-0 flex-col items-center border-r border-[var(--c-border)] bg-[var(--c-bg)] py-2 gap-0.5">
        {SIDEBAR_BUTTONS.filter((b) => isSidebarButtonVisible(b.id, hidden)).map((b) => {
          const Icon = BUTTON_ICONS[b.id];
          const active = panel === b.id;
          // The dot only ever belongs to the AWS tab, and only when something
          // that carries work is about to lapse — see `aws_sso::alerts`.
          const alerting = b.id === "aws" && tone !== null;
          const label = b.hint ? `${b.label} — ${b.hint}` : b.label;
          return (
            <button
              key={b.id}
              onClick={() => activate(b.id)}
              // The reason goes in the tooltip rather than the badge: a bare
              // dot says "something", and the hosts are what makes it a
              // decision.
              title={alerting ? [b.label, ...awsAlerts.map(describeAlert)].join("\n") : label}
              className={`relative flex h-9 w-9 items-center justify-center rounded-lg border transition-all duration-150 ${
                active
                  ? "accent-surface"
                  : "border-transparent text-[var(--c-text-faint)] hover:bg-white/5 hover:text-[var(--c-text-secondary)]"
              }`}
            >
              <Icon size={16} />
              {alerting && (
                <span
                  className={`absolute right-1 top-1 h-2 w-2 rounded-full ring-2 ring-[var(--c-bg)] ${
                    tone === "danger" ? "bg-rose-500" : "bg-amber-400"
                  }`}
                />
              )}
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
          <Suspense fallback={<TabLoadingFallback />}>
          {panel === "knownHosts" && (
            <KnownHostsPanel onWorkspaceUpdate={props.onWorkspaceUpdate} onError={props.onError} />
          )}
          {panel === "hosts" && (
            <HostsPanel
              workspace={workspace}
              activeHostId={props.activeHostId}
              onConnect={props.onConnect}
              onConnectDocker={props.onConnectDocker}
              onConnectK8s={props.onConnectK8s}
              onConnectRdpView={props.onConnectRdpView}
              onOpenTransfer={props.onOpenTransfer}
              onProbeReachability={props.onProbeReachability}
              onNotify={props.onNotify}
              onSearchFiles={props.onSearchFiles}
              onOpenLocalTerminal={props.onOpenLocalTerminal}
              onQuickSSH={props.onQuickSSH}
              onNewHost={props.onNewHost}
              onEditHost={props.onEditHost}
              onNewGroup={props.onNewGroup}
              onImportCloud={props.onImportCloud}
              onImportAnsible={props.onImportAnsible}
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
              onRunAdaptiveSnippet={props.onRunAdaptiveSnippet}
              onSaveAdaptiveSnippet={props.onSaveAdaptiveSnippet}
              openTerminals={props.openTerminals}
            />
          )}
          {panel === "tunnels" && (
            <TunnelsPanel
              workspace={workspace}
              onAddForward={props.onAddForward}
              onUpdateForward={props.onUpdateForward}
              onDeleteForward={props.onDeleteForward}
              onError={props.onError}
            />
          )}
          {panel === "database" && (
            <SqlConnectionsPanel
              workspace={workspace}
              onConnect={props.onConnectSql}
              onNewConnection={props.onNewSqlConnection}
              onEditConnection={props.onEditSqlConnection}
              onImportAws={props.onImportAwsDatabases}
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
          {panel === "aws" && (
            <AwsIdentitiesPanel
              onConfigureSso={props.onConfigureSso}
              onReconnectSso={props.onReconnectSso}
              onAddProfiles={props.onAddAwsProfiles}
              onWorkspaceUpdate={props.onWorkspaceUpdate}
              refreshToken={props.awsRefreshToken}
              alerts={awsAlerts}
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
          </Suspense>
        </div>
      </div>
    </aside>
  );
}
