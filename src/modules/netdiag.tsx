import { lazy } from "react";
import { defineModule } from "./types";

const NetDiagTab = lazy(() => import("../components/NetDiagTab").then((m) => ({ default: m.NetDiagTab })));
const NetDiagTargetsPanel = lazy(() =>
  import("../components/NetDiagTargetsPanel").then((m) => ({ default: m.NetDiagTargetsPanel })),
);

export const netdiagModule = defineModule({
  id: "netdiag",
  label: "Diagnostic réseau",
  commandDomains: ["netdiag"],
  /** Le choix des machines à sonder, dans la barre latérale — là où l'app
   * montre déjà l'arborescence des hôtes. L'onglet ne garde que la question et
   * la grille de réponses. Les deux lisent le même magasin
   * (`useNetDiagSelection`), monté dans `App.tsx`. */
  panel: {
    kind: "netdiag",
    render: (ctx, a) => <NetDiagTargetsPanel workspace={ctx.workspace} onOpenTab={a.openNetDiag} />,
  },
  tab: {
    kind: "netdiag",
    render: (tab, ctx) => (
      <NetDiagTab
        onError={ctx.reportError}
        initialSourceId={tab.sourceHostId}
        onShowTargets={() => ctx.showSidebarPanel("netdiag")}
        // Remonte quand l'onglet est re-visé depuis le menu d'un autre hôte,
        // pour que la sélection suive au lieu de garder la source de
        // l'incident précédent — c'est ce remontage que l'effet `seedSource`
        // de l'onglet guette.
        key={tab.sourceHostId ?? "local"}
      />
    ),
  },
});
