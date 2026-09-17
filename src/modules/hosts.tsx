import { HostsPanel } from "../components/HostsPanel";
import { api } from "../lib/api";
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
        profile={a.guivaultStatus ? {
          connectedEmail: a.guivaultStatus.configured ? a.guivaultStatus.email : null,
          viewLocal: a.guivaultStatus.viewLocal,
          otherAccounts: a.guivaultStatus.accounts
            .filter((acc) => acc.userId !== a.guivaultStatus?.userId)
            .map((acc) => ({ userId: acc.userId, email: acc.email })),
          vaults: a.guivaultStatus.vaults.filter((v) => v.kind === "shared").map((v) => ({ id: v.id, name: v.name })),
        } : null}
        onSwitchProfile={(target) => {
          if (target === "local" || target === "account") {
            api.guivaultSwitchView(target === "local").then(a.onGuivaultStatusChange).catch((e) => ctx.reportError(String(e)));
          } else {
            // Un autre compte : il faut s'y connecter, c'est le panneau
            // GuiVault qui le propose (déconnexion du courant comprise).
            ctx.showSidebarPanel("guivault");
          }
        }}
      />
    ),
  },
});
