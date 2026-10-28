import { useState } from "react";
import type { GroupId, GuiVaultVault, VaultId, Workspace } from "../lib/types";
import { ACCENT_COLORS, type UiAccent } from "../lib/preferences";
import { IconFolder, IconClose } from "./ui-icons";
import { HostIcon } from "./icons";
import { IconPicker } from "./IconPicker";
import { GroupTreePicker } from "./GroupTreePicker";
import { ReadOnlyVaultNotice, VaultField, readOnlyVault } from "./VaultField";
import { DrawerDeleteButton, DrawerSaveButton, FormDrawer } from "./FormDrawer";
import { groupPath } from "../lib/hostTree";

export interface GroupFormData {
  id: GroupId | null;
  name: string;
  parentId: GroupId | null;
  icon: string | null;
  color: string | null;
  /** Le vault GuiVault (`null` = personnel) — absent sans compte affiché. */
  vaultId?: VaultId | null;
}

interface GroupFormProps {
  workspace: Workspace;
  group: GroupFormData;
  /** Les vaults du compte connecté — vide sans compte : pas de champ. */
  vaults?: GuiVaultVault[];
  onCancel: () => void;
  onSave: (input: GroupFormData) => void;
  onDeleteGroup?: (id: GroupId) => void;
  onWorkspaceUpdate?: (ws: Workspace) => void;
}

export function GroupForm({ workspace, group, vaults = [], onCancel, onSave, onDeleteGroup, onWorkspaceUpdate }: GroupFormProps) {
  const [name, setName] = useState(group.name);
  const [vaultId, setVaultId] = useState<VaultId | "">(group.vaultId ?? "");
  const readOnlyIn = readOnlyVault(vaults, group.vaultId);
  const vaultField = vaults.some((v) => v.kind === "shared") || vaultId !== "" ? { vaultId: vaultId || null } : {};
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
    onSave({ id: group.id, name: trimmed, parentId, icon, color, ...vaultField });
  };

  const path = groupPath(workspace.groups, parentId);
  const subtitle = <span className="truncate">{path.length ? `Dans ${path.join(" › ")}` : "À la racine"}</span>;

  return (
    <FormDrawer
      title={group.id ? group.name : "Nouveau dossier"}
      subtitle={subtitle}
      icon={icon ? <HostIcon iconId={icon} customIcons={workspace.customIcons} size={18} /> : <IconFolder size={16} />}
      onCancel={onCancel}
      onSubmit={submit}
      submitDisabled={readOnlyIn !== null}
      footer={
        <>
          {group.id && onDeleteGroup && readOnlyIn === null && (
            <DrawerDeleteButton
              what="ce dossier"
              confirming={confirmDelete}
              onAsk={() => setConfirmDelete(true)}
              onConfirm={() => onDeleteGroup(group.id!)}
              onCancel={() => setConfirmDelete(false)}
            />
          )}
          <span className="flex-1" />
          <button type="button" onClick={onCancel} className="btn btn-ghost">Annuler</button>
          <DrawerSaveButton onClick={submit} disabled={readOnlyIn !== null} />
        </>
      }
    >
      <fieldset disabled={readOnlyIn !== null} className="contents min-w-0">
      <div className="max-w-[460px] space-y-4">
        {readOnlyIn && <ReadOnlyVaultNotice vault={readOnlyIn} what="ce dossier" />}
        {error && <p className="callout callout-danger">{error}</p>}

        <div className="grid grid-cols-[56px_minmax(0,1fr)] items-end gap-3">
          <div className="relative">
            <span className="field-label">Icône</span>
            <button
              type="button"
              onClick={() => setShowIconPicker((v) => !v)}
              aria-label={icon ? "Changer l'icône" : "Choisir une icône"}
              title={icon ? "Changer l'icône" : "Choisir une icône"}
              className="flex h-[30px] w-[56px] items-center justify-center rounded-lg border border-[var(--c-border)] bg-[var(--c-bg3)] text-[var(--c-text-muted)] hover:border-[var(--c-border-strong)]"
            >
              {icon ? <HostIcon iconId={icon} customIcons={workspace.customIcons} size={18} /> : <IconFolder size={15} />}
            </button>
            {icon && (
              <button type="button" onClick={() => setIcon(null)} className="mt-1 text-[11px] text-[var(--c-text-muted)] hover:text-[var(--c-text)]">
                Retirer
              </button>
            )}
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
          <div>
            <span className="field-label">Nom</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
              placeholder="Mon dossier"
              className="input w-full"
              data-autofocus
            />
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

        <VaultField vaults={vaults} value={vaultId} onChange={setVaultId} readOnly={readOnlyIn !== null} hint="Tout ce que le dossier contient le suit." />
      </div>
      </fieldset>
    </FormDrawer>
  );
}
