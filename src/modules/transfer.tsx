import { lazy } from "react";
import { hostOf } from "./hostBound";
import { defineModule } from "./types";

const TransferTab = lazy(() => import("../components/TransferTab").then((m) => ({ default: m.TransferTab })));

export const transferModule = defineModule({
  id: "transfer",
  label: "Transfert de fichiers",
  commandDomains: ["sftp", "remote_edit"],
  tab: {
    kind: "transfer",
    render: (tab, ctx) => {
      const host = hostOf(ctx, tab.hostId);
      if (!host) return null;
      return (
        <TransferTab
          host={host}
          workspace={ctx.workspace}
          preferences={ctx.preferences}
          onPreferencesChange={ctx.updatePreferences}
          onError={ctx.reportError}
          onPushed={(message) => ctx.pushNotification("success", message)}
          dockerContainerId={tab.dockerContainerId}
          k8sPodName={tab.k8sPodName}
          k8sContainerName={tab.k8sContainerName}
        />
      );
    },
  },
});
