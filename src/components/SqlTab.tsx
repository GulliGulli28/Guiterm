import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import type { ColumnInfo, QueryResult, SqlCellValue, SqlConnection, TableInfo } from "../lib/types";
import { useResizablePane } from "../hooks/useResizablePane";
import { IconChevronDown, IconChevronRight, IconDatabase, IconFolder, IconPlay } from "./ui-icons";

interface SqlTabProps {
  connection: SqlConnection;
  onError: (message: string) => void;
}

type Status = "connecting" | "connected" | "failed";

/** What the right-hand pane's "Structure" tab currently shows — set by
 * clicking a schema/database or a table in the tree on the left. `null`
 * before anything's been clicked yet (the pane defaults to "Query" then). */
type Selected = { kind: "schema"; schema: string } | { kind: "table"; schema: string; table: string } | null;

/** Schema tree (left) + a two-tab pane (right: "Structure" of whatever was
 * last clicked in the tree, and "Query") for one SQL connection — opens a
 * session on mount, closes it on unmount (the tab itself staying
 * mounted-but-hidden while inactive, like every other tab kind, keeps the
 * session alive across switching tabs; only actually closing the tab tears
 * it down). No `isActive` prop needed: unlike `TerminalTab`/`RdpTab`, there's
 * no canvas/xterm redraw concern here — same reasoning `TransferTab`/
 * `FleetTab` already skip it for.
 *
 * The "Query" tab is a single persistent editor for the whole connection —
 * clicking around the tree only changes what "Structure" shows, it never
 * resets the query text/results, so switching back and forth to check a
 * table's columns while iterating on a query doesn't lose anything. */
export function SqlTab({ connection, onError }: SqlTabProps) {
  const [status, setStatus] = useState<Status>("connecting");
  const [connectError, setConnectError] = useState<string | null>(null);
  const sessionIdRef = useRef<string | null>(null);

  // PostgreSQL-only: when the connection has no database configured,
  // `openSqlSession` returns `database: null` and the session is left on a
  // bootstrap connection — `needsDatabasePick` gates the tree showing a
  // database picker (via `listSqlDatabases`) instead of a schema tree until
  // one is chosen (`switchSqlDatabase`, which reconnects through the same
  // tunnel). MySQL never sets this: it lists every database up front
  // regardless (see `core::sql`'s module doc comment).
  const [needsDatabasePick, setNeedsDatabasePick] = useState(false);
  const [databases, setDatabases] = useState<string[] | null>(null);
  const [pickedDatabase, setPickedDatabase] = useState<string | null>(null);

  const [schemas, setSchemas] = useState<string[] | null>(null);
  const [expandedSchemas, setExpandedSchemas] = useState<Set<string>>(new Set());
  const [tablesBySchema, setTablesBySchema] = useState<Record<string, TableInfo[]>>({});
  const [expandedTables, setExpandedTables] = useState<Set<string>>(new Set());
  const [columnsByTable, setColumnsByTable] = useState<Record<string, ColumnInfo[]>>({});

  const [selected, setSelected] = useState<Selected>(null);
  const [activeSubTab, setActiveSubTab] = useState<"structure" | "query">("query");

  const [query, setQuery] = useState("");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<QueryResult | null>(null);
  const [queryError, setQueryError] = useState<string | null>(null);

  const split = useResizablePane({ initial: 260, min: 180, max: 480, axis: "horizontal", mode: "px" });

  useEffect(() => {
    let cancelled = false;
    setStatus("connecting");
    api.openSqlSession(connection.id)
      .then(({ sessionId, database }) => {
        if (cancelled) { api.closeSqlSession(sessionId).catch(() => {}); return; }
        sessionIdRef.current = sessionId;
        setStatus("connected");
        if (connection.engine === "postgres" && database === null) {
          setNeedsDatabasePick(true);
          return api.listSqlDatabases(sessionId).then((d) => { if (!cancelled) setDatabases(d); });
        }
        return api.listSqlSchemas(sessionId).then((s) => { if (!cancelled) setSchemas(s); });
      })
      .catch((e) => { if (!cancelled) { setConnectError(String(e)); setStatus("failed"); } });
    return () => {
      cancelled = true;
      if (sessionIdRef.current) { api.closeSqlSession(sessionIdRef.current).catch(() => {}); sessionIdRef.current = null; }
    };
  }, [connection.id, connection.engine]);

  const pickDatabase = (database: string) => {
    if (!sessionIdRef.current) return;
    const sessionId = sessionIdRef.current;
    api.switchSqlDatabase(sessionId, database)
      .then(() => api.listSqlSchemas(sessionId))
      .then((s) => {
        setPickedDatabase(database);
        setNeedsDatabasePick(false);
        setSchemas(s);
      })
      .catch((e) => onError(String(e)));
  };

  const toggleSchema = (schema: string) => {
    setSelected({ kind: "schema", schema });
    setActiveSubTab("structure");
    setExpandedSchemas((prev) => {
      const next = new Set(prev);
      if (next.has(schema)) next.delete(schema);
      else next.add(schema);
      return next;
    });
    if (!tablesBySchema[schema] && sessionIdRef.current) {
      api.listSqlTables(sessionIdRef.current, schema)
        .then((tables) => setTablesBySchema((prev) => ({ ...prev, [schema]: tables })))
        .catch((e) => onError(String(e)));
    }
  };

  const toggleTable = (schema: string, table: string) => {
    const key = `${schema}.${table}`;
    setSelected({ kind: "table", schema, table });
    setActiveSubTab("structure");
    setExpandedTables((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    if (!columnsByTable[key] && sessionIdRef.current) {
      api.listSqlColumns(sessionIdRef.current, schema, table)
        .then((columns) => setColumnsByTable((prev) => ({ ...prev, [key]: columns })))
        .catch((e) => onError(String(e)));
    }
  };

  const insertSelect = (schema: string, table: string) => {
    setQuery(`SELECT * FROM ${schema}.${table} LIMIT 100;`);
    setActiveSubTab("query");
  };

  const run = () => {
    if (!sessionIdRef.current || !query.trim() || running) return;
    setRunning(true);
    setQueryError(null);
    api.runSqlQuery(sessionIdRef.current, query)
      .then(setResult)
      .catch((e) => { setQueryError(String(e)); setResult(null); })
      .finally(() => setRunning(false));
  };

  if (status === "connecting") {
    return <div className="flex flex-1 items-center justify-center text-sm text-[var(--c-text-muted)]">Connexion à « {connection.label} »…</div>;
  }
  if (status === "failed") {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-4 text-center">
        <p className="text-sm text-[var(--c-text-secondary)]">Impossible de se connecter à « {connection.label} »</p>
        <p className="max-w-md text-xs text-rose-400">{connectError}</p>
      </div>
    );
  }

  const structureLabel = selected?.kind === "table" ? `Table : ${selected.table}` : selected?.kind === "schema" ? `Base : ${selected.schema}` : "Structure";

  return (
    <div className="flex min-h-0 flex-1">
      {/* Schema tree */}
      <div style={{ width: split.value }} className="sidebar-scroll flex shrink-0 flex-col overflow-y-auto border-r border-[var(--c-border)] bg-[var(--c-bg2)] p-2">
        {pickedDatabase && (
          <p className="mb-1 truncate px-1.5 text-[10px] text-[var(--c-text-faint)]">Base sélectionnée : <span className="font-mono">{pickedDatabase}</span></p>
        )}
        {needsDatabasePick ? (
          databases === null ? (
            <p className="p-2 text-xs text-[var(--c-text-muted)]">Chargement des bases…</p>
          ) : databases.length === 0 ? (
            <p className="p-2 text-xs text-[var(--c-text-muted)]">Aucune base visible</p>
          ) : (
            databases.map((db) => (
              <button
                key={db}
                onClick={() => pickDatabase(db)}
                className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-[13px] text-[var(--c-text-secondary)] hover:bg-white/5"
              >
                <IconDatabase size={12} className="shrink-0 text-[var(--c-text-faint)]" />
                <span className="min-w-0 flex-1 truncate">{db}</span>
              </button>
            ))
          )
        ) : schemas === null ? (
          <p className="p-2 text-xs text-[var(--c-text-muted)]">Chargement du schéma…</p>
        ) : schemas.length === 0 ? (
          <p className="p-2 text-xs text-[var(--c-text-muted)]">Aucune base/schéma visible</p>
        ) : (
          schemas.map((schema) => (
            <div key={schema}>
              <button
                onClick={() => toggleSchema(schema)}
                className={`flex w-full items-center gap-1 rounded-md px-1.5 py-1 text-left text-[13px] text-[var(--c-text-secondary)] hover:bg-white/5 ${
                  selected?.kind === "schema" && selected.schema === schema ? "bg-white/5" : ""
                }`}
              >
                {expandedSchemas.has(schema) ? <IconChevronDown size={11} /> : <IconChevronRight size={11} />}
                <IconDatabase size={12} className="shrink-0 text-[var(--c-text-faint)]" />
                <span className="min-w-0 flex-1 truncate">{schema}</span>
              </button>
              {expandedSchemas.has(schema) && (
                <div className="ml-4 border-l border-[var(--c-border)] pl-2">
                  {!tablesBySchema[schema] ? (
                    <p className="px-1 py-1 text-[11px] text-[var(--c-text-muted)]">…</p>
                  ) : tablesBySchema[schema].length === 0 ? (
                    <p className="px-1 py-1 text-[11px] text-[var(--c-text-muted)]">Vide</p>
                  ) : (
                    tablesBySchema[schema].map((t) => {
                      const key = `${schema}.${t.name}`;
                      return (
                        <div key={key}>
                          <div className="flex items-center gap-1">
                            <button
                              onClick={() => toggleTable(schema, t.name)}
                              className={`flex min-w-0 flex-1 items-center gap-1 rounded-md px-1.5 py-1 text-left text-[12px] text-[var(--c-text-secondary)] hover:bg-white/5 ${
                                selected?.kind === "table" && selected.schema === schema && selected.table === t.name ? "bg-white/5" : ""
                              }`}
                            >
                              {expandedTables.has(key) ? <IconChevronDown size={10} /> : <IconChevronRight size={10} />}
                              <IconFolder size={11} className="shrink-0 text-[var(--c-text-faint)]" />
                              <span className="min-w-0 flex-1 truncate">{t.name}</span>
                              {t.kind === "view" && <span className="shrink-0 text-[9px] text-[var(--c-text-faint)]">vue</span>}
                            </button>
                            <button
                              onClick={() => insertSelect(schema, t.name)}
                              title="Insérer un SELECT dans l'éditeur"
                              className="shrink-0 rounded px-1 text-[10px] text-[var(--c-text-faint)] hover:bg-white/5 hover:text-[var(--c-text-secondary)]"
                            >
                              SQL
                            </button>
                          </div>
                          {expandedTables.has(key) && (
                            <div className="ml-4 border-l border-[var(--c-border)] pl-2">
                              {!columnsByTable[key] ? (
                                <p className="px-1 py-1 text-[11px] text-[var(--c-text-muted)]">…</p>
                              ) : (
                                columnsByTable[key].map((c) => (
                                  <p key={c.name} className="truncate px-1 py-0.5 text-[11px] text-[var(--c-text-muted)]">
                                    {c.name} <span className="text-[var(--c-text-faint)]">{c.dataType}{c.nullable ? "" : " · not null"}</span>
                                  </p>
                                ))
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })
                  )}
                </div>
              )}
            </div>
          ))
        )}
      </div>

      <div onMouseDown={split.onMouseDown} className="group relative flex w-1 shrink-0 cursor-col-resize items-center justify-center">
        <div className="h-full w-px bg-[var(--c-border)] transition-colors group-hover:bg-[var(--c-accent)]" />
      </div>

      {/* Structure / Query pane */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex shrink-0 border-b border-[var(--c-border)]">
          <button
            onClick={() => setActiveSubTab("structure")}
            className={`truncate px-3 py-2 text-xs font-medium ${
              activeSubTab === "structure" ? "border-b-2 border-[var(--c-accent)] text-[var(--c-text)]" : "text-[var(--c-text-muted)] hover:text-[var(--c-text-secondary)]"
            }`}
          >
            {structureLabel}
          </button>
          <button
            onClick={() => setActiveSubTab("query")}
            className={`px-3 py-2 text-xs font-medium ${
              activeSubTab === "query" ? "border-b-2 border-[var(--c-accent)] text-[var(--c-text)]" : "text-[var(--c-text-muted)] hover:text-[var(--c-text-secondary)]"
            }`}
          >
            Query
          </button>
        </div>

        {activeSubTab === "structure" && (
          <div className="min-h-0 flex-1 overflow-auto p-3">
            {selected === null ? (
              <p className="text-xs text-[var(--c-text-faint)]">Cliquez une base/un schéma ou une table dans l'arbre pour voir sa structure.</p>
            ) : selected.kind === "schema" ? (
              <StructureTables schema={selected.schema} tables={tablesBySchema[selected.schema]} />
            ) : (
              <StructureColumns table={selected.table} columns={columnsByTable[`${selected.schema}.${selected.table}`]} />
            )}
          </div>
        )}

        {/* Kept mounted (just hidden) rather than conditionally rendered when
         * "Structure" is active, so typed query text / results / scroll
         * position survive switching tabs — same "mounted but hidden"
         * convention every other tab kind in this app already follows. */}
        <div className="flex min-h-0 flex-1 flex-col" style={{ display: activeSubTab === "query" ? "flex" : "none" }}>
          <div className="flex shrink-0 flex-col gap-1.5 border-b border-[var(--c-border)] p-2">
            <textarea
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); run(); } }}
              placeholder="SELECT * FROM ..."
              rows={5}
              spellCheck={false}
              className="w-full resize-y rounded-md bg-[var(--c-bg2)] px-2 py-1.5 font-mono text-[13px] text-[var(--c-text)] placeholder:text-[var(--c-text-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--c-accent)]"
            />
            <div className="flex items-center gap-2">
              <button
                onClick={run}
                disabled={running || !query.trim()}
                className="accent-surface flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium disabled:opacity-50"
              >
                <IconPlay size={11} /> {running ? "Exécution…" : "Exécuter"}
              </button>
              <span className="text-[11px] text-[var(--c-text-faint)]">Ctrl+Entrée pour exécuter</span>
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-auto p-2">
            {queryError && <p className="whitespace-pre-wrap text-xs text-rose-400">{queryError}</p>}
            {!queryError && result && (
              <>
                {result.truncated && (
                  <p className="mb-2 text-[11px] text-amber-400">
                    Résultat tronqué — seules les {result.rows.length} premières lignes sont affichées.
                  </p>
                )}
                {result.columns.length === 0 ? (
                  <p className="text-xs text-[var(--c-text-muted)]">Requête exécutée — aucune ligne retournée.</p>
                ) : (
                  <table className="w-full border-collapse text-left text-[12px]">
                    <thead>
                      <tr>
                        {result.columns.map((c) => (
                          <th key={c} className="sticky top-0 border-b border-[var(--c-border)] bg-[var(--c-bg)] px-2 py-1 font-medium text-[var(--c-text-secondary)]">{c}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {result.rows.map((row, i) => (
                        <tr key={i} className="hover:bg-white/5">
                          {row.map((cell, j) => (
                            <td key={j} className="whitespace-nowrap border-b border-[var(--c-border)] px-2 py-1 font-mono text-[var(--c-text)]">
                              {formatCell(cell)}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </>
            )}
            {!queryError && !result && <p className="text-xs text-[var(--c-text-faint)]">Aucun résultat — écrivez une requête et exécutez-la.</p>}
          </div>
        </div>
      </div>
    </div>
  );
}

/** A cell is a JSON scalar for most columns, but a nested object/array for
 * JSON(B) columns and (best-effort) text arrays — see `SqlCellValue`'s doc
 * comment. Only the scalar `null` gets the "NULL" treatment; an empty
 * object/array is a real (non-null) value and is shown as such. */
function formatCell(cell: SqlCellValue) {
  if (cell === null) return <span className="italic text-[var(--c-text-faint)]">NULL</span>;
  if (typeof cell === "object") return JSON.stringify(cell);
  return String(cell);
}

function StructureTables({ schema, tables }: { schema: string; tables: TableInfo[] | undefined }) {
  if (!tables) return <p className="text-xs text-[var(--c-text-muted)]">Chargement…</p>;
  if (tables.length === 0) return <p className="text-xs text-[var(--c-text-muted)]">Aucune table dans « {schema} ».</p>;
  return (
    <table className="w-full border-collapse text-left text-[12px]">
      <thead>
        <tr>
          <th className="border-b border-[var(--c-border)] px-2 py-1 font-medium text-[var(--c-text-secondary)]">Nom</th>
          <th className="border-b border-[var(--c-border)] px-2 py-1 font-medium text-[var(--c-text-secondary)]">Type</th>
        </tr>
      </thead>
      <tbody>
        {tables.map((t) => (
          <tr key={t.name} className="hover:bg-white/5">
            <td className="border-b border-[var(--c-border)] px-2 py-1 font-mono text-[var(--c-text)]">{t.name}</td>
            <td className="border-b border-[var(--c-border)] px-2 py-1 text-[var(--c-text-muted)]">{t.kind === "view" ? "Vue" : "Table"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function StructureColumns({ table, columns }: { table: string; columns: ColumnInfo[] | undefined }) {
  if (!columns) return <p className="text-xs text-[var(--c-text-muted)]">Chargement…</p>;
  if (columns.length === 0) return <p className="text-xs text-[var(--c-text-muted)]">Aucune colonne pour « {table} ».</p>;
  return (
    <table className="w-full border-collapse text-left text-[12px]">
      <thead>
        <tr>
          <th className="border-b border-[var(--c-border)] px-2 py-1 font-medium text-[var(--c-text-secondary)]">Colonne</th>
          <th className="border-b border-[var(--c-border)] px-2 py-1 font-medium text-[var(--c-text-secondary)]">Type</th>
          <th className="border-b border-[var(--c-border)] px-2 py-1 font-medium text-[var(--c-text-secondary)]">Nullable</th>
        </tr>
      </thead>
      <tbody>
        {columns.map((c) => (
          <tr key={c.name} className="hover:bg-white/5">
            <td className="border-b border-[var(--c-border)] px-2 py-1 font-mono text-[var(--c-text)]">{c.name}</td>
            <td className="border-b border-[var(--c-border)] px-2 py-1 text-[var(--c-text-muted)]">{c.dataType}</td>
            <td className="border-b border-[var(--c-border)] px-2 py-1 text-[var(--c-text-muted)]">{c.nullable ? "oui" : "non"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
