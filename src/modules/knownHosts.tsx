import { lazy } from "react";
import { defineModule } from "./types";

const KnownHostsPanel = lazy(() => import("../components/KnownHostsPanel").then((m) => ({ default: m.KnownHostsPanel })));

export const knownHostsModule = defineModule({
  id: "known-hosts",
  label: "Known Hosts",
  commandDomains: ["known_hosts"],
  panel: {
    kind: "knownHosts",
    render: (ctx) => <KnownHostsPanel onWorkspaceUpdate={ctx.refreshWorkspace} onError={ctx.reportError} />,
  },
});
