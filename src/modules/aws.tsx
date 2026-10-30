import { lazy } from "react";
import { defineModule } from "./types";

const CloudPage = lazy(() => import("../components/CloudPage").then((m) => ({ default: m.CloudPage })));

/** Identités cloud : les sessions AWS SSO et leurs profils, et où en sont
 * `gcloud` et `az` — une page, qui tenait dans la barre latérale. */
export const awsModule = defineModule({
  id: "aws",
  label: "Identités cloud",
  commandDomains: ["aws", "aws_sso"],
  tab: {
    kind: "cloud",
    render: (_tab, ctx, _isActive, a) => (
      <CloudPage
        onConfigureSso={a.configureSso}
        onReconnectSso={a.reconnectSso}
        onAddProfiles={a.addAwsProfiles}
        onWorkspaceUpdate={ctx.refreshWorkspace}
        refreshToken={a.awsRefreshToken}
        alerts={a.awsAlerts}
        onImportHosts={a.importHosts}
      />
    ),
  },
});
