import { lazy } from "react";
import { defineModule } from "./types";

const AwsIdentitiesPanel = lazy(() => import("../components/AwsIdentitiesPanel").then((m) => ({ default: m.AwsIdentitiesPanel })));

export const awsModule = defineModule({
  id: "aws",
  label: "Identités AWS",
  commandDomains: ["aws", "aws_sso"],
  panel: {
    kind: "aws",
    render: (ctx, a) => (
      <AwsIdentitiesPanel
        onConfigureSso={a.configureSso}
        onReconnectSso={a.reconnectSso}
        onAddProfiles={a.addAwsProfiles}
        onWorkspaceUpdate={ctx.refreshWorkspace}
        refreshToken={a.awsRefreshToken}
        alerts={a.awsAlerts}
      />
    ),
  },
});
