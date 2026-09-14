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
    <div className="flex shrink-0 items-center gap-2 border-b border-[color-mix(in_srgb,var(--c-warn)_35%,transparent)] bg-[color-mix(in_srgb,var(--c-warn)_10%,transparent)] px-3 py-2">
      <IconBroadcast size={14} className="shrink-0 text-[var(--c-warn)]" />

      <div className="segmented shrink-0">
        <button onClick={() => { if (liveSyncMode) onToggleLiveSync(); }} data-active={!liveSyncMode ? "true" : undefined} className="!py-0.5 !text-[11.5px]">
          Commande
        </button>
        <button onClick={() => { if (!liveSyncMode) onToggleLiveSync(); }} data-active={liveSyncMode ? "true" : undefined} className="!py-0.5 !text-[11.5px]">
          Direct
        </button>
      </div>

      {liveSyncMode ? (
        <p className="min-w-0 flex-1 truncate text-[12px] text-[var(--c-text-secondary)]">
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
          className="min-w-0 flex-1 bg-transparent font-mono text-[12.5px] text-[var(--c-text)] outline-none placeholder:font-sans placeholder:text-[var(--c-text-muted)] disabled:cursor-not-allowed"
        />
      )}

      <TerminalTargetPicker terminals={targets} selected={selectedIds} onChange={onChangeSelected} emptyLabel="Aucune cible" />
      {!liveSyncMode && (
        <button
          onClick={submit}
          disabled={selectedIds.size === 0 || !value.trim()}
          className="btn btn-sm shrink-0 border-[color-mix(in_srgb,var(--c-warn)_40%,transparent)] bg-[color-mix(in_srgb,var(--c-warn)_15%,transparent)] text-[var(--c-warn)] hover:bg-[color-mix(in_srgb,var(--c-warn)_25%,transparent)]"
        >
          Envoyer
        </button>
      )}
      <button onClick={onClose} title="Fermer (Échap)" className="btn btn-ghost btn-sm btn-icon shrink-0 text-[var(--c-warn)]">
        <IconClose size={12} />
      </button>
    </div>
  );
}
