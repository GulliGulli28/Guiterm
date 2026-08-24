import { HostsPanel } from "../components/HostsPanel";
import { defineModule } from "./types";

// Eager, comme dans `Sidebar.tsx` : c'est le panneau affiché au lancement.
export const hostsModule = defineModule({
  id: "hosts",
  label: "Hôtes",
  commandDomains: ["hosts", "proxy", "reachability", "remote_search", "inventory", "cloud_inventory"],
  panel: {
    kind: "hosts",
    render: (ctx, a) => (
      <HostsPanel
        workspace={ctx.workspace}
        activeHostId={a.activeHostId}
        onConnect={a.connect}
        onConnectDocker={a.connectDocker}
        onConnectK8s={a.connectK8s}
        onConnectRdpView={a.connectRdpView}
        onOpenTransfer={a.openTransfer}
        onProbeReachability={a.probeReachability}
        onNotify={(message) => ctx.pushNotification("success", message)}
        onSearchFiles={a.searchFiles}
        onResumeSession={a.resumeSession}
        onConnectSql={a.connectSql}
        onOpenLocalTerminal={a.openLocalTerminal}
        onQuickSSH={a.quickSSH}
        onNewHost={a.newHost}
        onEditHost={a.editHost}
        onNewGroup={a.newGroup}
        onImportCloud={a.importCloud}
        onImportAnsible={a.importAnsible}
        onNewHostInGroup={a.newHostInGroup}
        onNewGroupUnder={a.newGroupUnder}
        onEditGroup={a.editGroup}
        onWorkspaceUpdate={ctx.refreshWorkspace}
        onError={ctx.reportError}
      />
    ),
  },
});
