import { lazy } from "react";
import { defineModule } from "./types";

const FleetTab = lazy(() => import("../components/FleetTab").then((m) => ({ default: m.FleetTab })));

export const fleetModule = defineModule({
  id: "fleet",
  label: "Opérations de flotte",
  tab: {
    kind: "fleet",
    render: (_tab, ctx) => (
      <FleetTab workspace={ctx.workspace} onError={ctx.reportError} onWorkspaceUpdate={ctx.refreshWorkspace} />
    ),
  },
});
