import { useState } from "react";
import type { GroupId, Workspace } from "../lib/types";
import { ACCENT_COLORS, type UiAccent } from "../lib/preferences";
import { IconTrash, IconFolder, IconClose } from "./ui-icons";
import { HostIcon } from "./icons";
import { IconPicker } from "./IconPicker";
import { GroupTreePicker } from "./GroupTreePicker";

export interface GroupFormData {
  id: GroupId | null;
  name: string;
  parentId: GroupId | null;
  icon: string | null;
  color: string | null;
}

interface GroupFormProps {
  workspace: Workspace;
  group: GroupFormData;
  onCancel: () => void;
  onSave: (input: GroupFormData) => void;
  onDeleteGroup?: (id: GroupId) => void;
  onWorkspaceUpdate?: (ws: Workspace) => void;
}

export function GroupForm({ workspace, group, onCancel, onSave, onDeleteGroup, onWorkspaceUpdate }: GroupFormProps) {
  const [name, setName] = useState(group.name);
  const [parentId, setParentId] = useState<GroupId | null>(group.parentId);
  const [icon, setIcon] = useState<string | null>(group.icon);
  const [color, setColor] = useState<string | null>(group.color);
  const [showIconPicker, setShowIconPicker] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed) { setError("Le nom du dossier est requis"); return; }
    const duplicate = workspace.groups.some(
      (g) => g.id !== group.id && g.parentId === parentId && g.name.toLowerCase() === trimmed.toLowerCase()
    );
    if (duplicate) {
      setError(`Un dossier "${trimmed}" existe déjà à ce niveau`);
      return;
    }
    onSave({ id: group.id, name: trimmed, parentId, icon, color });
  };

  return (
    <div data-form className="flex min-h-0 flex-1 flex-col border-l border-[var(--c-border)]">
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-[var(--c-border)] px-5">
        <h2 className="text-[13px] font-semibold text-[var(--c-text)]">
          {group.id ? "Modifier le dossier" : "Nouveau dossier"}
        </h2>
        <div className="flex items-center gap-1.5">
          <button onClick={onCancel} className="btn btn-ghost">Annuler</button>
          <button onClick={submit} className="btn btn-primary">Enregistrer</button>
        </div>
      </div>
      <div className="sidebar-scroll min-h-0 flex-1 space-y-4 overflow-y-auto p-5">
        {error && <p className="callout callout-danger">{error}</p>}

        {/* Icon */}
        <div className="space-y-1">
          <span className="field-label">Icône</span>
          <div className="relative">
            <div className="flex items-center gap-2">
              <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-[var(--c-border)] bg-[var(--c-bg3)] text-[var(--c-text-muted)]">
                {icon ? (
                  <HostIcon iconId={icon} customIcons={workspace.customIcons} size={18} />
                ) : (
                  <IconFolder size={14} />
                )}
              </div>
              <button type="button" onClick={() => setShowIconPicker((v) => !v)} className="btn btn-secondary">
                {icon ? "Changer l'icône" : "Choisir une icône"}
              </button>
              {icon && (
                <button
                  type="button"
                  onClick={() => setIcon(null)}
                  aria-label="Retirer l'icône"
                  title="Retirer l'icône"
                  className="btn btn-ghost btn-icon"
                >
                  <IconClose size={12} />
                </button>
              )}
            </div>
            {showIconPicker && (
              <IconPicker
                value={icon}
                customIcons={workspace.customIcons}
                onSelect={(id) => { setIcon(id); setShowIconPicker(false); }}
                onWorkspaceUpdate={(ws) => onWorkspaceUpdate?.(ws)}
                onClose={() => setShowIconPicker(false)}
              />
            )}
          </div>
        </div>

        {/* Color tag */}
        <div className="space-y-1">
          <span className="field-label">Couleur (affichée sur les onglets)</span>
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={() => setColor(null)}
              title="Aucune couleur"
              className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2 text-[var(--c-text-muted)] ${
                color === null ? "border-[var(--c-text)]" : "border-transparent hover:border-[var(--c-border-strong)]"
              }`}
              style={{ background: "var(--c-bg3)" }}
            >
              <IconClose size={10} />
            </button>
            {(Object.entries(ACCENT_COLORS) as [UiAccent, typeof ACCENT_COLORS[UiAccent]][]).map(([key, entry]) => (
              <button
                key={key}
                type="button"
                onClick={() => setColor(key)}
                title={entry.label}
                className={`h-6 w-6 shrink-0 rounded-full border-2 ${color === key ? "border-[var(--c-text)]" : "border-transparent hover:border-[var(--c-border-strong)]"}`}
                style={{ background: entry.c500 }}
              />
            ))}
          </div>
        </div>

        {/* Name */}
        <div className="space-y-1">
          <span className="field-label">Nom</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
            placeholder="Mon dossier"
            className="input w-full"
            autoFocus
          />
        </div>

        {/* Parent folder */}
        <div className="space-y-1">
          <span className="field-label">Dossier parent</span>
          <GroupTreePicker
            groups={workspace.groups}
            value={parentId}
            onChange={setParentId}
            excludeId={group.id ?? undefined}
            customIcons={workspace.customIcons}
          />
        </div>

        {group.id && onDeleteGroup && (
          <div className="border-t border-[var(--c-border)] pt-3">
            {confirmDelete ? (
              <div className="callout callout-danger space-y-2">
                <p className="font-medium">Supprimer ce dossier définitivement ?</p>
                <div className="flex gap-2">
                  <button onClick={() => onDeleteGroup(group.id!)} className="btn btn-danger">
                    Oui, supprimer
                  </button>
                  <button onClick={() => setConfirmDelete(false)} className="btn btn-ghost">
                    Annuler
                  </button>
                </div>
              </div>
            ) : (
              <button onClick={() => setConfirmDelete(true)} className="btn btn-ghost text-[var(--c-danger)] hover:bg-[color-mix(in_srgb,var(--c-danger)_10%,transparent)]">
                <IconTrash size={13} /> Supprimer ce dossier
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
