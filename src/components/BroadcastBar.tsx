import { useEffect, useRef, useState } from "react";
import { IconBroadcast, IconClose } from "./ui-icons";
import { TerminalTargetPicker } from "./TerminalTargetPicker";

interface BroadcastBarProps {
  targets: { id: string; label: string }[];
  selectedIds: Set<string>;
  onChangeSelected: (next: Set<string>) => void;
  liveSyncMode: boolean;
  onToggleLiveSync: () => void;
  onSend: (command: string) => void;
  onClose: () => void;
}

export function BroadcastBar({ targets, selectedIds, onChangeSelected, liveSyncMode, onToggleLiveSync, onSend, onClose }: BroadcastBarProps) {
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (!liveSyncMode) inputRef.current?.focus(); }, [liveSyncMode]);

  const submit = () => {
    if (!value.trim() || selectedIds.size === 0) return;
    onSend(value);
    setValue("");
  };

  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-amber-500/30 bg-amber-950/40 px-3 py-2">
      <IconBroadcast size={14} className="shrink-0 text-amber-300" />

      <div className="flex shrink-0 rounded-md bg-black/20 p-0.5">
        <button
          onClick={() => { if (liveSyncMode) onToggleLiveSync(); }}
          className={`rounded px-2 py-0.5 text-[11px] font-medium ${!liveSyncMode ? "bg-amber-800 text-amber-50" : "text-amber-300/70 hover:text-amber-200"}`}
        >
          Commande
        </button>
        <button
          onClick={() => { if (!liveSyncMode) onToggleLiveSync(); }}
          className={`rounded px-2 py-0.5 text-[11px] font-medium ${liveSyncMode ? "bg-amber-800 text-amber-50" : "text-amber-300/70 hover:text-amber-200"}`}
        >
          Direct
        </button>
      </div>

      {liveSyncMode ? (
        <p className="min-w-0 flex-1 truncate text-xs text-amber-200/80">
          Tapez dans un terminal : la frappe est répercutée en direct vers {selectedIds.size} terminal(aux) sélectionné(s).
        </p>
      ) : (
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); submit(); }
            if (e.key === "Escape") { e.preventDefault(); onClose(); }
          }}
          placeholder={selectedIds.size > 0 ? `Diffuser vers ${selectedIds.size} terminal(aux)…` : "Aucune cible sélectionnée"}
          disabled={targets.length === 0}
          className="min-w-0 flex-1 bg-transparent font-mono text-sm text-amber-100 placeholder:font-sans placeholder:text-amber-300/50 focus:outline-none disabled:cursor-not-allowed"
        />
      )}

      <TerminalTargetPicker terminals={targets} selected={selectedIds} onChange={onChangeSelected} emptyLabel="Aucune cible" />
      {!liveSyncMode && (
        <button
          onClick={submit}
          disabled={selectedIds.size === 0 || !value.trim()}
          className="shrink-0 rounded-md bg-amber-800/60 px-2.5 py-1 text-xs font-medium text-amber-100 hover:bg-amber-800 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Envoyer
        </button>
      )}
      <button onClick={onClose} title="Fermer (Échap)" className="flex shrink-0 items-center rounded p-1 text-amber-300 hover:bg-white/10">
        <IconClose size={12} />
      </button>
    </div>
  );
}
