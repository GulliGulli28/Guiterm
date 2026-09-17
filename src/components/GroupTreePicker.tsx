import { IconFolder, IconCheck, IconChevronDown, IconHosts } from "./ui-icons";
import { useRef, useState } from "react";
import type { CustomIcon, Group, GroupId } from "../lib/types";
import { HostIcon, hasIcon } from "./icons";

interface GroupTreePickerProps {
  groups: Group[];
  value: GroupId | null;
  onChange: (id: GroupId | null) => void;
  /** Exclude this group from the list (used when editing a group to avoid self-parenting) */
  excludeId?: GroupId;
  customIcons: CustomIcon[];
  placeholder?: string;
}

export function GroupTreePicker({
  groups, value, onChange, excludeId, customIcons,
  placeholder = "— Racine (pas de dossier) —",
}: GroupTreePickerProps) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const [dropdownStyle, setDropdownStyle] = useState<React.CSSProperties>({});

  const selected = value ? groups.find((g) => g.id === value) ?? null : null;

  const openDropdown = () => {
    if (btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect();
      const dropdownMaxH = 220;
      const spaceBelow = window.innerHeight - rect.bottom;
      if (spaceBelow < dropdownMaxH && rect.top > dropdownMaxH) {
        setDropdownStyle({
          position: "fixed",
          bottom: window.innerHeight - rect.top + 4,
          left: rect.left,
          width: rect.width,
          zIndex: 9999,
        });
      } else {
        setDropdownStyle({
          position: "fixed",
          top: rect.bottom + 4,
          left: rect.left,
          width: rect.width,
          zIndex: 9999,
        });
      }
    }
    setOpen(true);
  };

  // Stop propagation + preventDefault so that a wrapping <label> doesn't
  // re-dispatch the click to the first focusable element (which would reopen the dropdown).
  const pick = (e: React.MouseEvent, id: GroupId | null) => {
    e.preventDefault();
    e.stopPropagation();
    onChange(id);
    setOpen(false);
  };

  const childrenOf = (parentId: GroupId | null) =>
    groups
      .filter((g) => g.parentId === parentId && g.id !== excludeId)
      .sort((a, b) => a.name.localeCompare(b.name));

  const renderNode = (group: Group, depth: number): React.ReactNode => {
    const isSelected = value === group.id;
    return (
      <div key={group.id}>
        <button
          type="button"
          onClick={(e) => pick(e, group.id)}
          style={{ paddingLeft: `${8 + depth * 16}px` }}
          className={`flex w-full items-center gap-1.5 py-1.5 pr-3 text-left text-[12.5px] transition-colors hover:bg-[var(--c-hover)] ${isSelected ? "bg-[var(--c-accent-dim)] text-[var(--c-text)]" : "text-[var(--c-text-secondary)]"}`}
        >
          {hasIcon(group.icon, customIcons) ? (
            <HostIcon iconId={group.icon} customIcons={customIcons} size={13} />
          ) : (
            <IconFolder size={13} className="shrink-0 text-[var(--c-text-muted)]" />
          )}
          <span className="truncate">{group.name}</span>
          {isSelected && <IconCheck size={12} className="ml-auto shrink-0 text-[var(--c-accent-text)]" />}
        </button>
        {childrenOf(group.id).map((child) => renderNode(child, depth + 1))}
      </div>
    );
  };

  return (
    <div className="relative">
      <button
        ref={btnRef}
        type="button"
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); if (open) setOpen(false); else openDropdown(); }}
        className="input flex w-full items-center justify-between gap-2 text-left"
      >
        <span className="flex min-w-0 items-center gap-1.5 truncate">
          {selected ? (
            <>
              {hasIcon(selected.icon, customIcons) ? (
                <HostIcon iconId={selected.icon} customIcons={customIcons} size={13} />
              ) : (
                <IconFolder size={13} className="shrink-0 text-[var(--c-text-muted)]" />
              )}
              <span className="truncate">{selected.name}</span>
            </>
          ) : (
            <span className="text-[var(--c-text-muted)]">{placeholder}</span>
          )}
        </span>
        <IconChevronDown size={10} className={`shrink-0 text-[var(--c-text-muted)] transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-[9998]" onClick={() => setOpen(false)} />
          <div style={dropdownStyle} className="popover overflow-hidden">
            <div className="max-h-52 overflow-y-auto py-1">
              <button
                type="button"
                onClick={(e) => pick(e, null)}
                className={`flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-[12.5px] transition-colors hover:bg-[var(--c-hover)] ${!value ? "bg-[var(--c-accent-dim)] text-[var(--c-text)]" : "text-[var(--c-text-secondary)]"}`}
              >
                <IconHosts size={13} className="shrink-0 text-[var(--c-text-muted)]" />
                <span>{placeholder}</span>
                {!value && <IconCheck size={12} className="ml-auto shrink-0 text-[var(--c-accent-text)]" />}
              </button>
              {childrenOf(null).map((g) => renderNode(g, 0))}
              {groups.filter((g) => g.id !== excludeId).length === 0 && (
                <p className="px-3 py-2 text-xs text-[var(--c-text-muted)]">Aucun dossier créé</p>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
