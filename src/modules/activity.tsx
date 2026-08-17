import { lazy } from "react";
import { defineModule } from "./types";

const ActivityTab = lazy(() => import("../components/ActivityTab").then((m) => ({ default: m.ActivityTab })));

export const activityModule = defineModule({
  id: "activity",
  label: "Activité",
  tab: {
    kind: "activity",
    render: (_tab, ctx) => (
      <ActivityTab
        workspace={ctx.workspace}
        onError={ctx.reportError}
        onExported={(message) => ctx.pushNotification("success", message)}
      />
    ),
  },
});
