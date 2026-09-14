import { useEffect, useState } from "react";
import { useModalSurface } from "../hooks/useModalSurface";
import { IconClose } from "./ui-icons";

interface QuickEditModalProps {
  fileName: string;
  content: string;
  loading: boolean;
  saving: boolean;
  error: string | null;
  onSave: (content: string) => void;
  onClose: () => void;
}

export function QuickEditModal({ fileName, content, loading, saving, error, onSave, onClose }: QuickEditModalProps) {
  const { ref, dialogProps } = useModalSurface({ onClose, label: "Édition rapide" });
  const [value, setValue] = useState(content);

  // `content` arrives asynchronously (after the read completes) — sync it once loaded.
  useEffect(() => { if (!loading) setValue(content); }, [content, loading]);


  return (
    <>
      <div className="fixed inset-0 z-30 bg-black/50" onClick={onClose} />
      <div ref={ref} {...dialogProps} className="fixed inset-8 z-40 flex flex-col modal overflow-hidden">
        <div className="flex items-center justify-between border-b border-[var(--c-border)] px-4 py-2.5">
          <p className="truncate font-mono text-[13px] font-medium text-[var(--c-text)]">{fileName}</p>
          <button aria-label="Fermer l'éditeur" onClick={onClose} className="btn btn-ghost btn-sm btn-icon shrink-0">
            <IconClose size={14} />
          </button>
        </div>

        <div className="min-h-0 flex-1 p-2">
          {loading ? (
            <div className="flex h-full items-center justify-center text-sm text-[var(--c-text-muted)]">Chargement…</div>
          ) : (
            <textarea
              autoFocus
              value={value}
              onChange={(e) => setValue(e.target.value)}
              spellCheck={false}
              className="input input-mono h-full w-full resize-none"
            />
          )}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-[var(--c-border)] px-4 py-2.5">
          <span className="truncate text-[12px] text-[var(--c-danger)]">{error ?? ""}</span>
          <div className="flex shrink-0 gap-1.5">
            <button onClick={onClose} className="btn btn-ghost">
              Annuler
            </button>
            <button
              onClick={() => onSave(value)}
              disabled={loading || saving}
              className="btn btn-primary disabled:opacity-50"
            >
              {saving ? "Enregistrement…" : "Enregistrer"}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
