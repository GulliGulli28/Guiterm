import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import type { Runbook, RunbookId, Workspace } from "../lib/types";
import { IconPlus, IconPlay, IconTrash, IconDownload } from "./ui-icons";

interface RunbookPanelProps {
  workspace: Workspace;
  /** Ouvre (ou ramène au premier plan) l'onglet de cette procédure. */
  onOpen: (runbookId: RunbookId) => void;
  onCreate: (name: string) => void;
  onDelete: (runbookId: RunbookId) => void;
  /** Combien de cibles sont cochées, et de quoi aller les changer. Les
   * runbooks partagent la sélection des opérations de flotte — voir
   * `modules/runbook.tsx` pour pourquoi il n'y en a pas une deuxième. */
  selectedTargets: number;
  onShowTargets: () => void;
  /** Relire un fichier de runbook. Le chemin arrive du sélecteur natif — le
   * panneau ne lit rien lui-même. */
  onImport: (path: string) => void;
}

/**
 * La liste des procédures, dans la barre latérale.
 *
 * Même découpage que la flotte : la barre choisit *quoi* et *sur qui*,
 * l'onglet compose et exécute. Ce panneau ne contient donc pas d'arborescence
 * de cibles — il renvoie vers celle des opérations de flotte, qui est
 * littéralement la même sélection.
 */
export function RunbookPanel({
  workspace, onOpen, onCreate, onDelete, selectedTargets, onShowTargets, onImport,
}: RunbookPanelProps) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [confirming, setConfirming] = useState<RunbookId | null>(null);

  const create = () => {
    if (!name.trim()) return;
    onCreate(name.trim());
    setName("");
    setCreating(false);
  };

  return (
    <div className="flex h-full min-w-0 flex-col gap-2">
      <div className="flex items-center justify-between px-1">
        <span className="text-xs font-semibold uppercase tracking-wide text-[var(--c-text-secondary)]">
          Runbooks · {workspace.runbooks.length}
        </span>
        <div className="flex items-center gap-0.5">
          <button
            onClick={async () => {
              const path = await open({
                multiple: false,
                filters: [{ name: "Runbook", extensions: ["json"] }],
              }).catch(() => null);
              if (typeof path === "string") onImport(path);
            }}
            title="Importer un runbook depuis un fichier"
            className="rounded px-1.5 py-0.5 text-[var(--c-text-muted)] hover:bg-[var(--c-bg3)]"
          >
            <IconDownload size={14} />
          </button>
          <button
            onClick={() => setCreating((v) => !v)}
            title="Nouvelle procédure"
            className="rounded px-1.5 py-0.5 text-[var(--c-accent-text)] hover:bg-[var(--c-bg3)]"
          >
            <IconPlus size={14} />
          </button>
        </div>
      </div>

      {/* Les cibles ne sont pas dans ce panneau, et le dire vaut mieux que de
          laisser quelqu'un lancer une procédure sur zéro machine. */}
      <button
        onClick={onShowTargets}
        className="mx-1 rounded-md border border-[var(--c-border)] bg-[var(--c-bg3)] px-2 py-1.5 text-left text-[11px] text-[var(--c-text-muted)] hover:border-[var(--c-accent)]"
      >
        Cibles : <span className="font-semibold text-[var(--c-text)]">{selectedTargets}</span> sélectionnée
        {selectedTargets > 1 ? "s" : ""} — les mêmes que les opérations de flotte. Cliquer pour les changer.
      </button>

      {creating && (
        <div className="mx-1 flex gap-1">
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") create();
              if (e.key === "Escape") setCreating(false);
            }}
            placeholder="Nom de la procédure"
            className="min-w-0 flex-1 rounded border border-[var(--c-border)] bg-[var(--c-bg2)] px-2 py-1 text-xs"
          />
          <button onClick={create} className="rounded bg-[var(--c-accent)] px-2 py-1 text-xs text-white">
            Créer
          </button>
        </div>
      )}

      <div className="sidebar-scroll min-h-0 flex-1 space-y-1 px-1">
        {workspace.runbooks.length === 0 && !creating && (
          <p className="px-1 py-3 text-[11px] leading-relaxed text-[var(--c-text-faint)]">
            Une procédure est une suite d'étapes lancées dans l'ordre sur les cibles cochées, avec, à chaque
            étape, ce qui se passe si une machine échoue.
          </p>
        )}
        {workspace.runbooks.map((book: Runbook) => (
          <div
            key={book.id}
            className="group rounded-md border border-[var(--c-border)] bg-[var(--c-bg2)] px-2 py-1.5 hover:border-[var(--c-accent)]"
          >
            <div className="flex items-center gap-1.5">
              <button onClick={() => onOpen(book.id)} className="min-w-0 flex-1 text-left">
                <div className="truncate text-xs font-medium text-[var(--c-text)]">{book.name}</div>
                <div className="text-[10px] text-[var(--c-text-faint)]">
                  {book.steps.length} étape{book.steps.length > 1 ? "s" : ""}
                </div>
              </button>
              <button
                onClick={() => onOpen(book.id)}
                title="Ouvrir"
                className="rounded p-1 text-[var(--c-text-muted)] opacity-0 hover:bg-[var(--c-bg3)] group-hover:opacity-100"
              >
                <IconPlay size={13} />
              </button>
              <button
                onClick={() => setConfirming(confirming === book.id ? null : book.id)}
                title="Supprimer"
                className="rounded p-1 text-[var(--c-text-muted)] opacity-0 hover:bg-[var(--c-bg3)] group-hover:opacity-100"
              >
                <IconTrash size={13} />
              </button>
            </div>
            {confirming === book.id && (
              <div className="mt-1.5 flex items-center gap-1.5 text-[11px]">
                <span className="text-[var(--c-text-muted)]">Supprimer « {book.name} » ?</span>
                <button
                  onClick={() => { onDelete(book.id); setConfirming(null); }}
                  className="rounded bg-[#ef4444] px-1.5 py-0.5 text-white"
                >
                  Supprimer
                </button>
                <button onClick={() => setConfirming(null)} className="rounded px-1.5 py-0.5 hover:bg-[var(--c-bg3)]">
                  Annuler
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
