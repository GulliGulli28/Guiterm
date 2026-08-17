import { lazy } from "react";
import { defineModule } from "./types";

const KeychainPanel = lazy(() => import("../components/KeychainPanel").then((m) => ({ default: m.KeychainPanel })));

export const keychainModule = defineModule({
  id: "keychain",
  label: "Clés",
  panel: {
    kind: "keychain",
    render: (ctx, a) => (
      <KeychainPanel
        workspace={ctx.workspace}
        onAddKey={a.addKey}
        onGenerateKey={a.generateKey}
        onDeleteKey={a.deleteKey}
        onRenameKey={a.renameKey}
      />
    ),
  },
});
