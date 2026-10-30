import { lazy } from "react";
import { vaultSections } from "../lib/vaultSections";
import { defineModule } from "./types";

const KeysPage = lazy(() => import("../components/KeysPage").then((m) => ({ default: m.KeysPage })));

/** « Clés et empreintes » : le trousseau, les clés d'hôtes approuvées
 * (anciennement le panneau Known Hosts) et l'agent SSH, sur une page. */
export const keychainModule = defineModule({
  id: "keychain",
  label: "Clés et empreintes",
  commandDomains: ["keys", "known_hosts"],
  tab: {
    kind: "keys",
    render: (_tab, ctx, _isActive, a) => (
      <KeysPage
        workspace={ctx.workspace}
        vaultSections={vaultSections(a.guivaultStatus)}
        onAddKey={a.addKey}
        onGenerateKey={a.generateKey}
        onDeleteKey={a.deleteKey}
        onRenameKey={a.renameKey}
        onError={ctx.reportError}
      />
    ),
  },
});
