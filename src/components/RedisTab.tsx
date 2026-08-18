import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import type { RedisKeyDetail, RedisKeyEntry, RedisReply, RedisValue, SqlConnection } from "../lib/types";
import { useResizablePane } from "../hooks/useResizablePane";
import { IconPlay, IconRefresh, IconSearch } from "./ui-icons";

interface RedisTabProps {
  connection: SqlConnection;
  onError: (message: string) => void;
}

/** `120` → `"2m"`, `90000` → `"1j"` — compact enough for a badge next to a
 * key name, unlike a raw seconds count. */
function formatTtl(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}j`;
}

type ActiveSubTab = "value" | "console";
interface ConsoleEntry { command: string; reply?: RedisReply; error?: string }

/** Flat key list (left) + a tabbed pane (right: "Valeur" of whichever key
 * was last clicked, and "Console") for one Redis connection — same
 * connect-on-mount/close-on-unmount lifecycle and mounted-but-hidden-while-
 * inactive convention as `SqlTab`, but a genuinely different component (not
 * a branch inside it): a key-value store has no schema/table tree or SQL
 * query language, so forcing it through `SqlTab`'s shape would mean more
 * special-casing than sharing. See `core::redis_client`'s module doc
 * comment for the full reasoning, and `App.tsx`'s dispatch on
 * `connection.engine`.
 *
 * Unlike `SqlTab`'s schema tree (which lists everything up front), the key
 * list is a flat, paginated, searchable `SCAN` — deliberately not a
 * colon-namespaced virtual folder tree, which would need to see far more of
 * a potentially huge keyspace just to group anything. */
export function RedisTab({ connection, onError }: RedisTabProps) {
  const [status, setStatus] = useState<"connecting" | "connected" | "failed">("connecting");
  const [connectError, setConnectError] = useState<string | null>(null);
  const [database, setDatabase] = useState<number | null>(null);
  const sessionIdRef = useRef<string | null>(null);

  const [pattern, setPattern] = useState("");
  const [keys, setKeys] = useState<RedisKeyEntry[]>([]);
  const [cursor, setCursor] = useState(0);
  const [hasLoadedOnce, setHasLoadedOnce] = useState(false);
  const [loadingKeys, setLoadingKeys] = useState(false);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [activeSubTab, setActiveSubTab] = useState<ActiveSubTab>("value");
  const [keyDetail, setKeyDetail] = useState<RedisKeyDetail | null>(null);
  const [keyDetailMissing, setKeyDetailMissing] = useState(false);
  const [keyDetailError, setKeyDetailError] = useState<string | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);

  const [consoleInput, setConsoleInput] = useState("");
  const [consoleRunning, setConsoleRunning] = useState(false);
  const [consoleHistory, setConsoleHistory] = useState<ConsoleEntry[]>([]);

  const split = useResizablePane({ initial: 260, min: 180, max: 480, axis: "horizontal", mode: "px" });

  const loadKeys = (fromCursor: number, searchPattern: string, append: boolean) => {
    if (!sessionIdRef.current) return;
    setLoadingKeys(true);
    api.scanRedisKeys(sessionIdRef.current, fromCursor, searchPattern || null)
      .then((page) => {
        setKeys((prev) => (append ? [...prev, ...page.keys] : page.keys));
        setCursor(page.cursor);
        setHasLoadedOnce(true);
      })
      .catch((e) => onError(String(e)))
      .finally(() => setLoadingKeys(false));
  };

  useEffect(() => {
    let cancelled = false;
    setStatus("connecting");
    api.openRedisSession(connection.id)
      .then(({ sessionId, database: db }) => {
        if (cancelled) { api.closeRedisSession(sessionId).catch(() => {}); return; }
        sessionIdRef.current = sessionId;
        setDatabase(db);
        setStatus("connected");
        loadKeys(0, "", false);
      })
      .catch((e) => { if (!cancelled) { setConnectError(String(e)); setStatus("failed"); } });
    return () => {
      cancelled = true;
      if (searchTimer.current) clearTimeout(searchTimer.current);
      if (sessionIdRef.current) { api.closeRedisSession(sessionIdRef.current).catch(() => {}); sessionIdRef.current = null; }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection.id]);

  const onPatternChange = (value: string) => {
    setPattern(value);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => loadKeys(0, value, false), 300);
  };

  const refreshKeys = () => {
    if (loadingKeys) return;
    loadKeys(0, pattern, false);
  };

  const loadMoreKeys = () => {
    if (loadingKeys || cursor === 0) return;
    loadKeys(cursor, pattern, true);
  };

  const fetchKeyDetail = (key: string) => {
    if (!sessionIdRef.current) return;
    setLoadingDetail(true);
    setKeyDetail(null);
    setKeyDetailMissing(false);
    setKeyDetailError(null);
    api.getRedisValue(sessionIdRef.current, key)
      .then((detail) => {
        if (detail === null) setKeyDetailMissing(true);
        else setKeyDetail(detail);
      })
      .catch((e) => setKeyDetailError(String(e)))
      .finally(() => setLoadingDetail(false));
  };

  const selectKey = (key: string) => {
    setSelectedKey(key);
    setActiveSubTab("value");
    fetchKeyDetail(key);
  };

  // Refreshes the currently-open key's value in place — used after a
  // Console command whose first argument matches it, so "I'm looking at
  // session:42, I HSET it from the console" reflects immediately, without
  // switching away from the Console tab the way `selectKey` would.
  const refreshSelectedKeyValueQuietly = (key: string) => {
    if (!sessionIdRef.current) return;
    api.getRedisValue(sessionIdRef.current, key)
      .then((detail) => { setKeyDetailMissing(detail === null); if (detail) setKeyDetail(detail); })
      .catch(() => {});
  };

  const runConsoleCommand = () => {
    const command = consoleInput.trim();
    if (!sessionIdRef.current || !command || consoleRunning) return;
    setConsoleRunning(true);
    api.runRedisCommand(sessionIdRef.current, command)
      .then((reply) => {
        setConsoleHistory((prev) => [...prev, { command, reply }]);
        const firstArg = command.split(/\s+/)[1];
        if (selectedKey && firstArg === selectedKey) refreshSelectedKeyValueQuietly(selectedKey);
      })
      .catch((e) => setConsoleHistory((prev) => [...prev, { command, error: String(e) }]))
      .finally(() => { setConsoleRunning(false); setConsoleInput(""); });
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
    <div className="flex min-h-0 min-w-0 flex-1">
      {/* Key list — same `max-w-[50%]` responsiveness clamp as `SqlTab`'s
       * schema tree, for the same reason (this tab's own container can be
       * squeezed narrow by the split-terminal view). */}
      <div style={{ width: split.value }} className="flex max-w-[50%] shrink-0 flex-col overflow-hidden border-r border-[var(--c-border)] bg-[var(--c-bg2)]">
        <div className="flex shrink-0 items-center justify-between border-b border-[var(--c-border)] px-3 py-2.5">
          <span className="truncate text-xs font-semibold uppercase tracking-wide text-[var(--c-text-secondary)]">
            Redis{database !== null ? ` · DB ${database}` : ""}
          </span>
          <button
            onClick={refreshKeys}
            disabled={loadingKeys}
            title="Actualiser la liste des clés"
            className="flex shrink-0 items-center justify-center rounded p-1 text-[var(--c-text-faint)] hover:bg-white/10 hover:text-[var(--c-text-secondary)] disabled:opacity-50"
          >
            <IconRefresh size={13} className={loadingKeys && !hasLoadedOnce ? "animate-spin" : ""} />
          </button>
        </div>
        <div className="shrink-0 border-b border-[var(--c-border)] p-2">
          <div className="flex items-center gap-2 rounded-md border border-[var(--c-border)] bg-[var(--c-bg)] px-2 py-1.5">
            <IconSearch size={13} className="shrink-0 text-[var(--c-text-faint)]" />
            <input
              value={pattern}
              onChange={(e) => onPatternChange(e.target.value)}
              placeholder="Rechercher (motif ou sous-chaîne)…"
              className="w-full bg-transparent text-xs text-[var(--c-text)] placeholder:text-[var(--c-text-faint)]"
            />
          </div>
        </div>
        <div className="sidebar-scroll min-h-0 flex-1 space-y-0.5 overflow-y-auto p-2">
          {!hasLoadedOnce && loadingKeys ? (
            <p className="p-2 text-xs text-[var(--c-text-muted)]">Chargement des clés…</p>
          ) : keys.length === 0 ? (
            <p className="p-2 text-xs text-[var(--c-text-muted)]">Aucune clé{pattern ? " pour ce motif" : ""}.</p>
          ) : (
            keys.map((entry) => {
              const active = entry.key === selectedKey;
              return (
                <button
                  key={entry.key}
                  onClick={() => selectKey(entry.key)}
                  className={`flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors ${
                    active ? "bg-[var(--c-accent-dim)] text-[var(--c-accent-text)]" : "text-[var(--c-text-secondary)] hover:bg-white/[0.07] hover:text-[var(--c-text)]"
                  }`}
                >
                  <span className="min-w-0 flex-1 truncate font-mono">{entry.key}</span>
                  <span className="shrink-0 rounded-full bg-[var(--c-bg3)] px-1.5 py-0.5 text-[9px] text-[var(--c-text-secondary)]">{entry.keyType}</span>
                  {entry.ttlSecs !== null && <span className="shrink-0 text-[9px] text-amber-400">{formatTtl(entry.ttlSecs)}</span>}
                </button>
              );
            })
          )}
          {cursor !== 0 && (
            <button
              onClick={loadMoreKeys}
              disabled={loadingKeys}
              className="w-full rounded-md px-2 py-1.5 text-center text-[11px] text-[var(--c-accent-text)] hover:bg-white/5 disabled:opacity-50"
            >
              {loadingKeys ? "Chargement…" : "Charger plus"}
            </button>
          )}
        </div>
      </div>

      <div onMouseDown={split.onMouseDown} className="group relative flex w-1 shrink-0 cursor-col-resize items-center justify-center">
        <div className="h-full w-px bg-[var(--c-border)] transition-colors group-hover:bg-[var(--c-accent)]" />
      </div>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center gap-1 border-b border-[var(--c-border)] px-2 py-1.5">
          <button
            onClick={() => setActiveSubTab("value")}
            className={`truncate rounded px-2.5 py-1 text-xs font-medium transition-colors ${
              activeSubTab === "value" ? "bg-[var(--c-accent-dim)] text-[var(--c-accent-text)]" : "text-[var(--c-text-muted)] hover:bg-[var(--c-bg2)] hover:text-[var(--c-text-secondary)]"
            }`}
          >
            {selectedKey ? `Valeur : ${selectedKey}` : "Valeur"}
          </button>
          <button
            onClick={() => setActiveSubTab("console")}
            className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${
              activeSubTab === "console" ? "bg-[var(--c-accent-dim)] text-[var(--c-accent-text)]" : "text-[var(--c-text-muted)] hover:bg-[var(--c-bg2)] hover:text-[var(--c-text-secondary)]"
            }`}
          >
            Console
          </button>
        </div>

        {activeSubTab === "value" && (
          <div className="m-2 min-h-0 flex-1 overflow-auto rounded-lg border border-[var(--c-border)] p-3">
            {selectedKey === null ? (
              <p className="text-xs text-[var(--c-text-faint)]">Cliquez une clé dans la liste pour voir sa valeur.</p>
            ) : loadingDetail ? (
              <p className="text-xs text-[var(--c-text-muted)]">Chargement…</p>
            ) : keyDetailError ? (
              <p className="whitespace-pre-wrap text-xs text-rose-400">{keyDetailError}</p>
            ) : keyDetailMissing ? (
              <p className="text-xs text-[var(--c-text-muted)]">Clé introuvable — expirée ou supprimée depuis le dernier chargement de la liste.</p>
            ) : keyDetail ? (
              <RedisValueView detail={keyDetail} />
            ) : null}
          </div>
        )}

        <div className="flex min-h-0 flex-1 flex-col" style={{ display: activeSubTab === "console" ? "flex" : "none" }}>
          <div className="flex shrink-0 items-center gap-2 border-b border-[var(--c-border)] p-2">
            <input
              value={consoleInput}
              onChange={(e) => setConsoleInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); runConsoleCommand(); } }}
              placeholder="HGETALL user:1"
              spellCheck={false}
              className="w-full rounded-md bg-[var(--c-bg2)] px-2.5 py-1.5 font-mono text-[13px] text-[var(--c-text)] placeholder:text-[var(--c-text-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--c-accent)]"
            />
            <button
              onClick={runConsoleCommand}
              disabled={consoleRunning || !consoleInput.trim()}
              className="accent-surface flex shrink-0 items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium disabled:opacity-50"
            >
              <IconPlay size={11} /> {consoleRunning ? "…" : "Exécuter"}
            </button>
          </div>
          <div className="m-2 min-h-0 flex-1 space-y-3 overflow-auto rounded-lg border border-[var(--c-border)] p-3">
            {consoleHistory.length === 0 ? (
              <p className="text-xs text-[var(--c-text-faint)]">Aucune commande — tapez-en une ci-dessus et appuyez sur Entrée.</p>
            ) : (
              consoleHistory.map((entry, i) => (
                <div key={i} className="space-y-1">
                  <p className="font-mono text-[12px] text-[var(--c-text-secondary)]">&gt; {entry.command}</p>
                  {entry.error ? (
                    <p className="whitespace-pre-wrap pl-3 text-xs text-rose-400">{entry.error}</p>
                  ) : (
                    <div className="pl-3">
                      <RedisReplyView reply={entry.reply ?? null} />
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function tableClass() {
  return "w-full border-collapse text-left text-[12px]";
}
function thClass() {
  return "border-b border-[var(--c-border)] bg-[var(--c-bg2)] px-2 py-1 font-medium text-[var(--c-text-secondary)]";
}
function tdClass() {
  return "border-b border-[var(--c-border)] px-2 py-1 font-mono text-[var(--c-text)]";
}

/** Best-effort pretty-print for a string value that happens to be JSON (a
 * very common shape for cached values) — falls back to the raw text for
 * anything else, never errors. */
function prettyPrintIfJson(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

function TruncatedNotice({ truncated }: { truncated: boolean }) {
  if (!truncated) return null;
  return <p className="mb-2 text-[11px] text-amber-400">Résultat tronqué — seuls les premiers éléments sont affichés.</p>;
}

/** The "Valeur" tab's body — type-dispatched rendering of `detail.value`,
 * plus its TTL. Mirrors `SqlTab`'s rounded/bordered table conventions (see
 * `ResultTable`/`StructureTables` there) without importing from it: the two
 * tabs are deliberately independent components (see this file's own doc
 * comment), just sharing a visual vocabulary. */
function RedisValueView({ detail }: { detail: RedisKeyDetail }) {
  const ttlLabel = detail.ttlSecs === null ? "Pas d'expiration" : `Expire dans ${formatTtl(detail.ttlSecs)}`;
  return (
    <div className="space-y-2">
      <p className="text-[11px] text-[var(--c-text-faint)]">{detail.keyType} · {ttlLabel}</p>
      <RedisValueBody value={detail.value} />
    </div>
  );
}

function RedisValueBody({ value }: { value: RedisValue }) {
  switch (value.kind) {
    case "string":
      return <pre className="whitespace-pre-wrap break-words font-mono text-[12px] text-[var(--c-text)]">{prettyPrintIfJson(value.value)}</pre>;
    case "hash":
      return (
        <>
          <TruncatedNotice truncated={value.truncated} />
          {value.entries.length === 0 ? (
            <p className="text-xs text-[var(--c-text-muted)]">Hash vide.</p>
          ) : (
            <table className={tableClass()}>
              <thead><tr><th className={thClass()}>Champ</th><th className={thClass()}>Valeur</th></tr></thead>
              <tbody>
                {value.entries.map(([field, v]) => (
                  <tr key={field} className="hover:bg-white/5">
                    <td className={tdClass()}>{field}</td>
                    <td className={tdClass()}>{v}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      );
    case "list":
    case "set":
      return (
        <>
          <TruncatedNotice truncated={value.truncated} />
          {(value.kind === "list" ? value.items : value.members).length === 0 ? (
            <p className="text-xs text-[var(--c-text-muted)]">{value.kind === "list" ? "Liste vide." : "Ensemble vide."}</p>
          ) : (
            <table className={tableClass()}>
              <tbody>
                {(value.kind === "list" ? value.items : value.members).map((item, i) => (
                  <tr key={i} className="hover:bg-white/5">
                    <td className={`${tdClass()} w-10 text-[var(--c-text-faint)]`}>{i}</td>
                    <td className={tdClass()}>{item}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      );
    case "sortedSet":
      return (
        <>
          <TruncatedNotice truncated={value.truncated} />
          {value.members.length === 0 ? (
            <p className="text-xs text-[var(--c-text-muted)]">Ensemble trié vide.</p>
          ) : (
            <table className={tableClass()}>
              <thead><tr><th className={thClass()}>Membre</th><th className={thClass()}>Score</th></tr></thead>
              <tbody>
                {value.members.map(([member, score]) => (
                  <tr key={member} className="hover:bg-white/5">
                    <td className={tdClass()}>{member}</td>
                    <td className={tdClass()}>{score}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      );
    case "unsupported":
      return (
        <p className="text-xs text-[var(--c-text-muted)]">
          Type « {value.typeName} » non représenté ici — utilisez l'onglet Console (ex. <span className="font-mono">XRANGE</span>, <span className="font-mono">JSON.GET</span>).
        </p>
      );
  }
}

/** Recursive renderer for a raw Console reply — `null`/number/string/array/
 * `{error}`, see `RedisReply`'s doc comment. */
function RedisReplyView({ reply }: { reply: RedisReply }) {
  if (reply === null) return <span className="italic text-[var(--c-text-faint)]">nil</span>;
  if (typeof reply === "number") return <span className="font-mono text-[13px] text-[var(--c-text)]">{reply}</span>;
  if (typeof reply === "string") return <span className="whitespace-pre-wrap font-mono text-[13px] text-[var(--c-text)]">{reply}</span>;
  if (Array.isArray(reply)) {
    if (reply.length === 0) return <span className="italic text-[var(--c-text-faint)]">(vide)</span>;
    return (
      <ol className="space-y-0.5">
        {reply.map((item, i) => (
          <li key={i} className="flex gap-1.5">
            <span className="shrink-0 font-mono text-[11px] text-[var(--c-text-faint)]">{i + 1})</span>
            <RedisReplyView reply={item} />
          </li>
        ))}
      </ol>
    );
  }
  return <span className="whitespace-pre-wrap text-[13px] text-rose-400">{reply.error}</span>;
}
