import { useState } from "react";
import type { GroupId, Workspace } from "../lib/types";
import { IconTrash } from "./ui-icons";
import { HostIcon } from "./icons";
import { IconPicker } from "./IconPicker";
import { GroupTreePicker } from "./GroupTreePicker";

export interface GroupFormData {
  id: GroupId | null;
  name: string;
  parentId: GroupId | null;
  icon: string | null;
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
    onSave({ id: group.id, name: trimmed, parentId, icon });
  };

  return (
    <div className="flex flex-1 flex-col overflow-y-auto p-4">
      <div className="w-full space-y-4 rounded-xl bg-[var(--c-bg2)] p-5 shadow-[var(--shadow-md)]">
        <h2 className="text-[16px] font-semibold text-[var(--c-text)]">
          {group.id ? "Modifier le dossier" : "Nouveau dossier"}
        </h2>

        {error && <p className="rounded-md bg-rose-950 px-3 py-2 text-sm text-rose-300">{error}</p>}

        {/* Icon */}
        <div className="space-y-1">
          <span className="text-xs font-medium text-[var(--c-text-secondary)]">Icône</span>
          <div className="relative">
            <div className="flex items-center gap-2">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-[var(--c-bg3)]">
                {icon ? (
                  <HostIcon iconId={icon} customIcons={workspace.customIcons} size={24} />
                ) : (
                  <span className="text-lg">📁</span>
                )}
              </div>
              <button
                type="button"
                onClick={() => setShowIconPicker((v) => !v)}
                className="rounded-md bg-[var(--c-bg3)] px-3 py-2 text-xs text-[var(--c-text-secondary)] hover:bg-white/5"
              >
                {icon ? "Changer l'icône" : "Choisir une icône"}
              </button>
              {icon && (
                <button
                  type="button"
                  onClick={() => setIcon(null)}
                  className="rounded-md px-2 py-2 text-xs text-rose-400 hover:bg-rose-900/30"
                >
                  ✕
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

        {/* Name */}
        <div className="space-y-1">
          <span className="text-xs font-medium text-[var(--c-text-secondary)]">Nom</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
            placeholder="Mon dossier"
            className="w-full rounded-md bg-[var(--c-bg3)] px-3 py-2 text-sm text-[var(--c-text)] placeholder:text-[var(--c-text-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--c-accent-hover)]"
            autoFocus
          />
        </div>

        {/* Parent folder */}
        <div className="space-y-1">
          <span className="text-xs font-medium text-[var(--c-text-secondary)]">Dossier parent</span>
          <GroupTreePicker
            groups={workspace.groups}
            value={parentId}
            onChange={setParentId}
            excludeId={group.id ?? undefined}
            customIcons={workspace.customIcons}
          />
        </div>

        <div className="flex gap-2 pt-2">
          <button
            onClick={submit}
            className="flex-1 rounded-md bg-[var(--c-accent)] px-3 py-2 text-sm font-medium text-white hover:bg-[var(--c-accent-hover)]"
          >
            Enregistrer
          </button>
          <button
            onClick={onCancel}
            className="flex-1 rounded-md bg-[var(--c-bg3)] px-3 py-2 text-sm font-medium text-[var(--c-text)] hover:bg-white/5"
          >
            Annuler
          </button>
        </div>

        {group.id && onDeleteGroup && (
          <div className="border-t border-[var(--c-border)] pt-3">
            {confirmDelete ? (
              <div className="space-y-2 rounded-lg bg-rose-950/30 p-3">
                <p className="text-sm text-rose-300">Supprimer ce dossier définitivement ?</p>
                <div className="flex gap-2">
                  <button
                    onClick={() => onDeleteGroup(group.id!)}
                    className="flex-1 rounded-md bg-rose-700 px-3 py-2 text-sm font-medium text-white hover:bg-rose-600"
                  >
                    Oui, supprimer
                  </button>
                  <button
                    onClick={() => setConfirmDelete(false)}
                    className="flex-1 rounded-md bg-[var(--c-bg3)] px-3 py-2 text-sm font-medium text-[var(--c-text)] hover:bg-white/5"
                  >
                    Annuler
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => setConfirmDelete(true)}
                className="flex w-full items-center justify-center gap-2 rounded-md py-2 text-sm text-rose-400 hover:bg-rose-950/40 hover:text-rose-300"
              >
                <IconTrash size={13} /> Supprimer ce dossier
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
