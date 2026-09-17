import { lazy } from "react";
import { vaultNameMap } from "../lib/vaultLabels";
import { defineModule } from "./types";

const KeychainPanel = lazy(() => import("../components/KeychainPanel").then((m) => ({ default: m.KeychainPanel })));

export const keychainModule = defineModule({
  id: "keychain",
  label: "Clés",
  commandDomains: ["keys"],
  panel: {
    kind: "keychain",
    render: (ctx, a) => (
      <KeychainPanel
        workspace={ctx.workspace}
        vaultNameOf={vaultNameMap(ctx.workspace, a.guivaultStatus)}
        onAddKey={a.addKey}
        onGenerateKey={a.generateKey}
        onDeleteKey={a.deleteKey}
        onRenameKey={a.renameKey}
      />
    ),
  },
});
