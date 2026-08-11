import { useCallback, useEffect, useRef, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { api } from "../lib/api";
import type { Host, SqlExportDestination, TableInfo } from "../lib/types";
import { RemoteSavePathPicker } from "./RemoteSavePathPicker";
import { IconChevronDown, IconChevronRight, IconDownload } from "./ui-icons";

const selectClass =
  "w-full rounded-md bg-[var(--c-bg2)] px-3 py-2 text-sm text-[var(--c-text)] focus:outline-none focus:ring-1 focus:ring-[var(--c-accent-hover)]";
const inputClass = `${selectClass} font-mono placeholder:text-[var(--c-text-muted)]`;
const EMPTY_TABLE_SET: Set<string> = new Set();

interface SqlExportPanelProps {
  /** Whether "Exporter" is the sub-tab currently on screen.
   *
   * The panel stays mounted when it isn't — that is what lets a selection
   * survive a trip through "Structure" — so it can't use its own mount as
   * "the tab was just opened". This flag is that signal instead. */
  active: boolean;
  /** Names the fallback dump file when the selection spans several schemas. */
  connectionLabel: string;
  /** Read through a getter rather than passed as a value: the id only exists
   * once the connection effect has run, and `SqlTab` deliberately keeps it in
   * a ref so reading it re-renders nothing. */
  getSessionId: () => string | null;
  schemas: string[];
  /** The tree's shared table cache — also feeding "Structure" and "Données",
   * which is why it stays owned by `SqlTab` rather than moving in here. */
  tablesBySchema: Record<string, TableInfo[]>;
  /** Asks `SqlTab` to fill `tablesBySchema` for a schema not browsed yet. */
  onNeedTables: (schema: string) => void;
  /** What to tick by default the first time the tab is opened — whatever the
   * tree has selected, or the first schema. */
  initialSchema: string | null;
  multiDatabase: boolean;
  hosts: Host[];
}

/**
 * The "Exporter" sub-tab — a checklist tree spanning every schema/database
 * currently visible (each expandable to individual tables, plus a schema-level
 * "select all" checkbox and a top-level "Toutes les bases" shortcut so a full
 * export is a single click), and a destination (a local file via the native
 * save dialog, or a path on a saved SSH host — typed directly or picked via
 * `RemoteSavePathPicker`'s directory browser — uploaded over SFTP) before
 * calling `api.exportSqlDump`. Produces a single `.sql` file with
 * `DROP TABLE IF EXISTS` + `CREATE TABLE` + batched `INSERT` statements per
 * selected table, one schema's worth after another — see
 * `core::sql::dump_tables`'s doc comment.
 *
 * **Owns its own state**, where it used to sit in `SqlTab`: nine `useState`
 * and two refs threaded back down through twenty props, in a component that
 * already carried the connection, the tree, the data grid and the query pane.
 * Nothing outside this tab ever read any of it, so nothing outside needs to
 * hold it.
 *
 * `selectedTables` maps schema -> the set of its tables to include (a schema
 * absent from the map, or mapped to an empty set, contributes nothing);
 * spanning several schemas at once (e.g. "every database" on a MySQL
 * connection) just means several entries, concatenated into one file by
 * `export_sql_dump`. `pendingFullSelectRef` tracks schemas whose table list
 * was requested purely to select all of it once it arrives — a schema not yet
 * browsed in the tree has no cached entry to select from immediately.
 */
export function SqlExportPanel({
  active,
  connectionLabel,
  getSessionId,
  schemas,
  tablesBySchema,
  onNeedTables,
  initialSchema,
  multiDatabase,
  hosts,
}: SqlExportPanelProps) {
  const [selectedTables, setSelectedTables] = useState<Record<string, Set<string>>>({});
  const [expandedSchemas, setExpandedSchemas] = useState<Set<string>>(new Set());
  const [destKind, setDestKind] = useState<"local" | "remoteHost">("local");
  const [hostId, setHostId] = useState("");
  const [remotePath, setRemotePath] = useState("");
  const [showRemotePicker, setShowRemotePicker] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const pendingFullSelectRef = useRef<Set<string>>(new Set());
  const openedOnceRef = useRef(false);

  // Selects every table of `schema`, fetching its table list first if it
  // hasn't been browsed yet (`pendingFullSelectRef` — applied by the effect
  // below the moment it arrives). Shared by the schema-level "select all"
  // checkbox, "Toutes les bases", and the first-open default.
  const selectAllTablesIn = useCallback(
    (schema: string) => {
      const tables = tablesBySchema[schema];
      if (tables) {
        setSelectedTables((prev) => ({ ...prev, [schema]: new Set(tables.map((t) => t.name)) }));
      } else {
        pendingFullSelectRef.current.add(schema);
        onNeedTables(schema);
      }
    },
    [tablesBySchema, onNeedTables],
  );

  // Applies every schema in `pendingFullSelectRef` whose table list has just
  // arrived — at most once per schema (removed from the set as soon as it's
  // applied), so a later manual deselect isn't silently reset by an unrelated
  // re-fetch of the same schema.
  useEffect(() => {
    const ready = Array.from(pendingFullSelectRef.current).filter((schema) => tablesBySchema[schema]);
    if (ready.length === 0) return;
    ready.forEach((schema) => pendingFullSelectRef.current.delete(schema));
    setSelectedTables((prev) => {
      const next = { ...prev };
      ready.forEach((schema) => { next[schema] = new Set(tablesBySchema[schema].map((t) => t.name)); });
      return next;
    });
  }, [tablesBySchema]);

  // First opening of the tab defaults to whichever schema the tree has
  // selected (or the first one), fully ticked and expanded so its tables are
  // visible right away. Guarded so reopening the tab later never overrides a
  // selection the user has since changed — the guard is set even when there is
  // no schema to apply it to, exactly as before.
  useEffect(() => {
    if (!active || openedOnceRef.current) return;
    openedOnceRef.current = true;
    if (!initialSchema) return;
    setExpandedSchemas((prev) => new Set(prev).add(initialSchema));
    selectAllTablesIn(initialSchema);
  }, [active, initialSchema, selectAllTablesIn]);

  const toggleSchemaExpand = (schema: string) => {
    setExpandedSchemas((prev) => {
      const next = new Set(prev);
      if (next.has(schema)) next.delete(schema); else next.add(schema);
      return next;
    });
    if (!tablesBySchema[schema]) onNeedTables(schema);
  };

  const toggleSchemaAll = (schema: string) => {
    const tables = tablesBySchema[schema];
    const current = selectedTables[schema];
    const allSelected = !!tables && !!current && current.size === tables.length;
    if (allSelected) {
      setSelectedTables((prev) => { const next = { ...prev }; delete next[schema]; return next; });
    } else {
      selectAllTablesIn(schema);
    }
  };

  const toggleTable = (schema: string, table: string) => {
    setSelectedTables((prev) => {
      const current = new Set(prev[schema] ?? []);
      if (current.has(table)) current.delete(table); else current.add(table);
      const next = { ...prev };
      if (current.size === 0) delete next[schema]; else next[schema] = current;
      return next;
    });
  };

  // "Toutes les bases" — selects every table of every schema currently
  // visible, expanding them all so the result is visible at a glance. For a
  // PostgreSQL connection with no database configured, this only covers the
  // schemas of whichever database is currently active (see `multiDatabase`'s
  // doc comment in `SqlTab`) — switching database mid-export isn't attempted.
  const selectAllSchemas = () => {
    setExpandedSchemas(new Set(schemas));
    schemas.forEach(selectAllTablesIn);
  };

  const deselectAll = () => setSelectedTables({});

  /** The schema/table groups the current ticks describe, dropping the empty
   * ones — also what names the default dump file. */
  const includedGroups = () =>
    Object.entries(selectedTables)
      .filter(([, tables]) => tables.size > 0)
      .map(([schema, tables]) => ({ schema, tables: Array.from(tables) }));

  const defaultFileName = () => {
    const groups = includedGroups();
    return groups.length === 1
      ? `${groups[0].schema}.sql`
      : `${connectionLabel.replace(/[^\w.-]+/g, "_") || "export"}.sql`;
  };

  const runExport = async () => {
    const groups = includedGroups();
    const sessionId = getSessionId();
    if (!sessionId || groups.length === 0 || exporting) return;
    setError(null);
    setDone(null);

    let destination: SqlExportDestination;
    if (destKind === "local") {
      let path: string | null;
      try {
        path = await save({
          title: "Exporter le dump SQL",
          defaultPath: defaultFileName(),
          filters: [{ name: "SQL", extensions: ["sql"] }, { name: "Tous les fichiers", extensions: ["*"] }],
        });
      } catch (e) { setError(String(e)); return; }
      if (!path) return;
      destination = { kind: "local", path };
    } else {
      if (!hostId || !remotePath.trim()) return;
      destination = { kind: "remoteHost", hostId, path: remotePath.trim() };
    }

    setExporting(true);
    try {
      await api.exportSqlDump(sessionId, groups, destination);
      setDone(`Export réussi vers ${destination.path}`);
    } catch (e) {
      setError(String(e));
    } finally {
      setExporting(false);
    }
  };

  if (schemas.length === 0) {
    return <p className="text-xs text-[var(--c-text-faint)]">Aucune base/schéma à exporter pour le moment.</p>;
  }

  // Tunnel targets are SSH hosts by nature (SFTP needs a real shell account) —
  // same filter `SqlConnectionForm` already applies to its own host pickers.
  const sshHosts = hosts.filter((h) => (h.kind ?? "ssh") === "ssh");
  const hasSelection = Object.values(selectedTables).some((tables) => tables.size > 0);
  const canExport = hasSelection && (destKind === "local" || (!!hostId && !!remotePath.trim()));

  return (
    <>
      <div className="max-w-lg space-y-4">
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-[var(--c-text-secondary)]">Bases/schémas et tables</span>
            <div className="flex gap-2.5">
              <button onClick={selectAllSchemas} className="text-[11px] text-[var(--c-accent-text)] hover:underline">
                Toutes les bases
              </button>
              <button onClick={deselectAll} className="text-[11px] text-[var(--c-text-faint)] hover:underline">
                Tout désélectionner
              </button>
            </div>
          </div>
          {multiDatabase && (
            <p className="px-0.5 text-[11px] leading-relaxed text-[var(--c-text-muted)]">
              « Toutes les bases » ne couvre que la base PostgreSQL actuellement active — changer de base
              réinitialiserait la session en cours.
            </p>
          )}
          <div className="max-h-64 overflow-y-auto rounded-md border border-[var(--c-border)] bg-[var(--c-bg2)] p-1.5">
            {schemas.map((schema) => {
              const tables = tablesBySchema[schema];
              const selectedSet = selectedTables[schema] ?? EMPTY_TABLE_SET;
              const expanded = expandedSchemas.has(schema);
              const allSelected = !!tables && tables.length > 0 && selectedSet.size === tables.length;
              const partiallySelected = selectedSet.size > 0 && !allSelected;
              return (
                <div key={schema}>
                  <div className="flex items-center gap-1 rounded px-1 py-1 hover:bg-white/5">
                    <button onClick={() => toggleSchemaExpand(schema)} className="shrink-0 p-0.5 text-[var(--c-text-faint)]">
                      {expanded ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
                    </button>
                    <input
                      type="checkbox"
                      checked={allSelected}
                      ref={(el) => { if (el) el.indeterminate = partiallySelected; }}
                      onChange={() => toggleSchemaAll(schema)}
                    />
                    <button onClick={() => toggleSchemaExpand(schema)} className="min-w-0 flex-1 truncate py-0.5 text-left font-mono text-[13px] text-[var(--c-text)]">
                      {schema}
                    </button>
                    {selectedSet.size > 0 && (
                      <span className="shrink-0 text-[10px] text-[var(--c-text-faint)]">
                        {selectedSet.size} table{selectedSet.size > 1 ? "s" : ""}
                      </span>
                    )}
                  </div>
                  {expanded && (
                    <div className="ml-5 border-l-2 border-[var(--c-border)] pl-2">
                      {!tables ? (
                        <p className="px-1 py-1 text-[11px] text-[var(--c-text-muted)]">Chargement…</p>
                      ) : tables.length === 0 ? (
                        <p className="px-1 py-1 text-[11px] text-[var(--c-text-muted)]">Aucune table.</p>
                      ) : (
                        tables.map((t) => (
                          <label key={t.name} className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-[12.5px] text-[var(--c-text)] hover:bg-white/5">
                            <input type="checkbox" checked={selectedSet.has(t.name)} onChange={() => toggleTable(schema, t.name)} />
                            <span className="min-w-0 flex-1 truncate font-mono">{t.name}</span>
                            {t.kind === "view" && (
                              <span className="shrink-0 rounded-full bg-[var(--c-bg3)] px-1.5 py-0.5 text-[9px] text-[var(--c-text-secondary)]">vue</span>
                            )}
                          </label>
                        ))
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        <div className="space-y-1">
          <span className="text-xs font-medium text-[var(--c-text-secondary)]">Destination</span>
          <div className="flex gap-4 text-[13px] text-[var(--c-text)]">
            <label className="flex cursor-pointer items-center gap-1.5">
              <input type="radio" checked={destKind === "local"} onChange={() => setDestKind("local")} /> Local
            </label>
            <label className="flex cursor-pointer items-center gap-1.5">
              <input type="radio" checked={destKind === "remoteHost"} onChange={() => setDestKind("remoteHost")} /> Hôte distant
            </label>
          </div>
          {destKind === "local" ? (
            <p className="px-0.5 text-[11px] leading-relaxed text-[var(--c-text-muted)]">
              Un sélecteur de fichier s'ouvre au clic sur « Exporter ».
            </p>
          ) : (
            <div className="space-y-1.5">
              <select value={hostId} onChange={(e) => setHostId(e.target.value)} className={selectClass}>
                <option value="">Sélectionner un hôte…</option>
                {sshHosts.map((h) => <option key={h.id} value={h.id}>{h.label}</option>)}
              </select>
              <div className="flex gap-1.5">
                <input
                  value={remotePath}
                  onChange={(e) => setRemotePath(e.target.value)}
                  placeholder="/home/utilisateur/dump.sql"
                  className={`${inputClass} flex-1`}
                />
                <button
                  onClick={() => setShowRemotePicker(true)}
                  className="shrink-0 rounded-md bg-[var(--c-bg3)] px-3 py-2 text-xs font-medium text-[var(--c-text-secondary)] hover:bg-white/5"
                >
                  Parcourir…
                </button>
              </div>
            </div>
          )}
        </div>

        {error && <p className="whitespace-pre-wrap text-xs text-rose-400">{error}</p>}
        {done && <p className="text-xs text-emerald-400">{done}</p>}

        <button
          onClick={runExport}
          disabled={!canExport || exporting}
          className="accent-surface flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium disabled:opacity-50"
        >
          <IconDownload size={11} /> {exporting ? "Export en cours…" : "Exporter"}
        </button>
      </div>

      {showRemotePicker && (
        <RemoteSavePathPicker
          hosts={hosts}
          initialHostId={hostId || undefined}
          defaultFileName={defaultFileName()}
          onCancel={() => setShowRemotePicker(false)}
          onSelect={(pickedHostId, path) => { setHostId(pickedHostId); setRemotePath(path); setShowRemotePicker(false); }}
        />
      )}
    </>
  );
}
