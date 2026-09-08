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
  /** « Exécuter une commande sur ces cibles ».
   *
   * La flotte accepte tout ce qu'une clé peut désigner — hôte SSH, conteneur
   * Docker, pod K8s, machine locale — donc aucune n'est écartée, contrairement
   * au diagnostic. C'est le retour du trajet : « ces douze-là ne répondent
   * pas » devient « redémarre le service sur ces douze-là ». */
  objects: {
    actionsFor: (obj, _ctx, open) => {
      if (obj.kind !== "targets" || obj.keys.length === 0) return [];
      return [{
        id: "fleet.run-on",
        label: `Exécuter une commande sur ${obj.keys.length === 1 ? "cette cible" : `ces ${obj.keys.length} cibles`}`,
        run: () => open.openFleet({ targetKeys: obj.keys }),
      }];
    },
  },
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
    render: (tab, ctx) => (
      <FleetTab
        workspace={ctx.workspace}
        onError={ctx.reportError}
        onWorkspaceUpdate={ctx.refreshWorkspace}
        onShowTargets={() => ctx.showSidebarPanel("fleet")}
        objectActions={ctx.objectActions}
        initialTargetKeys={tab.initialTargetKeys}
        // Même raison que l'onglet de diagnostic : l'onglet est unique, donc
        // une seconde sélection envoyée ne changerait rien d'autre et
        // n'aurait pas remonté — les cases seraient restées sur l'envoi
        // précédent, sous un onglet qu'on vient pourtant de viser.
        key={(tab.initialTargetKeys ?? []).join(",")}
      />
    ),
  },
});
