import { lazy } from "react";
import { directoryOf } from "../lib/appObject";
import { hostOf } from "./hostBound";
import { defineModule } from "./types";

const TransferTab = lazy(() => import("../components/TransferTab").then((m) => ({ default: m.TransferTab })));

export const transferModule = defineModule({
  id: "transfer",
  label: "Transfert de fichiers",
  commandDomains: ["sftp", "remote_edit"],
  /** « Ouvrir un transfert ici » — le symétrique du terminal ci-dessus.
   *
   * Ce lien-là n'existait pas du tout : on pouvait aller des fichiers vers un
   * terminal, jamais l'inverse ni depuis ailleurs. Trouver un fichier par la
   * recherche distante puis vouloir le rapatrier demandait de rouvrir un
   * transfert et de renaviguer jusqu'à son dossier à la main. */
  objects: {
    actionsFor: (obj, _ctx, open) => {
      if (obj.kind !== "remotePath") return [];
      // Rien à proposer sur un chemin local : le panneau **gauche** de tout
      // transfert est déjà cette machine. Offrir l'action puis échouer serait
      // une entrée de menu morte — c'est au module de savoir ce qu'il ne sait
      // pas faire, pas à l'utilisateur de le découvrir en cliquant.
      if (obj.source.kind === "local") return [];
      return [{
        id: "transfer.open-here",
        label: "Ouvrir un transfert sur ce dossier",
        run: () => open.openTransferIn(obj.source, directoryOf(obj)),
      }];
    },
  },
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
          objectActions={ctx.objectActions}
          initialPath={tab.initialPath}
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
