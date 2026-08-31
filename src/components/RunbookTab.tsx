import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  Approval, FleetOutcome, FleetTarget, Host, HostId, OnFailure, Runbook, RunbookAction,
  RunbookApprovalRequest, RunbookId, RunbookRun, RunbookRunStatus, RunbookStep, SkippedTarget, Workspace,
} from "../lib/types";
import { fleetTargetKey } from "../lib/types";
import { targetLabel } from "../lib/fleetLabels";
import { assertNever } from "../lib/exhaustive";
import { api, onRunbookApprovalNeeded, onRunbookDone, onRunbookStepDone, onRunbookStepOutcome, onRunbookStepStarted } from "../lib/api";
import { RunbookApprovalModal } from "./RunbookApprovalModal";
import { useFleetSelection } from "../hooks/useFleetSelection";
import { IconPlay, IconPlus, IconTrash, IconChevronDown, IconChevronRight, IconClose } from "./ui-icons";

interface RunbookTabProps {
  runbookId: RunbookId;
  workspace: Workspace;
  onError: (message: string) => void;
  onWorkspaceUpdate: (ws: Workspace) => void;
  /** Ramène la barre latérale sur le panneau de cibles. */
  onShowTargets: () => void;
}

/** L'état d'une étape pendant et après une exécution. */
interface StepRunState {
  status: "waiting" | "running" | "awaitingApproval" | "done";
  /** Ce que chaque cible lance — clé de cible → commande rendue. */
  commands: Map<string, string>;
  skipped: SkippedTarget[];
  outcomes: Map<string, FleetOutcome>;
  stop: boolean;
  stopReason: string | null;
  dropped: FleetTarget[];
}

function emptyStepState(): StepRunState {
  return {
    status: "waiting", commands: new Map(), skipped: [],
    outcomes: new Map(), stop: false, stopReason: null, dropped: [],
  };
}

const FAILURE_LABELS: Record<OnFailure, string> = {
  stop: "arrêter la procédure",
  continue: "continuer avec tout le monde",
  dropFailed: "continuer sans les machines en échec",
};

const APPROVAL_LABELS: Record<Approval, string> = {
  beforeIrreversible: "avant une opération sans retour",
  never: "jamais",
  always: "toujours",
};

const STATUS_LABELS: Record<RunbookRunStatus, string> = {
  completed: "terminée",
  stopped: "arrêtée",
  cancelled: "annulée",
};

function newStep(): RunbookStep {
  return {
    id: crypto.randomUUID(),
    title: "",
    notes: "",
    action: { kind: "command", command: "" },
    scope: { tags: [], groups: [] },
    onFailure: "stop",
    // Le même défaut que le backend, et pour la même raison : une étape qui
    // supprime quelque chose demande, sans qu'on ait à y penser.
    approval: "beforeIrreversible",
  };
}

/** Un champ « a, b, c » ↔ une liste. Les espaces autour comptent pour rien, et
 * une entrée vide n'est pas un tag qui ne correspondrait à rien. */
function parseList(text: string): string[] {
  return text.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
}

function outcomeFailed(o: FleetOutcome): boolean {
  return o.error != null || o.exitCode !== 0;
}

function StatusDot({ state }: { state: "ok" | "fail" | "pending" }) {
  if (state === "pending") {
    return <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-[var(--c-text-faint)] border-t-transparent" />;
  }
  return (
    <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: state === "ok" ? "#22c55e" : "#ef4444" }} />
  );
}

/**
 * Une procédure : l'éditeur de ses étapes, son exécution en direct, et ses
 * rapports passés.
 *
 * **Les cibles viennent de la sélection de flotte**, pas d'ici : un runbook
 * décrit ce qu'il faut faire, la barre latérale sur qui. Une étape peut
 * restreindre cette sélection par tag et par dossier — jamais la nommer par
 * identifiant d'hôte, pour qu'une procédure reste vraie ailleurs que sur cette
 * machine.
 */
export function RunbookTab({ runbookId, workspace, onError, onWorkspaceUpdate, onShowTargets }: RunbookTabProps) {
  const { targetsByKey, selected, dockerContainers } = useFleetSelection();

  const saved = useMemo(
    () => workspace.runbooks.find((r) => r.id === runbookId) ?? null,
    [workspace.runbooks, runbookId],
  );

  const [draft, setDraft] = useState<Runbook | null>(saved);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [view, setView] = useState<"steps" | "history">("steps");
  const [history, setHistory] = useState<RunbookRun[]>([]);
  const [openReport, setOpenReport] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // Exécution en cours.
  const [runId, setRunId] = useState<string | null>(null);
  const runIdRef = useRef<string | null>(null);
  const [runStates, setRunStates] = useState<Map<number, StepRunState>>(new Map());
  const [finalStatus, setFinalStatus] = useState<RunbookRunStatus | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [approval, setApproval] = useState<RunbookApprovalRequest | null>(null);

  // Reprendre le brouillon quand l'onglet change de procédure — ou quand
  // quelqu'un d'autre a écrit dessus (import, suppression d'étape ailleurs).
  // `dirty` protège les modifications en cours : les écraser à chaque
  // rafraîchissement du workspace ferait disparaître une étape en train d'être
  // tapée.
  useEffect(() => {
    if (!dirty) setDraft(saved);
  }, [saved, dirty]);

  const hostById = useMemo(() => new Map<HostId, Host>(workspace.hosts.map((h) => [h.id, h])), [workspace.hosts]);

  const targets = useMemo<FleetTarget[]>(
    () => [...selected].map((key) => targetsByKey.get(key)).filter((t): t is FleetTarget => t != null),
    [selected, targetsByKey],
  );

  const labelOf = useCallback(
    (t: FleetTarget) => targetLabel(t, hostById, dockerContainers),
    [hostById, dockerContainers],
  );

  const refreshHistory = useCallback(() => {
    api.getRunbookHistory()
      .then((runs) => setHistory(runs.filter((r) => r.runbookId === runbookId)))
      .catch(() => {});
  }, [runbookId]);

  useEffect(() => { refreshHistory(); }, [refreshHistory]);

  // ── Abonnement aux évènements d'exécution ────────────────────────────────
  // Un seul abonnement pour la vie de l'onglet, filtré sur le `runId` courant
  // via une ref : se réabonner à chaque lancement laisserait passer les
  // premiers évènements d'une étape rapide.
  useEffect(() => {
    const patch = (index: number, update: (prev: StepRunState) => StepRunState) => {
      setRunStates((prev) => {
        const next = new Map(prev);
        next.set(index, update(next.get(index) ?? emptyStepState()));
        return next;
      });
    };
    const subs = [
      onRunbookStepStarted((id, payload) => {
        if (id !== runIdRef.current) return;
        patch(payload.stepIndex, (prev) => ({
          ...prev,
          status: "running",
          commands: new Map(payload.commands.map((c) => [fleetTargetKey(c.target), c.command])),
          skipped: payload.skipped,
        }));
      }),
      onRunbookStepOutcome((id, stepIndex, outcome) => {
        if (id !== runIdRef.current) return;
        patch(stepIndex, (prev) => {
          const outcomes = new Map(prev.outcomes);
          outcomes.set(fleetTargetKey(outcome.target), outcome);
          return { ...prev, outcomes };
        });
      }),
      onRunbookApprovalNeeded((request) => {
        if (request.runId !== runIdRef.current) return;
        setApproval(request);
        patch(request.stepIndex, (prev) => ({ ...prev, status: "awaitingApproval" }));
      }),
      onRunbookStepDone((id, payload) => {
        if (id !== runIdRef.current) return;
        // La demande peut aussi avoir été tranchée ailleurs qu'ici — le délai
        // dépassé côté Rust, ou « Arrêter » pendant l'attente. Fermer sur
        // l'évènement de fin d'étape couvre les trois d'un coup.
        setApproval((prev) => (prev?.stepIndex === payload.stepIndex ? null : prev));
        patch(payload.stepIndex, (prev) => ({
          ...prev,
          status: "done",
          stop: payload.stop,
          stopReason: payload.reason,
          dropped: payload.dropped,
        }));
      }),
      onRunbookDone((id, status) => {
        if (id !== runIdRef.current) return;
        runIdRef.current = null;
        setRunId(null);
        setCancelling(false);
        setApproval(null);
        setFinalStatus(status);
        refreshHistory();
      }),
    ];
    return () => { subs.forEach((s) => s.then((un) => un()).catch(() => {})); };
  }, [refreshHistory]);

  // ── Édition ──────────────────────────────────────────────────────────────
  const edit = (update: (book: Runbook) => Runbook) => {
    setDraft((prev) => (prev ? update(prev) : prev));
    setDirty(true);
  };

  const editStep = (index: number, update: (step: RunbookStep) => RunbookStep) =>
    edit((book) => ({ ...book, steps: book.steps.map((s, i) => (i === index ? update(s) : s)) }));

  const moveStep = (index: number, delta: number) =>
    edit((book) => {
      const steps = [...book.steps];
      const target = index + delta;
      if (target < 0 || target >= steps.length) return book;
      [steps[index], steps[target]] = [steps[target], steps[index]];
      return { ...book, steps };
    });

  const save = useCallback(async (book: Runbook) => {
    setSaving(true);
    try {
      onWorkspaceUpdate(await api.saveRunbook(book));
      setDirty(false);
      return true;
    } catch (e) {
      onError(String(e));
      return false;
    } finally {
      setSaving(false);
    }
  }, [onError, onWorkspaceUpdate]);

  // ── Exécution ────────────────────────────────────────────────────────────
  const run = async () => {
    if (!draft) return;
    if (draft.steps.length === 0) { onError("cette procédure n'a aucune étape"); return; }
    if (targets.length === 0) { onError("aucune cible sélectionnée — cochez des machines dans la barre latérale"); return; }
    // Le backend déroule le runbook **enregistré**. Lancer sans enregistrer
    // ferait tourner la version d'avant en montrant celle d'après — le genre
    // d'écart qu'on ne remarque qu'après coup.
    if (dirty && !(await save(draft))) return;

    const id = crypto.randomUUID();
    runIdRef.current = id;
    setRunId(id);
    setFinalStatus(null);
    setApproval(null);
    setRunStates(new Map(draft.steps.map((_, i) => [i, emptyStepState()])));
    try {
      await api.runRunbook(id, draft.id, targets);
    } catch (e) {
      onError(String(e));
      runIdRef.current = null;
      setRunId(null);
    }
  };

  /** Répondre. Le refus n'est pas un « annuler » de modale : il arrête la
   * procédure, parce qu'une étape refusée est une étape qui n'a pas eu lieu et
   * que la suivante suppose qu'elle a eu lieu. */
  const answerApproval = async (approved: boolean) => {
    if (!approval) return;
    const { runId: id, stepIndex } = approval;
    setApproval(null);
    try {
      await api.answerRunbookApproval(id, stepIndex, approved);
    } catch (e) {
      onError(String(e));
    }
  };

  const cancel = async () => {
    if (!runId) return;
    setCancelling(true);
    try {
      await api.cancelRunbook(runId);
    } catch (e) {
      setCancelling(false);
      onError(String(e));
    }
  };

  const toggleExpanded = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  if (!draft) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-sm text-[var(--c-text-muted)]">
        Cette procédure a été supprimée.
      </div>
    );
  }

  const running = runId != null;

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--c-bg)]">
      {/* Dans un portail (voir le composant) : cet onglet reste monté mais
          masqué quand un autre est au premier plan, et une demande qu'on ne
          voit pas finit refusée au bout du délai. */}
      {approval && (
        <RunbookApprovalModal
          request={approval}
          labelOf={labelOf}
          onApprove={() => answerApproval(true)}
          onRefuse={() => answerApproval(false)}
        />
      )}
      {/* ── En-tête ─────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2 border-b border-[var(--c-border)] px-3 py-2">
        <input
          value={draft.name}
          onChange={(e) => edit((b) => ({ ...b, name: e.target.value }))}
          className="min-w-0 flex-1 rounded border border-transparent bg-transparent px-1 py-0.5 text-sm font-semibold text-[var(--c-text)] hover:border-[var(--c-border)] focus:border-[var(--c-accent)]"
        />
        <button
          onClick={onShowTargets}
          className="rounded border border-[var(--c-border)] px-2 py-1 text-xs text-[var(--c-text-muted)] hover:border-[var(--c-accent)]"
        >
          {targets.length} cible{targets.length > 1 ? "s" : ""}
        </button>
        {dirty && (
          <button
            onClick={() => save(draft)}
            disabled={saving}
            className="rounded border border-[var(--c-accent)] px-2 py-1 text-xs text-[var(--c-accent-text)] disabled:opacity-50"
          >
            {saving ? "Enregistrement…" : "Enregistrer"}
          </button>
        )}
        {running ? (
          <button
            onClick={cancel}
            disabled={cancelling}
            className="flex items-center gap-1 rounded bg-[#ef4444] px-2.5 py-1 text-xs text-white disabled:opacity-60"
          >
            <IconClose size={13} />
            {cancelling ? "Arrêt après cette étape…" : "Arrêter"}
          </button>
        ) : (
          <button
            onClick={run}
            className="flex items-center gap-1 rounded bg-[var(--c-accent)] px-2.5 py-1 text-xs text-white"
          >
            <IconPlay size={13} /> Lancer
          </button>
        )}
      </div>

      <div className="flex gap-1 border-b border-[var(--c-border)] px-3 py-1.5 text-xs">
        {(["steps", "history"] as const).map((v) => (
          <button
            key={v}
            onClick={() => setView(v)}
            className={`rounded px-2 py-0.5 ${view === v ? "bg-[var(--c-bg3)] text-[var(--c-text)]" : "text-[var(--c-text-muted)] hover:bg-[var(--c-bg3)]"}`}
          >
            {v === "steps" ? "Étapes" : `Historique (${history.length})`}
          </button>
        ))}
      </div>

      {view === "steps" ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
          <textarea
            value={draft.description}
            onChange={(e) => edit((b) => ({ ...b, description: e.target.value }))}
            placeholder="À quoi sert cette procédure ?"
            rows={2}
            className="mb-3 w-full resize-y rounded border border-[var(--c-border)] bg-[var(--c-bg2)] px-2 py-1.5 text-xs text-[var(--c-text)]"
          />

          {cancelling && (
            <p className="mb-2 rounded border border-[var(--c-border)] bg-[var(--c-bg2)] px-2 py-1.5 text-[11px] text-[var(--c-text-muted)]">
              L'arrêt prend effet <strong>entre deux étapes</strong> : l'étape en cours va au bout sur ses cibles.
              Couper un <code className="font-mono">apt-get</code> à mi-chemin laisserait des machines dans un état
              que la procédure ne décrit nulle part.
            </p>
          )}
          {finalStatus && !running && (
            <p className="mb-2 rounded border border-[var(--c-border)] bg-[var(--c-bg2)] px-2 py-1.5 text-[11px] text-[var(--c-text-muted)]">
              Exécution {STATUS_LABELS[finalStatus]}.
            </p>
          )}

          <div className="space-y-2">
            {draft.steps.map((step, index) => {
              const state = runStates.get(index);
              return (
                <StepCard
                  key={step.id}
                  step={step}
                  index={index}
                  total={draft.steps.length}
                  state={state}
                  labelOf={labelOf}
                  expanded={expanded}
                  onToggleExpanded={toggleExpanded}
                  onChange={(update) => editStep(index, update)}
                  onMove={(delta) => moveStep(index, delta)}
                  onDelete={() => edit((b) => ({ ...b, steps: b.steps.filter((_, i) => i !== index) }))}
                />
              );
            })}
          </div>

          <button
            onClick={() => edit((b) => ({ ...b, steps: [...b.steps, newStep()] }))}
            className="mt-2 flex items-center gap-1 rounded border border-dashed border-[var(--c-border)] px-2 py-1.5 text-xs text-[var(--c-text-muted)] hover:border-[var(--c-accent)]"
          >
            <IconPlus size={13} /> Ajouter une étape
          </button>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
          {history.length === 0 && (
            <p className="text-xs text-[var(--c-text-faint)]">Cette procédure n'a pas encore été lancée.</p>
          )}
          <div className="space-y-1.5">
            {history.map((run) => (
              <div key={run.id} className="rounded-md border border-[var(--c-border)] bg-[var(--c-bg2)]">
                <button
                  onClick={() => setOpenReport(openReport === run.id ? null : run.id)}
                  className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs"
                >
                  {openReport === run.id ? <IconChevronDown size={13} /> : <IconChevronRight size={13} />}
                  <span className="text-[var(--c-text)]">{new Date(run.startedAtMs).toLocaleString()}</span>
                  <span className="text-[var(--c-text-muted)]">
                    {run.steps.length} étape{run.steps.length > 1 ? "s" : ""} · {(run.durationMs / 1000).toFixed(1)} s
                  </span>
                  <span
                    className="ml-auto rounded px-1.5 py-0.5 text-[10px]"
                    style={{
                      background: run.status === "completed" ? "#22c55e22" : "#ef444422",
                      color: run.status === "completed" ? "#22c55e" : "#ef4444",
                    }}
                  >
                    {STATUS_LABELS[run.status]}
                  </span>
                </button>
                {openReport === run.id && (
                  <div className="space-y-2 border-t border-[var(--c-border)] px-3 py-2">
                    {run.steps.map((record, i) => {
                      const failures = record.outcomes.filter(outcomeFailed).length;
                      return (
                        <div key={`${record.stepId}-${i}`} className="text-[11px]">
                          <div className="flex items-center gap-2">
                            <span className="text-[var(--c-text-faint)]">{i + 1}.</span>
                            <span className="font-medium text-[var(--c-text)]">{record.title}</span>
                            <span className="text-[var(--c-text-muted)]">
                              {record.outcomes.length - failures} ok · {failures} en échec
                              {record.skipped.length > 0 && ` · ${record.skipped.length} non visée(s)`}
                            </span>
                          </div>
                          <pre className="mt-0.5 whitespace-pre-wrap break-all rounded bg-[var(--c-bg3)] px-1.5 py-1 font-mono text-[10px] text-[var(--c-text-muted)]">
                            {record.summary}
                          </pre>
                          {record.stopReason && (
                            <p className="mt-0.5 text-[10px] text-[#ef4444]">Arrêt : {record.stopReason}</p>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** Une étape : son édition, et son résultat quand une exécution est passée. */
function StepCard({
  step, index, total, state, labelOf, expanded, onToggleExpanded, onChange, onMove, onDelete,
}: {
  step: RunbookStep;
  index: number;
  total: number;
  state: StepRunState | undefined;
  labelOf: (t: FleetTarget) => string;
  expanded: Set<string>;
  onToggleExpanded: (key: string) => void;
  onChange: (update: (step: RunbookStep) => RunbookStep) => void;
  onMove: (delta: number) => void;
  onDelete: () => void;
}) {
  const outcomes = state ? [...state.outcomes.values()] : [];
  const border =
    state?.stop ? "border-[#ef4444]"
    : state?.status === "awaitingApproval" ? "border-[#f59e0b]"
    : state?.status === "running" ? "border-[var(--c-accent)]"
    : "border-[var(--c-border)]";

  return (
    // `data-runbook-step` : le point d'accroche stable d'une étape, pour les
    // scénarios en fenêtre réelle. Sans lui, ils devraient compter les champs
    // du document entier — donc casser au premier champ ajouté ailleurs.
    <div data-runbook-step={index} className={`rounded-md border ${border} bg-[var(--c-bg2)] p-2`}>
      <div className="flex items-center gap-1.5">
        <span className="w-5 text-center text-xs text-[var(--c-text-faint)]">{index + 1}</span>
        <input
          value={step.title}
          onChange={(e) => onChange((s) => ({ ...s, title: e.target.value }))}
          placeholder="Ce que fait cette étape"
          className="min-w-0 flex-1 rounded border border-transparent bg-transparent px-1 py-0.5 text-xs font-medium text-[var(--c-text)] hover:border-[var(--c-border)] focus:border-[var(--c-accent)]"
        />
        {state?.status === "running" && <StatusDot state="pending" />}
        {state?.status === "awaitingApproval" && (
          <span className="rounded bg-[#f59e0b22] px-1.5 py-0.5 text-[10px] text-[#f59e0b]">en attente d'accord</span>
        )}
        <button onClick={() => onMove(-1)} disabled={index === 0} title="Monter" className="rounded px-1 text-xs text-[var(--c-text-muted)] hover:bg-[var(--c-bg3)] disabled:opacity-30">↑</button>
        <button onClick={() => onMove(1)} disabled={index === total - 1} title="Descendre" className="rounded px-1 text-xs text-[var(--c-text-muted)] hover:bg-[var(--c-bg3)] disabled:opacity-30">↓</button>
        <button onClick={onDelete} title="Supprimer l'étape" className="rounded p-1 text-[var(--c-text-muted)] hover:bg-[var(--c-bg3)]"><IconTrash size={12} /></button>
      </div>

      {/* Le choix commande libre / langage adaptatif. Un `switch` fermé sur
          `assertNever` plus bas garantit qu'une troisième forme d'action ne
          pourrait pas être ajoutée sans décider de son rendu ici. */}
      <div className="mt-1.5 flex gap-1 pl-6 text-[11px]">
        {(["command", "program"] as const).map((kind) => (
          <button
            key={kind}
            onClick={() =>
              onChange((s) => ({
                ...s,
                action: kind === "command" ? { kind: "command", command: "" } : { kind: "program", programText: "" },
              }))
            }
            className={`rounded px-1.5 py-0.5 ${step.action.kind === kind ? "bg-[var(--c-bg3)] text-[var(--c-text)]" : "text-[var(--c-text-muted)] hover:bg-[var(--c-bg3)]"}`}
          >
            {kind === "command" ? "Commande" : "Langage"}
          </button>
        ))}
      </div>
      <ActionEditor action={step.action} onChange={(action) => onChange((s) => ({ ...s, action }))} />

      <div className="mt-1.5 grid grid-cols-1 gap-1.5 pl-6 sm:grid-cols-2 lg:grid-cols-4">
        <label className="flex flex-col gap-0.5 text-[10px] text-[var(--c-text-muted)]">
          Tags (tous requis)
          <input
            value={step.scope.tags.join(", ")}
            onChange={(e) => onChange((s) => ({ ...s, scope: { ...s.scope, tags: parseList(e.target.value) } }))}
            placeholder="web, prod"
            className="rounded border border-[var(--c-border)] bg-[var(--c-bg3)] px-1.5 py-1 text-[11px] text-[var(--c-text)]"
          />
        </label>
        <label className="flex flex-col gap-0.5 text-[10px] text-[var(--c-text-muted)]">
          Dossiers (un suffit)
          <input
            value={step.scope.groups.join(", ")}
            onChange={(e) => onChange((s) => ({ ...s, scope: { ...s.scope, groups: parseList(e.target.value) } }))}
            placeholder="Paris, Lyon"
            className="rounded border border-[var(--c-border)] bg-[var(--c-bg3)] px-1.5 py-1 text-[11px] text-[var(--c-text)]"
          />
        </label>
        <label className="flex flex-col gap-0.5 text-[10px] text-[var(--c-text-muted)]">
          Si une machine échoue
          <select
            value={step.onFailure}
            onChange={(e) => onChange((s) => ({ ...s, onFailure: e.target.value as OnFailure }))}
            className="rounded border border-[var(--c-border)] bg-[var(--c-bg3)] px-1.5 py-1 text-[11px] text-[var(--c-text)]"
          >
            {(Object.keys(FAILURE_LABELS) as OnFailure[]).map((k) => (
              <option key={k} value={k}>{FAILURE_LABELS[k]}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-0.5 text-[10px] text-[var(--c-text-muted)]">
          Demander avant de lancer
          <select
            value={step.approval}
            onChange={(e) => onChange((s) => ({ ...s, approval: e.target.value as Approval }))}
            className="rounded border border-[var(--c-border)] bg-[var(--c-bg3)] px-1.5 py-1 text-[11px] text-[var(--c-text)]"
          >
            {(Object.keys(APPROVAL_LABELS) as Approval[]).map((k) => (
              <option key={k} value={k}>{APPROVAL_LABELS[k]}</option>
            ))}
          </select>
        </label>
      </div>
      {step.approval === "beforeIrreversible" && step.action.kind === "command" && (
        <p className="ml-6 mt-1 text-[10px] text-[var(--c-text-faint)]">
          Une commande shell libre n'est jamais jugée destructrice : décider si un <code className="font-mono">rm -rf</code>{" "}
          caché dedans l'est reviendrait à interpréter du shell arbitraire, et deviner donnerait une assurance
          fausse. Passez sur « toujours » si cette étape doit s'arrêter pour demander.
        </p>
      )}

      <textarea
        value={step.notes}
        onChange={(e) => onChange((s) => ({ ...s, notes: e.target.value }))}
        placeholder="Notes : le pourquoi, le ticket, ce qu'il faut vérifier avant de continuer"
        rows={step.notes ? 3 : 1}
        className="ml-6 mt-1.5 w-[calc(100%-1.5rem)] resize-y rounded border border-[var(--c-border)] bg-[var(--c-bg3)] px-1.5 py-1 text-[11px] text-[var(--c-text-muted)]"
      />

      {/* ── Résultats de l'exécution ──────────────────────────────────── */}
      {state && (state.status !== "waiting" || state.skipped.length > 0) && (
        <div className="ml-6 mt-2 space-y-1">
          {state.stopReason && (
            <p className="rounded bg-[#ef444411] px-1.5 py-1 text-[10px] text-[#ef4444]">Arrêt : {state.stopReason}</p>
          )}
          {state.dropped.length > 0 && (
            <p className="text-[10px] text-[var(--c-text-muted)]">
              Retirées de la suite : {state.dropped.map(labelOf).join(", ")}
            </p>
          )}
          {outcomes.map((o) => {
            const key = fleetTargetKey(o.target);
            const isOpen = expanded.has(`${step.id}:${key}`);
            const body = o.error ?? [o.stdout, o.stderr].filter(Boolean).join("\n");
            return (
              <div key={key} className="rounded border border-[var(--c-border)] bg-[var(--c-bg3)]">
                <button
                  onClick={() => onToggleExpanded(`${step.id}:${key}`)}
                  className="flex w-full items-center gap-2 px-1.5 py-1 text-left text-[11px]"
                >
                  <StatusDot state={outcomeFailed(o) ? "fail" : "ok"} />
                  <span className="text-[var(--c-text)]">{labelOf(o.target)}</span>
                  <span className="ml-auto text-[10px] text-[var(--c-text-faint)]">
                    {o.error ? "non exécutée" : `code ${o.exitCode}`} · {o.durationMs} ms
                  </span>
                </button>
                {isOpen && body && (
                  <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all border-t border-[var(--c-border)] px-1.5 py-1 font-mono text-[10px] text-[var(--c-text-muted)]">
                    {body}
                  </pre>
                )}
              </div>
            );
          })}
          {state.skipped.map((s) => (
            <div key={fleetTargetKey(s.target)} className="px-1.5 text-[10px] text-[var(--c-text-faint)]">
              {labelOf(s.target)} — non visée : {s.reason}
            </div>
          ))}
          {state.status !== "waiting" && outcomes.length === 0 && state.skipped.length === 0 && (
            <p className="text-[10px] text-[var(--c-text-faint)]">Aucune cible pour cette étape.</p>
          )}
        </div>
      )}
    </div>
  );
}

/** Le corps de l'étape, selon la forme de son action.
 *
 * `switch` fermé par `assertNever` : ajouter une variante à `RunbookAction`
 * sans décider de son rendu devient une erreur `tsc`, et pas un champ qui
 * n'apparaît nulle part (voir `lib/exhaustive.ts`). */
function ActionEditor({ action, onChange }: { action: RunbookAction; onChange: (a: RunbookAction) => void }) {
  switch (action.kind) {
    case "command":
      return (
        <textarea
          value={action.command}
          onChange={(e) => onChange({ kind: "command", command: e.target.value })}
          placeholder="systemctl restart nginx"
          rows={2}
          className="ml-6 mt-1 w-[calc(100%-1.5rem)] resize-y rounded border border-[var(--c-border)] bg-[var(--c-bg3)] px-1.5 py-1 font-mono text-[11px] text-[var(--c-text)]"
        />
      );
    case "program":
      return (
        <div className="ml-6 mt-1 w-[calc(100%-1.5rem)]">
          <textarea
            value={action.programText}
            onChange={(e) => onChange({ kind: "program", programText: e.target.value })}
            placeholder={"target os: debian\ninstall-package nginx"}
            rows={3}
            className="w-full resize-y rounded border border-[var(--c-border)] bg-[var(--c-bg3)] px-1.5 py-1 font-mono text-[11px] text-[var(--c-text)]"
          />
          <p className="mt-0.5 text-[10px] text-[var(--c-text-faint)]">
            Résolu par machine selon sa plateforme. Hôtes SSH uniquement — les conteneurs et le terminal local
            sont indiqués « non visés » dans le rapport plutôt qu'écartés en silence.
          </p>
        </div>
      );
    default:
      return assertNever(action, "action d'étape de runbook");
  }
}
