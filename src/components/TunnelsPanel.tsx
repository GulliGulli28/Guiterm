import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type { Host, HostId, PortForward, PortForwardId, PortForwardKind, Workspace } from "../lib/types";
import { IconPlus, IconClose, IconTrash, IconEdit } from "./ui-icons";

/** Ce qu'un tunnel vaut dans le formulaire — les ports y sont du texte, parce
 * qu'un champ vidé au clavier n'est pas le port 0. */
interface TunnelDraft {
  hostId: HostId;
  kind: PortForwardKind;
  bindAddress: string;
  bindPort: string;
  destAddress: string;
  destPort: string;
}

interface TunnelsPanelProps {
  workspace: Workspace;
  onAddForward: (input: { hostId: HostId; kind: PortForwardKind; bindAddress: string; bindPort: number; destAddress: string; destPort: number }) => void;
  onUpdateForward: (input: { id: PortForwardId; hostId: HostId; kind: PortForwardKind; bindAddress: string; bindPort: number; destAddress: string; destPort: number }) => Promise<unknown>;
  onDeleteForward: (id: PortForwardId) => void;
  onError: (message: string) => void;
}

function emptyDraft(hostId: HostId): TunnelDraft {
  return { hostId, kind: "local", bindAddress: "127.0.0.1", bindPort: "", destAddress: "127.0.0.1", destPort: "" };
}

function draftOf(forward: PortForward): TunnelDraft {
  return {
    hostId: forward.hostId,
    kind: forward.kind,
    bindAddress: forward.bindAddress,
    bindPort: String(forward.bindPort),
    destAddress: forward.destAddress,
    destPort: String(forward.destPort),
  };
}

/** Les champs d'un tunnel, partagés par l'ajout et la modification.
 *
 * Un seul formulaire pour les deux : c'est exactement le même jeu de six
 * décisions, et deux copies auraient dérivé au premier champ ajouté. Ce qui
 * change d'un cas à l'autre tient dans le libellé du bouton et la présence de
 * « Supprimer ». */
function TunnelForm({
  hosts,
  draft,
  onChange,
  onSubmit,
  onCancel,
  onDelete,
  submitLabel,
  busy,
}: {
  hosts: Host[];
  draft: TunnelDraft;
  onChange: (next: TunnelDraft) => void;
  onSubmit: () => void;
  onCancel: () => void;
  /** Absent à l'ajout : il n'y a rien à supprimer tant que rien n'existe. */
  onDelete?: () => void;
  submitLabel: string;
  busy?: boolean;
}) {
  const set = <K extends keyof TunnelDraft>(key: K, value: TunnelDraft[K]) =>
    onChange({ ...draft, [key]: value });
  const isDynamic = draft.kind === "dynamic";

  return (
    <div className="mt-2 space-y-1.5 rounded-xl bg-[var(--c-bg3)] p-2.5">
      <select value={draft.hostId} onChange={(e) => set("hostId", e.target.value as HostId)} className={selectClass}>
        {hosts.map((h) => (
          <option key={h.id} value={h.id}>{h.label}</option>
        ))}
      </select>
      <select value={draft.kind} onChange={(e) => set("kind", e.target.value as PortForwardKind)} className={selectClass}>
        <option value="local">Local (-L)</option>
        <option value="remote">Distant (-R)</option>
        <option value="dynamic">SOCKS dynamique (-D)</option>
      </select>
      <div className="flex gap-1.5">
        <input value={draft.bindAddress} onChange={(e) => set("bindAddress", e.target.value)} placeholder="Locale" className={`${inputClass} min-w-0 flex-1 font-mono`} />
        <input value={draft.bindPort} onChange={(e) => set("bindPort", e.target.value)} placeholder="Port" inputMode="numeric" className={`${inputClass} w-16 shrink-0 font-mono`} />
      </div>
      {isDynamic ? (
        <p className="px-0.5 text-[11px] leading-relaxed text-[var(--c-text-muted)]">
          Proxy SOCKS5 : la destination est choisie par chaque application qui s'y connecte, pas de « distante » fixe.
        </p>
      ) : (
        <div className="flex gap-1.5">
          <input value={draft.destAddress} onChange={(e) => set("destAddress", e.target.value)} placeholder="Distante" className={`${inputClass} min-w-0 flex-1 font-mono`} />
          <input value={draft.destPort} onChange={(e) => set("destPort", e.target.value)} placeholder="Port" inputMode="numeric" className={`${inputClass} w-16 shrink-0 font-mono`} />
        </div>
      )}
      <div className="flex gap-1.5">
        <button onClick={onSubmit} disabled={busy} className="accent-surface flex-1 rounded-md border py-1.5 text-xs font-medium disabled:opacity-50">
          {busy ? "…" : submitLabel}
        </button>
        <button
          onClick={onCancel}
          className="flex items-center justify-center rounded-md bg-[var(--c-bg2)] px-2.5 py-1.5 text-xs text-[var(--c-text-secondary)] hover:bg-white/5"
        >
          <IconClose size={12} />
        </button>
      </div>
      {onDelete && (
        <button
          onClick={onDelete}
          className="flex w-full items-center justify-center gap-1.5 rounded-md bg-[var(--c-bg2)] py-1.5 text-xs text-rose-400 hover:bg-rose-900/60"
        >
          <IconTrash size={11} /> Supprimer ce tunnel
        </button>
      )}
    </div>
  );
}

export function TunnelsPanel({ workspace, onAddForward, onUpdateForward, onDeleteForward, onError }: TunnelsPanelProps) {
  const [running, setRunning] = useState<Set<PortForwardId>>(new Set());
  const [busy, setBusy] = useState<Set<PortForwardId>>(new Set());
  const [showForm, setShowForm] = useState(false);
  const [addDraft, setAddDraft] = useState<TunnelDraft>(() => emptyDraft(workspace.hosts[0]?.id ?? ("" as HostId)));
  /** Le tunnel en cours de modification, et son brouillon. Un seul à la fois :
   * la fiche modifiée remplace sa propre ligne, donc deux formulaires ouverts
   * n'auraient nulle part où s'afficher. */
  const [editing, setEditing] = useState<{ id: PortForwardId; draft: TunnelDraft } | null>(null);

  const refreshRunning = () => api.runningForwards().then((ids) => setRunning(new Set(ids)));

  useEffect(() => {
    refreshRunning();
  }, [workspace.portForwards]);

  const toggle = async (id: PortForwardId) => {
    setBusy((prev) => new Set(prev).add(id));
    try {
      if (running.has(id)) await api.stopForward(id);
      else await api.startForward(id);
      await refreshRunning();
    } catch (e) {
      onError(String(e));
    } finally {
      setBusy((prev) => { const next = new Set(prev); next.delete(id); return next; });
    }
  };

  /** Les six champs en valeurs utilisables, ou `null` en nommant ce qui cloche. */
  const readDraft = (draft: TunnelDraft) => {
    const isDynamic = draft.kind === "dynamic";
    const bindPort = Number(draft.bindPort);
    const destPort = isDynamic ? 0 : Number(draft.destPort);
    if (!draft.hostId || !draft.bindAddress.trim() || !Number.isInteger(bindPort) ||
        (!isDynamic && (!draft.destAddress.trim() || !Number.isInteger(destPort)))) {
      return null;
    }
    return {
      hostId: draft.hostId,
      kind: draft.kind,
      bindAddress: draft.bindAddress.trim(),
      bindPort,
      destAddress: isDynamic ? "" : draft.destAddress.trim(),
      destPort,
    };
  };

  const submitAdd = () => {
    const values = readDraft(addDraft);
    if (!values) { onError("Champs de tunnel invalides"); return; }
    onAddForward(values);
    setAddDraft(emptyDraft(addDraft.hostId));
    setShowForm(false);
  };

  const submitEdit = async () => {
    if (!editing) return;
    const values = readDraft(editing.draft);
    if (!values) { onError("Champs de tunnel invalides"); return; }
    const { id } = editing;
    // Relancé seulement s'il tournait avant la modification : `update_forward`
    // arrête toujours la session, et redémarrer un tunnel que l'utilisateur
    // avait laissé à l'arrêt le surprendrait autant que l'inverse.
    const wasRunning = running.has(id);
    setBusy((prev) => new Set(prev).add(id));
    try {
      await onUpdateForward({ id, ...values });
      setEditing(null);
      if (wasRunning) await api.startForward(id);
    } catch (e) {
      onError(String(e));
    } finally {
      setBusy((prev) => { const next = new Set(prev); next.delete(id); return next; });
      await refreshRunning();
    }
  };

  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className="sidebar-scroll min-h-0 min-w-0 flex-1 space-y-2 overflow-y-auto pb-2 pl-2 pt-2">
        <div>
          <button
            onClick={() => { setShowForm((v) => !v); setEditing(null); }}
            className={`accent-surface flex w-full items-center justify-center gap-1.5 rounded-xl border py-2 text-xs font-semibold transition-all ${
              showForm ? "ring-2 ring-white/25" : ""
            }`}
          >
            <IconPlus size={13} /> Ajouter un tunnel
          </button>
          {showForm && (
            <TunnelForm
              hosts={workspace.hosts}
              draft={addDraft}
              onChange={setAddDraft}
              onSubmit={submitAdd}
              onCancel={() => setShowForm(false)}
              submitLabel="Ajouter"
            />
          )}
        </div>
        {workspace.portForwards.map((forward) => {
          const hostLabel = workspace.hosts.find((h) => h.id === forward.hostId)?.label ?? "?";
          const isRunning = running.has(forward.id);
          const isBusy = busy.has(forward.id);
          const isEditing = editing?.id === forward.id;
          return (
            <div key={forward.id} className="rounded-xl border border-transparent bg-[var(--c-bg3)] p-2.5 transition-all hover:border-white/15">
              <p className="text-xs font-medium text-[var(--c-text-secondary)]">
                {forward.kind === "local" ? "Local" : forward.kind === "remote" ? "Distant" : "SOCKS"}{" "}
                <span className="font-mono text-[var(--c-text)]">{forward.bindAddress}:{forward.bindPort}</span>
                {forward.kind !== "dynamic" && (
                  <>
                    {" → "}
                    <span className="font-mono text-[var(--c-text)]">{forward.destAddress}:{forward.destPort}</span>
                  </>
                )}
              </p>
              <p className="mt-0.5 text-[10px] text-[var(--c-text-muted)]">{hostLabel}</p>
              <div className="mt-2 flex flex-wrap gap-1">
                <button
                  disabled={isBusy}
                  onClick={() => toggle(forward.id)}
                  className={`flex flex-1 basis-[80px] items-center justify-center rounded-md border px-1.5 py-1.5 text-xs font-medium text-white disabled:opacity-50 ${
                    isRunning ? "border-transparent bg-rose-700 hover:bg-rose-600" : "accent-surface"
                  }`}
                >
                  {isRunning ? "Arrêter" : "Démarrer"}
                </button>
                <button
                  onClick={() => {
                    setShowForm(false);
                    setEditing(isEditing ? null : { id: forward.id, draft: draftOf(forward) });
                  }}
                  className={`flex flex-1 basis-[80px] items-center justify-center gap-1.5 rounded-md px-1.5 py-1.5 text-xs text-[var(--c-text-secondary)] hover:bg-white/5 ${
                    isEditing ? "bg-[var(--c-bg2)] ring-1 ring-white/20" : "bg-[var(--c-bg2)]"
                  }`}
                >
                  <IconEdit size={11} /> Modifier
                </button>
              </div>
              {isEditing && (
                <>
                  {isRunning && (
                    <p className="mt-2 px-0.5 text-[10px] leading-relaxed text-[var(--c-text-muted)]">
                      Ce tunnel tourne : l'enregistrement l'arrête puis le relance avec la nouvelle
                      configuration. Les connexions en cours seront coupées.
                    </p>
                  )}
                  <TunnelForm
                    hosts={workspace.hosts}
                    draft={editing.draft}
                    onChange={(draft) => setEditing({ id: forward.id, draft })}
                    onSubmit={submitEdit}
                    onCancel={() => setEditing(null)}
                    onDelete={() => { setEditing(null); onDeleteForward(forward.id); }}
                    submitLabel="Enregistrer"
                    busy={isBusy}
                  />
                </>
              )}
            </div>
          );
        })}
        {workspace.portForwards.length === 0 && (
          <p className="px-1 py-4 text-center text-[13px] text-[var(--c-text-muted)]">Aucun tunnel configuré</p>
        )}
      </div>
    </div>
  );
}

// No `w-full` here: every call site pairs this with its own `flex-1`/`w-16`
// sizing in a flex row, and a baked-in `w-full` fights those utilities
// (both are "width", so whichever Tailwind emits last in the stylesheet
// wins — unrelated to source order in the className string).
const inputClass = "rounded-md bg-[var(--c-bg2)] px-2 py-1.5 text-[13px] text-[var(--c-text)] placeholder:text-[var(--c-text-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--c-accent)]";
const selectClass = "w-full rounded-md bg-[var(--c-bg2)] px-2 py-1.5 text-[13px] text-[var(--c-text)] focus:outline-none focus:ring-1 focus:ring-[var(--c-accent)]";
