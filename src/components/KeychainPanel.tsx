import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { api } from "../lib/api";
import type { HostId, KeyAlgorithm, KeyId, PrivateKey, Workspace } from "../lib/types";
import { IconPlus, IconTrash, IconEdit, IconKeychain, IconFolder, IconCopy, IconUpload, IconEye, IconEyeOff, IconCheck } from "./ui-icons";
import { EntityRow, EntityMono } from "./EntityRow";
import { VaultSectionList } from "./VaultSectionList";
import type { VaultSection } from "../lib/vaultSections";
import { HostTreePicker } from "./HostTreePicker";
import { ConfirmDialog } from "./ConfirmDialog";

interface KeychainPanelProps {
  workspace: Workspace;
  /** Les vaults du compte affiché : chaque clé est rangée sous le sien.
   * Absent = liste à plat. */
  vaultSections?: VaultSection[] | null;
  onAddKey: (name: string, path: string, passphrase: string | null) => void;
  onGenerateKey: (name: string, algorithm: KeyAlgorithm, passphrase: string | null) => void;
  onDeleteKey: (id: KeyId) => void;
  onRenameKey: (id: KeyId, name: string) => void;
}

export function KeychainPanel({ workspace, vaultSections, onAddKey, onGenerateKey, onDeleteKey, onRenameKey }: KeychainPanelProps) {
  const [mode, setMode] = useState<"import" | "generate">("import");
  const [algorithm, setAlgorithm] = useState<KeyAlgorithm>("ed25519");
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [showPassphrase, setShowPassphrase] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editingName, setEditingName] = useState<{ id: KeyId; draft: string } | null>(null);

  /** Key id → hosts authenticating with it. Reloaded whenever the workspace
   * changes, since editing a host's auth changes the answer. */
  const [keyUsage, setKeyUsage] = useState<Record<KeyId, string[]>>({});
  useEffect(() => {
    // Best effort: a failure here must not take the panel down — it only costs
    // the count next to each key, and the confirmation below degrades to the
    // generic wording.
    api.listKeyUsage().then(setKeyUsage).catch(() => setKeyUsage({}));
  }, [workspace]);
  /** The key awaiting a confirmed deletion, with what it would break. */
  const [confirmDelete, setConfirmDelete] = useState<{ key: PrivateKey; hosts: string[] } | null>(null);

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
      <div className="sidebar-scroll -mx-1 min-h-0 min-w-0 flex-1 overflow-y-auto px-1 pb-2">
        {/* Add form at top */}
        <div>
          <button
            onClick={() => (showForm ? resetForm() : setShowForm(true))}
            className={`btn mb-3 w-full ${showForm ? "btn-secondary" : "btn-primary"}`}
          >
            <IconPlus size={13} /> {showForm ? "Fermer le formulaire" : "Nouvelle clé"}
          </button>
          {showForm && (
            <div className="card -mt-1.5 mb-3 space-y-2 p-3">
              {error && <p className="callout callout-danger py-1">{error}</p>}
              <div className="segmented flex w-full">
                {([["import", "Importer"], ["generate", "Générer"]] as [typeof mode, string][]).map(([m, label]) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setMode(m)}
                    data-active={mode === m ? "true" : undefined}
                    className="flex-1"
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
                    className={`${inputClass} input-mono min-w-0 flex-1`}
                  />
                  <button onClick={browse} className="btn btn-secondary btn-icon" title="Parcourir" aria-label="Parcourir">
                    <IconFolder size={14} />
                  </button>
                </div>
              ) : (
                <div className="segmented flex w-full">
                  {([["ed25519", "Ed25519"], ["rsa", "RSA (4096)"]] as [KeyAlgorithm, string][]).map(([a, label]) => (
                    <button
                      key={a}
                      type="button"
                      onClick={() => setAlgorithm(a)}
                      data-active={algorithm === a ? "true" : undefined}
                      className="flex-1"
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
                  title={showPassphrase ? "Cacher la passphrase" : "Afficher la passphrase"}
                  aria-label={showPassphrase ? "Cacher la passphrase" : "Afficher la passphrase"}
                  className="btn btn-secondary btn-icon text-[var(--c-text-muted)]"
                >
                  {showPassphrase ? <IconEyeOff size={13} /> : <IconEye size={13} />}
                </button>
              </div>
              <div className="flex justify-end gap-1.5 pt-1">
                <button aria-label="Annuler la saisie" onClick={resetForm} className="btn btn-ghost">Annuler</button>
                <button onClick={submit} className="btn btn-primary">
                  {mode === "import" ? "Enregistrer" : "Générer"}
                </button>
              </div>
            </div>
          )}
        </div>
        {workspace.keychain.length === 0 && (
          <div className="px-2 py-8 text-center">
            <p className="text-[12.5px] font-medium text-[var(--c-text-secondary)]">Aucune clé</p>
            <p className="help-text mt-1">Importez une clé privée existante ou générez-en une, puis déployez sa clé publique sur vos hôtes d'ici.</p>
          </div>
        )}
        <VaultSectionList items={workspace.keychain} bindings={workspace.vaultBindings} sections={vaultSections} emptyMessage="Aucune clé dans ce vault." render={(key: PrivateKey) => (
          <EntityRow
            key={key.id}
            variant="card"
            icon={<IconKeychain size={13} />}
            title={editingName?.id === key.id ? (
              <input
                value={editingName.draft}
                onChange={(e) => setEditingName({ id: key.id, draft: e.target.value })}
                onBlur={() => commitRename(key)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitRename(key);
                  if (e.key === "Escape") setEditingName(null);
                }}
                autoFocus
                className="input h-6 w-full font-medium"
              />
            ) : key.name}
            // Says what depends on this key *before* anyone reaches for the
            // bin, not only in the confirmation.
            badges={
              <>
                {(keyUsage[key.id]?.length ?? 0) > 0 && (
                  <span title={`Utilisée par : ${keyUsage[key.id].join(", ")}`} className="tag">
                    {keyUsage[key.id].length} hôte{keyUsage[key.id].length > 1 ? "s" : ""}
                  </span>
                )}
              </>
            }
            secondary={key.content
              ? <span className="flex items-center gap-1 text-[var(--c-ok)]"><IconCheck size={10} /> Contenu intégré</span>
              : <EntityMono title={key.path}>{key.path}</EntityMono>}
            actions={
              <>
                <button onClick={() => copyPublicKey(key)} title="Copier la clé publique" className="btn btn-ghost btn-sm btn-icon">
                  {copiedKeyId === key.id ? <IconCheck size={12} className="text-[var(--c-ok)]" /> : <IconCopy size={12} />}
                </button>
                <button
                  onClick={() => (deployingKeyId === key.id ? setDeployingKeyId(null) : startDeploy(key))}
                  title="Déployer sur un hôte"
                  className="btn btn-ghost btn-sm btn-icon"
                >
                  <IconUpload size={12} />
                </button>
                <button onClick={() => setEditingName({ id: key.id, draft: key.name })} title="Renommer" className="btn btn-ghost btn-sm btn-icon">
                  <IconEdit size={12} />
                </button>
                <button
                  // Never a bare delete any more: this key may be how several
                  // hosts authenticate, and removing it used to break them
                  // with nothing to say which or why.
                  onClick={() => setConfirmDelete({ key, hosts: keyUsage[key.id] ?? [] })}
                  title="Supprimer"
                  className="btn btn-ghost btn-sm btn-icon hover:text-[var(--c-danger)]"
                >
                  <IconTrash size={12} />
                </button>
              </>
            }
          >
            {copyError?.id === key.id && (
              <p className="callout callout-danger mt-2 py-1 text-[11px]">{copyError.text}</p>
            )}
            {deployingKeyId === key.id && (
              <div className="mt-2 space-y-1.5 border-t border-[var(--c-border)] pt-2">
                <HostTreePicker
                  hosts={workspace.hosts}
                  groups={workspace.groups}
                  customIcons={workspace.customIcons}
                  value={deployHostId}
                  onChange={(v) => setDeployHostId(v ?? "")}
                  placeholder={workspace.hosts.length === 0 ? "Aucun hôte" : "Choisir un hôte…"}
                  className={`${selectClass} flex items-center justify-between gap-2 text-left`}
                />
                {deployResult && (
                  <p className={`callout py-1 text-[11.5px] ${deployResult.kind === "ok" ? "text-[var(--c-ok)]" : "callout-danger"}`}>
                    {deployResult.text}
                  </p>
                )}
                <div className="flex justify-end gap-1.5">
                  <button aria-label="Annuler le déploiement" onClick={() => setDeployingKeyId(null)} className="btn btn-ghost btn-sm">Annuler</button>
                  <button disabled={deployBusy || !deployHostId} onClick={() => confirmDeploy(key)} className="btn btn-primary btn-sm">
                    {deployBusy ? "Déploiement…" : "Déployer"}
                  </button>
                </div>
              </div>
            )}
          </EntityRow>
        )} />
      </div>

      {confirmDelete && (
        <ConfirmDialog
          title={`Supprimer « ${confirmDelete.key.name} » ?`}
          // The hosts are named, not counted: "3 hôtes" tells you there is a
          // problem, the names tell you whether it is one you can accept.
          message={
            confirmDelete.hosts.length === 0
              ? "Aucun hôte n'utilise cette clé. La suppression retire aussi sa passphrase et son contenu du coffre."
              : `${confirmDelete.hosts.length} hôte(s) s'authentifient avec cette clé et ne pourront plus se connecter : ` +
                `${confirmDelete.hosts.join(", ")}. La suppression retire aussi sa passphrase et son contenu du coffre.`
          }
          confirmLabel="Supprimer"
          danger
          onConfirm={() => { onDeleteKey(confirmDelete.key.id); setConfirmDelete(null); }}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
    </div>
  );
}

// No `w-full` here: two of the three call sites pair this with their own
// `flex-1` sizing in a flex row, and a baked-in `w-full` fights that (both
// are "width" utilities of equal specificity — whichever Tailwind emits
// last in the stylesheet wins, regardless of source order in the
// className string). The lone standalone usage adds `w-full` itself.
const inputClass = "input";
const selectClass = "input";
