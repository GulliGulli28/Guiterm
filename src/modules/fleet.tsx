import { lazy } from "react";
import { defineModule } from "./types";

const FleetTab = lazy(() => import("../components/FleetTab").then((m) => ({ default: m.FleetTab })));
const FleetTargetsPanel = lazy(() =>
  import("../components/FleetTargetsPanel").then((m) => ({ default: m.FleetTargetsPanel })),
);

export const fleetModule = defineModule({
  id: "fleet",
  label: "Opérations de flotte",
  commandDomains: ["fleet", "adaptive", "drift", "facts"],
  /** Le choix des cibles, dans la barre latérale — là où l'app montre déjà
   * l'arborescence des hôtes. L'onglet ne garde que la composition et les
   * résultats. Les deux lisent le même magasin (`useFleetSelection`), monté
   * dans `App.tsx`. */
  panel: {
    kind: "fleet",
    render: (ctx, a) => <FleetTargetsPanel workspace={ctx.workspace} onOpenTab={a.openFleet} />,
  },
  tab: {
    kind: "fleet",
    render: (_tab, ctx) => (
      <FleetTab
        workspace={ctx.workspace}
        onError={ctx.reportError}
        onWorkspaceUpdate={ctx.refreshWorkspace}
        onShowTargets={() => ctx.showSidebarPanel("fleet")}
      />
    ),
  },
});
