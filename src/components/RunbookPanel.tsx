import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import type { Runbook, RunbookId, Workspace } from "../lib/types";
import { IconPlus, IconTrash, IconDownload, IconFleet, IconRunbook } from "./ui-icons";

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
    <div className="flex h-full min-w-0 flex-col">
      <div className="flex shrink-0 items-center gap-1.5">
        <button onClick={() => setCreating((v) => !v)} className={`btn flex-1 ${creating ? "btn-secondary" : "btn-primary"}`}>
          <IconPlus size={13} /> {creating ? "Annuler" : "Nouvelle procédure"}
        </button>
        <button
          onClick={async () => {
            const path = await open({
              multiple: false,
              filters: [{ name: "Runbook", extensions: ["json"] }],
            }).catch(() => null);
            if (typeof path === "string") onImport(path);
          }}
          title="Importer un runbook depuis un fichier"
          aria-label="Importer un runbook"
          className="btn btn-secondary btn-icon text-[var(--c-text-secondary)]"
        >
          <IconDownload size={14} />
        </button>
      </div>

      {creating && (
        <div className="mt-2 flex gap-1.5">
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") create();
              if (e.key === "Escape") setCreating(false);
            }}
            placeholder="Nom de la procédure"
            className="input min-w-0 flex-1"
          />
          <button onClick={create} className="btn btn-primary">Créer</button>
        </div>
      )}

      {/* Les cibles ne sont pas dans ce panneau, et le dire vaut mieux que de
          laisser quelqu'un lancer une procédure sur zéro machine. */}
      <button onClick={onShowTargets} className="card mt-2 flex items-center gap-2 px-2.5 py-2 text-left transition-colors hover:border-[var(--c-border-strong)]">
        <IconFleet size={14} className="shrink-0 text-[var(--c-text-muted)]" />
        <span className="min-w-0 flex-1 text-[11.5px] leading-snug text-[var(--c-text-muted)]">
          <span className="font-medium text-[var(--c-text)]">{selectedTargets} cible{selectedTargets > 1 ? "s" : ""}</span>
          {" "}— les mêmes que les opérations de flotte. Cliquer pour les changer.
        </span>
      </button>

      <div className="sidebar-scroll -mx-1 mt-2 min-h-0 flex-1 overflow-y-auto px-1 pb-2">
        {workspace.runbooks.length === 0 && !creating && (
          <div className="px-2 py-8 text-center">
            <p className="text-[12.5px] font-medium text-[var(--c-text-secondary)]">Aucune procédure</p>
            <p className="help-text mt-1">
              Une suite d'étapes lancées dans l'ordre sur les cibles cochées, avec, à chaque étape, ce qui se passe si une machine échoue.
            </p>
          </div>
        )}
        {workspace.runbooks.map((book: Runbook) => (
          <div key={book.id} className="list-row group h-10 pr-1">
            <button onClick={() => onOpen(book.id)} className="flex min-w-0 flex-1 items-center gap-2.5 text-left">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-[var(--c-bg3)] text-[var(--c-text-secondary)]">
                <IconRunbook size={13} />
              </span>
              <span className="flex min-w-0 flex-1 flex-col justify-center gap-px leading-tight">
                <span className="truncate text-[12.5px] font-medium text-[var(--c-text)]">{book.name}</span>
                <span className="truncate text-[10.5px] text-[var(--c-text-muted)]">
                  {book.steps.length} étape{book.steps.length > 1 ? "s" : ""}{book.description ? ` · ${book.description}` : ""}
                </span>
              </span>
            </button>
            {confirming === book.id ? (
              <span className="flex shrink-0 items-center gap-1">
                <button onClick={() => setConfirming(null)} className="btn btn-ghost btn-sm">Annuler</button>
                <button onClick={() => { onDelete(book.id); setConfirming(null); }} className="btn btn-danger btn-sm">Supprimer</button>
              </span>
            ) : (
              <button
                onClick={() => setConfirming(book.id)}
                title="Supprimer"
                aria-label={`Supprimer ${book.name}`}
                className="btn btn-ghost btn-sm btn-icon shrink-0 opacity-0 hover:text-[var(--c-danger)] focus-visible:opacity-100 group-hover:opacity-100"
              >
                <IconTrash size={13} />
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
