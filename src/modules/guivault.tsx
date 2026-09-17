import { lazy } from "react";
import { defineModule } from "./types";

const GuiVaultPanel = lazy(() => import("../components/GuiVaultPanel").then((m) => ({ default: m.GuiVaultPanel })));

/** Compte GuiVault, synchronisation chiffrée et vaults partagés. Le statut
 * vit dans `App` (le formulaire d'hôte en a besoin pour son sélecteur de
 * vault) ; le panneau ne fait que le lire et demander son rechargement. */
export const guivaultModule = defineModule({
  id: "guivault",
  label: "GuiVault",
  commandDomains: ["guivault"],
  panel: {
    kind: "guivault",
    render: (ctx, a) => (
      <GuiVaultPanel
        workspace={ctx.workspace}
        status={a.guivaultStatus}
        onStatusChange={a.onGuivaultStatusChange}
        focus={a.guivaultFocus}
        onWorkspaceUpdate={ctx.refreshWorkspace}
        onError={ctx.reportError}
        onNotify={(m) => ctx.pushNotification("info", m)}
      />
    ),
  },
});
