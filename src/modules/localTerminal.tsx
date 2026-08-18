import { lazy } from "react";
import { defineModule } from "./types";

// Lazy pour la même raison que `terminal` : ce composant tire xterm, et rien
// ne le monte au lancement.
const LocalTerminalTab = lazy(() => import("../components/LocalTerminalTab").then((m) => ({ default: m.LocalTerminalTab })));

export const localTerminalModule = defineModule({
  id: "local-terminal",
  label: "Terminal local",
  tab: {
    kind: "local-terminal",
    render: (tab, ctx, isActive) => (
      <LocalTerminalTab
        isActive={isActive}
        preferences={ctx.preferences}
        initialCommand={tab.initialCommand}
        shell={tab.shell}
        onLongCommand={ctx.notifyLongCommand}
        onDisconnect={() => ctx.closeTab(tab.id, "disconnected")}
        onInputData={(data) => ctx.mirrorInput(tab.id, data)}
        ref={(handle) => ctx.registerTerminalHandle(tab.id, handle)}
      />
    ),
  },
});
