import { useMemo, useState } from "react";
import { api } from "../lib/api";
import type { FleetTarget, HostId, ReachabilityOutcome, Workspace } from "../lib/types";
import { fleetTargetKey } from "../lib/types";
import { DEFAULT_PROBE_PORT, describeVerdict, splitEndpoint } from "../lib/reachability";
import { IconClose } from "./ui-icons";

interface ReachabilityPanelProps {
  workspace: Workspace;
  /** The host this was opened from — pre-ticked, since "can *this* one reach
   * it" is the question that made the user open the panel. */
  initialSourceId: HostId | null;
  onClose: () => void;
}

const inputClass =
  "w-full rounded-md bg-[var(--c-bg3)] px-2 py-1.5 text-sm text-[var(--c-text)] focus:outline-none focus:ring-1 focus:ring-[var(--c-accent-hover)]";

const TONE_CLASS: Record<string, string> = {
  ok: "text-emerald-400",
  warn: "text-amber-400",
  bad: "text-rose-400",
  idle: "text-[var(--c-text-muted)]",
};

/**
 * « Est-ce que A atteint B:443 ? » — the question asked constantly during an
 * incident, and until now only answerable by opening a terminal and
 * remembering the syntax of `nc` or `/dev/tcp`.
 *
 * Several sources at once because that is what makes the answer conclusive:
 * one host failing is a host problem, all of them failing is a network
 * problem, and finding that out one terminal at a time is the slow part.
 */
export function ReachabilityPanel({ workspace, initialSourceId, onClose }: ReachabilityPanelProps) {
  const [endpoint, setEndpoint] = useState("");
  const [port, setPort] = useState(String(DEFAULT_PROBE_PORT));
  // Opened from a host: that host. Opened from the palette: this machine —
  // either way something is ticked, so the panel is never a form that refuses
  // to do anything until you find the checkbox.
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set([initialSourceId ? fleetTargetKey({ kind: "ssh", hostId: initialSourceId }) : "local"]),
  );
  const [outcomes, setOutcomes] = useState<ReachabilityOutcome[] | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** SSH hosts, plus this machine. Docker and K8s targets are reachable by the
   * backend too, but picking a live container or pod is a whole selector of
   * its own — that lives in `FleetTab`, and duplicating it here would be a
   * second place to keep correct. */
  const sources = useMemo(() => {
    const list: { key: string; label: string; sub: string; target: FleetTarget }[] = [
      { key: "local", label: "Cette machine", sub: "Guiterm lui-même", target: { kind: "local" } },
    ];
    for (const host of workspace.hosts) {
      if ((host.kind ?? "ssh") !== "ssh") continue;
      const target: FleetTarget = { kind: "ssh", hostId: host.id };
      list.push({ key: fleetTargetKey(target), label: host.label, sub: host.address, target });
    }
    return list;
  }, [workspace.hosts]);

  const toggle = (key: string) => {
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  /** Pasting `db-1:5432` fills both fields rather than failing validation on
   * the colon — that string is what gets copied out of a log or a config. */
  const onEndpointChange = (text: string) => {
    const { host, port: parsed } = splitEndpoint(text);
    if (parsed !== null) {
      setEndpoint(host);
      setPort(String(parsed));
      return;
    }
    setEndpoint(text);
  };

  const run = () => {
    const targets = sources.filter((s) => selected.has(s.key)).map((s) => s.target);
    const parsedPort = Number(port);
    if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
      setError("Indiquer un port entre 1 et 65535.");
      return;
    }
    setRunning(true);
    setError(null);
    setOutcomes(null);
    api.probeReachability(targets, endpoint.trim(), parsedPort)
      .then(setOutcomes)
      .catch((e) => setError(e.message ?? String(e)))
      .finally(() => setRunning(false));
  };

  const canRun = !running && endpoint.trim().length > 0 && selected.size > 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6" onClick={onClose}>
      <div
        className="flex max-h-full w-[min(40rem,100%)] flex-col overflow-hidden rounded-xl border border-[var(--c-border)] bg-[var(--c-bg2)] shadow-[var(--shadow-lg)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-[var(--c-border)] px-4 py-2.5">
          <div>
            <p className="text-[13px] font-medium text-[var(--c-text)]">Tester la joignabilité</p>
            <p className="text-[11px] text-[var(--c-text-muted)]">
              Depuis les hôtes choisis, vers une adresse et un port. Rien n'est installé sur eux.
            </p>
          </div>
          <button onClick={onClose} aria-label="Fermer" className="rounded p-1 text-[var(--c-text-muted)] hover:bg-white/5 hover:text-[var(--c-text)]">
            <IconClose size={13} />
          </button>
        </div>

        <div className="shrink-0 border-b border-[var(--c-border)] px-4 py-2.5">
          <div className="flex items-end gap-2">
            <label className="block flex-1 space-y-1">
              <span className="text-xs font-medium text-[var(--c-text-muted)]">Adresse à joindre</span>
              <input
                value={endpoint}
                onChange={(e) => onEndpointChange(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && canRun) run(); }}
                placeholder="db-1.internal ou 10.0.4.12"
                autoFocus
                className={`${inputClass} font-mono`}
              />
            </label>
            <label className="block w-24 space-y-1">
              <span className="text-xs font-medium text-[var(--c-text-muted)]">Port</span>
              <input
                value={port}
                onChange={(e) => setPort(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && canRun) run(); }}
                inputMode="numeric"
                className={`${inputClass} font-mono`}
              />
            </label>
            <button
              onClick={run}
              disabled={!canRun}
              className="accent-surface shrink-0 rounded-md border px-3 py-1.5 text-xs font-medium disabled:opacity-50"
            >
              {running ? "Test…" : "Tester"}
            </button>
          </div>
          {error && <p className="mt-1.5 text-[11px] text-rose-300">{error}</p>}
        </div>

        <div className="sidebar-scroll min-h-0 flex-1 overflow-y-auto px-4 py-2">
          <p className="mb-1 text-[11px] font-medium text-[var(--c-text-muted)]">
            Depuis ({selected.size})
          </p>
          <div className="space-y-0.5">
            {sources.map((source) => {
              const outcome = outcomes?.find((o) => fleetTargetKey(o.target) === source.key);
              const display = outcome ? describeVerdict(outcome.verdict) : null;
              return (
                <label key={source.key} className="flex items-start gap-2 rounded-md px-1 py-1 hover:bg-white/5">
                  <input
                    type="checkbox"
                    checked={selected.has(source.key)}
                    onChange={() => toggle(source.key)}
                    className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--c-accent)]"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] text-[var(--c-text)]">{source.label}</p>
                    {display ? (
                      <p className={`text-[11px] leading-relaxed ${TONE_CLASS[display.tone]}`}>
                        <span className="font-medium">{display.label}</span> — {display.detail}
                      </p>
                    ) : (
                      <p className="truncate font-mono text-[10px] text-[var(--c-text-muted)]">{source.sub}</p>
                    )}
                  </div>
                  {outcome && (
                    <span className="shrink-0 text-[10px] text-[var(--c-text-faint)]">
                      {Math.round(outcome.durationMs / 100) / 10}s
                    </span>
                  )}
                </label>
              );
            })}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2 border-t border-[var(--c-border)] px-4 py-2">
          <p className="text-[11px] leading-relaxed text-[var(--c-text-faint)]">
            « Refusé » veut dire que la machine a répondu non ; « Silence », que rien n'est revenu.
            Les deux causes n'ont rien à voir.
          </p>
        </div>
      </div>
    </div>
  );
}
