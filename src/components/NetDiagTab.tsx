import { useEffect, useMemo, useRef, useState } from "react";
import { api, onNetdiagDone, onNetdiagOutcome } from "../lib/api";
import { describeVerdict, diagRowKey, diagToolKey, diagToolLabel } from "../lib/netdiag";
import { fleetTargetKey } from "../lib/types";
import type { DiagTool, DiagVerdict, HostId } from "../lib/types";
import { useNetDiagSelection } from "../hooks/useNetDiagSelection";
import { IconPlay } from "./ui-icons";

interface NetDiagTabProps {
  onError: (message: string) => void;
  /** Preselected source. A host when the tab was opened from its menu — that
   * entry has always meant "probe *from* this host" — and `null` from the
   * palette, which preselects this machine instead. */
  initialSourceId?: HostId | null;
  /** Ramène la barre latérale sur le panneau de sélection — ce que fait le
   * récapitulatif de cibles quand elle affiche autre chose. */
  onShowTargets: () => void;
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
export function NetDiagTab({ onError, initialSourceId, onShowTargets }: NetDiagTabProps) {
  // Le choix des machines vit dans la barre latérale (`NetDiagTargetsPanel`),
  // donc dans un magasin partagé plutôt que dans cet onglet.
  const { direction, setDirection, selected, selectable, seedSource } = useNetDiagSelection();

  const [destination, setDestination] = useState("");
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

  const [results, setResults] = useState<Map<string, { verdict: DiagVerdict; durationMs: number; raw: string }>>(new Map());
  /** Cells whose raw output is unfolded, by `row|tool` key. */
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [ranTools, setRanTools] = useState<DiagTool[]>([]);
  const [ranRows, setRanRows] = useState<{ key: string; label: string; sub: string }[]>([]);
  const runIdRef = useRef<string | null>(null);

  const tools = useMemo<DiagTool[]>(() => {
    const list: DiagTool[] = [];
    if (tcpOn) list.push({ kind: "tcp", port: Number(tcpPort) || 0 });
    if (dnsOn) list.push({ kind: "dns" });
    if (httpOn) list.push({ kind: "http", secure: httpSecure, port: null, path: httpPath.trim() });
    if (pingOn) list.push({ kind: "ping", count: 4 });
    // 30 hops, the traditional default. 15 was too short for anything on the
    // public internet — a trace would stop before arriving and read as a
    // failure, which is exactly the confusion this tab exists to remove.
    if (tracerouteOn) list.push({ kind: "traceroute", maxHops: 30 });
    return list;
  }, [tcpOn, tcpPort, dnsOn, httpOn, httpSecure, httpPath, pingOn, tracerouteOn]);

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
          raw: outcome.raw,
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

  // La sélection ne vit plus dans cet onglet, donc son remontage ne la remet
  // plus d'elle-même sur l'hôte visé. Ce composant est monté avec
  // `key={tab.sourceHostId ?? "local"}` (voir `modules/netdiag`) : viser
  // l'onglet depuis le menu d'un autre hôte le remonte, et c'est *ici* que la
  // source repart de cet hôte-là. Sans cet effet, on hériterait silencieusement
  // de la source de l'incident précédent.
  useEffect(() => {
    seedSource(initialSourceId ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    setExpanded(new Set());
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
                // `setDirection` vide la sélection lui-même (les deux sens ne
                // cochent pas la même liste) ; la grille déjà affichée part
                // ici, elle répondait à l'autre question.
                onClick={() => { setDirection(value); setRanRows([]); }}
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

          {/* Le récapitulatif remplace la colonne de sélection : elle est
              maintenant dans la barre latérale, qui peut afficher autre chose.
              Sans lui, on lancerait un diagnostic sans avoir sous les yeux sur
              quoi. Cliquer ramène la barre sur le panneau de cibles. */}
          <button
            onClick={onShowTargets}
            title="Choisir les machines — ouvre le panneau « Diagnostic réseau » dans la barre latérale"
            className="ml-auto rounded-md border border-[var(--c-border)] bg-[var(--c-bg2)] px-2.5 py-1.5 text-[11px] text-[var(--c-text-secondary)] hover:bg-[var(--c-bg3)]"
          >
            {selected.size === 0
              ? "Aucune machine choisie"
              : `${selected.size} machine${selected.size > 1 ? "s" : ""} · modifier`}
          </button>

          <button
            onClick={run}
            disabled={running || (direction === "from" && !destination.trim())}
            className="accent-surface flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium disabled:opacity-40"
          >
            <IconPlay size={12} />
            {running ? "Diagnostic…" : `Lancer sur ${selected.size} hôte(s)`}
          </button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
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
                      const cellKey = `${info.key}|${diagToolKey(tool)}`;
                      const isOpen = expanded.has(cellKey);
                      return (
                        <td key={diagToolKey(tool)} className="align-top px-2 py-1.5">
                          <button
                            onClick={() => setExpanded((prev) => {
                              const next = new Set(prev);
                              if (next.has(cellKey)) next.delete(cellKey);
                              else next.add(cellKey);
                              return next;
                            })}
                            // The verdict is a summary; the tool's own output
                            // is what someone reads line by line — a hop list,
                            // above all. Disabled rather than hidden when
                            // there is nothing to show, so the affordance is
                            // consistent across the grid.
                            disabled={!cell.raw}
                            title={cell.raw ? `${described.detail}\n\n(cliquer pour la sortie complète)` : described.detail}
                            className={`inline-block rounded px-1.5 py-0.5 text-left ${TONE_CLASS[described.tone]} ${
                              cell.raw ? "cursor-pointer hover:brightness-125" : "cursor-default"
                            }`}
                          >
                            {described.label}
                          </button>
                          <span className="ml-1.5 text-[10px] text-[var(--c-text-faint)]">{cell.durationMs} ms</span>
                          {isOpen && cell.raw && (
                            <pre className="mt-1 max-h-64 max-w-[32rem] overflow-auto whitespace-pre rounded bg-[var(--c-bg)] p-2 font-mono text-[10px] leading-relaxed text-[var(--c-text-secondary)]">
                              {cell.raw}
                            </pre>
                          )}
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
