import { lazy } from "react";
import { defineModule } from "./types";

const SettingsPanel = lazy(() => import("../components/SettingsPanel").then((m) => ({ default: m.SettingsPanel })));

// Le seul panneau non masquable, et pour cause : c'est de là qu'on masque les
// autres (cf. `lib/sidebarButtons.ts`). Il est déclaré ici comme les autres —
// le registre décide *où le rendu vit*, pas *ce qui est optionnel*.
export const settingsModule = defineModule({
  id: "settings",
  label: "Paramètres",
  panel: {
    kind: "settings",
    render: (ctx, a) => (
      <SettingsPanel
        workspace={ctx.workspace}
        onWorkspaceUpdate={ctx.refreshWorkspace}
        onError={ctx.reportError}
        preferences={ctx.preferences}
        onPreferencesChange={a.updatePreferences}
        vaultStatus={a.vaultStatus}
        onVaultStatusChange={a.onVaultStatusChange}
      />
    ),
  },
});
