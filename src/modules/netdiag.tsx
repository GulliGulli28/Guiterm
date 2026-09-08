import { lazy } from "react";
import { isSshTargetKey } from "../lib/types";
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
      if (obj.kind === "endpoint") {
        return [{
          id: "netdiag.probe",
          label: obj.port === null
            ? `Diagnostiquer ${obj.address}`
            : `Diagnostiquer ${obj.address}, port ${obj.port}`,
          run: () => open.openNetDiag(obj.via, { destination: obj.address, tcpPort: obj.port ?? undefined }),
        }];
      }
      if (obj.kind === "targets") {
        // **Le sens « vers » ne sonde que des hôtes SSH** : un conteneur
        // Docker, un pod ou la machine locale n'a pas d'adresse enregistrée à
        // viser. Le filtrage est fait ici, pas dans l'onglet, pour que le
        // libellé annonce le nombre exact — et pour que l'action disparaisse
        // quand il n'en reste aucun, plutôt que d'ouvrir un onglet vide.
        const hosts = obj.keys.filter(isSshTargetKey);
        if (hosts.length === 0) return [];
        return [{
          id: "netdiag.check-targets",
          label: `Vérifier que ${hosts.length === 1 ? "cet hôte répond" : `ces ${hosts.length} hôtes répondent`}`,
          run: () => open.openNetDiag(undefined, { targetKeys: hosts }),
        }];
      }
      return [];
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
        initialTargetKeys={tab.initialTargetKeys}
        objectActions={ctx.objectActions}
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
        key={`${tab.sourceHostId ?? "local"}:${tab.initialDestination ?? ""}:${(tab.initialTargetKeys ?? []).join(",")}`}
      />
    ),
  },
});
