import { lazy } from "react";
import { defineModule } from "./types";

const GuiVaultPanel = lazy(() => import("../components/GuiVaultPanel").then((m) => ({ default: m.GuiVaultPanel })));

/** Compte GuiVault, synchronisation chiffrée et vaults partagés — une page
 * (refonte, tranche 5) : les vaults en cartes, la fiche d'un vault en
 * sous-page à onglets. Le statut vit dans `App` (le formulaire d'hôte en a
 * besoin pour son champ « Vault ») ; la page ne fait que le lire et demander
 * son rechargement. */
export const guivaultModule = defineModule({
  id: "guivault",
  label: "GuiVault",
  commandDomains: ["guivault"],
  tab: {
    kind: "guivault",
    render: (_tab, ctx, _isActive, a) => (
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
