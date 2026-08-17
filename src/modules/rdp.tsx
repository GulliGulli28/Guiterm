import { lazy } from "react";
import { hostOf } from "./hostBound";
import { defineModule } from "./types";

const RdpTab = lazy(() => import("../components/RdpTab").then((m) => ({ default: m.RdpTab })));

export const rdpModule = defineModule({
  id: "rdp",
  label: "Aperçu RDP",
  tab: {
    kind: "rdp-view",
    render: (tab, ctx, isActive) => {
      const host = hostOf(ctx, tab.hostId);
      if (!host) return null;
      return (
        <RdpTab
          host={host}
          isActive={isActive}
          preferences={ctx.preferences}
          // Pas de `"disconnected"` ici, contrairement au terminal : une
          // session RDP qui se termine n'a pas de notification de déconnexion.
          onDisconnect={() => ctx.closeTab(tab.id)}
          ref={(handle) => ctx.registerTerminalHandle(tab.id, handle)}
        />
      );
    },
  },
});
