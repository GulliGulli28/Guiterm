import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { api } from "../lib/api";
import type { HostId, KeyAlgorithm, KeyId, PrivateKey, Workspace } from "../lib/types";
import { IconPlus, IconClose, IconTrash, IconEdit, IconKeychain, IconFolder, IconCopy, IconUpload } from "./ui-icons";

interface KeychainPanelProps {
  workspace: Workspace;
  onAddKey: (name: string, path: string, passphrase: string | null) => void;
  onGenerateKey: (name: string, algorithm: KeyAlgorithm, passphrase: string | null) => void;
  onDeleteKey: (id: KeyId) => void;
  onRenameKey: (id: KeyId, name: string) => void;
}

export function KeychainPanel({ workspace, onAddKey, onGenerateKey, onDeleteKey, onRenameKey }: KeychainPanelProps) {
  const [mode, setMode] = useState<"import" | "generate">("import");
  const [algorithm, setAlgorithm] = useState<KeyAlgorithm>("ed25519");
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [showPassphrase, setShowPassphrase] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editingName, setEditingName] = useState<{ id: KeyId; draft: string } | null>(null);

  const [copiedKeyId, setCopiedKeyId] = useState<KeyId | null>(null);
  const [copyError, setCopyError] = useState<{ id: KeyId; text: string } | null>(null);
  const [deployingKeyId, setDeployingKeyId] = useState<KeyId | null>(null);
  const [deployHostId, setDeployHostId] = useState<HostId>("");
  const [deployBusy, setDeployBusy] = useState(false);
  const [deployResult, setDeployResult] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

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

  const resetForm = () => {
    setShowForm(false);
    setError(null);
    setName("");
    setPath("");
    setPassphrase("");
  };

  const submit = () => {
    if (!name.trim()) { setError("Le nom est requis"); return; }
    if (mode === "import") {
      if (!path.trim()) { setError("Le chemin est requis"); return; }
      onAddKey(name.trim(), path.trim(), passphrase || null);
    } else {
      onGenerateKey(name.trim(), algorithm, passphrase || null);
    }
    resetForm();
  };

  const commitRename = (key: PrivateKey) => {
    if (!editingName) return;
    const trimmed = editingName.draft.trim();
    if (trimmed && trimmed !== key.name) onRenameKey(key.id, trimmed);
    setEditingName(null);
  };

  const copyPublicKey = async (key: PrivateKey) => {
    setCopyError(null);
    try {
      const publicKey = await api.getPublicKey(key.id);
      await writeText(publicKey);
      setCopiedKeyId(key.id);
      setTimeout(() => setCopiedKeyId((id) => (id === key.id ? null : id)), 1500);
    } catch (e) {
      setCopyError({ id: key.id, text: String(e) });
    }
  };

  const startDeploy = (key: PrivateKey) => {
    setDeployingKeyId(key.id);
    setDeployHostId(workspace.hosts[0]?.id ?? "");
    setDeployResult(null);
  };

  const confirmDeploy = async (key: PrivateKey) => {
    if (!deployHostId) return;
    setDeployBusy(true);
    setDeployResult(null);
    try {
      await api.deployPublicKey(deployHostId, key.id);
      setDeployResult({ kind: "ok", text: "Clé déployée ✓" });
    } catch (e) {
      setDeployResult({ kind: "err", text: String(e) });
    } finally {
      setDeployBusy(false);
    }
  };

  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className="sidebar-scroll min-h-0 min-w-0 flex-1 space-y-2 overflow-y-auto pb-2 pl-2 pt-2">
        {/* Add form at top */}
        <div>
          <button
            onClick={() => (showForm ? resetForm() : setShowForm(true))}
            className={`accent-surface flex w-full items-center justify-center gap-1.5 rounded-xl border py-2 text-xs font-semibold transition-all ${
              showForm ? "ring-2 ring-white/25" : ""
            }`}
          >
            <IconPlus size={13} /> Ajouter une clé
          </button>
          {showForm && (
            <div className="mt-2 space-y-2 rounded-xl bg-[var(--c-bg3)] p-2.5">
              {error && <p className="rounded-md bg-rose-950 px-2 py-1 text-xs text-rose-300">{error}</p>}
              <div className="flex gap-1.5 rounded-md bg-[var(--c-bg2)] p-1">
                {([["import", "Importer"], ["generate", "Générer"]] as [typeof mode, string][]).map(([m, label]) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setMode(m)}
                    className={`flex-1 rounded border py-1 text-xs font-medium transition-all ${
                      mode === m ? "accent-surface" : "border-transparent text-[var(--c-text-secondary)] hover:bg-white/5"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Nom (ex: ma-clé-perso)"
                autoFocus
                className={`${inputClass} w-full`}
              />
              {mode === "import" ? (
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
              ) : (
                <div className="flex gap-1.5">
                  {([["ed25519", "Ed25519"], ["rsa", "RSA (4096)"]] as [KeyAlgorithm, string][]).map(([a, label]) => (
                    <button
                      key={a}
                      type="button"
                      onClick={() => setAlgorithm(a)}
                      className={`flex-1 rounded-md border py-1.5 text-xs font-medium transition-all ${
                        algorithm === a ? "accent-surface" : "border-transparent bg-[var(--c-bg2)] text-[var(--c-text-secondary)] hover:bg-white/5"
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              )}
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
                  className="accent-surface flex-1 rounded-md border py-1.5 text-xs font-medium"
                >
                  {mode === "import" ? "Enregistrer" : "Générer"}
                </button>
                <button
                  onClick={resetForm}
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
          <div key={key.id} className="group rounded-xl border border-transparent bg-[var(--c-bg3)] p-2.5 transition-all hover:border-white/15">
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
                  onClick={() => copyPublicKey(key)}
                  title="Copier la clé publique"
                  className="flex items-center rounded p-1 text-[var(--c-text-muted)] hover:bg-white/5 hover:text-[var(--c-text-secondary)]"
                >
                  {copiedKeyId === key.id ? <span className="px-0.5 text-[11px] font-medium text-emerald-400">✓</span> : <IconCopy size={12} />}
                </button>
                <button
                  onClick={() => (deployingKeyId === key.id ? setDeployingKeyId(null) : startDeploy(key))}
                  title="Déployer sur un hôte"
                  className="flex items-center rounded p-1 text-[var(--c-text-muted)] hover:bg-white/5 hover:text-[var(--c-text-secondary)]"
                >
                  <IconUpload size={12} />
                </button>
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
            {copyError?.id === key.id && (
              <p className="mt-1.5 rounded-md bg-rose-950 px-2 py-1 text-[11px] text-rose-300">{copyError.text}</p>
            )}
            {deployingKeyId === key.id && (
              <div className="mt-2 space-y-1.5 border-t border-white/10 pt-2">
                <select value={deployHostId} onChange={(e) => setDeployHostId(e.target.value)} className={selectClass}>
                  {workspace.hosts.length === 0 && <option value="">Aucun hôte</option>}
                  {workspace.hosts.map((h) => (
                    <option key={h.id} value={h.id}>{h.label}</option>
                  ))}
                </select>
                {deployResult && (
                  <p className={`rounded-md px-2 py-1 text-[11px] ${deployResult.kind === "ok" ? "bg-emerald-950 text-emerald-300" : "bg-rose-950 text-rose-300"}`}>
                    {deployResult.text}
                  </p>
                )}
                <div className="flex gap-1.5">
                  <button
                    disabled={deployBusy || !deployHostId}
                    onClick={() => confirmDeploy(key)}
                    className="accent-surface flex-1 rounded-md border py-1.5 text-xs font-medium disabled:opacity-50"
                  >
                    {deployBusy ? "Déploiement…" : "Déployer"}
                  </button>
                  <button
                    onClick={() => setDeployingKeyId(null)}
                    className="flex items-center justify-center rounded-md bg-[var(--c-bg2)] px-2.5 py-1.5 text-[var(--c-text-secondary)] hover:bg-white/5"
                  >
                    <IconClose size={12} />
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// No `w-full` here: two of the three call sites pair this with their own
// `flex-1` sizing in a flex row, and a baked-in `w-full` fights that (both
// are "width" utilities of equal specificity — whichever Tailwind emits
// last in the stylesheet wins, regardless of source order in the
// className string). The lone standalone usage adds `w-full` itself.
const inputClass = "rounded-md bg-[var(--c-bg2)] px-2 py-1.5 text-[13px] text-[var(--c-text)] placeholder:text-[var(--c-text-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--c-accent)]";
const selectClass = "w-full rounded-md bg-[var(--c-bg2)] px-2 py-1.5 text-[13px] text-[var(--c-text)] focus:outline-none focus:ring-1 focus:ring-[var(--c-accent)]";
