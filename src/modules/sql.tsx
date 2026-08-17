import { lazy } from "react";
import { SqlConnectionTab } from "../components/SqlConnectionTab";
import { defineModule } from "./types";

const SqlConnectionsPanel = lazy(() => import("../components/SqlConnectionsPanel").then((m) => ({ default: m.SqlConnectionsPanel })));

// Importé eager, comme il l'était dans `App.tsx` : ce commit est un
// déplacement, pas un changement de découpage du bundle. Le passer en `lazy`
// est une décision à part — défendable (les bases de données ne sont pas le
// chemin principal), mais qui mérite d'être prise et mesurée pour elle-même.
export const sqlModule = defineModule({
  id: "sql",
  label: "Bases de données",
  tab: {
    kind: "sql",
    render: (tab, ctx) => {
      // La connexion peut avoir été supprimée pendant que l'onglet était
      // ouvert — même cas que l'hôte disparu des onglets liés à un hôte.
      const connection = ctx.workspace.sqlConnections.find((c) => c.id === tab.sqlConnectionId);
      if (!connection) return null;
      return <SqlConnectionTab connection={connection} hosts={ctx.workspace.hosts} onError={ctx.reportError} />;
    },
  },
  // Le premier module à porter les deux : l'onglet de requêtes et le panneau
  // qui liste les connexions. C'est la forme que le registre visait — une
  // fonctionnalité, pas une couche.
  panel: {
    kind: "database",
    render: (ctx, a) => (
      <SqlConnectionsPanel
        workspace={ctx.workspace}
        onConnect={a.connectSql}
        onNewConnection={a.newSqlConnection}
        onEditConnection={a.editSqlConnection}
        onImportAws={a.importAwsDatabases}
      />
    ),
  },
});
