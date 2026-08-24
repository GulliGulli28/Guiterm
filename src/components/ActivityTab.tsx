import { useCallback, useEffect, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { api } from "../lib/api";
import { ACTIVITY_KINDS, activityKindLabel, formatActivityTime, groupByDay } from "../lib/activity";
import type { ActivityEvent, ActivityFilter, ActivityKind, HostId, Workspace } from "../lib/types";
import { HostTreePicker } from "./HostTreePicker";
import { IconHosts } from "./ui-icons";

interface ActivityTabProps {
  workspace: Workspace;
  onError: (message: string) => void;
  /** A successful export is a success, not an error — reported through the
   * notification channel rather than the error banner. */
  onExported: (message: string) => void;
}

const inputClass =
  "rounded-md bg-[var(--c-bg3)] px-2 py-1.5 text-sm text-[var(--c-text)] placeholder:text-[var(--c-text-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--c-accent-hover)]";

/** Windows the period filter offers. Relative rather than a date picker: the
 * question people actually ask a journal is "what happened today / this week",
 * and two calendar fields to answer it is three clicks too many. */
const PERIODS: { id: string; label: string; days: number | null }[] = [
  { id: "all", label: "Depuis toujours", days: null },
  { id: "1", label: "Dernières 24 h", days: 1 },
  { id: "7", label: "7 derniers jours", days: 7 },
  { id: "30", label: "30 derniers jours", days: 30 },
];

const KIND_TONE: Record<ActivityKind, string> = {
  fleetRun: "bg-indigo-500/15 text-indigo-300",
  command: "bg-slate-500/15 text-slate-300",
  recording: "bg-teal-500/15 text-teal-300",
};

/**
 * « Qui a fait quoi, où, quand » — the three trails this app already kept,
 * read as one timeline.
 *
 * Nothing here is a new record: fleet runs, command history and session
 * recordings each keep their own file, their own cap and their own writer, and
 * this only reads them (see `termius_core::activity` for why merging on disk
 * was refused). Which means the journal inherits their limits, and says so
 * rather than implying an audit completeness it doesn't have — a command entry
 * stands for its most recent run, and entries older than timestamps have no
 * date at all.
 */
export function ActivityTab({ workspace, onError, onExported }: ActivityTabProps) {
  const [events, setEvents] = useState<ActivityEvent[] | null>(null);
  const [kinds, setKinds] = useState<Set<ActivityKind>>(new Set());
  const [period, setPeriod] = useState("all");
  const [hostId, setHostId] = useState<HostId | "">("");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);

  const buildFilter = useCallback((): ActivityFilter => {
    const days = PERIODS.find((p) => p.id === period)?.days ?? null;
    return {
      kinds: [...kinds],
      sinceMs: days === null ? null : Date.now() - days * 24 * 60 * 60 * 1000,
      hostId: hostId || null,
      search: search.trim() || null,
    };
  }, [kinds, period, hostId, search]);

  const reload = useCallback(() => {
    setLoading(true);
    api.listActivity(buildFilter())
      .then(setEvents)
      .catch((e) => onError(String(e)))
      .finally(() => setLoading(false));
  }, [buildFilter, onError]);

  useEffect(reload, [reload]);

  const runExport = async (format: "csv" | "json") => {
    const path = await save({
      defaultPath: `activite-guiterm.${format}`,
      filters: [{ name: format.toUpperCase(), extensions: [format] }],
    }).catch(() => null);
    if (!path) return;
    try {
      // The *filtered* set, matching what's on screen — see `export_activity`.
      const count = await api.exportActivity(path, format, buildFilter());
      onExported(`${count} évènement(s) exporté(s) vers ${path}`);
    } catch (e) {
      onError(String(e));
    }
  };

  const toggleKind = (kind: ActivityKind) => {
    setKinds((current) => {
      const next = new Set(current);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  };

  const groups = groupByDay(events ?? []);

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--c-bg)]">
      <div className="shrink-0 space-y-2 border-b border-[var(--c-border)] px-4 py-3">
        <div className="flex items-center gap-2">
          <h2 className="flex-1 text-[15px] font-semibold text-[var(--c-text)]">Activité</h2>
          <button
            onClick={() => runExport("csv")}
            disabled={!events?.length}
            className="rounded-md bg-[var(--c-bg3)] px-2.5 py-1.5 text-xs text-[var(--c-text-secondary)] hover:bg-white/5 disabled:opacity-40"
          >
            Exporter en CSV
          </button>
          <button
            onClick={() => runExport("json")}
            disabled={!events?.length}
            className="rounded-md bg-[var(--c-bg3)] px-2.5 py-1.5 text-xs text-[var(--c-text-secondary)] hover:bg-white/5 disabled:opacity-40"
          >
            Exporter en JSON
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {ACTIVITY_KINDS.map((kind) => {
            const active = kinds.size === 0 || kinds.has(kind);
            return (
              <button
                key={kind}
                onClick={() => toggleKind(kind)}
                className={`rounded-full px-2.5 py-1 text-[11px] transition-colors ${
                  active ? KIND_TONE[kind] : "bg-[var(--c-bg3)] text-[var(--c-text-muted)]"
                }`}
              >
                {activityKindLabel(kind)}
              </button>
            );
          })}
        </div>

        <div className="flex flex-wrap gap-1.5">
          <select value={period} onChange={(e) => setPeriod(e.target.value)} className={inputClass}>
            {PERIODS.map((p) => (
              <option key={p.id} value={p.id}>{p.label}</option>
            ))}
          </select>
          <HostTreePicker
            hosts={workspace.hosts}
            groups={workspace.groups}
            customIcons={workspace.customIcons}
            value={hostId === "" ? "" : hostId}
            onChange={(v) => setHostId((v ?? "") as HostId | "")}
            specials={[{ value: "", label: "Tous les hôtes", icon: <IconHosts size={12} /> }]}
            className={`${inputClass} flex w-48 items-center justify-between gap-2 text-left`}
          />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Rechercher dans les commandes…"
            className={`${inputClass} min-w-0 flex-1`}
          />
        </div>

        {/* Said once, at the top, rather than repeated on every command row:
            the journal reads the ghost-text history, which keeps one entry per
            distinct command. Leaving it out would make an audit trail look
            more complete than it is. */}
        <p className="text-[10px] leading-relaxed text-[var(--c-text-faint)]">
          Les commandes proviennent de l'historique de saisie : une entrée par commande distincte,
          datée de sa dernière utilisation — pas une ligne par exécution. Les opérations de flotte et
          les enregistrements sont, eux, listés un par un.
        </p>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {loading && events === null && <p className="text-sm text-[var(--c-text-muted)]">Lecture du journal…</p>}
        {events !== null && events.length === 0 && (
          <p className="text-sm text-[var(--c-text-muted)]">
            Aucun évènement pour ces filtres. Les opérations de flotte, les commandes saisies dans un
            terminal et les enregistrements de session apparaissent ici au fur et à mesure.
          </p>
        )}

        {groups.map((group) => (
          <div key={group.day} className="mb-4">
            <h3 className="sticky top-0 z-10 bg-[var(--c-bg)] py-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--c-text-faint)]">
              {group.day}
            </h3>
            <div className="space-y-1">
              {group.events.map((event, i) => (
                <div
                  key={`${event.kind}-${event.atMs}-${i}`}
                  className={`rounded-lg border p-2.5 ${
                    event.failed ? "border-rose-500/30 bg-rose-950/20" : "border-transparent bg-[var(--c-bg2)]"
                  }`}
                >
                  <div className="flex items-baseline gap-2">
                    <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] ${KIND_TONE[event.kind]}`}>
                      {activityKindLabel(event.kind)}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-[var(--c-text)]" title={event.summary}>
                      {event.summary}
                    </span>
                    <span className="shrink-0 text-[10px] text-[var(--c-text-faint)]">{formatActivityTime(event.atMs)}</span>
                  </div>
                  <p className="mt-0.5 truncate text-[10px] text-[var(--c-text-muted)]" title={event.detail}>
                    {event.target}
                    {event.detail && <> · {event.detail}</>}
                  </p>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
