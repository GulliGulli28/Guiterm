import { lazy } from "react";
import { defineModule } from "./types";
import { useFleetSelection } from "../hooks/useFleetSelection";

const RunbookTab = lazy(() => import("../components/RunbookTab").then((m) => ({ default: m.RunbookTab })));
const RunbookPanel = lazy(() => import("../components/RunbookPanel").then((m) => ({ default: m.RunbookPanel })));

/** Le compteur de cibles du panneau.
 *
 * Un composant minuscule plutôt qu'un champ de plus dans `AppContext` : la
 * sélection appartient au module de flotte, et `modules/types` demande de ne
 * faire grossir le contexte central que pour ce dont un *deuxième* module a
 * besoin d'une manière que le fournisseur ne couvre pas. Ici il le couvre —
 * les deux points de rendu du registre sont sous `FleetSelectionProvider`.
 */
function SelectedTargetCount({ children }: { children: (count: number) => React.ReactNode }) {
  const { selected } = useFleetSelection();
  return <>{children(selected.size)}</>;
}

/**
 * Les runbooks : des procédures ordonnées au-dessus du moteur de flotte.
 *
 * **Pas de sélection de cibles à lui.** Un runbook tourne sur les mêmes
 * machines qu'une opération de flotte, et l'app a déjà décidé une fois où ce
 * choix se fait (commit « Flotte et diagnostic réseau : le choix des cibles
 * passe dans la barre latérale »). En ouvrir une troisième copie redonnerait
 * ce que ce chantier avait justement supprimé : cocher ses machines à un
 * endroit différent selon ce qu'on veut en faire. Le panneau renvoie donc vers
 * celui de la flotte, et l'onglet lit la même sélection.
 *
 * Le module ne possède aucun domaine de commandes en propre au sens du
 * registre : `runbook` est le sien, `fleet`/`adaptive` restent à la flotte, qui
 * les a écrits.
 */
export const runbookModule = defineModule({
  id: "runbook",
  label: "Runbooks",
  commandDomains: ["runbook"],
  panel: {
    kind: "runbook",
    render: (ctx, a) => (
      <SelectedTargetCount>
        {(count) => (
          <RunbookPanel
            workspace={ctx.workspace}
            onOpen={a.openRunbook}
            onCreate={a.createRunbook}
            onDelete={a.deleteRunbook}
            selectedTargets={count}
            onShowTargets={() => ctx.showSidebarPanel("fleet")}
          />
        )}
      </SelectedTargetCount>
    ),
  },
  tab: {
    kind: "runbook",
    render: (tab, ctx) => (
      <RunbookTab
        runbookId={tab.runbookId}
        workspace={ctx.workspace}
        onError={ctx.reportError}
        onWorkspaceUpdate={ctx.refreshWorkspace}
        onShowTargets={() => ctx.showSidebarPanel("fleet")}
      />
    ),
  },
});
