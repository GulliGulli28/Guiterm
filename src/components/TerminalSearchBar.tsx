import { useEffect, useRef, useState } from "react";
import { IconSearch, IconChevronDown, IconChevronRight, IconClose } from "./ui-icons";

interface TerminalSearchBarProps {
  onSearch: (value: string, direction: "next" | "prev") => void;
  onClose: () => void;
}

export function TerminalSearchBar({ onSearch, onClose }: TerminalSearchBarProps) {
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  return (
    <div className="absolute right-3 top-3 z-10 flex items-center gap-1 rounded-md bg-[var(--c-bg2)] px-2 py-1.5 shadow-[var(--shadow-lg)]">
      <IconSearch size={12} className="shrink-0 text-[var(--c-text-muted)]" />
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => { setValue(e.target.value); onSearch(e.target.value, "next"); }}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); onSearch(value, e.shiftKey ? "prev" : "next"); }
          if (e.key === "Escape") { e.preventDefault(); onClose(); }
        }}
        placeholder="Rechercher dans le terminal…"
        className="w-48 bg-transparent font-mono text-xs text-[var(--c-text)] placeholder:font-sans placeholder:text-[var(--c-text-muted)] focus:outline-none"
      />
      <button onClick={() => onSearch(value, "prev")} title="Occurrence précédente (Maj+Entrée)" className="flex shrink-0 items-center rounded p-1 text-[var(--c-text-secondary)] hover:bg-white/5 hover:text-[var(--c-text)]">
        <IconChevronRight size={11} className="-rotate-90" />
      </button>
      <button onClick={() => onSearch(value, "next")} title="Occurrence suivante (Entrée)" className="flex shrink-0 items-center rounded p-1 text-[var(--c-text-secondary)] hover:bg-white/5 hover:text-[var(--c-text)]">
        <IconChevronDown size={11} />
      </button>
      <button onClick={onClose} title="Fermer (Échap)" className="flex shrink-0 items-center rounded p-1 text-[var(--c-text-secondary)] hover:bg-white/5 hover:text-[var(--c-text)]">
        <IconClose size={11} />
      </button>
    </div>
  );
}
