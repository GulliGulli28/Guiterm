import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type { HostId, PortForwardId, PortForwardKind, Workspace } from "../lib/types";
import { IconPlus, IconClose, IconTrash } from "./ui-icons";

interface TunnelsPanelProps {
  workspace: Workspace;
  onAddForward: (input: { hostId: HostId; kind: PortForwardKind; bindAddress: string; bindPort: number; destAddress: string; destPort: number }) => void;
  onDeleteForward: (id: PortForwardId) => void;
  onError: (message: string) => void;
}

export function TunnelsPanel({ workspace, onAddForward, onDeleteForward, onError }: TunnelsPanelProps) {
  const [running, setRunning] = useState<Set<PortForwardId>>(new Set());
  const [hostId, setHostId] = useState<HostId>(workspace.hosts[0]?.id ?? "");
  const [kind, setKind] = useState<PortForwardKind>("local");
  const [bindAddress, setBindAddress] = useState("127.0.0.1");
  const [bindPort, setBindPort] = useState("");
  const [destAddress, setDestAddress] = useState("127.0.0.1");
  const [destPort, setDestPort] = useState("");
  const [busy, setBusy] = useState<Set<PortForwardId>>(new Set());
  const [showForm, setShowForm] = useState(false);

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

  const submit = () => {
    const bp = Number(bindPort);
    const dp = Number(destPort);
    if (!hostId || !bindAddress.trim() || !destAddress.trim() || !Number.isInteger(bp) || !Number.isInteger(dp)) {
      onError("Champs de tunnel invalides");
      return;
    }
    onAddForward({ hostId, kind, bindAddress: bindAddress.trim(), bindPort: bp, destAddress: destAddress.trim(), destPort: dp });
    setBindPort("");
    setDestPort("");
    setShowForm(false);
  };

  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className="sidebar-scroll min-h-0 min-w-0 flex-1 space-y-2 overflow-y-auto">
        {/* Add form at top */}
        <div>
          <button
            onClick={() => setShowForm((v) => !v)}
            className={`flex w-full items-center justify-center gap-1.5 rounded-md border py-1.5 text-xs font-medium transition-colors ${
              showForm
                ? "border-[var(--c-accent)] bg-[var(--c-accent-dim)] text-[var(--c-accent-text)]"
                : "border-dashed border-[var(--c-border)] text-[var(--c-text-muted)] hover:border-[var(--c-accent)] hover:text-[var(--c-accent-text)]"
            }`}
          >
            <IconPlus size={13} /> Ajouter un tunnel
          </button>
          {showForm && (
            <div className="mt-2 space-y-1.5 rounded-lg bg-[var(--c-bg3)]/40 p-2.5">
              <select value={hostId} onChange={(e) => setHostId(e.target.value)} className={selectClass}>
                {workspace.hosts.map((h) => (
                  <option key={h.id} value={h.id}>{h.label}</option>
                ))}
              </select>
              <select value={kind} onChange={(e) => setKind(e.target.value as PortForwardKind)} className={selectClass}>
                <option value="local">Local (-L)</option>
                <option value="remote">Distant (-R)</option>
              </select>
              <div className="flex gap-1.5">
                <input value={bindAddress} onChange={(e) => setBindAddress(e.target.value)} placeholder="Locale" className={`${inputClass} min-w-0 flex-1 font-mono`} />
                <input value={bindPort} onChange={(e) => setBindPort(e.target.value)} placeholder="Port" inputMode="numeric" className={`${inputClass} w-16 shrink-0 font-mono`} />
              </div>
              <div className="flex gap-1.5">
                <input value={destAddress} onChange={(e) => setDestAddress(e.target.value)} placeholder="Distante" className={`${inputClass} min-w-0 flex-1 font-mono`} />
                <input value={destPort} onChange={(e) => setDestPort(e.target.value)} placeholder="Port" inputMode="numeric" className={`${inputClass} w-16 shrink-0 font-mono`} />
              </div>
              <div className="flex gap-1.5">
                <button onClick={submit} className="flex-1 rounded-md bg-[var(--c-accent)] py-1.5 text-xs font-medium text-white hover:bg-[var(--c-accent-hover)]">
                  Ajouter
                </button>
                <button
                  onClick={() => setShowForm(false)}
                  className="flex items-center justify-center rounded-md bg-[var(--c-bg2)] px-2.5 py-1.5 text-xs text-[var(--c-text-secondary)] hover:bg-white/5"
                >
                  <IconClose size={12} />
                </button>
              </div>
            </div>
          )}
        </div>
        {workspace.portForwards.map((forward) => {
          const hostLabel = workspace.hosts.find((h) => h.id === forward.hostId)?.label ?? "?";
          const isRunning = running.has(forward.id);
          const isBusy = busy.has(forward.id);
          return (
            <div key={forward.id} className="rounded-lg bg-[var(--c-bg3)]/40 p-2.5">
              <p className="text-xs font-medium text-[var(--c-text-secondary)]">
                {forward.kind === "local" ? "Local" : "Distant"}{" "}
                <span className="font-mono text-[var(--c-text)]">{forward.bindAddress}:{forward.bindPort}</span>
                {" → "}
                <span className="font-mono text-[var(--c-text)]">{forward.destAddress}:{forward.destPort}</span>
              </p>
              <p className="mt-0.5 text-[10px] text-[var(--c-text-muted)]">{hostLabel}</p>
              <div className="mt-2 flex flex-wrap gap-1">
                <button
                  disabled={isBusy}
                  onClick={() => toggle(forward.id)}
                  className={`flex flex-1 basis-[80px] items-center justify-center rounded-md px-1.5 py-1.5 text-xs font-medium text-white disabled:opacity-50 ${
                    isRunning ? "bg-rose-700 hover:bg-rose-600" : "bg-[var(--c-accent)] hover:bg-[var(--c-accent-hover)]"
                  }`}
                >
                  {isRunning ? "Arrêter" : "Démarrer"}
                </button>
                <button
                  onClick={() => onDeleteForward(forward.id)}
                  className="flex flex-1 basis-[80px] items-center justify-center gap-1.5 rounded-md bg-[var(--c-bg2)] px-1.5 py-1.5 text-xs text-rose-400 hover:bg-rose-900/60"
                >
                  <IconTrash size={11} /> Supprimer
                </button>
              </div>
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

const inputClass = "w-full rounded-md bg-[var(--c-bg2)] px-2 py-1.5 text-[13px] text-[var(--c-text)] placeholder:text-[var(--c-text-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--c-accent)]";
const selectClass = "w-full rounded-md bg-[var(--c-bg2)] px-2 py-1.5 text-[13px] text-[var(--c-text)] focus:outline-none focus:ring-1 focus:ring-[var(--c-accent)]";
