import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import type { KeyId, PrivateKey, Workspace } from "../lib/types";
import { IconPlus, IconClose, IconTrash, IconEdit, IconKeychain, IconFolder } from "./ui-icons";

interface KeychainPanelProps {
  workspace: Workspace;
  onAddKey: (name: string, path: string, passphrase: string | null) => void;
  onDeleteKey: (id: KeyId) => void;
  onRenameKey: (id: KeyId, name: string) => void;
}

export function KeychainPanel({ workspace, onAddKey, onDeleteKey, onRenameKey }: KeychainPanelProps) {
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [showPassphrase, setShowPassphrase] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editingName, setEditingName] = useState<{ id: KeyId; draft: string } | null>(null);

  const browse = async () => {
    const selected = await open({ title: "Sélectionner une clé privée SSH", multiple: false, directory: false });
    if (selected && typeof selected === "string") {
      setPath(selected);
      if (!name) {
        const parts = selected.replace(/\\/g, "/").split("/");
        setName(parts[parts.length - 1]);
      }
    }
  };

  const submit = () => {
    if (!name.trim()) { setError("Le nom est requis"); return; }
    if (!path.trim()) { setError("Le chemin est requis"); return; }
    setError(null);
    onAddKey(name.trim(), path.trim(), passphrase || null);
    setName("");
    setPath("");
    setPassphrase("");
    setShowForm(false);
  };

  const commitRename = (key: PrivateKey) => {
    if (!editingName) return;
    const trimmed = editingName.draft.trim();
    if (trimmed && trimmed !== key.name) onRenameKey(key.id, trimmed);
    setEditingName(null);
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
            <IconPlus size={13} /> Ajouter une clé
          </button>
          {showForm && (
            <div className="mt-2 space-y-2 rounded-lg bg-[var(--c-bg3)]/40 p-2.5">
              {error && <p className="rounded-md bg-rose-950 px-2 py-1 text-xs text-rose-300">{error}</p>}
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Nom (ex: ma-clé-perso)"
                autoFocus
                className={inputClass}
              />
              <div className="flex gap-1.5">
                <input
                  value={path}
                  onChange={(e) => setPath(e.target.value)}
                  placeholder="Chemin vers la clé privée"
                  className={`${inputClass} min-w-0 flex-1 font-mono`}
                />
                <button
                  onClick={browse}
                  className="flex shrink-0 items-center justify-center rounded-md bg-[var(--c-bg2)] px-2.5 py-1.5 text-[var(--c-text-muted)] hover:bg-white/5 hover:text-[var(--c-text-secondary)]"
                  title="Parcourir"
                >
                  <IconFolder size={14} />
                </button>
              </div>
              <div className="flex gap-1.5">
                <input
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                  type={showPassphrase ? "text" : "password"}
                  placeholder="Passphrase (optionnelle)"
                  className={`${inputClass} min-w-0 flex-1`}
                />
                <button
                  onClick={() => setShowPassphrase((v) => !v)}
                  className="shrink-0 rounded-md bg-[var(--c-bg2)] px-2.5 py-1.5 text-xs text-[var(--c-text-muted)] hover:bg-white/5"
                >
                  {showPassphrase ? "Cacher" : "Voir"}
                </button>
              </div>
              <div className="flex gap-1.5">
                <button
                  onClick={submit}
                  className="flex-1 rounded-md bg-[var(--c-accent)] py-1.5 text-xs font-medium text-white hover:bg-[var(--c-accent-hover)]"
                >
                  Enregistrer
                </button>
                <button
                  onClick={() => { setShowForm(false); setError(null); setName(""); setPath(""); setPassphrase(""); }}
                  className="flex items-center justify-center rounded-md bg-[var(--c-bg2)] px-2.5 py-1.5 text-[var(--c-text-secondary)] hover:bg-white/5"
                >
                  <IconClose size={12} />
                </button>
              </div>
            </div>
          )}
        </div>
        {workspace.keychain.length === 0 && (
          <p className="px-1 py-4 text-center text-[13px] text-[var(--c-text-muted)]">Aucune clé enregistrée</p>
        )}
        {workspace.keychain.map((key: PrivateKey) => (
          <div key={key.id} className="group rounded-lg bg-[var(--c-bg3)]/40 p-2.5 transition-colors hover:bg-[var(--c-bg3)]">
            <div className="flex items-center gap-2">
              <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-[var(--c-accent-dim)]">
                <IconKeychain size={13} className="text-[var(--c-accent-text)]" />
              </div>
              <div className="min-w-0 flex-1">
                {editingName?.id === key.id ? (
                  <input
                    value={editingName.draft}
                    onChange={(e) => setEditingName({ id: key.id, draft: e.target.value })}
                    onBlur={() => commitRename(key)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitRename(key);
                      if (e.key === "Escape") setEditingName(null);
                    }}
                    autoFocus
                    className="w-full rounded-md bg-[var(--c-bg2)] px-1.5 py-0.5 text-[14px] font-medium text-[var(--c-text)] focus:outline-none focus:ring-1 focus:ring-[var(--c-accent)]"
                  />
                ) : (
                  <p className="truncate text-[14px] font-medium text-[var(--c-text)]">{key.name}</p>
                )}
                {key.content ? (
                  <p className="mt-0.5 text-[10px] text-emerald-500">Contenu intégré ✓</p>
                ) : (
                  <p className="mt-0.5 truncate font-mono text-[10px] text-[var(--c-text-muted)]" title={key.path}>{key.path}</p>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100">
                <button
                  onClick={() => setEditingName({ id: key.id, draft: key.name })}
                  title="Renommer"
                  className="flex items-center rounded p-1 text-[var(--c-text-muted)] hover:bg-white/5 hover:text-[var(--c-text-secondary)]"
                >
                  <IconEdit size={12} />
                </button>
                <button
                  onClick={() => onDeleteKey(key.id)}
                  title="Supprimer"
                  className="flex items-center rounded p-1 text-[var(--c-text-muted)] hover:bg-rose-900/60 hover:text-rose-300"
                >
                  <IconTrash size={12} />
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

const inputClass = "w-full rounded-md bg-[var(--c-bg2)] px-2 py-1.5 text-[13px] text-[var(--c-text)] placeholder:text-[var(--c-text-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--c-accent)]";
