import { useEffect, useRef, useState } from "react";
import { IconBroadcast, IconClose } from "./ui-icons";

interface BroadcastBarProps {
  targetCount: number;
  onSend: (command: string) => void;
  onClose: () => void;
}

export function BroadcastBar({ targetCount, onSend, onClose }: BroadcastBarProps) {
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const submit = () => {
    if (!value.trim()) return;
    onSend(value);
    setValue("");
  };

  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-amber-500/30 bg-amber-950/40 px-3 py-2">
      <IconBroadcast size={14} className="shrink-0 text-amber-300" />
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); submit(); }
          if (e.key === "Escape") { e.preventDefault(); onClose(); }
        }}
        placeholder={targetCount > 0 ? `Diffuser vers ${targetCount} terminal(aux)…` : "Aucun terminal ouvert"}
        disabled={targetCount === 0}
        className="min-w-0 flex-1 bg-transparent font-mono text-sm text-amber-100 placeholder:font-sans placeholder:text-amber-300/50 focus:outline-none disabled:cursor-not-allowed"
      />
      <button
        onClick={submit}
        disabled={targetCount === 0 || !value.trim()}
        className="shrink-0 rounded-md bg-amber-800/60 px-2.5 py-1 text-xs font-medium text-amber-100 hover:bg-amber-800 disabled:cursor-not-allowed disabled:opacity-40"
      >
        Envoyer
      </button>
      <button onClick={onClose} title="Fermer (Échap)" className="flex shrink-0 items-center rounded p-1 text-amber-300 hover:bg-white/10">
        <IconClose size={12} />
      </button>
    </div>
  );
}
