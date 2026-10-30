import { useCallback, useEffect, useState, type ComponentType } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { api } from "../lib/api";
import { ACTIVITY_KINDS, activityKindLabel, formatActivityTime, groupByDay } from "../lib/activity";
import type { ActivityEvent, ActivityFilter, ActivityKind, HostId, Workspace } from "../lib/types";
import { HostTreePicker } from "./HostTreePicker";
import { IconActivity, IconChevronDown, IconFleet, IconHosts, IconSearch, IconTerminal, IconUpload } from "./ui-icons";

interface ActivityTabProps {
  workspace: Workspace;
  onError: (message: string) => void;
  /** A successful export is a success, not an error — reported through the
   * notification channel rather than the error banner. */
  onExported: (message: string) => void;
}

const inputClass = "input";

/** Windows the period filter offers. Relative rather than a date picker: the
 * question people actually ask a journal is "what happened today / this week",
 * and two calendar fields to answer it is three clicks too many. */
const PERIODS: { id: string; label: string; days: number | null }[] = [
  { id: "all", label: "Depuis toujours", days: null },
  { id: "1", label: "Dernières 24 h", days: 1 },
  { id: "7", label: "7 derniers jours", days: 7 },
  { id: "30", label: "30 derniers jours", days: 30 },
];

// L'icône du genre, comme dans le rail : la couleur reste au résultat.
const KIND_ICON: Record<ActivityKind, ComponentType<{ size?: number }>> = {
  fleetRun: IconFleet,
  command: IconTerminal,
  recording: IconActivity,
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
  const [failedOnly, setFailedOnly] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);

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

  // « Échecs » se filtre ici, sur ce qui est déjà chargé : le journal n'a pas
  // de critère d'échec côté backend, et il n'en a pas besoin pour une poignée
  // de lignes.
  const failures = (events ?? []).filter((e) => e.failed).length;
  const shown = failedOnly ? (events ?? []).filter((e) => e.failed) : events ?? [];
  const groups = groupByDay(shown);

  return (
    <div data-page="activity" className="sidebar-scroll h-full overflow-y-auto bg-[var(--c-bg2)]">
      <div className="mx-auto max-w-[1100px] space-y-[18px] px-9 py-7">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h1 className="text-[20px] font-semibold text-[var(--c-text)]">Activité</h1>
            <p
              className="mt-1 text-[12.5px] text-[var(--c-text-muted)]"
              title="Les commandes proviennent de l'historique de saisie : une entrée par commande distincte, datée de sa dernière utilisation — pas une ligne par exécution. Les opérations de flotte et les enregistrements sont, eux, listés un par un."
            >
              Commandes, opérations de flotte et enregistrements de session, sur cet appareil.
            </p>
          </div>
          <div className="relative">
            <button
              type="button"
              onClick={() => setExportOpen((v) => !v)}
              disabled={!events?.length}
              aria-expanded={exportOpen}
              className="btn btn-secondary"
            >
              <IconUpload size={13} /> Exporter <IconChevronDown size={10} className="text-[var(--c-text-muted)]" />
            </button>
            {exportOpen && (
              <div className="popover absolute right-0 top-full z-20 mt-1 w-40 p-1" role="menu">
                <button type="button" role="menuitem" onClick={() => { setExportOpen(false); void runExport("csv"); }} className="menu-item">En CSV</button>
                <button type="button" role="menuitem" onClick={() => { setExportOpen(false); void runExport("json"); }} className="menu-item">En JSON</button>
              </div>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <label className="input flex w-[300px] items-center gap-2">
            <IconSearch size={13} className="shrink-0 text-[var(--c-text-muted)]" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Rechercher une commande"
              aria-label="Rechercher dans l'activité"
              className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-[var(--c-text-muted)]"
            />
          </label>
          <button
            type="button"
            onClick={() => setKinds(new Set())}
            aria-pressed={kinds.size === 0}
            className={`chip h-7 ${kinds.size === 0 ? "chip-accent" : ""}`}
          >
            Tout
          </button>
          {ACTIVITY_KINDS.map((kind) => {
            const active = kinds.has(kind);
            return (
              <button
                key={kind}
                type="button"
                onClick={() => toggleKind(kind)}
                aria-pressed={active}
                className={`chip h-7 ${active ? "chip-accent" : ""}`}
              >
                {activityKindLabel(kind)}
              </button>
            );
          })}
          {failures > 0 && (
            <button
              type="button"
              onClick={() => setFailedOnly((v) => !v)}
              aria-pressed={failedOnly}
              className={`chip h-7 ${failedOnly ? "chip-danger" : ""}`}
            >
              Échecs · {failures}
            </button>
          )}
          <span className="flex-1" />
          <select value={period} onChange={(e) => setPeriod(e.target.value)} aria-label="Période" className={`${inputClass} w-auto`}>
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
        </div>

        {loading && events === null && <p className="text-[12.5px] text-[var(--c-text-muted)]">Lecture du journal…</p>}
        {events !== null && shown.length === 0 && (
          <p className="text-[12.5px] text-[var(--c-text-muted)]">
            Aucun évènement pour ces filtres. Les opérations de flotte, les commandes et les enregistrements apparaissent ici au fil de l'eau.
          </p>
        )}

        {shown.length > 0 && (
          <div className="card overflow-hidden p-0">
            <table className="w-full table-fixed border-collapse text-[12.5px]" data-activity-table>
              <thead>
                <tr className="border-b border-[var(--c-border)] text-left text-[11.5px] text-[var(--c-text-muted)]">
                  <th className="w-[90px] px-3.5 py-2 font-medium">Heure</th>
                  <th className="w-[150px] px-3.5 py-2 font-medium">Type</th>
                  <th className="px-3.5 py-2 font-medium">Commande</th>
                  <th className="w-[180px] px-3.5 py-2 font-medium">Où</th>
                  <th className="w-[200px] px-3.5 py-2 font-medium">Résultat</th>
                </tr>
              </thead>
              {groups.map((group) => (
                <tbody key={group.day}>
                  <tr>
                    <td colSpan={5} className="bg-[var(--c-bg3)] px-3.5 py-1.5 text-[11.5px] font-medium text-[var(--c-text-muted)]">{group.day}</td>
                  </tr>
                  {group.events.map((event, i) => {
                    const Icon = KIND_ICON[event.kind];
                    return (
                      <tr
                        key={`${event.kind}-${event.atMs}-${i}`}
                        data-activity-row={event.kind}
                        className={`border-t border-[var(--c-border)] ${event.failed ? "bg-[color-mix(in_srgb,var(--c-danger)_8%,transparent)]" : ""}`}
                      >
                        <td className="px-3.5 py-2 font-mono text-[11.5px] tabular-nums text-[var(--c-text-muted)]">{formatActivityTime(event.atMs)}</td>
                        <td className="px-3.5 py-2">
                          <span className="flex items-center gap-1.5 text-[var(--c-text-secondary)]"><Icon size={13} /> {activityKindLabel(event.kind)}</span>
                        </td>
                        <td className={`truncate px-3.5 py-2 text-[var(--c-text)] ${event.kind === "recording" ? "" : "font-mono text-[12px]"}`} title={event.summary}>{event.summary}</td>
                        <td className="truncate px-3.5 py-2 text-[var(--c-text-secondary)]" title={event.target}>{event.target}</td>
                        <td className="truncate px-3.5 py-2" title={event.detail}>
                          {event.failed
                            ? <span className="chip chip-danger">{event.detail || "Échec"}</span>
                            : event.detail
                              ? <span className={event.kind === "fleetRun" ? "chip chip-ok" : "text-[var(--c-text-muted)]"}>{event.detail}</span>
                              : <span className="text-[var(--c-text-faint)]">—</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              ))}
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
