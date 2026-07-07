import { useEffect, useRef, useState } from "react";
import { IconChevronDown } from "./ui-icons";

interface TerminalTargetPickerProps {
  terminals: { id: string; label: string }[];
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
  emptyLabel: string;
}

export function TerminalTargetPicker({ terminals, selected, onChange, emptyLabel }: TerminalTargetPickerProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDocDown);
    return () => window.removeEventListener("mousedown", onDocDown);
  }, [open]);

  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange(next);
  };

  const label =
    selected.size === 0 ? emptyLabel :
    selected.size === terminals.length ? "Tous les terminaux" :
    `${selected.size} terminal(aux)`;

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="Choisir les terminaux cibles"
        className="flex items-center gap-1 rounded-md bg-[var(--c-bg2)] px-2 py-1 text-xs text-[var(--c-text-secondary)] hover:bg-white/5 hover:text-[var(--c-text)]"
      >
        {label}
        <IconChevronDown size={10} />
      </button>
      {open && (
        <div className="absolute bottom-full left-0 z-20 mb-1 max-h-56 w-56 overflow-y-auto rounded-md border border-[var(--c-border)] bg-[var(--c-bg2)] py-1 shadow-[var(--shadow-lg)]">
          <div className="flex gap-1 border-b border-[var(--c-border)] px-2 py-1">
            <button
              onClick={() => onChange(new Set())}
              className="flex-1 rounded px-1.5 py-0.5 text-[11px] text-[var(--c-text-muted)] hover:bg-white/5 hover:text-[var(--c-text)]"
            >
              Aucun
            </button>
            <button
              onClick={() => onChange(new Set(terminals.map((t) => t.id)))}
              className="flex-1 rounded px-1.5 py-0.5 text-[11px] text-[var(--c-text-muted)] hover:bg-white/5 hover:text-[var(--c-text)]"
            >
              Tout sélectionner
            </button>
          </div>
          {terminals.length === 0 && (
            <p className="px-3 py-2 text-[12px] text-[var(--c-text-muted)]">Aucun terminal ouvert</p>
          )}
          {terminals.map((t) => (
            <label key={t.id} className="flex cursor-pointer items-center gap-2 px-3 py-1 text-[13px] text-[var(--c-text-secondary)] hover:bg-white/5 hover:text-[var(--c-text)]">
              <input
                type="checkbox"
                checked={selected.has(t.id)}
                onChange={() => toggle(t.id)}
                className="h-3.5 w-3.5 shrink-0 accent-[var(--c-accent)]"
              />
              <span className="truncate">{t.label}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
