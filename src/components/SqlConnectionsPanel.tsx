import { sqlConnectionTarget, sqlConnectionViaHostId, sqlEngineLabel, type SqlConnection, type Workspace } from "../lib/types";
import { IconDatabase, IconPlus, IconEdit, IconFlash, IconDownload } from "./ui-icons";

interface SqlConnectionsPanelProps {
  workspace: Workspace;
  onConnect: (conn: SqlConnection) => void;
  onNewConnection: () => void;
  onEditConnection: (conn: SqlConnection) => void;
  onImportAws: () => void;
}

/** List-only — creating/editing (and deleting, from inside that form) goes
 * through `SqlConnectionForm` in the app's right panel, same as hosts/groups
 * (`App.tsx`'s `showRightPanel`), not an inline expansion in this list. */
export function SqlConnectionsPanel({ workspace, onConnect, onNewConnection, onEditConnection, onImportAws }: SqlConnectionsPanelProps) {
  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className="sidebar-scroll min-h-0 min-w-0 flex-1 space-y-2 overflow-y-auto pb-2 pl-2 pt-2">
        <button
          onClick={onNewConnection}
          className="accent-surface flex w-full items-center justify-center gap-1.5 rounded-xl border py-2 text-xs font-semibold transition-all"
        >
          <IconPlus size={13} /> Ajouter une connexion
        </button>
        <button
          onClick={onImportAws}
          className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-[var(--c-border)] py-1.5 text-[11px] text-[var(--c-text-muted)] hover:border-[var(--c-accent)] hover:text-[var(--c-accent-text)]"
        >
          <IconDownload size={12} /> Importer depuis AWS
        </button>
        {workspace.sqlConnections.map((conn) => {
          const viaHostId = sqlConnectionViaHostId(conn);
          const viaHost = viaHostId ? workspace.hosts.find((h) => h.id === viaHostId) : null;
          // "sur" for SQLite (the file lives there), "via" for everything else
          // (the connection is tunnelled through it) — see `sqlConnectionViaHostId`.
          const viaPreposition = conn.engine === "sqlite" ? "sur" : "via";
          return (
            <div key={conn.id} className="rounded-xl border border-transparent bg-[var(--c-bg3)] p-2.5 transition-all hover:border-white/15">
              <div className="flex items-center gap-2">
                <IconDatabase size={14} className="shrink-0 text-[var(--c-text-faint)]" />
                <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-[var(--c-text)]">{conn.label}</span>
              </div>
              <p className="mt-0.5 truncate pl-[22px] text-[10px] text-[var(--c-text-muted)]">
                {sqlEngineLabel(conn.engine)} ·{" "}
                <span className="font-mono">{sqlConnectionTarget(conn)}</span>
                {viaHost && <> · {viaPreposition} {viaHost.label}</>}
              </p>
              <div className="mt-2 flex gap-1">
                <button
                  onClick={() => onConnect(conn)}
                  className="accent-surface flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded-md border py-1.5 text-xs font-medium"
                >
                  <IconFlash size={11} className="shrink-0" /> <span className="truncate">Connexion</span>
                </button>
                <button
                  onClick={() => onEditConnection(conn)}
                  className="flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded-md bg-[var(--c-bg2)] px-2 py-1.5 text-xs text-[var(--c-text-secondary)] hover:bg-white/5"
                >
                  <IconEdit size={11} className="shrink-0" /> <span className="truncate">Modifier</span>
                </button>
              </div>
            </div>
          );
        })}
        {workspace.sqlConnections.length === 0 && (
          <p className="px-1 py-4 text-center text-[13px] text-[var(--c-text-muted)]">Aucune connexion SQL configurée</p>
        )}
      </div>
    </div>
  );
}
