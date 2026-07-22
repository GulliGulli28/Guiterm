import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import type { ColumnInfo, QueryResult, SqlCellValue, SqlConnection, TableInfo } from "../lib/types";
import { useResizablePane } from "../hooks/useResizablePane";
import { IconChevronDown, IconChevronRight, IconDatabase, IconFolder, IconPlay, IconRefresh } from "./ui-icons";

interface SqlTabProps {
  connection: SqlConnection;
  onError: (message: string) => void;
}

type Status = "connecting" | "connected" | "failed";

/** What the right-hand pane's "Structure"/"Data" tabs currently show — set by
 * clicking a schema/database or a table in the tree on the left. `null`
 * before anything's been clicked yet (the pane defaults to "Query" then). */
type Selected = { kind: "schema"; schema: string } | { kind: "table"; schema: string; table: string } | null;

/** Schema tree (left) + a tabbed pane (right: "Structure" of whatever was
 * last clicked in the tree, "Data" — a table's full row preview, only
 * offered once a table specifically is selected — and "Query") for one SQL
 * connection — opens a session on mount, closes it on unmount (the tab
 * itself staying mounted-but-hidden while inactive, like every other tab
 * kind, keeps the session alive across switching tabs; only actually
 * closing the tab tears it down). No `isActive` prop needed: unlike
 * `TerminalTab`/`RdpTab`, there's no canvas/xterm redraw concern here — same
 * reasoning `TransferTab`/`FleetTab` already skip it for.
 *
 * The "Query" tab is a single persistent editor for the whole connection —
 * clicking around the tree only changes what "Structure"/"Data" show, it
 * never resets the query text/results, so switching back and forth to check
 * a table's columns/rows while iterating on a query doesn't lose anything. */
export function SqlTab({ connection, onError }: SqlTabProps) {
  const [status, setStatus] = useState<Status>("connecting");
  const [connectError, setConnectError] = useState<string | null>(null);
  const sessionIdRef = useRef<string | null>(null);

  // PostgreSQL-only: when the connection has no database configured,
  // `openSqlSession` returns `database: null` and the session is left on a
  // bootstrap connection — `multiDatabase` switches the tree's top level to
  // a persistent database list (via `listSqlDatabases`) instead of a schema
  // list. The list stays visible for the whole tab's lifetime (clicking one
  // database doesn't hide the others): `activeDatabase` tracks whichever one
  // the session is currently reconnected to (`switchSqlDatabase`, reusing
  // the same tunnel), and only its entry has a schema tree expanded under
  // it. MySQL never sets this: it lists every database up front regardless
  // (see `core::sql`'s module doc comment).
  const [multiDatabase, setMultiDatabase] = useState(false);
  const [databases, setDatabases] = useState<string[] | null>(null);
  const [activeDatabase, setActiveDatabase] = useState<string | null>(null);

  const [schemas, setSchemas] = useState<string[] | null>(null);
  const [expandedSchemas, setExpandedSchemas] = useState<Set<string>>(new Set());
  const [tablesBySchema, setTablesBySchema] = useState<Record<string, TableInfo[]>>({});
  const [columnsByTable, setColumnsByTable] = useState<Record<string, ColumnInfo[]>>({});

  const [selected, setSelected] = useState<Selected>(null);
  const [activeSubTab, setActiveSubTab] = useState<"structure" | "data" | "query">("query");

  // Full-table preview shown by the "Data" tab — only ever offered for a
  // `Selected` of kind "table" (see the tab bar below), keyed the same way
  // as `columnsByTable` so switching between tables already visited doesn't
  // re-run the query. Lazily fetched (unlike columns, this is a real query
  // against — potentially — a huge table, so it only runs once the tab is
  // actually opened), and re-runnable via a "Rafraîchir" button since the
  // underlying data can change between visits.
  const [dataByTable, setDataByTable] = useState<Record<string, QueryResult>>({});
  const [dataErrorByTable, setDataErrorByTable] = useState<Record<string, string>>({});
  const [loadingDataKey, setLoadingDataKey] = useState<string | null>(null);

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
          setMultiDatabase(true);
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

  // Re-scopes the session to a different database — a no-op if it's already
  // the active one. The previous database's schema tree state is dropped
  // (it belongs to a pool that's about to be closed server-side) so the
  // schema-tree code below can stay exactly the same as the single-database
  // case, just re-fetching under the newly active database.
  const selectDatabase = (database: string) => {
    if (database === activeDatabase || !sessionIdRef.current) return;
    const sessionId = sessionIdRef.current;
    setActiveDatabase(database);
    setSchemas(null);
    setTablesBySchema({});
    setColumnsByTable({});
    setExpandedSchemas(new Set());
    setSelected(null);
    api.switchSqlDatabase(sessionId, database)
      .then(() => api.listSqlSchemas(sessionId))
      .then(setSchemas)
      .catch((e) => onError(String(e)));
  };

  // Runs (or re-runs) the "Data" tab's query for one table — a plain
  // unfiltered `SELECT *`, relying on the server-side `MAX_RESULT_ROWS` cap
  // (surfaced back as `QueryResult.truncated`) rather than an explicit
  // `LIMIT`, same trust as the "Query" tab's own result table.
  const loadTableData = (schema: string, table: string) => {
    if (!sessionIdRef.current) return;
    const key = `${schema}.${table}`;
    setLoadingDataKey(key);
    api.runSqlQuery(sessionIdRef.current, `SELECT * FROM ${table}`, schema)
      .then((res) => {
        setDataByTable((prev) => ({ ...prev, [key]: res }));
        setDataErrorByTable((prev) => { const { [key]: _drop, ...rest } = prev; return rest; });
      })
      .catch((e) => setDataErrorByTable((prev) => ({ ...prev, [key]: String(e) })))
      .finally(() => setLoadingDataKey((k) => (k === key ? null : k)));
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

  // Selects a table for the "Structure"/"Data" tabs — no expand/collapse of
  // its own (unlike a schema): its columns are shown in the dedicated
  // Structure tab now, not previewed inline in the tree. Clicking a table
  // defaults to "Structure" like before, *unless* "Data" was already the
  // active tab — in that case it stays put and loads the new table's rows,
  // so browsing several tables' data one after another only takes one click
  // each rather than "table, then Data tab" every time.
  const selectTable = (schema: string, table: string) => {
    const key = `${schema}.${table}`;
    setSelected({ kind: "table", schema, table });
    if (!columnsByTable[key] && sessionIdRef.current) {
      api.listSqlColumns(sessionIdRef.current, schema, table)
        .then((columns) => setColumnsByTable((prev) => ({ ...prev, [key]: columns })))
        .catch((e) => onError(String(e)));
    }
    if (activeSubTab === "data") {
      if (!dataByTable[key] && loadingDataKey !== key) loadTableData(schema, table);
    } else {
      setActiveSubTab("structure");
    }
  };

  // Opens the "Data" tab for whichever table is currently selected —
  // only reachable when one is (see the tab bar below) — fetching its rows
  // on first visit and reusing the cached result afterwards.
  const openDataTab = () => {
    setActiveSubTab("data");
    if (selected?.kind === "table") {
      const key = `${selected.schema}.${selected.table}`;
      if (!dataByTable[key] && loadingDataKey !== key) loadTableData(selected.schema, selected.table);
    }
  };

  // Unqualified — `run()` below passes the clicked table's schema as query
  // context, so this resolves without needing `schema.table`.
  const insertSelect = (table: string) => {
    setQuery(`SELECT * FROM ${table} LIMIT 100;`);
    setActiveSubTab("query");
  };

  const run = () => {
    if (!sessionIdRef.current || !query.trim() || running) return;
    setRunning(true);
    setQueryError(null);
    api.runSqlQuery(sessionIdRef.current, query, selected?.schema ?? null)
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

  // The schema/table tree — shared as-is between the single-database case
  // (top level) and the multi-database case (nested under whichever
  // database is active, below).
  const schemaTree = schemas === null ? (
    <p className="p-2 text-xs text-[var(--c-text-muted)]">Chargement du schéma…</p>
  ) : schemas.length === 0 ? (
    <p className="p-2 text-xs text-[var(--c-text-muted)]">Aucune base/schéma visible</p>
  ) : (
    schemas.map((schema) => {
      const schemaActive = selected?.kind === "schema" && selected.schema === schema;
      return (
        <div key={schema}>
          <button
            onClick={() => toggleSchema(schema)}
            className={`flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-[14px] font-semibold transition-colors ${
              schemaActive ? "bg-[var(--c-accent-dim)] text-[var(--c-accent-text)]" : "text-[var(--c-text)] hover:bg-white/[0.07]"
            }`}
          >
            {expandedSchemas.has(schema) ? <IconChevronDown size={13} className="shrink-0" /> : <IconChevronRight size={13} className="shrink-0" />}
            <IconDatabase size={15} className={`shrink-0 ${schemaActive ? "text-[var(--c-accent-text)]" : "text-[var(--c-text-secondary)]"}`} />
            <span className="min-w-0 flex-1 truncate">{schema}</span>
          </button>
          {expandedSchemas.has(schema) && (
            <div className="ml-4 border-l-2 border-[var(--c-border)] pl-2.5">
              {!tablesBySchema[schema] ? (
                <p className="px-1.5 py-1 text-[11.5px] text-[var(--c-text-muted)]">…</p>
              ) : tablesBySchema[schema].length === 0 ? (
                <p className="px-1.5 py-1 text-[11.5px] text-[var(--c-text-muted)]">Vide</p>
              ) : (
                tablesBySchema[schema].map((t) => {
                  const tableActive = selected?.kind === "table" && selected.schema === schema && selected.table === t.name;
                  return (
                    <div key={`${schema}.${t.name}`} className="flex items-center gap-1">
                      <button
                        onClick={() => selectTable(schema, t.name)}
                        className={`flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-[13px] font-medium transition-colors ${
                          tableActive ? "bg-[var(--c-accent-dim)] text-[var(--c-accent-text)]" : "text-[var(--c-text-secondary)] hover:bg-white/[0.07] hover:text-[var(--c-text)]"
                        }`}
                      >
                        <IconFolder size={13} className={`shrink-0 ${tableActive ? "text-[var(--c-accent-text)]" : "text-[var(--c-text-faint)]"}`} />
                        <span className="min-w-0 flex-1 truncate">{t.name}</span>
                        {t.kind === "view" && (
                          <span className="shrink-0 rounded-full bg-[var(--c-bg2)] px-1.5 py-0.5 text-[9px] font-normal text-[var(--c-text-secondary)]">vue</span>
                        )}
                      </button>
                      <button
                        onClick={() => insertSelect(t.name)}
                        title="Insérer un SELECT dans l'éditeur"
                        className="shrink-0 rounded px-1.5 py-1 text-[10px] text-[var(--c-text-faint)] hover:bg-white/[0.07] hover:text-[var(--c-text-secondary)]"
                      >
                        SQL
                      </button>
                    </div>
                  );
                })
              )}
            </div>
          )}
        </div>
      );
    })
  );

  return (
    <div className="flex min-h-0 flex-1">
      {/* Schema tree */}
      <div style={{ width: split.value }} className="sidebar-scroll flex shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-[var(--c-border)] bg-[var(--c-bg2)] p-2.5">
        {multiDatabase ? (
          databases === null ? (
            <p className="p-2 text-xs text-[var(--c-text-muted)]">Chargement des bases…</p>
          ) : databases.length === 0 ? (
            <p className="p-2 text-xs text-[var(--c-text-muted)]">Aucune base visible</p>
          ) : (
            databases.map((db) => {
              const active = db === activeDatabase;
              return (
                <div key={db}>
                  <button
                    onClick={() => selectDatabase(db)}
                    className={`flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-[14px] font-semibold transition-colors ${
                      active ? "bg-[var(--c-accent-dim)] text-[var(--c-accent-text)]" : "text-[var(--c-text)] hover:bg-white/[0.07]"
                    }`}
                  >
                    {active ? <IconChevronDown size={13} className="shrink-0" /> : <IconChevronRight size={13} className="shrink-0" />}
                    <IconDatabase size={15} className={`shrink-0 ${active ? "text-[var(--c-accent-text)]" : "text-[var(--c-text-secondary)]"}`} />
                    <span className="min-w-0 flex-1 truncate">{db}</span>
                  </button>
                  {active && <div className="ml-4 border-l-2 border-[var(--c-border)] pl-2.5">{schemaTree}</div>}
                </div>
              );
            })
          )
        ) : (
          schemaTree
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
          {/* Only offered once a table (not a schema/database) is selected —
           * "all the rows" has no meaning for the schema-level Structure
           * view above. */}
          {selected?.kind === "table" && (
            <button
              onClick={openDataTab}
              className={`px-3 py-2 text-xs font-medium ${
                activeSubTab === "data" ? "border-b-2 border-[var(--c-accent)] text-[var(--c-text)]" : "text-[var(--c-text-muted)] hover:text-[var(--c-text-secondary)]"
              }`}
            >
              Data
            </button>
          )}
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

        {activeSubTab === "data" && selected?.kind === "table" && (
          <TableData
            schema={selected.schema}
            table={selected.table}
            result={dataByTable[`${selected.schema}.${selected.table}`]}
            error={dataErrorByTable[`${selected.schema}.${selected.table}`]}
            loading={loadingDataKey === `${selected.schema}.${selected.table}`}
            onRefresh={() => loadTableData(selected.schema, selected.table)}
          />
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
                  <ResultTable columns={result.columns} rows={result.rows} />
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

/** The rows/columns table shared by the "Query" tab's results and the
 * "Data" tab's full-table preview below — same rendering either way, only
 * the query that produced `rows` differs. */
function ResultTable({ columns, rows }: { columns: string[]; rows: SqlCellValue[][] }) {
  return (
    <table className="w-full border-collapse text-left text-[12px]">
      <thead>
        <tr>
          {columns.map((c) => (
            <th key={c} className="sticky top-0 border-b border-[var(--c-border)] bg-[var(--c-bg)] px-2 py-1 font-medium text-[var(--c-text-secondary)]">{c}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
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
  );
}

/** The "Data" tab's body — a read-only preview of every row currently in
 * `table` (capped server-side, see `core::sql::MAX_RESULT_ROWS`), fetched
 * on first visit and cached by `SqlTab` until `onRefresh` is clicked. */
function TableData({
  schema, table, result, error, loading, onRefresh,
}: {
  schema: string;
  table: string;
  result: QueryResult | undefined;
  error: string | undefined;
  loading: boolean;
  onRefresh: () => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-[var(--c-border)] px-3 py-1.5">
        <span className="truncate text-[11px] text-[var(--c-text-faint)]">
          {result ? `${result.rows.length} ligne${result.rows.length === 1 ? "" : "s"}${result.truncated ? " (tronqué)" : ""}` : `${schema}.${table}`}
        </span>
        <button
          onClick={onRefresh}
          disabled={loading}
          className="flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-[11px] text-[var(--c-text-secondary)] hover:bg-white/5 disabled:opacity-50"
        >
          <IconRefresh size={11} /> {loading ? "Chargement…" : "Rafraîchir"}
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-2">
        {error && <p className="whitespace-pre-wrap text-xs text-rose-400">{error}</p>}
        {!error && result && (
          <>
            {result.truncated && (
              <p className="mb-2 text-[11px] text-amber-400">
                Résultat tronqué — seules les {result.rows.length} premières lignes sont affichées.
              </p>
            )}
            {result.columns.length === 0 ? (
              <p className="text-xs text-[var(--c-text-muted)]">Table vide — aucune ligne.</p>
            ) : (
              <ResultTable columns={result.columns} rows={result.rows} />
            )}
          </>
        )}
        {!error && !result && <p className="text-xs text-[var(--c-text-faint)]">{loading ? "Chargement des données…" : "…"}</p>}
      </div>
    </div>
  );
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
