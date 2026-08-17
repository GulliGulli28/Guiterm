import { lazy } from "react";
import { defineModule } from "./types";

const NetDiagTab = lazy(() => import("../components/NetDiagTab").then((m) => ({ default: m.NetDiagTab })));

export const netdiagModule = defineModule({
  id: "netdiag",
  label: "Diagnostic réseau",
  tab: {
    kind: "netdiag",
    render: (tab, ctx) => (
      <NetDiagTab
        workspace={ctx.workspace}
        onError={ctx.reportError}
        initialSourceId={tab.sourceHostId}
        // Remonte quand l'onglet est re-visé depuis le menu d'un autre hôte,
        // pour que la sélection suive au lieu de garder la source de
        // l'incident précédent.
        key={tab.sourceHostId ?? "local"}
      />
    ),
  },
});
