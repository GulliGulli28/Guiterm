import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { ConnectionFailed } from "./ConnectionFailed";
import type { CollectionInfo, MongoQueryResult, SqlConnection } from "../lib/types";
import { useResizablePane } from "../hooks/useResizablePane";
import { IconChevronDown, IconChevronRight, IconDatabase, IconPlay, IconRefresh, IconTable } from "./ui-icons";

interface MongoTabProps {
  connection: SqlConnection;
  onError: (message: string) => void;
}

type ActiveSubTab = "data" | "query";

/** One pane's worth of documents, tracked separately for "Données" and
 * "Requête" so switching between them doesn't discard the other's result —
 * both call the same `findMongoDocuments`, they differ only by filter. */
interface DocumentsPane {
  result: MongoQueryResult | null;
  loading: boolean;
  error: string | null;
}

const EMPTY_PANE: DocumentsPane = { result: null, loading: false, error: null };

interface Selection {
  database: string;
  collection: string;
}

/** Database/collection tree (left) + a tabbed document pane (right:
 * "Données", an unfiltered listing, and "Requête", a JSON filter) for one
 * MongoDB connection — same connect-on-mount/close-on-unmount lifecycle and
 * mounted-but-hidden-while-inactive convention as `SqlTab`/`RedisTab`, but a
 * separate component for the reason given in `core::mongo_client`'s module
 * doc: a document store has no fixed schema to browse and no SQL to type, so
 * `SqlTab`'s shape would need more special-casing than it would share.
 *
 * Two tabs, not four. There is no "Structure" tab because inferring a schema
 * by sampling (à la Compass) is a feature of its own, and showing real
 * documents is both simpler and more honest for a schemaless store; there is
 * no "Console" either, because a Mongo shell is a JavaScript evaluator rather
 * than the flat command list Redis's console tokenises. Both are deliberate
 * scope choices — see `core::mongo_client`'s module doc.
 *
 * Documents arrive as relaxed MongoDB Extended JSON (`$oid`/`$date` wrappers
 * only where JSON genuinely can't represent the BSON type), the same
 * representation `mongosh` and Compass show, so they are rendered as-is
 * rather than reinterpreted here. */
export function MongoTab({ connection, onError }: MongoTabProps) {
  const [status, setStatus] = useState<"connecting" | "connected" | "failed">("connecting");
  // Incrémenté par « Réessayer » (`ConnectionFailed`) : seule dépendance de
  // l'effet de connexion en dehors de la connexion elle-même, donc
  // l'incrémenter rejoue tout le cycle, fermeture de la session précédente
  // comprise.
  const [attempt, setAttempt] = useState(0);

  const [connectError, setConnectError] = useState<string | null>(null);
  const sessionIdRef = useRef<string | null>(null);

  const [databases, setDatabases] = useState<string[]>([]);
  const [loadingDatabases, setLoadingDatabases] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [collections, setCollections] = useState<Record<string, CollectionInfo[]>>({});
  const [loadingCollections, setLoadingCollections] = useState<string | null>(null);

  const [selection, setSelection] = useState<Selection | null>(null);
  const [activeSubTab, setActiveSubTab] = useState<ActiveSubTab>("data");
  const [dataPane, setDataPane] = useState<DocumentsPane>(EMPTY_PANE);
  const [queryPane, setQueryPane] = useState<DocumentsPane>(EMPTY_PANE);
  const [filter, setFilter] = useState("");

  const split = useResizablePane({ initial: 260, min: 180, max: 480, axis: "horizontal", mode: "px" });

  const loadDatabases = () => {
    if (!sessionIdRef.current) return;
    setLoadingDatabases(true);
    api.listMongoDatabases(sessionIdRef.current)
      .then(setDatabases)
      .catch((e) => onError(String(e)))
      .finally(() => setLoadingDatabases(false));
  };

  useEffect(() => {
    let cancelled = false;
    setStatus("connecting");
    api.openMongoSession(connection.id)
      .then((sessionId) => {
        if (cancelled) { api.closeMongoSession(sessionId).catch(() => {}); return; }
        sessionIdRef.current = sessionId;
        setStatus("connected");
        loadDatabases();
      })
      .catch((e) => { if (!cancelled) { setConnectError(String(e)); setStatus("failed"); } });
    return () => {
      cancelled = true;
      if (sessionIdRef.current) { api.closeMongoSession(sessionIdRef.current).catch(() => {}); sessionIdRef.current = null; }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection.id, attempt]);

  const toggleDatabase = (database: string) => {
    const next = new Set(expanded);
    if (next.has(database)) {
      next.delete(database);
      setExpanded(next);
      return;
    }
    next.add(database);
    setExpanded(next);
    // Collections are fetched once per database and kept: re-expanding a
    // database shouldn't re-query a server that may be remote and tunnelled.
    if (collections[database] || !sessionIdRef.current) return;
    setLoadingCollections(database);
    api.listMongoCollections(sessionIdRef.current, database)
      .then((list) => setCollections((prev) => ({ ...prev, [database]: list })))
      .catch((e) => onError(String(e)))
      .finally(() => setLoadingCollections(null));
  };

  /** Runs `find` against the selected collection. `useFilter` distinguishes
   * the two tabs; a blank filter is sent as `null`, which the backend treats
   * as "every document" exactly like the Données tab. */
  const runFind = (target: Selection, useFilter: boolean) => {
    if (!sessionIdRef.current) return;
    const setPane = useFilter ? setQueryPane : setDataPane;
    setPane({ result: null, loading: true, error: null });
    api.findMongoDocuments(sessionIdRef.current, target.database, target.collection, useFilter ? filter.trim() || null : null)
      .then((result) => setPane({ result, loading: false, error: null }))
      .catch((e) => setPane({ result: null, loading: false, error: String(e) }));
  };

  const selectCollection = (database: string, collection: string) => {
    const target = { database, collection };
    setSelection(target);
    setActiveSubTab("data");
    setQueryPane(EMPTY_PANE);
    runFind(target, false);
  };

  if (status === "connecting") {
    return <div className="flex flex-1 items-center justify-center text-[12.5px] text-[var(--c-text-muted)]">Connexion à « {connection.label} »…</div>;
  }
  if (status === "failed") {
    return (
      <ConnectionFailed
        title={`Impossible de se connecter à « ${connection.label} »`}
        error={connectError}
        onRetry={() => setAttempt((n) => n + 1)}
      />
    );
  }

  const activePane = activeSubTab === "data" ? dataPane : queryPane;

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      {/* Same `max-w-[50%]` clamp as `SqlTab`'s schema tree and `RedisTab`'s
       * key list, for the same reason: the split-terminal view can squeeze
       * this tab's own container narrow. */}
      <div style={{ width: split.value }} className="flex max-w-[50%] shrink-0 flex-col overflow-hidden border-r border-[var(--c-border)] bg-[var(--c-bg2)]">
        <div className="flex shrink-0 items-center justify-between border-b border-[var(--c-border)] px-3 py-2.5">
          <span className="eyebrow truncate">MongoDB</span>
          <button
            onClick={() => { if (!loadingDatabases) loadDatabases(); }}
            disabled={loadingDatabases}
            title="Actualiser la liste des bases"
            className="btn btn-ghost btn-sm btn-icon"
          >
            <IconRefresh size={13} className={loadingDatabases ? "animate-spin" : ""} />
          </button>
        </div>
        <div className="sidebar-scroll min-h-0 flex-1 space-y-0.5 overflow-y-auto p-2">
          {loadingDatabases && databases.length === 0 ? (
            <p className="p-2 text-xs text-[var(--c-text-muted)]">Chargement des bases…</p>
          ) : databases.length === 0 ? (
            <p className="p-2 text-xs text-[var(--c-text-muted)]">Aucune base accessible.</p>
          ) : (
            databases.map((database) => {
              const open = expanded.has(database);
              return (
                <div key={database}>
                  <button
                    onClick={() => toggleDatabase(database)}
                    className="flex h-7 w-full items-center gap-1.5 rounded-md px-1 text-left text-[12.5px] font-medium text-[var(--c-text)] transition-colors hover:bg-[var(--c-hover)]"
                  >
                    {open ? <IconChevronDown size={12} className="shrink-0 text-[var(--c-text-muted)]" /> : <IconChevronRight size={12} className="shrink-0 text-[var(--c-text-muted)]" />}
                    <IconDatabase size={13} className="shrink-0 text-[var(--c-text-muted)]" />
                    <span className="min-w-0 flex-1 truncate">{database}</span>
                  </button>
                  {open && (
                    <div className="ml-2.5 border-l border-[var(--c-border)] pl-1.5">
                      {loadingCollections === database ? (
                        <p className="px-2 py-1 text-[11px] text-[var(--c-text-muted)]">Chargement…</p>
                      ) : (collections[database] ?? []).length === 0 ? (
                        <p className="px-2 py-1 text-[11px] text-[var(--c-text-muted)]">Aucune collection.</p>
                      ) : (
                        (collections[database] ?? []).map((collection) => {
                          const active = selection?.database === database && selection.collection === collection.name;
                          return (
                            <button
                              key={collection.name}
                              onClick={() => selectCollection(database, collection.name)}
                              className={`flex h-6 w-full items-center gap-1.5 rounded-md px-2 text-left text-[12.5px] transition-colors ${
                                active ? "bg-[var(--c-accent-dim)] text-[var(--c-text)]" : "text-[var(--c-text-secondary)] hover:bg-[var(--c-hover)] hover:text-[var(--c-text)]"
                              }`}
                            >
                              <IconTable size={12} className={`shrink-0 ${active ? "text-[var(--c-accent-text)]" : "text-[var(--c-text-faint)]"}`} />
                              <span className="min-w-0 flex-1 truncate">{collection.name}</span>
                              {collection.kind !== "collection" && (
                                <span className="tag">
                                  {collection.kind === "view" ? "vue" : "séries"}
                                </span>
                              )}
                            </button>
                          );
                        })
                      )}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>

      <div onMouseDown={split.onMouseDown} className="group relative z-10 -mx-0.5 flex w-1.5 shrink-0 cursor-col-resize items-center justify-center">
        <div className="h-full w-px bg-[var(--c-border)] transition-colors group-hover:w-0.5 group-hover:bg-[var(--c-accent)]" />
      </div>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center gap-1 border-b border-[var(--c-border)] px-2 py-1.5">
          <div className="segmented">
            <button onClick={() => setActiveSubTab("data")} data-active={activeSubTab === "data" ? "true" : undefined} className="max-w-[16rem] truncate">
              {selection ? `Données : ${selection.collection}` : "Données"}
            </button>
            <button onClick={() => setActiveSubTab("query")} data-active={activeSubTab === "query" ? "true" : undefined}>
              Requête
            </button>
          </div>
          {selection && (
            <button
              onClick={() => runFind(selection, activeSubTab === "query")}
              disabled={activePane.loading}
              title="Relancer"
              className="btn btn-ghost btn-sm btn-icon ml-auto"
            >
              <IconRefresh size={13} className={activePane.loading ? "animate-spin" : ""} />
            </button>
          )}
        </div>

        {activeSubTab === "query" && (
          <div className="flex shrink-0 items-start gap-2 border-b border-[var(--c-border)] p-2">
            <textarea
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              onKeyDown={(e) => {
                // Ctrl/Cmd+Enter runs, plain Enter keeps inserting newlines —
                // a filter is a JSON object, routinely written on several
                // lines, unlike Redis's single-line commands.
                if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); if (selection) runFind(selection, true); }
              }}
              rows={3}
              spellCheck={false}
              placeholder={'{ "status": "active" }'}
              className="input input-mono w-full resize-y"
            />
            <button
              onClick={() => { if (selection) runFind(selection, true); }}
              disabled={!selection || queryPane.loading}
              title="Exécuter (Ctrl+Entrée)"
              className="btn btn-primary"
            >
              <IconPlay size={11} /> {queryPane.loading ? "…" : "Exécuter"}
            </button>
          </div>
        )}

        <div className="m-2 min-h-0 flex-1 overflow-auto p-1">
          {selection === null ? (
            <p className="text-[12px] text-[var(--c-text-muted)]">Cliquez une collection dans l'arborescence pour voir ses documents.</p>
          ) : activePane.loading ? (
            <p className="text-[12px] text-[var(--c-text-muted)]">Chargement…</p>
          ) : activePane.error ? (
            <p className="callout callout-danger whitespace-pre-wrap font-mono text-[11.5px]">{activePane.error}</p>
          ) : activePane.result === null ? (
            <p className="text-[12px] text-[var(--c-text-muted)]">
              {activeSubTab === "query" ? "Saisissez un filtre JSON puis exécutez — un filtre vide renvoie tous les documents." : "Aucun résultat."}
            </p>
          ) : activePane.result.documents.length === 0 ? (
            <p className="text-[12px] text-[var(--c-text-muted)]">Aucun document.</p>
          ) : (
            <div className="space-y-2">
              {activePane.result.truncated && (
                <p className="text-[11px] text-[var(--c-warn)]">
                  Résultat tronqué : seuls les premiers documents sont affichés.
                </p>
              )}
              {activePane.result.documents.map((document, i) => (
                <pre
                  key={i}
                  className="overflow-x-auto rounded-md border border-[var(--c-border)] bg-[var(--c-bg)] p-2.5 font-mono text-[12px] leading-relaxed text-[var(--c-text-secondary)]"
                >
                  {JSON.stringify(document, null, 2)}
                </pre>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
