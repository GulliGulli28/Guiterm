import { lazy } from "react";
import { defineModule } from "./types";

const SettingsPanel = lazy(() => import("../components/SettingsPanel").then((m) => ({ default: m.SettingsPanel })));

// Une page, plus un panneau : les réglages s'empilaient dans 560 px de barre
// latérale pendant que la zone principale restait vide (refonte, tranche 5).
// Le seul bouton du rail non masquable avec Hôtes — c'est de là qu'on masque
// les autres (cf. `lib/sidebarButtons.ts`).
export const settingsModule = defineModule({
  id: "settings",
  label: "Réglages",
  commandDomains: ["export"],
  tab: {
    kind: "settings",
    render: (_tab, ctx, isActive, a) => (
      <SettingsPanel
        workspace={ctx.workspace}
        onWorkspaceUpdate={ctx.refreshWorkspace}
        onError={ctx.reportError}
        preferences={ctx.preferences}
        onPreferencesChange={ctx.updatePreferences}
        vaultStatus={a.vaultStatus}
        onVaultStatusChange={a.onVaultStatusChange}
        active={isActive}
      />
    ),
  },
});
