import { lazy } from "react";
import { defineModule } from "./types";

const SftpPanel = lazy(() => import("../components/SftpPanel").then((m) => ({ default: m.SftpPanel })));

export const sftpModule = defineModule({
  id: "sftp",
  label: "SFTP",
  panel: {
    kind: "sftp",
    render: (ctx, a) => <SftpPanel workspace={ctx.workspace} onOpenTransfer={a.openTransfer} />,
  },
});
