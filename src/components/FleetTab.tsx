import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { DockerContainer, ExecutionGroup, FleetOutcome, FleetRun, FleetTarget, Host, HostDrift, HostId, RollbackPlan, Snippet, SnippetId, Workspace } from "../lib/types";
import { fleetTargetKey } from "../lib/types";
import { api, onFleetDone, onFleetOutcome } from "../lib/api";
import { AdaptiveComposer } from "./AdaptiveComposer";
import { DSL_CONDITION_FIELDS, DSL_FUNCTIONS } from "../lib/operations";
import { hasSomethingToRun, rollbackAvailability } from "../lib/rollback";
import { driftedHosts, summarise } from "../lib/drift";
import { SnippetPicker } from "./SnippetPicker";
import { IconPlay, IconChevronRight, IconChevronDown, IconSnippets } from "./ui-icons";
import { useResizablePane } from "../hooks/useResizablePane";
import { useFleetSelection } from "../hooks/useFleetSelection";

function formatTimestamp(ms: number): string {
  return new Date(ms).toLocaleString();
}

interface FleetTabProps {
  workspace: Workspace;
  onError: (message: string) => void;
  /** Appelé avec l'espace de travail frais après l'enregistrement d'un snippet
   * adaptatif, pour que le reste de l'app le reprenne. */
  onWorkspaceUpdate: (ws: Workspace) => void;
  /** Ramène la barre latérale sur le panneau de cibles — ce que fait le
   * récapitulatif de sélection quand elle affiche autre chose. */
  onShowTargets: () => void;
}

/** One selectable fleet target, resolved from either the workspace (SSH
 * hosts, always; a single fixed "Terminal local" entry) or a live Docker
 * container listing (per `dockerExec` host — see `dockerContainers` state).
 * `key` is what selection/results state actually indexes by (`FleetTarget`
 * itself isn't a valid Set/Map key — it's a structural object, not a
 * primitive). */
type RowStatus = "pending" | "ok" | "fail" | "error";

function outcomeStatus(o: FleetOutcome): RowStatus {
  if (o.error != null) return "error";
  return o.exitCode === 0 ? "ok" : "fail";
}

function statusOf(key: string, results: Map<string, FleetOutcome>, pending: Set<string>): RowStatus {
  if (pending.has(key)) return "pending";
  const o = results.get(key);
  if (!o) return "pending";
  return outcomeStatus(o);
}

function countOutcomes(outcomes: FleetOutcome[]): { ok: number; fail: number } {
  let ok = 0;
  let fail = 0;
  for (const o of outcomes) {
    if (outcomeStatus(o) === "ok") ok++;
    else fail++;
  }
  return { ok, fail };
}

/** Best-effort display name for a target — used for both the live results
 * table and Historique, where a Docker container may no longer be in the
 * live `dockerContainers` listing (falls back to a truncated container id). */
function targetLabel(t: FleetTarget, hostById: Map<HostId, Host>, dockerContainers: Map<HostId, DockerContainer[]>): string {
  if (t.kind === "local") return "Terminal local";
  if (t.kind === "ssh") return hostById.get(t.hostId)?.label ?? t.hostId;
  const host = hostById.get(t.hostId);
  if (t.kind === "k8s") {
    const name = t.containerName ? `${t.podName} › ${t.containerName}` : t.podName;
    return host ? `${name} (${host.label})` : name;
  }
  const container = dockerContainers.get(t.hostId)?.find((c) => c.id === t.containerId);
  const name = container?.name ?? t.containerId.slice(0, 12);
  return host ? `${name} (${host.label})` : name;
}

/** Whether `text` has at least one `target …` condition line — same
 * word-boundary check as `core::adaptive::looks_like_condition_line`
 * ("target" must be the whole first word, not e.g. "targets"). Drives
 * whether "Langage" mode's live auto-selection should manage the target
 * checkboxes at all: a program with a `target` is host-scoped, so the
 * checkboxes should reflect exactly what the DSL matched — but a program
 * with none applies to every host by the DSL's own semantics (see
 * `core::adaptive`'s module docs), which says nothing about *which* hosts
 * to run it on. Forcing every SSH host selected in that case would be more
 * surprising than useful, so those checkboxes are left to manual selection
 * instead, same as "Commande" mode. */
function programHasTargetLine(text: string): boolean {
  return text.split("\n").some((line) => {
    const t = line.trim();
    if (!t.startsWith("target")) return false;
    const rest = t.slice("target".length);
    return rest.length === 0 || /^\s/.test(rest);
  });
}

function StatusDot({ status }: { status: RowStatus }) {
  if (status === "pending") {
    return <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-[var(--c-text-faint)] border-t-transparent" />;
  }
  const color = status === "ok" ? "#22c55e" : "#ef4444";
  return <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: color }} />;
}

export function FleetTab({ workspace, onError, onWorkspaceUpdate, onShowTargets }: FleetTabProps) {
  // Le choix des cibles vit dans la barre latérale (`FleetTargetsPanel`), donc
  // dans un magasin partagé plutôt que dans cet onglet : la liste des machines,
  // le filtre, la sélection et les filtres par état collecté y sont tous
  // passés ensemble. Il ne reste ici que la composition et les résultats.
  const {
    sshHosts, targetsByKey, dockerContainers, selected, setSelected,
    mode, setMode, setHasTargetLine, collectFacts,
  } = useFleetSelection();
  const hostById = useMemo(() => new Map(workspace.hosts.map((h) => [h.id, h])), [workspace.hosts]);

  const [command, setCommand] = useState("");
  const [running, setRunning] = useState(false);

  // Results of the current / last run, keyed by target, plus the ordered
  // target list so rows keep a stable order as outcomes stream in out of order.
  const [runTargets, setRunTargets] = useState<FleetTarget[]>([]);
  const [results, setResults] = useState<Map<string, FleetOutcome>>(new Map());
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const runIdRef = useRef<string | null>(null);

  // ── Resizable panels ─────────────────────────────────────────────────────
  // Same shared hook as App.tsx's sidebar/right-panel/split-pane and
  // TransferTab.tsx's left/right panes. Neither of these persists across
  // sessions — resets to these defaults every time, on purpose, for
  // consistency.
  const rightSectionRef = useRef<HTMLDivElement>(null);
  const composer = useResizablePane({ initial: 40, min: 20, max: 70, axis: "vertical", mode: "percent", containerRef: rightSectionRef });

  const [showSnippetPicker, setShowSnippetPicker] = useState(false);

  // Adaptive snippet engine: "Langage" mode edits a small DSL program (see
  // src/lib/operations.ts for the syntax) — written by hand, by the AI from
  // an English instruction, or both; the AI is only an optional assist
  // (aiIntent/generateWithAi), never required. SSH-only for now (the DSL's
  // per-host translation depends on `Host.lastFacts`, which Docker exec/
  // local targets don't have) — see `selectedSshHostIds` below. Evaluating
  // the program against the target hosts is always deterministic and free,
  // both for the live target selection below and for the explicit
  // "Prévisualiser" (runPreview) step before running; only *writing*/
  // extending the text via AI (generateWithAi) costs a call.
  const [programText, setProgramText] = useState("");
  // Whether the current program has at least one `target` line — see
  // `programHasTargetLine`'s doc comment for what this changes (live
  // auto-selection, and whether the SSH checkboxes are manually selectable in
  // "Langage" mode). Calculé ici, où vit le programme, mais publié dans le
  // magasin : c'est le panneau de cibles qui grise les cases d'après lui.
  const hasTargetLine = useMemo(() => programHasTargetLine(programText), [programText]);
  useEffect(() => { setHasTargetLine(hasTargetLine); }, [hasTargetLine, setHasTargetLine]);
  const [activeSnippetId, setActiveSnippetId] = useState<SnippetId | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewGroups, setPreviewGroups] = useState<ExecutionGroup[] | null>(null);
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const [saveSnippetName, setSaveSnippetName] = useState("");

  // Persisted run history (audit trail) + which panel is shown on the right.
  const [view, setView] = useState<"run" | "history">("run");
  const [history, setHistory] = useState<FleetRun[]>([]);
  const [expandedRuns, setExpandedRuns] = useState<Set<string>>(new Set());
  /** The rollback being reviewed, if any — nothing is undone until it is
   * confirmed from this preview. */
  const [rollback, setRollback] = useState<{ run: FleetRun; plan: RollbackPlan } | null>(null);
  const [rollbackLoading, setRollbackLoading] = useState<string | null>(null);
  /** Last drift check, or `null` when none has been asked for. Read-only on
   * the hosts — asking changes nothing, which is why it can sit next to the
   * program without a confirmation step. */
  const [drift, setDrift] = useState<HostDrift[] | null>(null);
  const [checkingDrift, setCheckingDrift] = useState(false);

  // Every currently selected target that's an SSH host — the only kind the
  // adaptive DSL ("Langage" mode) can translate for.
  const selectedSshHostIds = (): HostId[] =>
    [...selected]
      .map((k) => targetsByKey.get(k))
      .filter((t): t is Extract<FleetTarget, { kind: "ssh" }> => t?.kind === "ssh")
      .map((t) => t.hostId);

  // One subscription for the tab's lifetime; events are matched to the active
  // run by id so a stale run's late outcomes are ignored.
  useEffect(() => {
    let disposed = false;
    let offOutcome: (() => void) | undefined;
    let offDone: (() => void) | undefined;
    onFleetOutcome((runId, outcome) => {
      if (runId !== runIdRef.current) return;
      const key = fleetTargetKey(outcome.target);
      setResults((prev) => new Map(prev).set(key, outcome));
      setPending((prev) => {
        const next = new Set(prev);
        next.delete(key);
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
  // over SSH — cheap enough to re-run on every keystroke. SSH-only, so it
  // only ever selects `ssh:` keys — Docker exec/local targets simply never
  // get checked in this mode. Skipped entirely when the program has no
  // `target` line at all (see `programHasTargetLine`): the DSL isn't
  // host-scoped in that case, so the checkboxes stay under manual control
  // instead of being force-selected to "every host".
  useEffect(() => {
    if (mode !== "intent") return;
    const text = programText.trim();
    if (!text) { setSelected(new Set()); return; }
    if (!programHasTargetLine(text)) return;
    const timer = setTimeout(() => {
      api
        .previewAdaptiveProgram(sshHosts.map((h) => h.id), text)
        .then((groups) => {
          const keys = groups
            .filter((g) => g.command != null)
            .flatMap((g) => g.hostIds.map((hostId) => fleetTargetKey({ kind: "ssh", hostId })));
          setSelected(new Set(keys));
        })
        .catch(() => {}); // invalid/incomplete program mid-edit — ignore, keep the last selection
    }, 350);
    return () => clearTimeout(timer);
  }, [mode, programText, sshHosts]);

  const toggleExpanded = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
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
  // exist, and switch back to the composer so the user reviews before
  // running. An SSH target is dropped if its host was deleted since; Docker/
  // local targets are always kept (no cheap way to verify a container still
  // exists without a live fetch).
  const loadRun = (run: FleetRun) => {
    setCommand(run.command);
    const keep = run.targets.filter((t) => t.kind !== "ssh" || hostById.has(t.hostId));
    setSelected(new Set(keep.map(fleetTargetKey)));
    setView("run");
  };

  const run = async () => {
    if (running) return;
    const targets = [...selected].map((k) => targetsByKey.get(k)).filter((t): t is FleetTarget => t != null);
    if (targets.length === 0) {
      onError("Sélectionne au moins une cible");
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
    setPending(new Set(targets.map(fleetTargetKey)));
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

  // Facts older than this are treated the same as missing facts by
  // `runPreview` below — a `target ram: > 80` decision made on a
  // multi-hour-old snapshot is just as wrong as one made on no snapshot at
  // all, and silently trusting stale data is worse than the extra latency
  // of a re-probe (only paid when actually stale — see `runPreview`).
  const STALE_FACTS_THRESHOLD_MS = 15 * 60 * 1000;
  const factsAreStale = (host: Host | undefined) =>
    !host?.lastFacts || host.lastFactsAtMs == null || Date.now() - host.lastFactsAtMs > STALE_FACTS_THRESHOLD_MS;

  // Parses + evaluates the current program text against the selected SSH
  // hosts — pure and deterministic, no AI involved. Facts are collected
  // first for any target missing them *or* whose last collection is older
  // than `STALE_FACTS_THRESHOLD_MS`, since evaluation (`target ram: > N`
  // and friends) depends entirely on `lastFacts` being a reasonably current
  // snapshot, not just a present one.
  const runPreview = async () => {
    if (previewing) return;
    const targets = selectedSshHostIds();
    if (targets.length === 0) {
      onError("Sélectionne au moins un hôte SSH");
      return;
    }
    if (!programText.trim()) {
      onError("Écris ou génère un programme d'abord");
      return;
    }
    setPreviewing(true);
    try {
      if (targets.some((id) => factsAreStale(hostById.get(id)))) {
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
    const targets: FleetTarget[] = runnable.flatMap((g) => g.hostIds.map((hostId) => ({ kind: "ssh" as const, hostId })));
    const runId = crypto.randomUUID();
    runIdRef.current = runId;
    setRunTargets(targets);
    setResults(new Map());
    setPending(new Set(targets.map(fleetTargetKey)));
    setExpanded(new Set());
    setRunning(true);
    try {
      await api.runAdaptivePlan(
        runId,
        programText.trim(),
        runnable.map((g) => ({ hostIds: g.hostIds, command: g.command })),
        // The DSL, kept with the run so it can be undone later. The commands
        // above are rendered shell, which can't be inverted.
        programText.trim() || null,
      );
    } catch (e) {
      onError(String(e));
    } finally {
      if (runIdRef.current === runId) setRunning(false);
    }
    setPreviewGroups(null);
  };

  /** Reads the program as wanted state and reports which hosts have drifted.
   *
   * Deliberately on demand: nothing here polls. A desktop app quietly probing
   * fifty machines in the background is a nuisance to the very network it is
   * meant to help manage — see `core::drift`. */
  const runDriftCheck = async () => {
    const hostIds = selectedSshHostIds();
    if (hostIds.length === 0 || !programText.trim()) return;
    setCheckingDrift(true);
    try {
      setDrift(await api.checkDrift(hostIds, programText.trim()));
    } catch (e) {
      onError(String(e));
    } finally {
      setCheckingDrift(false);
    }
  };

  /** Hosts the last check found drifted. An unknown verdict is not drift — it
   * must neither put a host on this list nor take it off. */
  const driftedHostIds = useMemo(() => driftedHosts(drift ?? []).map((entry) => entry.hostId), [drift]);

  /** Narrows the selection to the drifting hosts, so "corriger" is just the
   * ordinary run on the ones that need it — no separate repair path. */
  const selectDriftedHosts = () =>
    setSelected(new Set(driftedHostIds.map((hostId) => fleetTargetKey({ kind: "ssh", hostId }))));

  /** Builds the rollback and shows it. Nothing runs here — the point of the
   * feature is that "annuler ce run" is a decision taken with the list of what
   * will and won't be undone in front of you. */
  const reviewRollback = async (run: FleetRun) => {
    setRollbackLoading(run.id);
    try {
      setRollback({ run, plan: await api.previewRollback(run.id) });
    } catch (e) {
      onError(String(e));
    } finally {
      setRollbackLoading((current) => (current === run.id ? null : current));
    }
  };

  /** Runs the reviewed rollback through the ordinary adaptive path, so it is
   * itself recorded as a run — an undo nobody can see afterwards would be a
   * gap in the very audit trail this feature is part of. */
  const executeRollback = async () => {
    if (!rollback || running) return;
    const runnable = rollback.plan.groups.filter((g): g is typeof g & { command: string } => g.command != null);
    if (runnable.length === 0) return;
    const targets: FleetTarget[] = runnable.flatMap((g) => g.hostIds.map((hostId) => ({ kind: "ssh" as const, hostId })));
    const runId = crypto.randomUUID();
    runIdRef.current = runId;
    setRunTargets(targets);
    setResults(new Map());
    setPending(new Set(targets.map(fleetTargetKey)));
    setExpanded(new Set());
    setRunning(true);
    setView("run");
    const plan = rollback.plan;
    const intent = `Annulation de : ${rollback.run.command}`;
    setRollback(null);
    try {
      await api.runAdaptivePlan(
        runId,
        intent,
        runnable.map((g) => ({ hostIds: g.hostIds, command: g.command })),
        // The rollback's own program, so a rollback can itself be rolled back.
        plan.programText,
      );
      setHistory(await api.getFleetHistory());
    } catch (e) {
      onError(String(e));
    } finally {
      if (runIdRef.current === runId) setRunning(false);
    }
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
      onWorkspaceUpdate(ws);
      setShowSaveDialog(false);
    } catch (e) {
      onError(String(e));
    }
  };

  // Picking an adaptive snippet switches into Langage mode with its DSL
  // program text pre-filled (which in turn live-selects matching SSH hosts,
  // see above) and its id tracked (so "Sauvegarder" defaults to updating
  // it). A classic snippet keeps filling the plain command box (handled by
  // the existing onRun={setCommand} below).
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
    for (const t of runTargets) {
      const s = statusOf(fleetTargetKey(t), results, pending);
      if (s === "ok") ok++;
      else if (s === "fail" || s === "error") fail++;
    }
    return { ok, fail, pending: pending.size, total: runTargets.length };
  }, [runTargets, results, pending]);

  return (
    <div className="flex h-full min-h-0 min-w-0 bg-[var(--c-bg)] text-[var(--c-text)]">
      {/* ── Target picker ─────────────────────────────────────────────── */}
      {/* `max-w-[50%]` caps this fixed-pixel sidebar (`leftPane.value`) as a
       * share of this tab's own container rather than the window — without
       * it, squeezing this tab very narrow (e.g. the split-terminal view
       * dragged wide) overflows past the content section instead of
       * shrinking, same bug `SqlTab`'s schema tree used to have. */}
      {/* ── Command + results ─────────────────────────────────────────── */}
      <section ref={rightSectionRef} className="flex min-w-0 flex-1 flex-col">
        <div style={{ height: `${composer.value}%` }} className="shrink-0 overflow-y-auto border-b border-[var(--c-border)] p-3">
          <div className="mb-2 flex shrink-0 items-center gap-2 text-[11px]">
          <div className="flex rounded-md bg-[var(--c-bg2)] p-0.5">
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

            {/* Le récapitulatif remplace la colonne de cibles : elle est
                maintenant dans la barre latérale, qui peut afficher autre
                chose. Sans lui, on lancerait une commande sur une flotte sans
                avoir sous les yeux laquelle. Cliquer y ramène. */}
            <button
              onClick={onShowTargets}
              title="Choisir les cibles — ouvre le panneau « Opérations de flotte » dans la barre latérale"
              className="ml-auto rounded-md border border-[var(--c-border)] bg-[var(--c-bg2)] px-2.5 py-1 text-[var(--c-text-secondary)] hover:bg-[var(--c-bg3)]"
            >
              {selected.size === 0
                ? "Aucune cible sélectionnée"
                : `${selected.size} cible${selected.size > 1 ? "s" : ""} · modifier`}
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
                  placeholder="Commande à exécuter sur les cibles sélectionnées…  (Ctrl+Entrée)"
                  spellCheck={false}
                  className="min-h-[2.5rem] flex-1 resize-y rounded-md border border-[var(--c-border)] bg-[var(--c-bg2)] px-3 py-2 font-mono text-sm text-[var(--c-text)] placeholder:text-[var(--c-text-faint)] focus:border-[var(--c-accent)]"
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
                    className="min-h-[2.5rem] flex-1 resize-y rounded-md border border-[var(--c-border)] bg-[var(--c-bg2)] px-3 py-2 font-mono text-xs text-[var(--c-text)] placeholder:text-[var(--c-text-faint)] focus:border-[var(--c-accent)]"
                  />
                  {/* Reads the program as wanted state instead of as actions:
                      same text, opposite direction. Read-only on the hosts —
                      nothing is changed by asking. */}
                  <button
                    onClick={runDriftCheck}
                    disabled={checkingDrift || selectedSshHostIds().length === 0 || !programText.trim()}
                    title="Lit ce programme comme un état voulu et dit quels hôtes s'en écartent — ne change rien"
                    className="flex items-center gap-1.5 self-stretch rounded-md border border-[var(--c-border)] bg-[var(--c-bg2)] px-3 py-2 text-sm text-[var(--c-text-secondary)] hover:bg-[var(--c-bg3)] hover:text-[var(--c-text)] disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {checkingDrift ? "…" : "Vérifier l'écart"}
                  </button>
                  <button
                    onClick={runPreview}
                    disabled={previewing || selectedSshHostIds().length === 0 || !programText.trim()}
                    title="Analyse le programme et montre quels hôtes exécuteraient quoi — ne lance rien"
                    className="flex items-center gap-1.5 self-stretch rounded-md bg-[var(--c-accent)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--c-accent-hover)] disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <IconPlay size={14} />
                    {previewing ? "…" : "Prévisualiser"}
                  </button>
                </div>

                {drift && (
                  <div className="rounded-md border border-[var(--c-border)] bg-[var(--c-bg2)] p-2">
                    <div className="flex items-center gap-2">
                      <p className="flex-1 text-[11px] font-medium text-[var(--c-text-secondary)]">
                        Écart par rapport à l'état décrit
                      </p>
                      {driftedHostIds.length > 0 && (
                        <button
                          onClick={selectDriftedHosts}
                          title="Ne garder que les hôtes en écart, pour n'exécuter que sur eux"
                          className="rounded bg-[var(--c-accent-dim)] px-2 py-0.5 text-[10px] font-medium text-[var(--c-accent-text)] hover:bg-[var(--c-accent)] hover:text-white"
                        >
                          Sélectionner les {driftedHostIds.length} hôte(s) en écart
                        </button>
                      )}
                      <button
                        onClick={() => setDrift(null)}
                        className="rounded px-1.5 py-0.5 text-[10px] text-[var(--c-text-muted)] hover:bg-white/5"
                      >
                        Fermer
                      </button>
                    </div>
                    <div className="mt-1.5 max-h-48 space-y-1 overflow-y-auto">
                      {drift.map((entry) => {
                        const drifted = entry.checks.filter((c) => c.verdict.kind === "drifted");
                        const unknown = entry.checks.filter((c) => c.verdict.kind === "unknown");
                        const summary = summarise(entry);
                        return (
                          <div key={entry.hostId} className="rounded bg-[var(--c-bg3)] px-2 py-1.5">
                            <div className="flex items-center gap-2">
                              <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--c-text)]">
                                {hostById.get(entry.hostId)?.label ?? entry.hostId}
                              </span>
                              {summary === "unreachable" ? (
                                <span className="shrink-0 text-[10px] text-[#ef4444]">injoignable</span>
                              ) : summary === "drifted" ? (
                                <span className="shrink-0 text-[10px] text-amber-400">{drifted.length} écart(s)</span>
                              ) : (
                                <span className="shrink-0 text-[10px] text-emerald-400">conforme</span>
                              )}
                              {/* Shown even on a conforming host: "conforme
                                  sur 2 lignes, 3 non vérifiables" is a
                                  different fact from "conforme". */}
                              {unknown.length > 0 && (
                                <span className="shrink-0 text-[10px] text-[var(--c-text-faint)]">
                                  {unknown.length} indéterminé(s)
                                </span>
                              )}
                            </div>
                            {entry.error && (
                              <p className="mt-0.5 font-mono text-[10px] text-[#ef4444]/90">{entry.error}</p>
                            )}
                            {(drifted.length > 0 || unknown.length > 0) && (
                              <ul className="mt-1 space-y-0.5">
                                {drifted.map((c, i) => (
                                  <li key={`d${i}`} className="font-mono text-[10px] text-amber-300/90">
                                    ✕ {c.operation}
                                  </li>
                                ))}
                                {unknown.map((c, i) => (
                                  <li key={`u${i}`} className="text-[10px] text-[var(--c-text-faint)]">
                                    <span className="font-mono">? {c.operation}</span>
                                    {c.verdict.kind === "unknown" && ` — ${c.verdict.reason}`}
                                  </li>
                                ))}
                              </ul>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
                <AdaptiveComposer
                  programText={programText}
                  onGenerated={(next) => { setProgramText(next); setPreviewGroups(null); }}
                  onError={onError}
                />
                <details className="text-[11px] text-[var(--c-text-faint)]">
                  <summary className="cursor-pointer select-none hover:text-[var(--c-text-muted)]">Aide-mémoire de la syntaxe</summary>
                  <div className="mt-1.5 max-h-64 space-y-1 overflow-y-auto rounded-md border border-[var(--c-border)] bg-[var(--c-bg2)] p-2">
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
                      className="w-full resize-y rounded border border-[var(--c-border)] bg-[var(--c-bg3)] px-2 py-1.5 font-mono text-xs text-[var(--c-text)] focus:border-[var(--c-accent)]"
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
              <span className="text-[var(--c-text-faint)]">· {summary.total} cible(s)</span>
            </div>
          )}
        </div>

        {/* Composer resize handle */}
        <div
          onMouseDown={composer.onMouseDown}
          className="group relative flex h-1 shrink-0 cursor-row-resize items-center justify-center"
        >
          <div className="h-px w-full bg-[var(--c-border)] transition-colors group-hover:bg-[var(--c-accent)]" />
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
                  const undoable = rollbackAvailability(hrun);
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
                            {formatTimestamp(hrun.startedAtMs)} · {hrun.targets.length} cible(s)
                          </div>
                        </div>
                        <span className="shrink-0 text-xs text-[#22c55e]">✓{counts.ok}</span>
                        <span className="shrink-0 text-xs text-[#ef4444]">✕{counts.fail}</span>
                        {/* Disabled rather than hidden, with the reason on
                            hover: "why can't I undo this one" is a question
                            worth answering where it is asked. */}
                        <button
                          disabled={!undoable.enabled || rollbackLoading === hrun.id}
                          title={undoable.reason}
                          onClick={(e) => {
                            e.stopPropagation();
                            void reviewRollback(hrun);
                          }}
                          className="shrink-0 rounded bg-[var(--c-bg3)] px-2 py-0.5 text-[11px] text-[var(--c-text-secondary)] hover:bg-white/5 hover:text-[var(--c-text)] disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          {rollbackLoading === hrun.id ? "…" : "Annuler"}
                        </button>
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
                            <div key={fleetTargetKey(o.target)} className="text-xs">
                              <div className="flex items-center gap-2">
                                <StatusDot status={outcomeStatus(o)} />
                                <span className="flex-1 truncate text-[var(--c-text-secondary)]">
                                  {targetLabel(o.target, hostById, dockerContainers)}
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
              Sélectionne des cibles, saisis une commande, puis exécute — le résultat de chacune s'affiche ici.
            </div>
          ) : (
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="sticky top-0 bg-[var(--c-bg2)] text-left text-[11px] uppercase tracking-wide text-[var(--c-text-muted)]">
                  <th className="w-8 py-2 pl-3"></th>
                  <th className="py-2">Cible</th>
                  <th className="w-16 py-2 text-center">Code</th>
                  <th className="w-20 py-2 pr-3 text-right">Durée</th>
                </tr>
              </thead>
              <tbody>
                {runTargets.map((t) => {
                  const key = fleetTargetKey(t);
                  const label = targetLabel(t, hostById, dockerContainers);
                  const outcome = results.get(key);
                  const status = statusOf(key, results, pending);
                  const isOpen = expanded.has(key);
                  const hasDetail = !!outcome && (!!outcome.stdout || !!outcome.stderr || !!outcome.error);
                  return (
                    <Fragment key={key}>
                      <tr
                        onClick={() => hasDetail && toggleExpanded(key)}
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
                        <td className="py-2 text-[var(--c-text)]">{label}</td>
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

      {rollback && (
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-[10vh]" onClick={() => setRollback(null)}>
          <div className="flex max-h-[75vh] w-full max-w-2xl flex-col overflow-hidden rounded-lg bg-[var(--c-bg2)] shadow-[var(--shadow-lg)]" onClick={(e) => e.stopPropagation()}>
            <div className="border-b border-[var(--c-border)] px-4 py-3">
              <p className="text-sm font-medium text-[var(--c-text)]">Annuler ce run</p>
              <p className="mt-0.5 truncate font-mono text-[11px] text-[var(--c-text-muted)]" title={rollback.run.command}>
                {rollback.run.command}
              </p>
            </div>

            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
              {/* What will NOT be undone comes first, and in red: read after
                  the plan it would look like a footnote, when it is the thing
                  that decides whether running this is a good idea at all. */}
              {rollback.plan.unreversed.length > 0 && (
                <div className="rounded-md border border-rose-900/60 bg-rose-950/40 p-2.5">
                  <p className="text-[11px] font-medium text-rose-200">
                    Ce que cette annulation ne remettra pas en état :
                  </p>
                  <ul className="mt-1.5 space-y-1">
                    {rollback.plan.unreversed.map((u, i) => (
                      <li key={`${u.function}-${i}`} className="text-[11px] leading-relaxed text-rose-200/90">
                        <span className="font-mono">{u.function}</span> — {u.reason}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {!hasSomethingToRun(rollback.plan) ? (
                <p className="rounded-md bg-[var(--c-bg3)] p-2.5 text-[11px] leading-relaxed text-[var(--c-text-secondary)]">
                  Rien à exécuter : aucune opération de ce run n'a d'inverse applicable sur ces hôtes.
                </p>
              ) : (
                <>
                  <div>
                    <p className="mb-1 text-[11px] font-medium text-[var(--c-text-secondary)]">
                      Programme d'annulation
                    </p>
                    <pre className="overflow-x-auto rounded-md bg-[var(--c-bg3)] p-2.5 font-mono text-[11px] leading-relaxed text-[var(--c-text)]">
                      {rollback.plan.programText}
                    </pre>
                  </div>
                  <div>
                    <p className="mb-1 text-[11px] font-medium text-[var(--c-text-secondary)]">
                      Ce qui sera réellement exécuté
                    </p>
                    <div className="space-y-1.5">
                      {rollback.plan.groups.map((group, i) => (
                        <div key={i} className="rounded-md bg-[var(--c-bg3)] p-2">
                          <p className="text-[10px] text-[var(--c-text-muted)]">
                            {group.hostIds.length} hôte(s) : {group.hostIds.map((id) => hostById.get(id)?.label ?? id).join(", ")}
                          </p>
                          {group.command != null ? (
                            <pre className="mt-1 overflow-x-auto font-mono text-[11px] text-[var(--c-text)]">{group.command}</pre>
                          ) : (
                            <p className="mt-1 text-[11px] italic text-[var(--c-text-faint)]">
                              {group.note ?? "rien à exécuter sur ces hôtes"}
                            </p>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                </>
              )}
            </div>

            <div className="flex gap-1.5 border-t border-[var(--c-border)] px-4 py-3">
              <button
                onClick={executeRollback}
                disabled={running || !hasSomethingToRun(rollback.plan)}
                className="accent-surface flex-1 rounded-md border py-1.5 text-xs font-medium disabled:opacity-40"
              >
                Exécuter l'annulation
              </button>
              <button onClick={() => setRollback(null)} className="rounded-md bg-[var(--c-bg3)] px-3 py-1.5 text-xs text-[var(--c-text-secondary)] hover:bg-white/5">
                Fermer
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
