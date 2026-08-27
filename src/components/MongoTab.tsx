import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { ConnectionFailed } from "./ConnectionFailed";
import type { CollectionInfo, MongoQueryResult, SqlConnection } from "../lib/types";
import { useResizablePane } from "../hooks/useResizablePane";
import { IconChevronDown, IconChevronRight, IconDatabase, IconFolder, IconPlay, IconRefresh } from "./ui-icons";

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
    return <div className="flex flex-1 items-center justify-center text-sm text-[var(--c-text-muted)]">Connexion à « {connection.label} »…</div>;
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
          <span className="truncate text-xs font-semibold uppercase tracking-wide text-[var(--c-text-secondary)]">MongoDB</span>
          <button
            onClick={() => { if (!loadingDatabases) loadDatabases(); }}
            disabled={loadingDatabases}
            title="Actualiser la liste des bases"
            className="flex shrink-0 items-center justify-center rounded p-1 text-[var(--c-text-faint)] hover:bg-white/10 hover:text-[var(--c-text-secondary)] disabled:opacity-50"
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
                    className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-[13px] text-[var(--c-text-secondary)] transition-colors hover:bg-white/[0.07] hover:text-[var(--c-text)]"
                  >
                    {open ? <IconChevronDown size={12} className="shrink-0" /> : <IconChevronRight size={12} className="shrink-0" />}
                    <IconDatabase size={13} className="shrink-0 text-[var(--c-text-faint)]" />
                    <span className="min-w-0 flex-1 truncate">{database}</span>
                  </button>
                  {open && (
                    <div className="ml-4 space-y-0.5 border-l border-[var(--c-border)] pl-1.5">
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
                              className={`flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors ${
                                active ? "bg-[var(--c-accent-dim)] text-[var(--c-accent-text)]" : "text-[var(--c-text-secondary)] hover:bg-white/[0.07] hover:text-[var(--c-text)]"
                              }`}
                            >
                              <IconFolder size={13} className="shrink-0 text-[var(--c-text-faint)]" />
                              <span className="min-w-0 flex-1 truncate">{collection.name}</span>
                              {collection.kind !== "collection" && (
                                <span className="shrink-0 rounded-full bg-[var(--c-bg3)] px-1.5 py-0.5 text-[9px] text-[var(--c-text-secondary)]">
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

      <div onMouseDown={split.onMouseDown} className="group relative flex w-1 shrink-0 cursor-col-resize items-center justify-center">
        <div className="h-full w-px bg-[var(--c-border)] transition-colors group-hover:bg-[var(--c-accent)]" />
      </div>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center gap-1 border-b border-[var(--c-border)] px-2 py-1.5">
          <button
            onClick={() => setActiveSubTab("data")}
            className={`truncate rounded px-2.5 py-1 text-xs font-medium transition-colors ${
              activeSubTab === "data" ? "bg-[var(--c-accent-dim)] text-[var(--c-accent-text)]" : "text-[var(--c-text-muted)] hover:bg-[var(--c-bg2)] hover:text-[var(--c-text-secondary)]"
            }`}
          >
            {selection ? `Données : ${selection.collection}` : "Données"}
          </button>
          <button
            onClick={() => setActiveSubTab("query")}
            className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${
              activeSubTab === "query" ? "bg-[var(--c-accent-dim)] text-[var(--c-accent-text)]" : "text-[var(--c-text-muted)] hover:bg-[var(--c-bg2)] hover:text-[var(--c-text-secondary)]"
            }`}
          >
            Requête
          </button>
          {selection && (
            <button
              onClick={() => runFind(selection, activeSubTab === "query")}
              disabled={activePane.loading}
              title="Relancer"
              className="ml-auto flex shrink-0 items-center justify-center rounded p-1 text-[var(--c-text-faint)] hover:bg-white/10 hover:text-[var(--c-text-secondary)] disabled:opacity-50"
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
              className="w-full resize-y rounded-md bg-[var(--c-bg2)] px-2.5 py-1.5 font-mono text-[13px] text-[var(--c-text)] placeholder:text-[var(--c-text-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--c-accent)]"
            />
            <button
              onClick={() => { if (selection) runFind(selection, true); }}
              disabled={!selection || queryPane.loading}
              title="Exécuter (Ctrl+Entrée)"
              className="accent-surface flex shrink-0 items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium disabled:opacity-50"
            >
              <IconPlay size={11} /> {queryPane.loading ? "…" : "Exécuter"}
            </button>
          </div>
        )}

        <div className="m-2 min-h-0 flex-1 overflow-auto rounded-lg border border-[var(--c-border)] p-3">
          {selection === null ? (
            <p className="text-xs text-[var(--c-text-faint)]">Cliquez une collection dans l'arborescence pour voir ses documents.</p>
          ) : activePane.loading ? (
            <p className="text-xs text-[var(--c-text-muted)]">Chargement…</p>
          ) : activePane.error ? (
            <p className="whitespace-pre-wrap text-xs text-rose-400">{activePane.error}</p>
          ) : activePane.result === null ? (
            <p className="text-xs text-[var(--c-text-faint)]">
              {activeSubTab === "query" ? "Saisissez un filtre JSON puis exécutez — un filtre vide renvoie tous les documents." : "Aucun résultat."}
            </p>
          ) : activePane.result.documents.length === 0 ? (
            <p className="text-xs text-[var(--c-text-muted)]">Aucun document.</p>
          ) : (
            <div className="space-y-2">
              {activePane.result.truncated && (
                <p className="text-[11px] text-amber-400">
                  Résultat tronqué : seuls les premiers documents sont affichés.
                </p>
              )}
              {activePane.result.documents.map((document, i) => (
                <pre
                  key={i}
                  className="overflow-x-auto rounded-md border border-[var(--c-border)] bg-[var(--c-bg2)] p-2.5 font-mono text-[12px] leading-relaxed text-[var(--c-text-secondary)]"
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
