import { lazy } from "react";
import { defineModule } from "./types";

const TunnelsPanel = lazy(() => import("../components/TunnelsPanel").then((m) => ({ default: m.TunnelsPanel })));

export const tunnelsModule = defineModule({
  id: "tunnels",
  label: "Tunnels",
  panel: {
    kind: "tunnels",
    render: (ctx, a) => (
      <TunnelsPanel
        workspace={ctx.workspace}
        onAddForward={a.addForward}
        onUpdateForward={a.updateForward}
        onDeleteForward={a.deleteForward}
        onError={ctx.reportError}
      />
    ),
  },
});
