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
    <div className="absolute right-3 top-3 z-10 flex items-center gap-1 popover px-2 py-1.5">
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
        className="w-48 bg-transparent font-mono text-[12px] text-[var(--c-text)] outline-none placeholder:font-sans placeholder:text-[var(--c-text-muted)]"
      />
      <button
        onClick={() => { setCaseSensitive((v) => !v); search(value, "next"); }}
        title="Sensible à la casse"
        aria-pressed={caseSensitive}
        className={`btn btn-sm btn-icon font-semibold ${caseSensitive ? "btn-toggled" : "btn-ghost"}`}
      >
        Aa
      </button>
      <button
        onClick={() => { setRegex((v) => !v); search(value, "next"); }}
        title="Expression régulière"
        aria-pressed={regex}
        className={`btn btn-sm btn-icon font-mono font-semibold ${regex ? "btn-toggled" : "btn-ghost"}`}
      >
        .*
      </button>
      <button onClick={() => search(value, "prev")} title="Occurrence précédente (Maj+Entrée)" className="btn btn-ghost btn-sm btn-icon shrink-0">
        <IconChevronRight size={11} className="-rotate-90" />
      </button>
      <button onClick={() => search(value, "next")} title="Occurrence suivante (Entrée)" className="btn btn-ghost btn-sm btn-icon shrink-0">
        <IconChevronDown size={11} />
      </button>
      <button onClick={onClose} title="Fermer (Échap)" className="btn btn-ghost btn-sm btn-icon shrink-0">
        <IconClose size={11} />
      </button>
    </div>
  );
}
