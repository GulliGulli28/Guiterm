import { useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "../lib/api";
import { sqlEngineLabel, type ColumnInfo, type Host, type QueryResult, type SqlConnection, type TableInfo } from "../lib/types";
import { useResizablePane } from "../hooks/useResizablePane";
import { ResultTable } from "./ResultTable";
import { SqlExportPanel } from "./SqlExportPanel";
import { IconChevronDown, IconChevronRight, IconDatabase, IconFolder, IconPlay, IconRefresh } from "./ui-icons";

interface SqlTabProps {
  connection: SqlConnection;
  /** For the "Exporter" tab's "hôte distant" destination — every saved SSH
   * host to offer as an SFTP upload target for the generated dump. */
  hosts: Host[];
  onError: (message: string) => void;
}

/** Matches a query that can change what the schema tree / cached table data
 * show (DDL, or DML that isn't a plain read) — used by `run()` below to
 * decide whether to refresh the tree after a successful query. Deliberately
 * keyword-based rather than a real parser: false positives just cost one
 * extra (cheap) re-fetch, false negatives leave stale data, so erring
 * towards matching is the safe direction. */
const MUTATING_SQL_RE = /^\s*(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|TRUNCATE|REPLACE|MERGE|GRANT|REVOKE)\b/i;

const SQL_KEYWORDS = new Set([
  "select", "from", "where", "insert", "into", "values", "update", "set", "delete", "create", "table", "drop",
  "alter", "add", "column", "join", "left", "right", "inner", "outer", "full", "cross", "on", "and", "or", "not",
  "null", "is", "in", "like", "ilike", "limit", "offset", "order", "by", "group", "having", "as", "distinct",
  "case", "when", "then", "else", "end", "union", "all", "exists", "begin", "commit", "rollback", "truncate",
  "default", "primary", "key", "foreign", "references", "unique", "index", "view", "with", "returning", "cascade",
  "check", "constraint", "between", "asc", "desc", "using", "grant", "revoke", "replace", "merge", "if", "schema",
  "database", "function", "procedure", "trigger", "before", "after", "for", "each", "row", "statement", "language",
  "execute", "do", "true", "false",
]);

/** Splits `sql` into keyword/string/number/comment/plain spans for the
 * read-only `<pre>` overlaid behind the query textarea — a lightweight
 * regex tokenizer rather than a real SQL parser (good enough for coloring,
 * not meant to validate syntax). */
function highlightSql(sql: string): ReactNode[] {
  const TOKEN_RE = /(--[^\n]*)|(\/\*[\s\S]*?\*\/)|('(?:[^']|'')*')|("(?:[^"]|"")*")|(`(?:[^`]|``)*`)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_][A-Za-z0-9_]*)/g;
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let key = 0;
  let match: RegExpExecArray | null;
  while ((match = TOKEN_RE.exec(sql))) {
    if (match.index > lastIndex) nodes.push(sql.slice(lastIndex, match.index));
    const [full, comment, blockComment, singleQuoted, doubleQuoted, backtick, number, word] = match;
    if (comment || blockComment) {
      nodes.push(<span key={key++} className="italic text-[var(--c-text-faint)]">{full}</span>);
    } else if (singleQuoted || doubleQuoted || backtick) {
      nodes.push(<span key={key++} className="text-emerald-400">{full}</span>);
    } else if (number) {
      nodes.push(<span key={key++} className="text-amber-400">{full}</span>);
    } else if (word && SQL_KEYWORDS.has(word.toLowerCase())) {
      nodes.push(<span key={key++} className="font-semibold text-sky-400">{full}</span>);
    } else {
      nodes.push(full);
    }
    lastIndex = TOKEN_RE.lastIndex;
  }
  if (lastIndex < sql.length) nodes.push(sql.slice(lastIndex));
  return nodes;
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
export function SqlTab({ connection, hosts, onError }: SqlTabProps) {
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
  const [refreshingTree, setRefreshingTree] = useState(false);

  const [selected, setSelected] = useState<Selected>(null);
  const [activeSubTab, setActiveSubTab] = useState<"structure" | "data" | "query" | "export">("query");

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
  const queryHighlightRef = useRef<HTMLPreElement>(null);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<QueryResult | null>(null);
  const [queryError, setQueryError] = useState<string | null>(null);

  // Everything the "Exporter" tab needs lives in `SqlExportPanel` — see its
  // doc comment. It stays mounted while another sub-tab shows, so a selection
  // survives the trip; `activeSubTab` is what tells it it has just been opened.

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

  const fetchTables = (schema: string) => {
    if (!sessionIdRef.current) return;
    api.listSqlTables(sessionIdRef.current, schema)
      .then((tables) => setTablesBySchema((prev) => ({ ...prev, [schema]: tables })))
      .catch((e) => onError(String(e)));
  };

  // Selects a schema for the "Structure" tab and makes sure it's expanded —
  // never collapses it. Collapsing is `toggleSchemaExpand`'s job alone (the
  // chevron button), so clicking the row itself to browse a schema/table
  // can never surprise-close the branch you're standing in.
  const selectSchema = (schema: string) => {
    setSelected({ kind: "schema", schema });
    setActiveSubTab("structure");
    setExpandedSchemas((prev) => (prev.has(schema) ? prev : new Set(prev).add(schema)));
    if (!tablesBySchema[schema]) fetchTables(schema);
  };

  // Chevron-only expand/collapse — deliberately not tied to selection so it
  // can collapse a branch without changing what "Structure"/"Data" show.
  const toggleSchemaExpand = (schema: string) => {
    setExpandedSchemas((prev) => {
      const next = new Set(prev);
      if (next.has(schema)) next.delete(schema);
      else next.add(schema);
      return next;
    });
    if (!tablesBySchema[schema]) fetchTables(schema);
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

  // After a query that can change table/row data (anything but a plain
  // read), re-fetch every schema's table list that's already in the tree
  // and drop cached columns/table-preview data so they're re-fetched next
  // time they're viewed instead of showing what's now stale.
  const refreshAfterMutation = () => {
    Object.keys(tablesBySchema).forEach(fetchTables);
    setColumnsByTable({});
    setDataByTable({});
    setDataErrorByTable({});
  };

  // Shared by `refreshTree`'s single-database and (already-active)
  // multi-database branches: re-fetch the schema list, drop any schema the
  // refreshed list no longer has (so a deleted one doesn't sit forever on
  // "Chargement…"), and re-fetch tables for whichever schemas were already
  // loaded.
  const refreshSchemasAndTables = (sessionId: string) =>
    api.listSqlSchemas(sessionId).then((s) => {
      setSchemas(s);
      const stillThere = new Set(s);
      setExpandedSchemas((prev) => new Set(Array.from(prev).filter((schema) => stillThere.has(schema))));
      const known = Object.keys(tablesBySchema).filter((schema) => stillThere.has(schema));
      setTablesBySchema({});
      known.forEach(fetchTables);
    });

  // Re-fetches whichever table is currently selected in the tree.
  // `refreshTree` below wipes `columnsByTable`/`dataByTable` wholesale (the
  // tree/table list itself may have changed), but nothing else would ever
  // re-populate the Structure tab's columns for an already-selected table
  // afterward — unlike the Data tab, which self-heals the next time it's
  // opened (`openDataTab`/`selectTable` already re-fetch on a cache miss).
  // Without this, "select a table, then hit actualiser" left Structure
  // stuck on "Chargement…" forever, regardless of which sub-tab was active
  // at the time (a real bug this used to have). Runs after the tree itself
  // has been refreshed, so it reflects the table's current columns, not
  // whatever was cached before the refresh.
  const reloadSelectedTable = () => {
    if (selected?.kind !== "table" || !sessionIdRef.current) return;
    const { schema, table } = selected;
    const key = `${schema}.${table}`;
    api.listSqlColumns(sessionIdRef.current, schema, table)
      .then((columns) => setColumnsByTable((prev) => ({ ...prev, [key]: columns })))
      .catch((e) => onError(String(e)));
    if (activeSubTab === "data") loadTableData(schema, table);
  };

  // The tree's "actualiser" button. Unlike `refreshAfterMutation` below
  // (which only re-fetches tables already known within schemas already in
  // the tree, right after a query that's likely to have changed them), this
  // also re-fetches the top-level schema/database list itself, and first
  // calls `resyncSqlSession` — a no-op for every engine except a SQLite
  // connection backed by a remote host's file, where it's the only way to
  // pick up a change made outside the app since this session was opened
  // (see `core::sql::SqlSession::resync`'s doc comment).
  const refreshTree = () => {
    if (!sessionIdRef.current || refreshingTree) return;
    const sessionId = sessionIdRef.current;
    setRefreshingTree(true);
    api.resyncSqlSession(sessionId)
      .then(() => {
        setColumnsByTable({});
        setDataByTable({});
        setDataErrorByTable({});
        if (multiDatabase) {
          return api.listSqlDatabases(sessionId).then((d) => {
            setDatabases(d);
            if (!activeDatabase || !d.includes(activeDatabase)) {
              setActiveDatabase(null);
              setSchemas(null);
              setTablesBySchema({});
              setExpandedSchemas(new Set());
              setSelected(null);
              return undefined;
            }
            return refreshSchemasAndTables(sessionId).then(reloadSelectedTable);
          });
        }
        return refreshSchemasAndTables(sessionId).then(reloadSelectedTable);
      })
      .catch((e) => onError(String(e)))
      .finally(() => setRefreshingTree(false));
  };

  const run = () => {
    if (!sessionIdRef.current || !query.trim() || running) return;
    setRunning(true);
    setQueryError(null);
    const isMutation = MUTATING_SQL_RE.test(query);
    api.runSqlQuery(sessionIdRef.current, query, selected?.schema ?? null)
      .then((res) => { setResult(res); if (isMutation) refreshAfterMutation(); })
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
          <div
            className={`flex w-full items-center gap-0.5 rounded-lg text-[14px] font-semibold transition-colors ${
              schemaActive ? "bg-[var(--c-accent-dim)] text-[var(--c-accent-text)]" : "text-[var(--c-text)] hover:bg-white/[0.07]"
            }`}
          >
            <button
              onClick={() => toggleSchemaExpand(schema)}
              title={expandedSchemas.has(schema) ? "Réduire" : "Développer"}
              className="flex shrink-0 items-center justify-center rounded p-1.5"
            >
              {expandedSchemas.has(schema) ? <IconChevronDown size={13} /> : <IconChevronRight size={13} />}
            </button>
            <button
              onClick={() => selectSchema(schema)}
              className="flex min-w-0 flex-1 items-center gap-1.5 py-1.5 pr-2 text-left"
            >
              <IconDatabase size={15} className={`shrink-0 ${schemaActive ? "text-[var(--c-accent-text)]" : "text-[var(--c-text-secondary)]"}`} />
              <span className="min-w-0 flex-1 truncate">{schema}</span>
            </button>
          </div>
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
    <div className="flex min-h-0 min-w-0 flex-1">
      {/* Schema tree. `max-w-[50%]` caps the sidebar's own fixed pixel width
       * (`split.value`, dragged via the handle below) as a share of this
       * tab's *own* container rather than the window — CSS resolves
       * `max-width` after flexbox's `flex-shrink: 0` would otherwise leave
       * it untouched, so squeezing this tab very narrow (e.g. opening the
       * split-terminal view and dragging it wide) shrinks the tree instead
       * of overflowing past the content pane, which is what broke before. */}
      <div style={{ width: split.value }} className="flex max-w-[50%] shrink-0 flex-col overflow-hidden border-r border-[var(--c-border)] bg-[var(--c-bg2)]">
        <div className="flex shrink-0 items-center justify-between border-b border-[var(--c-border)] px-3 py-2.5">
          <span className="truncate text-xs font-semibold uppercase tracking-wide text-[var(--c-text-secondary)]">
            {sqlEngineLabel(connection.engine)}
          </span>
          <button
            onClick={refreshTree}
            disabled={refreshingTree}
            title="Actualiser l'arborescence"
            className="flex shrink-0 items-center justify-center rounded p-1 text-[var(--c-text-faint)] hover:bg-white/10 hover:text-[var(--c-text-secondary)] disabled:opacity-50"
          >
            <IconRefresh size={13} className={refreshingTree ? "animate-spin" : ""} />
          </button>
        </div>
        <div className="sidebar-scroll min-h-0 flex-1 space-y-0.5 overflow-y-auto p-2">
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
      </div>

      <div onMouseDown={split.onMouseDown} className="group relative flex w-1 shrink-0 cursor-col-resize items-center justify-center">
        <div className="h-full w-px bg-[var(--c-border)] transition-colors group-hover:bg-[var(--c-accent)]" />
      </div>

      {/* Structure / Query pane */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {/* Segmented pill bar — same idiom as `FleetTab`'s "Résultats/Historique"
         * switcher, used instead of this tab's previous underline style for
         * consistency with the rest of the app's sub-view switchers. */}
        <div className="flex shrink-0 items-center gap-1 border-b border-[var(--c-border)] px-2 py-1.5">
          <button
            onClick={() => setActiveSubTab("structure")}
            className={`truncate rounded px-2.5 py-1 text-xs font-medium transition-colors ${
              activeSubTab === "structure" ? "bg-[var(--c-accent-dim)] text-[var(--c-accent-text)]" : "text-[var(--c-text-muted)] hover:bg-[var(--c-bg2)] hover:text-[var(--c-text-secondary)]"
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
              className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${
                activeSubTab === "data" ? "bg-[var(--c-accent-dim)] text-[var(--c-accent-text)]" : "text-[var(--c-text-muted)] hover:bg-[var(--c-bg2)] hover:text-[var(--c-text-secondary)]"
              }`}
            >
              Données
            </button>
          )}
          <button
            onClick={() => setActiveSubTab("query")}
            className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${
              activeSubTab === "query" ? "bg-[var(--c-accent-dim)] text-[var(--c-accent-text)]" : "text-[var(--c-text-muted)] hover:bg-[var(--c-bg2)] hover:text-[var(--c-text-secondary)]"
            }`}
          >
            Requête
          </button>
          <button
            onClick={() => setActiveSubTab("export")}
            className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${
              activeSubTab === "export" ? "bg-[var(--c-accent-dim)] text-[var(--c-accent-text)]" : "text-[var(--c-text-muted)] hover:bg-[var(--c-bg2)] hover:text-[var(--c-text-secondary)]"
            }`}
          >
            Exporter
          </button>
        </div>

        {activeSubTab === "structure" && (
          <div className="m-3 min-h-0 flex-1 overflow-auto rounded-lg border border-[var(--c-border)] p-3">
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

        {/* Mounted even while another sub-tab shows — same convention as the
         * query pane below, and what lets a half-built export selection
         * survive a trip through "Structure". */}
        <div
          className="min-h-0 flex-1 overflow-auto p-3"
          style={{ display: activeSubTab === "export" ? "block" : "none" }}
        >
          <SqlExportPanel
            active={activeSubTab === "export"}
            connectionLabel={connection.label}
            getSessionId={() => sessionIdRef.current}
            schemas={schemas ?? []}
            tablesBySchema={tablesBySchema}
            onNeedTables={fetchTables}
            initialSchema={selected?.schema ?? schemas?.[0] ?? null}
            multiDatabase={multiDatabase}
            hosts={hosts}
          />
        </div>

        {/* Kept mounted (just hidden) rather than conditionally rendered when
         * "Structure" is active, so typed query text / results / scroll
         * position survive switching tabs — same "mounted but hidden"
         * convention every other tab kind in this app already follows. */}
        <div className="flex min-h-0 flex-1 flex-col" style={{ display: activeSubTab === "query" ? "flex" : "none" }}>
          <div className="flex shrink-0 flex-col gap-1.5 border-b border-[var(--c-border)] p-2">
            {/* Syntax highlighting is a read-only `<pre>` overlaid behind the
             * real (transparent-text) textarea — the textarea stays the
             * actual editable/selectable/accessible element, the `<pre>`
             * only ever mirrors its text and scroll position. Both share
             * the exact same font/padding/line-height so characters line
             * up pixel-for-pixel. */}
            <div
              className="relative w-full resize-y overflow-hidden rounded-md bg-[var(--c-bg2)] focus-within:ring-1 focus-within:ring-[var(--c-accent)]"
              style={{ height: "7.5rem", minHeight: "2.5rem" }}
            >
              <pre
                ref={queryHighlightRef}
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 m-0 overflow-hidden whitespace-pre-wrap break-words px-2 py-1.5 font-mono text-[13px] leading-[1.5] text-[var(--c-text)]"
              >
                {highlightSql(query)}
                {"\n"}
              </pre>
              <textarea
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); run(); } }}
                onScroll={(e) => {
                  if (queryHighlightRef.current) {
                    queryHighlightRef.current.scrollTop = e.currentTarget.scrollTop;
                    queryHighlightRef.current.scrollLeft = e.currentTarget.scrollLeft;
                  }
                }}
                placeholder="SELECT * FROM ..."
                spellCheck={false}
                className="absolute inset-0 h-full w-full resize-none whitespace-pre-wrap break-words bg-transparent px-2 py-1.5 font-mono text-[13px] leading-[1.5] text-transparent caret-[var(--c-text)] placeholder:text-[var(--c-text-muted)]"
              />
            </div>
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

          {/* `overflow-hidden`, not `overflow-auto`: `ResultTable` owns the
              scrolling itself so it can window its rows (see its doc comment). */}
          <div className="m-2 flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-[var(--c-border)] p-2">
            {queryError && <p className="whitespace-pre-wrap text-xs text-rose-400">{queryError}</p>}
            {!queryError && result && (
              <>
                {result.truncated && (
                  <p className="mb-2 shrink-0 text-[11px] text-amber-400">
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
      {/* See the query tab's matching container — `ResultTable` scrolls itself. */}
      <div className="m-2 flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-[var(--c-border)] p-2">
        {error && <p className="whitespace-pre-wrap text-xs text-rose-400">{error}</p>}
        {!error && result && (
          <>
            {result.truncated && (
              <p className="mb-2 shrink-0 text-[11px] text-amber-400">
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
          <th className="border-b border-[var(--c-border)] bg-[var(--c-bg2)] px-2 py-1 font-medium text-[var(--c-text-secondary)]">Nom</th>
          <th className="border-b border-[var(--c-border)] bg-[var(--c-bg2)] px-2 py-1 font-medium text-[var(--c-text-secondary)]">Type</th>
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
          <th className="border-b border-[var(--c-border)] bg-[var(--c-bg2)] px-2 py-1 font-medium text-[var(--c-text-secondary)]">Colonne</th>
          <th className="border-b border-[var(--c-border)] bg-[var(--c-bg2)] px-2 py-1 font-medium text-[var(--c-text-secondary)]">Type</th>
          <th className="border-b border-[var(--c-border)] bg-[var(--c-bg2)] px-2 py-1 font-medium text-[var(--c-text-secondary)]">Nullable</th>
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
