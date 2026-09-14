import { sqlConnectionTarget, sqlConnectionVia, sqlConnectionViaHostId, sqlEngineLabel, type Host, type SqlConnection, type Workspace } from "../lib/types";
import { IconDatabase, IconPlus, IconEdit, IconDownload, IconTunnels } from "./ui-icons";

interface SqlConnectionsPanelProps {
  workspace: Workspace;
  onConnect: (conn: SqlConnection) => void;
  onNewConnection: () => void;
  onEditConnection: (conn: SqlConnection) => void;
  onImportAws: () => void;
  /** Ouvrir un terminal sur l'hôte que cette connexion traverse. Le lien
   * existait déjà dans le modèle et s'affichait déjà en texte (« via
   * bastion-prod ») — il ne menait simplement nulle part. */
  onConnectHost: (host: Host) => void;
}

/** List-only — creating/editing (and deleting, from inside that form) goes
 * through `SqlConnectionForm` in the app's right panel, same as hosts/groups
 * (`App.tsx`'s `showRightPanel`), not an inline expansion in this list. */
export function SqlConnectionsPanel({ workspace, onConnect, onNewConnection, onEditConnection, onImportAws, onConnectHost }: SqlConnectionsPanelProps) {
  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className="flex shrink-0 items-center gap-1.5">
        <button onClick={onNewConnection} className="btn btn-primary flex-1">
          <IconPlus size={13} /> Nouvelle connexion
        </button>
        <button onClick={onImportAws} title="Importer depuis AWS (RDS, Aurora, ElastiCache…)" aria-label="Importer depuis AWS" className="btn btn-secondary text-[var(--c-text-secondary)]">
          <IconDownload size={12} /> AWS
        </button>
      </div>
      <div className="sidebar-scroll -mx-1 mt-2 min-h-0 min-w-0 flex-1 overflow-y-auto px-1 pb-2">
        {workspace.sqlConnections.map((conn) => {
          // Carries its own preposition ("sur" for a SQLite file that lives
          // there, "via" for anything tunnelled) and covers SSM, which has no
          // saved host to name — see `sqlConnectionVia`.
          const via = sqlConnectionVia(conn, workspace.hosts);
          // `null` pour un tunnel SSM ou une connexion directe : il y a alors
          // un texte à afficher, mais aucun hôte d'ici où aller.
          const viaHostId = sqlConnectionViaHostId(conn);
          const viaHost = viaHostId ? workspace.hosts.find((h) => h.id === viaHostId) ?? null : null;
          return (
            <div key={conn.id} className="list-row group mb-0.5 h-11 pr-1.5">
              <button
                onClick={() => onConnect(conn)}
                title={`Se connecter — ${sqlConnectionTarget(conn)}`}
                className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
              >
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-[var(--c-bg3)] text-[var(--c-text-secondary)]">
                  <IconDatabase size={13} />
                </span>
                <span className="flex min-w-0 flex-1 flex-col justify-center gap-0.5 leading-tight">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate text-[12.5px] font-medium text-[var(--c-text)]">{conn.label}</span>
                    <span className="tag">{sqlEngineLabel(conn.engine)}</span>
                  </span>
                  <span className="truncate font-mono text-[10.5px] text-[var(--c-text-muted)]">
                    {sqlConnectionTarget(conn)}
                    {via && !viaHost && <span className="font-sans"> · {via}</span>}
                  </span>
                </span>
              </button>
              {via && viaHost && (
                <button
                  onClick={() => onConnectHost(viaHost)}
                  title={`${via} — ouvrir un terminal sur ${viaHost.label}`}
                  aria-label={`Ouvrir un terminal sur ${viaHost.label}`}
                  className="btn btn-ghost btn-sm btn-icon shrink-0 text-[var(--c-text-muted)] opacity-0 focus-visible:opacity-100 group-hover:opacity-100"
                >
                  <IconTunnels size={12} />
                </button>
              )}
              <button
                onClick={() => onEditConnection(conn)}
                title="Modifier"
                aria-label={`Modifier ${conn.label}`}
                className="btn btn-ghost btn-sm btn-icon shrink-0 opacity-0 focus-visible:opacity-100 group-hover:opacity-100"
              >
                <IconEdit size={12} />
              </button>
            </div>
          );
        })}
        {workspace.sqlConnections.length === 0 && (
          <div className="px-2 py-8 text-center">
            <p className="text-[12.5px] font-medium text-[var(--c-text-secondary)]">Aucune connexion</p>
            <p className="help-text mt-1">MySQL, PostgreSQL, SQLite, Redis ou MongoDB — en direct, ou à travers un de vos hôtes SSH.</p>
          </div>
        )}
      </div>
    </div>
  );
}
