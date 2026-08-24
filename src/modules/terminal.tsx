import { lazy } from "react";
import { hostOf } from "./hostBound";
import { defineModule } from "./types";

// `lazy` depuis le 2026-08-18, contrairement à ce que ce fichier affirmait
// jusque-là. `TerminalTab` et `LocalTerminalTab` sont les seuls à importer
// xterm comme valeur, soit **367 ko** — 40 % du JS chargé au démarrage — pour
// un composant que rien ne monte au lancement : les onglets restaurés le sont
// en placeholders, et l'app s'ouvre sur le panneau Hôtes.
//
// Le coût est un chargement de chunk à l'ouverture du premier terminal. Il est
// local (empaqueté par Tauri, aucun aller-retour réseau) et `TabLoadingFallback`
// couvre l'intervalle.
const TerminalTab = lazy(() => import("../components/TerminalTab").then((m) => ({ default: m.TerminalTab })));
export const terminalModule = defineModule({
  id: "terminal",
  label: "Terminal SSH",
  commandDomains: ["terminal", "docker", "k8s"],
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
          onDetach={() => ctx.detachTab(tab.id)}
          onInputData={(data) => ctx.mirrorInput(tab.id, data)}
          // `App.tsx` gardait ici un `tab.kind === "terminal" ? … : undefined`,
          // rendu nécessaire par le fait que les trois onglets liés à un hôte
          // partagent un seul membre de `TabMeta`. Le registre le rend inutile :
          // ce rendu n'est appelé que pour le `kind` qu'il a déclaré.
          dockerContainerId={tab.dockerContainerId}
          k8sPodName={tab.k8sPodName}
          k8sContainerName={tab.k8sContainerName}
          initialCommand={tab.initialCommand}
          sessionKey={tab.sessionKey}
          readOnly={tab.readOnly}
          onSessionKey={(key) => ctx.rememberSessionKey(tab.id, key)}
          ref={(handle) => ctx.registerTerminalHandle(tab.id, handle)}
        />
      );
    },
  },
});
