import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { ExecutionGroup, FleetOutcome, FleetRun, Host, HostId, Snippet, SnippetId, Workspace } from "../lib/types";
import { api, onFleetDone, onFleetOutcome } from "../lib/api";
import { formatRelativeTime } from "../lib/format";
import { ramColor } from "../lib/facts";
import { DSL_CONDITION_FIELDS, DSL_FUNCTIONS } from "../lib/operations";
import { SnippetPicker } from "./SnippetPicker";
import { IconPlay, IconSearch, IconChevronRight, IconChevronDown, IconRefresh, IconSnippets, IconFlash } from "./ui-icons";

function formatTimestamp(ms: number): string {
  return new Date(ms).toLocaleString();
}

interface FleetTabProps {
  workspace: Workspace;
  onError: (message: string) => void;
  /** Called with the fresh workspace after a facts collection persists
   * `lastFacts` onto each host, so the rest of the app (host list badges,
   * etc.) picks it up too. */
  onWorkspaceUpdate?: (ws: Workspace) => void;
}

/** One fact-based selection criterion. `enabled` gates whether `selectByFacts`
 * checks it at all — lets several criteria combine (AND) without every
 * numeric field needing an explicit "off" sentinel value. */
interface FactFilters {
  ram: { enabled: boolean; value: number }; // RAM used % > value
  cpu: { enabled: boolean; value: number }; // CPU count >= value
  load1: { enabled: boolean; value: number }; // 1-min load average > value
  uptimeDays: { enabled: boolean; value: number }; // uptime < value days
  os: { enabled: boolean; value: string }; // OS name/id contains value
}

const DEFAULT_FILTERS: FactFilters = {
  ram: { enabled: false, value: 80 },
  cpu: { enabled: false, value: 2 },
  load1: { enabled: false, value: 1 },
  uptimeDays: { enabled: false, value: 7 },
  os: { enabled: false, value: "" },
};

type RowStatus = "pending" | "ok" | "fail" | "error";

function outcomeStatus(o: FleetOutcome): RowStatus {
  if (o.error != null) return "error";
  return o.exitCode === 0 ? "ok" : "fail";
}

function statusOf(hostId: HostId, results: Map<HostId, FleetOutcome>, pending: Set<HostId>): RowStatus {
  if (pending.has(hostId)) return "pending";
  const o = results.get(hostId);
  if (!o) return "pending";
  return outcomeStatus(o);
}

function countOutcomes(outcomes: FleetOutcome[]): { ok: number; fail: number } {
  let ok = 0;
  let fail = 0;
  for (const o of outcomes) (outcomeStatus(o) === "ok" ? ok++ : fail++);
  return { ok, fail };
}

function StatusDot({ status }: { status: RowStatus }) {
  if (status === "pending") {
    return <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-[var(--c-text-faint)] border-t-transparent" />;
  }
  const color = status === "ok" ? "#22c55e" : "#ef4444";
  return <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: color }} />;
}

export function FleetTab({ workspace, onError, onWorkspaceUpdate }: FleetTabProps) {
  const sshHosts = useMemo(() => workspace.hosts.filter((h) => h.kind === "ssh"), [workspace.hosts]);
  const hostById = useMemo(() => new Map(workspace.hosts.map((h) => [h.id, h])), [workspace.hosts]);
  const groupName = (h: Host) => (h.groupId ? workspace.groups.find((g) => g.id === h.groupId)?.name ?? "" : "");

  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<Set<HostId>>(new Set());
  const [command, setCommand] = useState("");
  const [running, setRunning] = useState(false);

  // Results of the current / last run, keyed by host, plus the ordered target
  // list so rows keep a stable order as outcomes stream in out of order.
  const [runTargets, setRunTargets] = useState<HostId[]>([]);
  const [results, setResults] = useState<Map<HostId, FleetOutcome>>(new Map());
  const [pending, setPending] = useState<Set<HostId>>(new Set());
  const [expanded, setExpanded] = useState<Set<HostId>>(new Set());
  const runIdRef = useRef<string | null>(null);

  // Collected host state ("facts") lives on the host itself (`lastFacts`,
  // persisted server-side by `collect_facts`) — no separate local copy to
  // keep in sync.
  const [collectingFacts, setCollectingFacts] = useState(false);
  const [filters, setFilters] = useState<FactFilters>(DEFAULT_FILTERS);
  const hasFacts = sshHosts.some((h) => h.lastFacts != null);
  const [showSnippetPicker, setShowSnippetPicker] = useState(false);

  // Adaptive snippet engine: "Langage" mode edits a small DSL program (see
  // src/lib/operations.ts for the syntax) — written by hand, by the AI from
  // an English instruction, or both; the AI is only an optional assist
  // (aiIntent/generateWithAi), never required. Evaluating the program against
  // the target hosts is always deterministic and free, both for the live
  // target selection below and for the explicit "Prévisualiser"
  // (runPreview) step before running; only *writing*/extending the text via
  // AI (generateWithAi) costs a call.
  const [mode, setMode] = useState<"command" | "intent">("command");
  const [programText, setProgramText] = useState("");
  const [aiIntent, setAiIntent] = useState("");
  const [activeSnippetId, setActiveSnippetId] = useState<SnippetId | null>(null);
  const [generatingAi, setGeneratingAi] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [previewGroups, setPreviewGroups] = useState<ExecutionGroup[] | null>(null);
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const [saveSnippetName, setSaveSnippetName] = useState("");

  // Persisted run history (audit trail) + which panel is shown on the right.
  const [view, setView] = useState<"run" | "history">("run");
  const [history, setHistory] = useState<FleetRun[]>([]);
  const [expandedRuns, setExpandedRuns] = useState<Set<string>>(new Set());

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return sshHosts;
    return sshHosts.filter(
      (h) =>
        h.label.toLowerCase().includes(q) ||
        h.address.toLowerCase().includes(q) ||
        h.tags.some((t) => t.toLowerCase().includes(q)) ||
        groupName(h).toLowerCase().includes(q),
    );
    // groupName is derived from workspace.groups, included via sshHosts identity
  }, [sshHosts, filter, workspace.groups]);

  // One subscription for the tab's lifetime; events are matched to the active
  // run by id so a stale run's late outcomes are ignored.
  useEffect(() => {
    let disposed = false;
    let offOutcome: (() => void) | undefined;
    let offDone: (() => void) | undefined;
    onFleetOutcome((runId, outcome) => {
      if (runId !== runIdRef.current) return;
      setResults((prev) => new Map(prev).set(outcome.hostId, outcome));
      setPending((prev) => {
        const next = new Set(prev);
        next.delete(outcome.hostId);
        return next;
      });
    }).then((fn) => (disposed ? fn() : (offOutcome = fn)));
    onFleetDone((runId) => {
      if (runId !== runIdRef.current) return;
      setRunning(false);
      // The completed run was just persisted server-side — pull it in.
      api.getFleetHistory().then(setHistory).catch(() => {});
    }).then((fn) => (disposed ? fn() : (offDone = fn)));
    return () => {
      disposed = true;
      offOutcome?.();
      offDone?.();
    };
  }, []);

  // Load the persisted history once on mount.
  useEffect(() => {
    api.getFleetHistory().then(setHistory).catch(() => {});
  }, []);

  // Live target selection while editing the DSL program ("Langage" mode):
  // debounced re-evaluation of the program against every SSH host's cached
  // facts, checking exactly the hosts that would run something — replaces
  // manual checkbox selection in this mode (see the aside below), reusing
  // the same deterministic evaluator `runPreview`/`runPlan` already call.
  // No I/O: it only reads facts already cached on each host, never re-probes
  // over SSH — cheap enough to re-run on every keystroke.
  useEffect(() => {
    if (mode !== "intent") return;
    const text = programText.trim();
    if (!text) { setSelected(new Set()); return; }
    const timer = setTimeout(() => {
      api
        .previewAdaptiveProgram(sshHosts.map((h) => h.id), text)
        .then((groups) => {
          const ids = groups.filter((g) => g.command != null).flatMap((g) => g.hostIds);
          setSelected(new Set(ids));
        })
        .catch(() => {}); // invalid/incomplete program mid-edit — ignore, keep the last selection
    }, 350);
    return () => clearTimeout(timer);
  }, [mode, programText, sshHosts]);

  const toggle = (id: HostId) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const selectAll = () => setSelected(new Set(filtered.map((h) => h.id)));
  const selectNone = () => setSelected(new Set());

  const collectFacts = async (hostIds?: HostId[]) => {
    if (collectingFacts) return;
    const ids = hostIds ?? sshHosts.map((h) => h.id);
    if (ids.length === 0) return;
    setCollectingFacts(true);
    try {
      const { outcomes, workspace: updated } = await api.collectFacts(ids);
      onWorkspaceUpdate?.(updated);
      const failed = outcomes.filter((o) => o.error != null);
      if (failed.length > 0) {
        const names = failed.map((o) => hostById.get(o.hostId)?.label ?? o.hostId).join(", ");
        onError(`${failed.length} hôte(s) n'ont pas répondu à la sonde d'état : ${names}`);
      }
    } catch (e) {
      onError(String(e));
    } finally {
      setCollectingFacts(false);
    }
  };

  const anyFilterEnabled = filters.ram.enabled || filters.cpu.enabled || filters.load1.enabled || filters.uptimeDays.enabled || filters.os.enabled;

  // Selects every host whose last collected facts satisfy *all* enabled
  // filters (AND) — a disabled filter is simply skipped, not treated as
  // "match anything".
  const selectByFacts = () => {
    if (!anyFilterEnabled) {
      onError("Coche au moins un critère avant de sélectionner");
      return;
    }
    const ids = sshHosts
      .filter((h) => {
        const f = h.lastFacts;
        if (!f) return false;
        if (filters.ram.enabled && !(f.memUsedPct != null && f.memUsedPct > filters.ram.value)) return false;
        if (filters.cpu.enabled && !(f.cpus != null && f.cpus >= filters.cpu.value)) return false;
        if (filters.load1.enabled && !(f.load1 != null && f.load1 > filters.load1.value)) return false;
        if (filters.uptimeDays.enabled) {
          const days = f.uptimeSecs != null ? f.uptimeSecs / 86400 : null;
          if (!(days != null && days < filters.uptimeDays.value)) return false;
        }
        if (filters.os.enabled) {
          const q = filters.os.value.trim().toLowerCase();
          if (!q) return false;
          const hay = `${f.osName ?? ""} ${f.osId ?? ""}`.toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      })
      .map((h) => h.id);
    setSelected(new Set(ids));
  };
  const toggleExpanded = (id: HostId) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleRun = (id: string) =>
    setExpandedRuns((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // Re-run a past run: load its command + re-select the targets that still
  // exist, and switch back to the composer so the user reviews before running.
  const loadRun = (run: FleetRun) => {
    setCommand(run.command);
    setSelected(new Set(run.hostIds.filter((id) => hostById.has(id))));
    setView("run");
  };

  const run = async () => {
    if (running) return;
    const targets = [...selected];
    if (targets.length === 0) {
      onError("Sélectionne au moins un hôte");
      return;
    }
    if (!command.trim()) {
      onError("Saisis une commande à exécuter");
      return;
    }
    const runId = crypto.randomUUID();
    runIdRef.current = runId;
    setRunTargets(targets);
    setResults(new Map());
    setPending(new Set(targets));
    setExpanded(new Set());
    setRunning(true);
    try {
      await api.runFleetCommand(runId, targets, command);
    } catch (e) {
      onError(String(e));
    } finally {
      if (runIdRef.current === runId) setRunning(false);
    }
  };

  // Asks the AI to write (or extend) the DSL program from a short English
  // instruction — never runs anything, never touches the target hosts.
  const generateWithAi = async () => {
    if (generatingAi) return;
    if (!aiIntent.trim()) {
      onError("Décris ce que tu veux faire");
      return;
    }
    setGeneratingAi(true);
    try {
      const result = await api.generateAdaptiveProgram(programText, aiIntent.trim());
      setProgramText(result);
      setPreviewGroups(null);
    } catch (e) {
      onError(String(e));
    } finally {
      setGeneratingAi(false);
    }
  };

  // Parses + evaluates the current program text against the selected hosts
  // — pure and deterministic, no AI involved. Facts are collected first for
  // any target still missing them, since evaluation depends on `lastFacts`.
  const runPreview = async () => {
    if (previewing) return;
    const targets = [...selected];
    if (targets.length === 0) {
      onError("Sélectionne au moins un hôte");
      return;
    }
    if (!programText.trim()) {
      onError("Écris ou génère un programme d'abord");
      return;
    }
    setPreviewing(true);
    try {
      if (targets.some((id) => !hostById.get(id)?.lastFacts)) {
        await collectFacts(targets);
      }
      const groups = await api.previewAdaptiveProgram(targets, programText);
      setPreviewGroups(groups);
    } catch (e) {
      onError(String(e));
    } finally {
      setPreviewing(false);
    }
  };

  const updateGroupCommand = (index: number, newCommand: string) =>
    setPreviewGroups((prev) => prev?.map((g, i) => (i === index ? { ...g, command: newCommand } : g)) ?? null);

  // Executes the (possibly hand-edited) preview — reuses the same
  // runTargets/results/pending state and fleet-run-* events as a classic
  // run, so the Résultats tab renders it identically. Groups without a
  // command (nothing matched, or unsupported for that platform) are simply
  // excluded — nothing to run there.
  const runPlan = async () => {
    if (!previewGroups || running) return;
    const runnable = previewGroups.filter((g): g is typeof g & { command: string } => g.command != null);
    if (runnable.length === 0) return;
    const targets = runnable.flatMap((g) => g.hostIds);
    const runId = crypto.randomUUID();
    runIdRef.current = runId;
    setRunTargets(targets);
    setResults(new Map());
    setPending(new Set(targets));
    setExpanded(new Set());
    setRunning(true);
    try {
      await api.runAdaptivePlan(
        runId,
        programText.trim(),
        runnable.map((g) => ({ hostIds: g.hostIds, command: g.command })),
      );
    } catch (e) {
      onError(String(e));
    } finally {
      if (runIdRef.current === runId) setRunning(false);
    }
    setPreviewGroups(null);
  };

  const openSaveDialog = () => {
    const existing = activeSnippetId ? workspace.snippets.find((s) => s.id === activeSnippetId) : null;
    setSaveSnippetName(existing?.name ?? "");
    setShowSaveDialog(true);
  };

  const confirmSaveSnippet = async () => {
    if (!programText.trim() || !saveSnippetName.trim()) return;
    try {
      const ws = await api.saveAdaptiveSnippet(activeSnippetId, saveSnippetName.trim(), programText);
      onWorkspaceUpdate?.(ws);
      setShowSaveDialog(false);
    } catch (e) {
      onError(String(e));
    }
  };

  // Picking an adaptive snippet switches into Langage mode with its DSL
  // program text pre-filled (which in turn live-selects matching hosts, see
  // above) and its id tracked (so "Sauvegarder" defaults to updating it). A
  // classic snippet keeps filling the plain command box (handled by the
  // existing onRun={setCommand} below).
  const handleSnippetResolved = (snippet: Snippet, resolvedText: string) => {
    if (!snippet.adaptive) return;
    setMode("intent");
    setProgramText(resolvedText);
    setActiveSnippetId(snippet.id);
    setPreviewGroups(null);
  };

  const summary = useMemo(() => {
    let ok = 0;
    let fail = 0;
    for (const id of runTargets) {
      const s = statusOf(id, results, pending);
      if (s === "ok") ok++;
      else if (s === "fail" || s === "error") fail++;
    }
    return { ok, fail, pending: pending.size, total: runTargets.length };
  }, [runTargets, results, pending]);

  return (
    <div className="flex h-full min-h-0 bg-[var(--c-bg)] text-[var(--c-text)]">
      {/* ── Target picker ─────────────────────────────────────────────── */}
      <aside className="flex w-72 shrink-0 flex-col border-r border-[var(--c-border)]">
        <div className="flex items-center justify-between px-3 py-2.5">
          <span className="text-xs font-semibold uppercase tracking-wide text-[var(--c-text-secondary)]">
            Cibles · {selected.size}/{sshHosts.length}
          </span>
          {mode === "command" ? (
            <div className="flex gap-1 text-[11px]">
              <button onClick={selectAll} className="rounded px-1.5 py-0.5 text-[var(--c-accent-text)] hover:bg-[var(--c-bg3)]">
                Tout
              </button>
              <button onClick={selectNone} className="rounded px-1.5 py-0.5 text-[var(--c-text-muted)] hover:bg-[var(--c-bg3)]">
                Aucun
              </button>
            </div>
          ) : (
            <span
              title="Calculée automatiquement d'après les « target … » du programme — repasse en mode Commande pour sélectionner à la main"
              className="rounded bg-[var(--c-accent-dim)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--c-accent-text)]"
            >
              auto
            </span>
          )}
        </div>
        <div className="px-3 pb-2">
          <div className="flex items-center gap-2 rounded-md border border-[var(--c-border)] bg-[var(--c-bg2)] px-2 py-1.5">
            <IconSearch size={13} className="text-[var(--c-text-faint)]" />
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filtrer (nom, tag, groupe…)"
              className="w-full bg-transparent text-xs text-[var(--c-text)] placeholder:text-[var(--c-text-faint)] focus:outline-none"
            />
          </div>
        </div>
        {sshHosts.length > 0 && (
          <div className="mb-1 space-y-1.5 px-3 pb-1">
            <button
              onClick={() => collectFacts()}
              disabled={collectingFacts}
              className="flex w-full items-center justify-center gap-1.5 rounded-md border border-[var(--c-border)] bg-[var(--c-bg2)] px-2 py-1.5 text-xs text-[var(--c-text-secondary)] hover:bg-[var(--c-bg3)] disabled:opacity-50"
            >
              <IconRefresh size={12} className={collectingFacts ? "animate-spin" : ""} />
              {collectingFacts ? "Collecte de l'état…" : "Collecter l'état (OS, RAM)"}
            </button>
            {mode === "intent" && (
              <p className="rounded-md border border-[var(--c-border)] bg-[var(--c-bg2)] px-2 py-1.5 text-[11px] text-[var(--c-text-faint)]">
                Ciblage automatique : les cases ci-dessous reflètent les hôtes dont l'état collecté correspond aux <code className="font-mono">target …</code> du programme.
              </p>
            )}
            {mode === "command" && hasFacts && (
              <div className="space-y-1 rounded-md border border-[var(--c-border)] bg-[var(--c-bg2)] p-1.5 text-[11px] text-[var(--c-text-muted)]">
                <label className="flex items-center gap-1.5">
                  <input type="checkbox" checked={filters.ram.enabled} onChange={(e) => setFilters((p) => ({ ...p, ram: { ...p.ram, enabled: e.target.checked } }))} className="accent-[var(--c-accent)]" />
                  <span className="shrink-0">RAM utilisée &gt;</span>
                  <input
                    type="number" min={0} max={100} value={filters.ram.value}
                    onChange={(e) => setFilters((p) => ({ ...p, ram: { ...p.ram, value: Number(e.target.value) } }))}
                    className="w-12 rounded border border-[var(--c-border)] bg-[var(--c-bg3)] px-1 py-0.5 text-center text-[var(--c-text)] focus:border-[var(--c-accent)] focus:outline-none"
                  />
                  <span>%</span>
                </label>
                <label className="flex items-center gap-1.5">
                  <input type="checkbox" checked={filters.cpu.enabled} onChange={(e) => setFilters((p) => ({ ...p, cpu: { ...p.cpu, enabled: e.target.checked } }))} className="accent-[var(--c-accent)]" />
                  <span className="shrink-0">CPU ≥</span>
                  <input
                    type="number" min={1} value={filters.cpu.value}
                    onChange={(e) => setFilters((p) => ({ ...p, cpu: { ...p.cpu, value: Number(e.target.value) } }))}
                    className="w-12 rounded border border-[var(--c-border)] bg-[var(--c-bg3)] px-1 py-0.5 text-center text-[var(--c-text)] focus:border-[var(--c-accent)] focus:outline-none"
                  />
                </label>
                <label className="flex items-center gap-1.5">
                  <input type="checkbox" checked={filters.load1.enabled} onChange={(e) => setFilters((p) => ({ ...p, load1: { ...p.load1, enabled: e.target.checked } }))} className="accent-[var(--c-accent)]" />
                  <span className="shrink-0">Charge (1 min) &gt;</span>
                  <input
                    type="number" min={0} step={0.1} value={filters.load1.value}
                    onChange={(e) => setFilters((p) => ({ ...p, load1: { ...p.load1, value: Number(e.target.value) } }))}
                    className="w-12 rounded border border-[var(--c-border)] bg-[var(--c-bg3)] px-1 py-0.5 text-center text-[var(--c-text)] focus:border-[var(--c-accent)] focus:outline-none"
                  />
                </label>
                <label className="flex items-center gap-1.5">
                  <input type="checkbox" checked={filters.uptimeDays.enabled} onChange={(e) => setFilters((p) => ({ ...p, uptimeDays: { ...p.uptimeDays, enabled: e.target.checked } }))} className="accent-[var(--c-accent)]" />
                  <span className="shrink-0">Uptime &lt;</span>
                  <input
                    type="number" min={0} value={filters.uptimeDays.value}
                    onChange={(e) => setFilters((p) => ({ ...p, uptimeDays: { ...p.uptimeDays, value: Number(e.target.value) } }))}
                    className="w-12 rounded border border-[var(--c-border)] bg-[var(--c-bg3)] px-1 py-0.5 text-center text-[var(--c-text)] focus:border-[var(--c-accent)] focus:outline-none"
                  />
                  <span>jours</span>
                </label>
                <label className="flex items-center gap-1.5">
                  <input type="checkbox" checked={filters.os.enabled} onChange={(e) => setFilters((p) => ({ ...p, os: { ...p.os, enabled: e.target.checked } }))} className="accent-[var(--c-accent)]" />
                  <span className="shrink-0">OS contient</span>
                  <input
                    type="text" value={filters.os.value} placeholder="ubuntu…"
                    onChange={(e) => setFilters((p) => ({ ...p, os: { ...p.os, value: e.target.value } }))}
                    className="w-full min-w-0 rounded border border-[var(--c-border)] bg-[var(--c-bg3)] px-1.5 py-0.5 text-[var(--c-text)] placeholder:text-[var(--c-text-faint)] focus:border-[var(--c-accent)] focus:outline-none"
                  />
                </label>
                <button
                  onClick={selectByFacts}
                  className="w-full rounded bg-[var(--c-accent-dim)] px-2 py-1 text-[var(--c-accent-text)] hover:bg-[var(--c-accent)] hover:text-white"
                >
                  Sélectionner les hôtes correspondants
                </button>
              </div>
            )}
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
          {sshHosts.length === 0 ? (
            <p className="px-2 py-4 text-xs text-[var(--c-text-faint)]">Aucun hôte SSH. La flotte ne cible que les hôtes SSH pour l'instant.</p>
          ) : (
            filtered.map((h) => {
              const checked = selected.has(h.id);
              const sub = [groupName(h), h.address].filter(Boolean).join(" · ");
              const f = h.lastFacts;
              return (
                <label
                  key={h.id}
                  title={mode === "intent" ? "Sélection automatique en mode Langage" : undefined}
                  className={`flex items-center gap-2.5 rounded-md px-2 py-1.5 ${mode === "command" ? "cursor-pointer" : ""} ${checked ? "bg-[var(--c-accent-dim)]" : mode === "command" ? "hover:bg-[var(--c-bg3)]" : ""}`}
                >
                  <input type="checkbox" checked={checked} disabled={mode === "intent"} onChange={() => toggle(h.id)} className="accent-[var(--c-accent)] disabled:opacity-60" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-[var(--c-text)]">{h.label}</span>
                    {sub && <span className="block truncate text-[11px] text-[var(--c-text-faint)]">{sub}</span>}
                    {f && (
                      <span className="mt-0.5 block space-y-0.5 text-[11px]">
                        {(f.osName || f.osId) && (
                          <span className="block truncate text-[var(--c-text-muted)]">{f.osName || f.osId}</span>
                        )}
                        <span className="flex items-center gap-2 truncate">
                          {f.memUsedPct != null && (
                            <span className="shrink-0 font-medium" style={{ color: ramColor(f.memUsedPct) }}>
                              RAM {Math.round(f.memUsedPct)}%
                            </span>
                          )}
                          {h.lastFactsAtMs != null && (
                            <span className="truncate text-[var(--c-text-faint)]">{formatRelativeTime(h.lastFactsAtMs)}</span>
                          )}
                        </span>
                      </span>
                    )}
                  </span>
                </label>
              );
            })
          )}
        </div>
      </aside>

      {/* ── Command + results ─────────────────────────────────────────── */}
      <section className="flex min-w-0 flex-1 flex-col">
        <div className="border-b border-[var(--c-border)] p-3">
          <div className="mb-2 flex shrink-0 rounded-md bg-[var(--c-bg2)] p-0.5 text-[11px]">
            <button
              onClick={() => setMode("command")}
              className={`rounded px-2 py-0.5 font-medium ${mode === "command" ? "bg-[var(--c-bg3)] text-[var(--c-text)]" : "text-[var(--c-text-muted)] hover:text-[var(--c-text-secondary)]"}`}
            >
              Commande
            </button>
            <button
              onClick={() => setMode("intent")}
              className={`rounded px-2 py-0.5 font-medium ${mode === "intent" ? "bg-[var(--c-bg3)] text-[var(--c-text)]" : "text-[var(--c-text-muted)] hover:text-[var(--c-text-secondary)]"}`}
            >
              Langage
            </button>
          </div>

          <div className="flex items-end gap-2">
            <button
              onClick={() => setShowSnippetPicker(true)}
              disabled={workspace.snippets.length === 0}
              title={workspace.snippets.length === 0 ? "Aucun snippet enregistré" : "Choisir un snippet — remplit la commande, à réviser avant d'exécuter"}
              className="flex shrink-0 items-center gap-1.5 self-stretch rounded-md border border-[var(--c-border)] bg-[var(--c-bg2)] px-2.5 text-xs text-[var(--c-text-secondary)] hover:bg-[var(--c-bg3)] disabled:cursor-not-allowed disabled:opacity-40"
            >
              <IconSnippets size={13} />
              Snippet
            </button>
            {mode === "command" ? (
              <>
                <textarea
                  value={command}
                  onChange={(e) => setCommand(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                      e.preventDefault();
                      run();
                    }
                  }}
                  rows={2}
                  placeholder="Commande à exécuter sur les hôtes sélectionnés…  (Ctrl+Entrée)"
                  spellCheck={false}
                  className="min-h-[2.5rem] flex-1 resize-y rounded-md border border-[var(--c-border)] bg-[var(--c-bg2)] px-3 py-2 font-mono text-sm text-[var(--c-text)] placeholder:text-[var(--c-text-faint)] focus:border-[var(--c-accent)] focus:outline-none"
                />
                <button
                  onClick={run}
                  disabled={running || selected.size === 0 || !command.trim()}
                  className="flex items-center gap-1.5 rounded-md bg-[var(--c-accent)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--c-accent-hover)] disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <IconPlay size={14} />
                  {running ? "En cours…" : `Exécuter (${selected.size})`}
                </button>
              </>
            ) : (
              <div className="flex-1 space-y-2">
                <div className="flex items-end gap-2">
                  <textarea
                    value={programText}
                    onChange={(e) => { setProgramText(e.target.value); setActiveSnippetId(null); setPreviewGroups(null); }}
                    rows={5}
                    placeholder={"install-package nginx\n\ntarget ram: > 80\nrestart-service nginx"}
                    spellCheck={false}
                    className="min-h-[2.5rem] flex-1 resize-y rounded-md border border-[var(--c-border)] bg-[var(--c-bg2)] px-3 py-2 font-mono text-xs text-[var(--c-text)] placeholder:text-[var(--c-text-faint)] focus:border-[var(--c-accent)] focus:outline-none"
                  />
                  <button
                    onClick={runPreview}
                    disabled={previewing || selected.size === 0 || !programText.trim()}
                    title="Analyse le programme et montre quels hôtes exécuteraient quoi — ne lance rien"
                    className="flex items-center gap-1.5 self-stretch rounded-md bg-[var(--c-accent)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--c-accent-hover)] disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <IconPlay size={14} />
                    {previewing ? "…" : "Prévisualiser"}
                  </button>
                </div>
                <div className="flex items-center gap-2 rounded-md border border-[var(--c-border)] bg-[var(--c-bg2)] p-1.5">
                  <IconFlash size={13} className="ml-1 shrink-0 text-sky-400" />
                  <input
                    value={aiIntent}
                    onChange={(e) => setAiIntent(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); generateWithAi(); } }}
                    placeholder="Décrire en français ce qu'ajouter/changer, et laisser l'IA écrire les lignes…"
                    className="min-w-0 flex-1 bg-transparent text-xs text-[var(--c-text)] placeholder:text-[var(--c-text-faint)] focus:outline-none"
                  />
                  <button
                    onClick={generateWithAi}
                    disabled={generatingAi || !aiIntent.trim()}
                    className="shrink-0 rounded bg-[var(--c-accent-dim)] px-2.5 py-1 text-[11px] font-medium text-[var(--c-accent-text)] hover:bg-[var(--c-accent)] hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {generatingAi ? "Génération…" : "Générer"}
                  </button>
                </div>
                <details className="text-[11px] text-[var(--c-text-faint)]">
                  <summary className="cursor-pointer select-none hover:text-[var(--c-text-muted)]">Aide-mémoire de la syntaxe</summary>
                  <div className="mt-1.5 space-y-1 rounded-md border border-[var(--c-border)] bg-[var(--c-bg2)] p-2">
                    <p>Un bloc = conditions/options facultatives, puis une commande. Blocs séparés par une ligne vide.</p>
                    <ul className="list-inside list-disc space-y-0.5">
                      {DSL_CONDITION_FIELDS.map((c) => (
                        <li key={c.field}><code className="font-mono">{c.example}</code></li>
                      ))}
                      <li><code className="font-mono">&amp;&amp;</code> (ET) / <code className="font-mono">||</code> (OU) — combine plusieurs <code className="font-mono">target</code> sur une ligne, ex. <code className="font-mono">target os: debian || target os: ubuntu</code> (<code className="font-mono">&amp;&amp;</code> prioritaire sur <code className="font-mono">||</code>)</li>
                      <li><code className="font-mono">sudo: true</code> — exécute la commande du bloc avec sudo</li>
                    </ul>
                    <p className="pt-1">Commandes disponibles :</p>
                    <ul className="grid grid-cols-2 gap-x-2 gap-y-0.5">
                      {DSL_FUNCTIONS.map((f) => (
                        <li key={f.name}><code className="font-mono">{f.name} {f.args}</code></li>
                      ))}
                    </ul>
                  </div>
                </details>
              </div>
            )}
          </div>

          {mode === "intent" && previewGroups && (
            <div className="mt-3 space-y-2">
              {previewGroups.map((g, i) => (
                <div key={i} className="rounded-md border border-[var(--c-border)] bg-[var(--c-bg2)] p-2">
                  <div className="mb-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs">
                    <span className="shrink-0 font-medium text-[var(--c-text)]">{g.hostIds.length} hôte(s) :</span>
                    <span className="text-[var(--c-text-secondary)]">
                      {g.hostIds.map((id) => hostById.get(id)?.label ?? id).join(", ")}
                    </span>
                  </div>
                  {g.command != null ? (
                    <textarea
                      value={g.command}
                      onChange={(e) => updateGroupCommand(i, e.target.value)}
                      rows={g.command.split("\n").length}
                      spellCheck={false}
                      className="w-full resize-y rounded border border-[var(--c-border)] bg-[var(--c-bg3)] px-2 py-1.5 font-mono text-xs text-[var(--c-text)] focus:border-[var(--c-accent)] focus:outline-none"
                    />
                  ) : (
                    <p className="rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-200">
                      {g.note ?? "Rien à exécuter pour ces hôtes"} — exclus de l'exécution.
                    </p>
                  )}
                </div>
              ))}
              <div className="flex gap-1.5">
                <button
                  onClick={runPlan}
                  disabled={running || !previewGroups.some((g) => g.command != null)}
                  className="flex flex-1 items-center justify-center gap-1.5 rounded-md bg-[var(--c-accent)] px-3 py-1.5 text-xs font-medium text-white hover:bg-[var(--c-accent-hover)] disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <IconPlay size={13} />
                  Exécuter le plan ({previewGroups.filter((g) => g.command != null).reduce((n, g) => n + g.hostIds.length, 0)} hôte(s))
                </button>
                <button
                  onClick={openSaveDialog}
                  className="rounded-md border border-[var(--c-border)] bg-[var(--c-bg2)] px-3 py-1.5 text-xs text-[var(--c-text-secondary)] hover:bg-[var(--c-bg3)]"
                >
                  Sauvegarder comme snippet adaptatif
                </button>
              </div>
            </div>
          )}

          {runTargets.length > 0 && (
            <div className="mt-2 flex items-center gap-3 text-xs">
              <span className="text-[#22c55e]">✓ {summary.ok} ok</span>
              <span className="text-[#ef4444]">✕ {summary.fail} échec</span>
              {summary.pending > 0 && <span className="text-[var(--c-text-muted)]">◷ {summary.pending} en cours</span>}
              <span className="text-[var(--c-text-faint)]">· {summary.total} hôte(s)</span>
            </div>
          )}
        </div>

        {/* Résultats / Historique */}
        <div className="flex items-center gap-1 border-b border-[var(--c-border)] px-3 py-1.5 text-xs">
          <button
            onClick={() => setView("run")}
            className={`rounded px-2 py-1 ${view === "run" ? "bg-[var(--c-bg3)] text-[var(--c-text)]" : "text-[var(--c-text-muted)] hover:bg-[var(--c-bg2)]"}`}
          >
            Résultats
          </button>
          <button
            onClick={() => setView("history")}
            className={`rounded px-2 py-1 ${view === "history" ? "bg-[var(--c-bg3)] text-[var(--c-text)]" : "text-[var(--c-text-muted)] hover:bg-[var(--c-bg2)]"}`}
          >
            Historique ({history.length})
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {view === "history" ? (
            history.length === 0 ? (
              <div className="flex h-full items-center justify-center px-6 text-center text-sm text-[var(--c-text-faint)]">
                Aucun run enregistré. Les exécutions passées apparaîtront ici.
              </div>
            ) : (
              <ul>
                {history.map((hrun) => {
                  const counts = countOutcomes(hrun.outcomes);
                  const isOpen = expandedRuns.has(hrun.id);
                  return (
                    <li key={hrun.id} className="border-b border-[var(--c-border)]">
                      <div
                        onClick={() => toggleRun(hrun.id)}
                        className="flex cursor-pointer items-center gap-2 px-3 py-2 hover:bg-[var(--c-bg2)]"
                      >
                        {isOpen ? (
                          <IconChevronDown size={12} className="shrink-0 text-[var(--c-text-faint)]" />
                        ) : (
                          <IconChevronRight size={12} className="shrink-0 text-[var(--c-text-faint)]" />
                        )}
                        <div className="min-w-0 flex-1">
                          <div className="truncate font-mono text-xs text-[var(--c-text)]">{hrun.command}</div>
                          <div className="text-[11px] text-[var(--c-text-faint)]">
                            {formatTimestamp(hrun.startedAtMs)} · {hrun.hostIds.length} hôte(s)
                          </div>
                        </div>
                        <span className="shrink-0 text-xs text-[#22c55e]">✓{counts.ok}</span>
                        <span className="shrink-0 text-xs text-[#ef4444]">✕{counts.fail}</span>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            loadRun(hrun);
                          }}
                          className="shrink-0 rounded bg-[var(--c-accent-dim)] px-2 py-0.5 text-[11px] text-[var(--c-accent-text)] hover:bg-[var(--c-accent)] hover:text-white"
                        >
                          Charger
                        </button>
                      </div>
                      {isOpen && (
                        <div className="space-y-1 px-3 pb-2 pl-7">
                          {hrun.outcomes.map((o) => (
                            <div key={o.hostId} className="text-xs">
                              <div className="flex items-center gap-2">
                                <StatusDot status={outcomeStatus(o)} />
                                <span className="flex-1 truncate text-[var(--c-text-secondary)]">
                                  {hostById.get(o.hostId)?.label ?? o.hostId}
                                </span>
                                <span className="shrink-0 font-mono text-[var(--c-text-faint)]">
                                  {o.error != null ? "—" : o.exitCode ?? "—"} · {o.durationMs} ms
                                </span>
                              </div>
                              {(o.stdout || o.stderr || o.error) && (
                                <details className="ml-5 mt-0.5">
                                  <summary className="cursor-pointer text-[11px] text-[var(--c-text-muted)]">sortie</summary>
                                  {o.error != null && <p className="mt-1 text-[11px] text-[#ef4444]">{o.error}</p>}
                                  {o.stdout && (
                                    <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-[var(--c-bg2)] p-2 font-mono text-[11px] text-[var(--c-text-secondary)]">{o.stdout}</pre>
                                  )}
                                  {o.stderr && (
                                    <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-[var(--c-bg2)] p-2 font-mono text-[11px] text-[#fca5a5]">{o.stderr}</pre>
                                  )}
                                </details>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )
          ) : runTargets.length === 0 ? (
            <div className="flex h-full items-center justify-center px-6 text-center text-sm text-[var(--c-text-faint)]">
              Sélectionne des hôtes, saisis une commande, puis exécute — le résultat de chaque hôte s'affiche ici.
            </div>
          ) : (
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="sticky top-0 bg-[var(--c-bg2)] text-left text-[11px] uppercase tracking-wide text-[var(--c-text-muted)]">
                  <th className="w-8 py-2 pl-3"></th>
                  <th className="py-2">Hôte</th>
                  <th className="w-16 py-2 text-center">Code</th>
                  <th className="w-20 py-2 pr-3 text-right">Durée</th>
                </tr>
              </thead>
              <tbody>
                {runTargets.map((id) => {
                  const host = hostById.get(id);
                  const outcome = results.get(id);
                  const status = statusOf(id, results, pending);
                  const isOpen = expanded.has(id);
                  const hasDetail = !!outcome && (!!outcome.stdout || !!outcome.stderr || !!outcome.error);
                  return (
                    <Fragment key={id}>
                      <tr
                        onClick={() => hasDetail && toggleExpanded(id)}
                        className={`border-b border-[var(--c-border)] ${hasDetail ? "cursor-pointer hover:bg-[var(--c-bg2)]" : ""}`}
                      >
                        <td className="py-2 pl-3">
                          <div className="flex items-center gap-1">
                            {hasDetail ? (
                              isOpen ? <IconChevronDown size={12} className="text-[var(--c-text-faint)]" /> : <IconChevronRight size={12} className="text-[var(--c-text-faint)]" />
                            ) : (
                              <span className="w-3" />
                            )}
                            <StatusDot status={status} />
                          </div>
                        </td>
                        <td className="py-2 text-[var(--c-text)]">{host?.label ?? id}</td>
                        <td className="py-2 text-center font-mono text-xs">
                          {outcome ? (outcome.error != null ? "—" : outcome.exitCode ?? "—") : ""}
                        </td>
                        <td className="py-2 pr-3 text-right font-mono text-xs text-[var(--c-text-muted)]">
                          {outcome ? `${outcome.durationMs} ms` : ""}
                        </td>
                      </tr>
                      {isOpen && outcome && (
                        <tr className="border-b border-[var(--c-border)] bg-[var(--c-bg)]">
                          <td colSpan={4} className="px-4 py-2">
                            {outcome.error != null && (
                              <p className="mb-2 text-xs text-[#ef4444]">{outcome.error}</p>
                            )}
                            {outcome.stdout && (
                              <pre className="mb-2 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-[var(--c-bg2)] p-2 font-mono text-xs text-[var(--c-text-secondary)]">{outcome.stdout}</pre>
                            )}
                            {outcome.stderr && (
                              <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded bg-[var(--c-bg2)] p-2 font-mono text-xs text-[#fca5a5]">{outcome.stderr}</pre>
                            )}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </section>

      {showSnippetPicker && (
        <SnippetPicker
          snippets={workspace.snippets}
          onRun={(resolvedCommand) => setCommand(resolvedCommand)}
          onSnippetResolved={handleSnippetResolved}
          onClose={() => setShowSnippetPicker(false)}
        />
      )}

      {showSaveDialog && (
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-[15vh]" onClick={() => setShowSaveDialog(false)}>
          <div className="w-full max-w-sm overflow-hidden rounded-lg bg-[var(--c-bg2)] p-4 shadow-[var(--shadow-lg)]" onClick={(e) => e.stopPropagation()}>
            <p className="mb-2 text-sm font-medium text-[var(--c-text)]">Sauvegarder comme snippet adaptatif</p>
            <input
              value={saveSnippetName}
              onChange={(e) => setSaveSnippetName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") confirmSaveSnippet();
                if (e.key === "Escape") setShowSaveDialog(false);
              }}
              placeholder="Nom du snippet"
              autoFocus
              className="w-full rounded-md bg-[var(--c-bg3)] px-2.5 py-1.5 text-sm text-[var(--c-text)] placeholder:text-[var(--c-text-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--c-accent-hover)]"
            />
            <div className="mt-3 flex gap-1.5">
              <button
                onClick={confirmSaveSnippet}
                disabled={!saveSnippetName.trim()}
                className="accent-surface flex-1 rounded-md border py-1.5 text-xs font-medium disabled:opacity-40"
              >
                Sauvegarder
              </button>
              <button onClick={() => setShowSaveDialog(false)} className="rounded-md bg-[var(--c-bg3)] px-3 py-1.5 text-xs text-[var(--c-text-secondary)] hover:bg-white/5">
                Annuler
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
