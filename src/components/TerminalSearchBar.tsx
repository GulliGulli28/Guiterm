import { useEffect, useRef, useState } from "react";
import { IconSearch, IconChevronDown, IconChevronRight, IconClose } from "./ui-icons";

export interface SearchOptions {
  caseSensitive: boolean;
  regex: boolean;
}

interface TerminalSearchBarProps {
  onSearch: (value: string, direction: "next" | "prev", options: SearchOptions) => void;
  onClose: () => void;
}

export function TerminalSearchBar({ onSearch, onClose }: TerminalSearchBarProps) {
  const [value, setValue] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [regex, setRegex] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const options: SearchOptions = { caseSensitive, regex };
  const search = (v: string, direction: "next" | "prev") => onSearch(v, direction, options);

  return (
    <div className="absolute right-3 top-3 z-10 flex items-center gap-1 rounded-md bg-[var(--c-bg2)] px-2 py-1.5 shadow-[var(--shadow-lg)]">
      <IconSearch size={12} className="shrink-0 text-[var(--c-text-muted)]" />
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => { setValue(e.target.value); search(e.target.value, "next"); }}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); search(value, e.shiftKey ? "prev" : "next"); }
          if (e.key === "Escape") { e.preventDefault(); onClose(); }
        }}
        placeholder="Rechercher dans le terminal…"
        className="w-48 bg-transparent font-mono text-xs text-[var(--c-text)] placeholder:font-sans placeholder:text-[var(--c-text-muted)] focus:outline-none"
      />
      <button
        onClick={() => { setCaseSensitive((v) => !v); search(value, "next"); }}
        title="Sensible à la casse"
        className={`flex shrink-0 items-center rounded px-1 py-1 text-[11px] font-semibold ${
          caseSensitive ? "bg-[var(--c-accent-dim)] text-[var(--c-accent-text)]" : "text-[var(--c-text-secondary)] hover:bg-white/5 hover:text-[var(--c-text)]"
        }`}
      >
        Aa
      </button>
      <button
        onClick={() => { setRegex((v) => !v); search(value, "next"); }}
        title="Expression régulière"
        className={`flex shrink-0 items-center rounded px-1 py-1 font-mono text-[11px] font-semibold ${
          regex ? "bg-[var(--c-accent-dim)] text-[var(--c-accent-text)]" : "text-[var(--c-text-secondary)] hover:bg-white/5 hover:text-[var(--c-text)]"
        }`}
      >
        .*
      </button>
      <button onClick={() => search(value, "prev")} title="Occurrence précédente (Maj+Entrée)" className="flex shrink-0 items-center rounded p-1 text-[var(--c-text-secondary)] hover:bg-white/5 hover:text-[var(--c-text)]">
        <IconChevronRight size={11} className="-rotate-90" />
      </button>
      <button onClick={() => search(value, "next")} title="Occurrence suivante (Entrée)" className="flex shrink-0 items-center rounded p-1 text-[var(--c-text-secondary)] hover:bg-white/5 hover:text-[var(--c-text)]">
        <IconChevronDown size={11} />
      </button>
      <button onClick={onClose} title="Fermer (Échap)" className="flex shrink-0 items-center rounded p-1 text-[var(--c-text-secondary)] hover:bg-white/5 hover:text-[var(--c-text)]">
        <IconClose size={11} />
      </button>
    </div>
  );
}
