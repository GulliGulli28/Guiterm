import { TerminalTab } from "../components/TerminalTab";
import { hostOf } from "./hostBound";
import { defineModule } from "./types";

// Pas de `lazy` ici, contrairement aux autres modules : c'est le chemin
// principal de l'app, chargé d'office par `App.tsx` (le panneau de split monte
// le même composant). Le sortir du bundle initial ne ferait que retarder le
// premier terminal.
export const terminalModule = defineModule({
  id: "terminal",
  label: "Terminal SSH",
  tab: {
    kind: "terminal",
    render: (tab, ctx, isActive) => {
      const host = hostOf(ctx, tab.hostId);
      if (!host) return null;
      return (
        <TerminalTab
          host={host}
          isActive={isActive}
          preferences={ctx.preferences}
          onLongCommand={ctx.notifyLongCommand}
          onDisconnect={() => ctx.closeTab(tab.id, "disconnected")}
          onInputData={(data) => ctx.mirrorInput(tab.id, data)}
          // `App.tsx` gardait ici un `tab.kind === "terminal" ? … : undefined`,
          // rendu nécessaire par le fait que les trois onglets liés à un hôte
          // partagent un seul membre de `TabMeta`. Le registre le rend inutile :
          // ce rendu n'est appelé que pour le `kind` qu'il a déclaré.
          dockerContainerId={tab.dockerContainerId}
          k8sPodName={tab.k8sPodName}
          k8sContainerName={tab.k8sContainerName}
          ref={(handle) => ctx.registerTerminalHandle(tab.id, handle)}
        />
      );
    },
  },
});
