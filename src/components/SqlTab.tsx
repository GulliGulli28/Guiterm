import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import type { ColumnInfo, QueryResult, SqlConnection, TableInfo } from "../lib/types";
import { useResizablePane } from "../hooks/useResizablePane";
import { IconChevronDown, IconChevronRight, IconDatabase, IconFolder, IconPlay } from "./ui-icons";

interface SqlTabProps {
  connection: SqlConnection;
  onError: (message: string) => void;
}

type Status = "connecting" | "connected" | "failed";

/** Schema tree (left) + query editor/results (right) for one SQL connection
 * — opens a session on mount, closes it on unmount (the tab itself staying
 * mounted-but-hidden while inactive, like every other tab kind, keeps the
 * session alive across switching tabs; only actually closing the tab tears
 * it down). No `isActive` prop needed: unlike `TerminalTab`/`RdpTab`, there's
 * no canvas/xterm redraw concern here — same reasoning `TransferTab`/
 * `FleetTab` already skip it for. */
export function SqlTab({ connection, onError }: SqlTabProps) {
  const [status, setStatus] = useState<Status>("connecting");
  const [connectError, setConnectError] = useState<string | null>(null);
  const sessionIdRef = useRef<string | null>(null);

  const [schemas, setSchemas] = useState<string[] | null>(null);
  const [expandedSchemas, setExpandedSchemas] = useState<Set<string>>(new Set());
  const [tablesBySchema, setTablesBySchema] = useState<Record<string, TableInfo[]>>({});
  const [expandedTables, setExpandedTables] = useState<Set<string>>(new Set());
  const [columnsByTable, setColumnsByTable] = useState<Record<string, ColumnInfo[]>>({});

  const [query, setQuery] = useState("");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<QueryResult | null>(null);
  const [queryError, setQueryError] = useState<string | null>(null);

  const split = useResizablePane({ initial: 260, min: 180, max: 480, axis: "horizontal", mode: "px" });

  useEffect(() => {
    let cancelled = false;
    setStatus("connecting");
    api.openSqlSession(connection.id)
      .then((sessionId) => {
        if (cancelled) { api.closeSqlSession(sessionId).catch(() => {}); return; }
        sessionIdRef.current = sessionId;
        setStatus("connected");
        return api.listSqlSchemas(sessionId).then((s) => { if (!cancelled) setSchemas(s); });
      })
      .catch((e) => { if (!cancelled) { setConnectError(String(e)); setStatus("failed"); } });
    return () => {
      cancelled = true;
      if (sessionIdRef.current) { api.closeSqlSession(sessionIdRef.current).catch(() => {}); sessionIdRef.current = null; }
    };
  }, [connection.id]);

  const toggleSchema = (schema: string) => {
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

  return (
    <div className="flex min-h-0 flex-1">
      {/* Schema tree */}
      <div style={{ width: split.value }} className="sidebar-scroll flex shrink-0 flex-col overflow-y-auto border-r border-[var(--c-border)] bg-[var(--c-bg2)] p-2">
        {schemas === null ? (
          <p className="p-2 text-xs text-[var(--c-text-muted)]">Chargement du schéma…</p>
        ) : schemas.length === 0 ? (
          <p className="p-2 text-xs text-[var(--c-text-muted)]">Aucune base/schéma visible</p>
        ) : (
          schemas.map((schema) => (
            <div key={schema}>
              <button
                onClick={() => toggleSchema(schema)}
                className="flex w-full items-center gap-1 rounded-md px-1.5 py-1 text-left text-[13px] text-[var(--c-text-secondary)] hover:bg-white/5"
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
                              className="flex min-w-0 flex-1 items-center gap-1 rounded-md px-1.5 py-1 text-left text-[12px] text-[var(--c-text-secondary)] hover:bg-white/5"
                            >
                              {expandedTables.has(key) ? <IconChevronDown size={10} /> : <IconChevronRight size={10} />}
                              <IconFolder size={11} className="shrink-0 text-[var(--c-text-faint)]" />
                              <span className="min-w-0 flex-1 truncate">{t.name}</span>
                              {t.kind === "view" && <span className="shrink-0 text-[9px] text-[var(--c-text-faint)]">vue</span>}
                            </button>
                            <button
                              onClick={() => setQuery(`SELECT * FROM ${schema}.${t.name} LIMIT 100;`)}
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

      {/* Query editor + results */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
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
                            {cell === null ? <span className="italic text-[var(--c-text-faint)]">NULL</span> : String(cell)}
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
  );
}
