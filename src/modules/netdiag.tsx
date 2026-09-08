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
  /** « Diagnostiquer cette adresse ».
   *
   * Le sens « depuis » avec l'hôte où l'adresse a été lue comme source : une
   * IP privée vue dans un `ss` sur un bastion ne veut rien dire depuis cette
   * machine-ci. C'est le second sens que `useNetDiagSelection` documente,
   * rendu atteignable en un geste au lieu d'un aller-retour par la barre. */
  objects: {
    actionsFor: (obj, _ctx, open) => {
      if (obj.kind !== "endpoint") return [];
      return [{
        id: "netdiag.probe",
        label: obj.port === null
          ? `Diagnostiquer ${obj.address}`
          : `Diagnostiquer ${obj.address}, port ${obj.port}`,
        run: () => open.openNetDiag(obj.via, { destination: obj.address, tcpPort: obj.port ?? undefined }),
      }];
    },
  },
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
        initialDestination={tab.initialDestination}
        initialTcpPort={tab.initialTcpPort}
        onShowTargets={() => ctx.showSidebarPanel("netdiag")}
        // Remonte quand l'onglet est re-visé depuis le menu d'un autre hôte,
        // pour que la sélection suive au lieu de garder la source de
        // l'incident précédent — c'est ce remontage que l'effet `seedSource`
        // de l'onglet guette.
        //
        // **La destination en fait partie** : l'onglet est unique, donc
        // envoyer une seconde adresse depuis un terminal ne change pas la
        // source et n'aurait rien remonté — le champ serait resté sur
        // l'adresse précédente, sous un onglet qu'on vient pourtant de viser.
        key={`${tab.sourceHostId ?? "local"}:${tab.initialDestination ?? ""}`}
      />
    ),
  },
});
