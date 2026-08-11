import { useState } from "react";
import { api } from "../lib/api";
import type { AuthMethod, BulkEdit, GroupId, Host, KeyId, Workspace } from "../lib/types";
import { IconClose } from "./ui-icons";
import { GroupTreePicker } from "./GroupTreePicker";

interface BulkEditPanelProps {
  workspace: Workspace;
  hosts: Host[];
  onWorkspaceUpdate: (ws: Workspace) => void;
  onClose: () => void;
  onError: (message: string) => void;
  onDone: (message: string) => void;
}

const inputClass =
  "w-full rounded-md bg-[var(--c-bg3)] px-2 py-1.5 text-sm text-[var(--c-text)] placeholder:text-[var(--c-text-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--c-accent-hover)]";

type AuthKind = "agent" | "password" | "privateKey";

/**
 * Changing one thing about many hosts at once.
 *
 * **Every field is opt-in, and that is the whole design.** An import creates
 * fifty hosts in one go; editing them afterwards was fifty times one by one.
 * But a write across fifty hosts is not something anyone undoes by hand, so
 * nothing is sent that wasn't explicitly ticked — a checkbox per field, and an
 * untouched field is simply absent from the payload (see `core::bulk_edit`).
 *
 * Tags are added and removed rather than replaced, for a reason that isn't
 * cosmetic: imports write the provider's own labels, and `target tag:` in the
 * adaptive language runs on them. Replacing the list would drop them silently.
 */
export function BulkEditPanel({ workspace, hosts, onWorkspaceUpdate, onClose, onError, onDone }: BulkEditPanelProps) {
  const [useUsername, setUseUsername] = useState(false);
  const [username, setUsername] = useState("");
  const [usePort, setUsePort] = useState(false);
  const [port, setPort] = useState("22");
  const [useGroup, setUseGroup] = useState(false);
  const [groupId, setGroupId] = useState<GroupId | null>(null);
  const [useAuth, setUseAuth] = useState(false);
  const [authKind, setAuthKind] = useState<AuthKind>("agent");
  const [keyId, setKeyId] = useState<KeyId | null>(null);
  const [keyPath, setKeyPath] = useState("");
  const [secret, setSecret] = useState("");
  const [addTags, setAddTags] = useState("");
  const [removeTags, setRemoveTags] = useState("");
  const [busy, setBusy] = useState(false);

  const splitTags = (raw: string) =>
    raw.split(",").map((t) => t.trim()).filter(Boolean);

  const authMethod = (): AuthMethod => {
    if (authKind !== "privateKey") return authKind;
    const fromKeychain = workspace.keychain.find((key) => key.id === keyId);
    return {
      privateKey: {
        path: fromKeychain?.path ?? keyPath.trim(),
        keyId: keyId || null,
        // Per-key and short-lived; one applied to a whole batch would be wrong
        // for most of it. Same call as the import panels make.
        certPath: null,
      },
    };
  };

  const buildEdit = (): BulkEdit => {
    const edit: BulkEdit = {};
    if (useUsername && username.trim()) edit.username = username.trim();
    if (usePort && Number(port) > 0) edit.port = Number(port);
    // Present-but-null is "move out of every group", which is why this is set
    // whenever the box is ticked rather than only when a group is chosen.
    if (useGroup) edit.groupId = groupId;
    if (useAuth) edit.auth = authMethod();
    const added = splitTags(addTags);
    const removed = splitTags(removeTags);
    if (added.length) edit.addTags = added;
    if (removed.length) edit.removeTags = removed;
    return edit;
  };

  const edit = buildEdit();
  const changes = Object.keys(edit).length;

  const apply = () => {
    if (changes === 0) {
      onError("Cocher au moins un champ à modifier.");
      return;
    }
    if (useAuth && authKind === "privateKey" && !keyId && !keyPath.trim()) {
      onError("Choisir une clé du trousseau ou saisir un chemin de clé privée");
      return;
    }
    setBusy(true);
    api.bulkEditHosts(hosts.map((h) => h.id), edit, useAuth ? secret.trim() || null : null)
      .then((ws) => {
        onWorkspaceUpdate(ws);
        onDone(`${hosts.length} hôte(s) modifié(s).`);
        onClose();
      })
      .catch((e) => onError(String(e)))
      .finally(() => setBusy(false));
  };

  const field = (checked: boolean, onToggle: (v: boolean) => void, label: string, control: React.ReactNode) => (
    <div className="flex items-start gap-2">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onToggle(e.target.checked)}
        className="mt-2 shrink-0 accent-[var(--c-accent)]"
      />
      <label className="block min-w-0 flex-1 space-y-1">
        <span className="text-xs font-medium text-[var(--c-text-muted)]">{label}</span>
        <div className={checked ? "" : "pointer-events-none opacity-40"}>{control}</div>
      </label>
    </div>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6" onClick={onClose}>
      <div
        className="flex max-h-full w-[min(34rem,100%)] flex-col overflow-hidden rounded-xl border border-[var(--c-border)] bg-[var(--c-bg2)] shadow-[var(--shadow-lg)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-[var(--c-border)] px-4 py-2.5">
          <div className="min-w-0">
            <p className="text-[13px] font-medium text-[var(--c-text)]">
              Modifier {hosts.length} hôte(s)
            </p>
            <p className="truncate text-[11px] text-[var(--c-text-muted)]" title={hosts.map((h) => h.label).join(", ")}>
              {hosts.map((h) => h.label).join(", ")}
            </p>
          </div>
          <button onClick={onClose} aria-label="Fermer" className="rounded p-1 text-[var(--c-text-muted)] hover:bg-white/5 hover:text-[var(--c-text)]">
            <IconClose size={13} />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto px-4 py-3">
          <p className="text-[10px] leading-relaxed text-[var(--c-text-faint)]">
            Seuls les champs cochés sont écrits. Les autres restent tels quels sur chaque hôte —
            c'est ce qui sépare une modification en lot d'un écrasement en lot.
          </p>

          {field(useUsername, setUseUsername, "Utilisateur", (
            <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="ubuntu" className={inputClass} />
          ))}

          {field(usePort, setUsePort, "Port", (
            <input
              value={port}
              onChange={(e) => setPort(e.target.value.replace(/\D/g, ""))}
              className={`${inputClass} font-mono`}
            />
          ))}

          {field(useGroup, setUseGroup, "Groupe", (
            <>
              <GroupTreePicker
                groups={workspace.groups}
                value={groupId}
                onChange={setGroupId}
                customIcons={workspace.customIcons ?? []}
              />
              <span className="mt-0.5 block text-[10px] text-[var(--c-text-faint)]">
                Laisser sur « aucun groupe » sort les hôtes de leur groupe actuel.
              </span>
            </>
          ))}

          {field(useAuth, setUseAuth, "Authentification", (
            <div className="space-y-1.5">
              <select value={authKind} onChange={(e) => setAuthKind(e.target.value as AuthKind)} className={inputClass}>
                <option value="agent">Agent SSH</option>
                <option value="password">Mot de passe</option>
                <option value="privateKey">Clé privée</option>
              </select>
              {authKind === "privateKey" && (
                <div className="flex gap-1.5">
                  {workspace.keychain.length > 0 && (
                    <select
                      value={keyId ?? ""}
                      onChange={(e) => { setKeyId((e.target.value as KeyId) || null); setKeyPath(""); }}
                      className={`${inputClass} flex-1`}
                    >
                      <option value="">(saisir un chemin)</option>
                      {workspace.keychain.map((k) => (
                        <option key={k.id} value={k.id}>{k.name}</option>
                      ))}
                    </select>
                  )}
                  {!keyId && (
                    <input value={keyPath} onChange={(e) => setKeyPath(e.target.value)} placeholder="~/.ssh/id_ed25519" className={`${inputClass} flex-1 font-mono`} />
                  )}
                </div>
              )}
              {(authKind === "password" || (authKind === "privateKey" && !keyId)) && (
                <input
                  type="password"
                  value={secret}
                  onChange={(e) => setSecret(e.target.value)}
                  placeholder={authKind === "password" ? "Mot de passe" : "Passphrase (optionnelle)"}
                  className={inputClass}
                />
              )}
            </div>
          ))}

          <div className="space-y-1">
            <span className="text-xs font-medium text-[var(--c-text-muted)]">Tags</span>
            <input
              value={addTags}
              onChange={(e) => setAddTags(e.target.value)}
              placeholder="Ajouter — séparés par des virgules"
              className={inputClass}
            />
            <input
              value={removeTags}
              onChange={(e) => setRemoveTags(e.target.value)}
              placeholder="Retirer — séparés par des virgules"
              className={inputClass}
            />
            <span className="block text-[10px] text-[var(--c-text-faint)]">
              Ajoutés et retirés, jamais remplacés : les imports écrivent les étiquettes du
              fournisseur, et <span className="font-mono">target tag:</span> s'en sert.
            </span>
          </div>
        </div>

        <div className="shrink-0 border-t border-[var(--c-border)] px-4 py-2.5">
          <button
            onClick={apply}
            disabled={busy || changes === 0}
            className="accent-surface w-full rounded-md border py-2 text-sm font-medium disabled:opacity-40"
          >
            {busy
              ? "Modification…"
              : changes === 0
                ? "Cocher un champ à modifier"
                : `Appliquer ${changes} modification(s) à ${hosts.length} hôte(s)`}
          </button>
        </div>
      </div>
    </div>
  );
}
