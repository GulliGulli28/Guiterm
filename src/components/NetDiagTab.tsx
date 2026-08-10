import { useEffect, useMemo, useRef, useState } from "react";
import { api, onNetdiagDone, onNetdiagOutcome } from "../lib/api";
import { describeVerdict, diagRowKey, diagToolKey, diagToolLabel } from "../lib/netdiag";
import { fleetTargetKey } from "../lib/types";
import type { DiagTool, DiagVerdict, HostId, Workspace } from "../lib/types";
import { useFleetTargets } from "../hooks/useFleetTargets";
import { IconPlay, IconSearch } from "./ui-icons";

interface NetDiagTabProps {
  workspace: Workspace;
  onError: (message: string) => void;
  /** Preselected source. A host when the tab was opened from its menu — that
   * entry has always meant "probe *from* this host" — and `null` from the
   * palette, which preselects this machine instead. */
  initialSourceId?: HostId | null;
}

const inputClass =
  "rounded-md bg-[var(--c-bg3)] px-2 py-1.5 text-sm text-[var(--c-text)] placeholder:text-[var(--c-text-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--c-accent-hover)]";

const TONE_CLASS: Record<string, string> = {
  ok: "bg-emerald-500/15 text-emerald-300",
  bad: "bg-rose-500/15 text-rose-300",
  unknown: "bg-amber-500/15 text-amber-200",
  muted: "bg-[var(--c-bg3)] text-[var(--c-text-muted)]",
};

/**
 * « Depuis ces machines, qu'est-ce qui répond ? »
 *
 * The generalisation of the reachability panel, which asked the same question
 * for one tool and has been absorbed here rather than kept alongside — two
 * implementations of a TCP connect is the shape of duplication this repo has
 * already paid for once.
 *
 * Results stream in as a grid of targets × tools. Each cell keeps the
 * distinction `core` works to preserve: a refusal is not a silence, an
 * unresolved name is not a network problem, and a missing tool is not a failed
 * test.
 */
export function NetDiagTab({ workspace, onError, initialSourceId }: NetDiagTabProps) {
  const { allTargets } = useFleetTargets(workspace);

  /** Which question is being asked. Both are needed in the same incident:
   * "je ne joins plus db-1" then "et depuis web-1, tu le joins ?" — and the
   * second direction needs no SSH connection, so it still answers about a host
   * that is itself the thing that has broken. */
  const [direction, setDirection] = useState<"from" | "to">("from");
  const [destination, setDestination] = useState("");
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<Set<string>>(
    // Something is always ticked on arrival: an empty selection would make the
    // run button refuse before the user has done anything wrong.
    () => new Set([initialSourceId ? fleetTargetKey({ kind: "ssh", hostId: initialSourceId }) : "local"]),
  );
  const [running, setRunning] = useState(false);

  // Which tools are on, and their parameters. TCP and HTTP carry a port, so
  // they are more than a checkbox.
  const [tcpOn, setTcpOn] = useState(true);
  const [tcpPort, setTcpPort] = useState("443");
  const [dnsOn, setDnsOn] = useState(true);
  const [httpOn, setHttpOn] = useState(false);
  const [httpSecure, setHttpSecure] = useState(true);
  const [httpPath, setHttpPath] = useState("");
  // Off by default, both of them: they need a privileged socket and are absent
  // from most container images, so a grid that switched them on would greet
  // people with a column of "outil absent".
  const [pingOn, setPingOn] = useState(false);
  const [tracerouteOn, setTracerouteOn] = useState(false);

  const [results, setResults] = useState<Map<string, { verdict: DiagVerdict; durationMs: number }>>(new Map());
  const [ranTools, setRanTools] = useState<DiagTool[]>([]);
  const [ranRows, setRanRows] = useState<{ key: string; label: string; sub: string }[]>([]);
  const runIdRef = useRef<string | null>(null);

  const tools = useMemo<DiagTool[]>(() => {
    const list: DiagTool[] = [];
    if (tcpOn) list.push({ kind: "tcp", port: Number(tcpPort) || 0 });
    if (dnsOn) list.push({ kind: "dns" });
    if (httpOn) list.push({ kind: "http", secure: httpSecure, port: null, path: httpPath.trim() });
    if (pingOn) list.push({ kind: "ping", count: 4 });
    if (tracerouteOn) list.push({ kind: "traceroute", maxHops: 15 });
    return list;
  }, [tcpOn, tcpPort, dnsOn, httpOn, httpSecure, httpPath, pingOn, tracerouteOn]);

  /** What can be ticked, which is not the same list in both directions: the
   * "toward" direction probes a saved host's address, and a Docker container
   * or the local machine has none. */
  const selectable = useMemo(
    () => (direction === "from" ? allTargets : allTargets.filter((t) => t.target.kind === "ssh")),
    [direction, allTargets],
  );

  // Subscribed for the tab's life rather than per run: the first cells come
  // back within milliseconds of a fast target, and a listener attached after
  // the call would miss them.
  useEffect(() => {
    const pending = onNetdiagOutcome((outcome) => {
      // A slow target from a replaced run would otherwise land in the new grid.
      if (outcome.runId !== runIdRef.current) return;
      setResults((prev) => {
        const next = new Map(prev);
        next.set(`${diagRowKey(outcome.row)}|${diagToolKey(outcome.tool)}`, {
          verdict: outcome.verdict,
          durationMs: outcome.durationMs,
        });
        return next;
      });
    });
    return () => { pending.then((un) => un()).catch(() => {}); };
  }, []);

  useEffect(() => {
    const pending = onNetdiagDone((runId) => {
      if (runId === runIdRef.current) setRunning(false);
    });
    return () => { pending.then((un) => un()).catch(() => {}); };
  }, []);

  const shown = useMemo(() => {
    const terms = filter.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return selectable;
    return selectable.filter((t) => {
      const haystack = `${t.label} ${t.sub}`.toLowerCase();
      return terms.every((term) => haystack.includes(term));
    });
  }, [selectable, filter]);

  const toggle = (key: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const run = () => {
    const picked = selectable.filter((t) => selected.has(t.key));
    if (picked.length === 0) {
      onError(direction === "from"
        ? "Choisir au moins un hôte depuis lequel diagnostiquer."
        : "Choisir au moins un hôte à diagnostiquer.");
      return;
    }
    if (tools.length === 0) {
      onError("Choisir au moins un diagnostic.");
      return;
    }
    if (direction === "from" && !destination.trim()) {
      onError("Indiquer l'adresse à joindre.");
      return;
    }

    const runId = crypto.randomUUID();
    runIdRef.current = runId;
    setResults(new Map());
    setRanTools(tools);
    setRunning(true);

    if (direction === "from") {
      setRanRows(picked.map((t) => ({
        key: `from:${fleetTargetKey(t.target)}`,
        label: t.label,
        sub: t.sub,
      })));
      api.runNetdiag(runId, picked.map((t) => t.target), destination.trim(), tools)
        .catch((e) => { setRunning(false); onError(String(e)); });
      return;
    }

    // Only SSH targets survive `selectable` here, so the cast is the shape the
    // filter already guarantees rather than an assumption.
    const hostIds = picked
      .map((t) => (t.target.kind === "ssh" ? t.target.hostId : null))
      .filter((id): id is HostId => id !== null);
    setRanRows(picked.map((t) => ({
      key: `to:${t.target.kind === "ssh" ? t.target.hostId : ""}`,
      label: t.label,
      sub: t.sub,
    })));
    api.runNetdiagToHosts(runId, hostIds, tools)
      .catch((e) => { setRunning(false); onError(String(e)); });
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--c-bg)]">
      <div className="shrink-0 space-y-2 border-b border-[var(--c-border)] px-4 py-3">
        <div className="flex items-center gap-2">
          <h2 className="text-[15px] font-semibold text-[var(--c-text)]">Diagnostic réseau</h2>
          <div className="flex overflow-hidden rounded-md border border-[var(--c-border)] text-[11px]">
            {(["from", "to"] as const).map((value) => (
              <button
                key={value}
                onClick={() => { setDirection(value); setSelected(new Set()); setRanRows([]); }}
                className={`px-2.5 py-1 transition-colors ${
                  direction === value
                    ? "accent-surface"
                    : "text-[var(--c-text-muted)] hover:bg-[var(--c-bg3)]"
                }`}
              >
                {value === "from" ? "Depuis les hôtes" : "Vers les hôtes"}
              </button>
            ))}
          </div>
          <span className="text-[11px] text-[var(--c-text-muted)]">
            {direction === "from"
              ? "Chaque machine répond pour elle-même."
              : "Depuis cette machine — aucune connexion SSH, donc répond même sur un hôte en panne."}
          </span>
        </div>

        {direction === "from" && (
          <input
            value={destination}
            onChange={(e) => setDestination(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !running) run(); }}
            placeholder="Adresse à joindre — api.example.com, 10.0.0.5…"
            className={`${inputClass} w-full font-mono`}
          />
        )}

        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-1.5 text-[11px] text-[var(--c-text-secondary)]">
            <input type="checkbox" checked={tcpOn} onChange={(e) => setTcpOn(e.target.checked)} className="accent-[var(--c-accent)]" />
            TCP
            <input
              value={tcpPort}
              onChange={(e) => setTcpPort(e.target.value.replace(/\D/g, ""))}
              disabled={!tcpOn}
              className={`${inputClass} w-16 py-0.5 text-center font-mono text-[11px] disabled:opacity-40`}
            />
          </label>

          <label className="flex items-center gap-1.5 text-[11px] text-[var(--c-text-secondary)]">
            <input type="checkbox" checked={dnsOn} onChange={(e) => setDnsOn(e.target.checked)} className="accent-[var(--c-accent)]" />
            DNS
          </label>

          <label className="flex items-center gap-1.5 text-[11px] text-[var(--c-text-secondary)]">
            <input type="checkbox" checked={httpOn} onChange={(e) => setHttpOn(e.target.checked)} className="accent-[var(--c-accent)]" />
            HTTP
            <select
              value={httpSecure ? "https" : "http"}
              onChange={(e) => setHttpSecure(e.target.value === "https")}
              disabled={!httpOn}
              className={`${inputClass} py-0.5 text-[11px] disabled:opacity-40`}
            >
              <option value="https">https</option>
              <option value="http">http</option>
            </select>
            <input
              value={httpPath}
              onChange={(e) => setHttpPath(e.target.value)}
              disabled={!httpOn}
              placeholder="/"
              className={`${inputClass} w-28 py-0.5 font-mono text-[11px] disabled:opacity-40`}
            />
          </label>

          <label className="flex items-center gap-1.5 text-[11px] text-[var(--c-text-secondary)]">
            <input type="checkbox" checked={pingOn} onChange={(e) => setPingOn(e.target.checked)} className="accent-[var(--c-accent)]" />
            <span title="Souvent indisponible : ICMP demande des privilèges, et beaucoup d'images conteneur n'embarquent pas ping.">
              Ping
            </span>
          </label>

          <label className="flex items-center gap-1.5 text-[11px] text-[var(--c-text-secondary)]">
            <input type="checkbox" checked={tracerouteOn} onChange={(e) => setTracerouteOn(e.target.checked)} className="accent-[var(--c-accent)]" />
            <span title="Lent (jusqu'à une minute) et rarement installé. Les résultats arrivent au fil de l'eau.">
              Traceroute
            </span>
          </label>

          <button
            onClick={run}
            disabled={running || (direction === "from" && !destination.trim())}
            className="accent-surface ml-auto flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium disabled:opacity-40"
          >
            <IconPlay size={12} />
            {running ? "Diagnostic…" : `Lancer sur ${selected.size} hôte(s)`}
          </button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* Sources */}
        <div className="flex w-64 shrink-0 flex-col border-r border-[var(--c-border)]">
          <div className="shrink-0 border-b border-[var(--c-border)] p-2">
            <div className="relative">
              <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[var(--c-text-faint)]">
                <IconSearch size={12} />
              </span>
              <input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Filtrer les hôtes…"
                className={`${inputClass} w-full pl-7 text-[12px]`}
              />
            </div>
            <div className="mt-1.5 flex gap-2">
              <button
                onClick={() => setSelected(new Set(shown.map((t) => t.key)))}
                className="text-[10px] text-[var(--c-accent-text)] hover:underline"
              >
                Tout ({shown.length})
              </button>
              <button
                onClick={() => setSelected(new Set())}
                className="text-[10px] text-[var(--c-text-muted)] hover:underline"
              >
                Aucun
              </button>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-1">
            {shown.map((t) => (
              <label
                key={t.key}
                className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 hover:bg-[var(--c-bg3)]"
              >
                <input
                  type="checkbox"
                  checked={selected.has(t.key)}
                  onChange={() => toggle(t.key)}
                  className="accent-[var(--c-accent)]"
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[12px] text-[var(--c-text)]">{t.label}</div>
                  {t.sub && <div className="truncate text-[10px] text-[var(--c-text-muted)]">{t.sub}</div>}
                </div>
              </label>
            ))}
          </div>
        </div>

        {/* Grid */}
        <div className="min-h-0 flex-1 overflow-auto p-3">
          {ranRows.length === 0 ? (
            <p className="py-8 text-center text-xs text-[var(--c-text-faint)]">
              {direction === "from"
                ? "Choisissez une adresse, les diagnostics à faire et les machines depuis lesquelles les faire. Chaque machine répond pour elle-même — c'est ce qui distingue « le service est tombé » de « ce réseau-là ne l'atteint pas »."
                : "Choisissez les hôtes à diagnostiquer depuis cette machine. Aucune connexion SSH n'est ouverte, donc la réponse arrive même quand c'est l'hôte lui-même qui ne va pas."}
            </p>
          ) : (
            <table className="w-full border-collapse text-[12px]">
              <thead>
                <tr className="text-left text-[10px] uppercase tracking-wide text-[var(--c-text-faint)]">
                  <th className="px-2 py-1 font-semibold">{direction === "from" ? "Depuis" : "Hôte"}</th>
                  {ranTools.map((tool) => (
                    <th key={diagToolKey(tool)} className="px-2 py-1 font-semibold">{diagToolLabel(tool)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {ranRows.map((info) => (
                  <tr key={info.key} className="border-t border-[var(--c-border)]">
                    <td className="px-2 py-1.5">
                      <div className="truncate text-[var(--c-text)]">{info.label}</div>
                      {info.sub && <div className="truncate text-[10px] text-[var(--c-text-muted)]">{info.sub}</div>}
                    </td>
                    {ranTools.map((tool) => {
                      const cell = results.get(`${info.key}|${diagToolKey(tool)}`);
                      if (!cell) {
                        return (
                          <td key={diagToolKey(tool)} className="px-2 py-1.5 text-[var(--c-text-faint)]">
                            {running ? "…" : "—"}
                          </td>
                        );
                      }
                      const described = describeVerdict(cell.verdict);
                      return (
                        <td key={diagToolKey(tool)} className="px-2 py-1.5">
                          <span
                            title={described.detail}
                            className={`inline-block rounded px-1.5 py-0.5 ${TONE_CLASS[described.tone]}`}
                          >
                            {described.label}
                          </span>
                          <span className="ml-1.5 text-[10px] text-[var(--c-text-faint)]">{cell.durationMs} ms</span>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
