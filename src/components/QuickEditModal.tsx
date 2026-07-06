import { useEffect, useState } from "react";
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
  const [value, setValue] = useState(content);

  // `content` arrives asynchronously (after the read completes) — sync it once loaded.
  useEffect(() => { if (!loading) setValue(content); }, [content, loading]);

  return (
    <>
      <div className="fixed inset-0 z-30 bg-black/60" onClick={onClose} />
      <div className="fixed inset-8 z-40 flex flex-col overflow-hidden rounded-lg bg-[var(--c-bg2)] shadow-[var(--shadow-lg)]">
        <div className="flex items-center justify-between border-b border-[var(--c-border)] px-4 py-2.5">
          <p className="truncate font-mono text-[13px] font-medium text-[var(--c-text)]">{fileName}</p>
          <button onClick={onClose} className="flex shrink-0 items-center rounded p-1 text-[var(--c-text-muted)] hover:bg-white/5 hover:text-[var(--c-text)]">
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
              className="h-full w-full resize-none rounded-md bg-[var(--c-bg3)] p-3 font-mono text-[13px] text-[var(--c-text)] focus:outline-none focus:ring-1 focus:ring-[var(--c-accent-hover)]"
            />
          )}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-[var(--c-border)] px-4 py-2.5">
          <span className="truncate text-[12px] text-rose-300">{error ?? ""}</span>
          <div className="flex shrink-0 gap-1.5">
            <button onClick={onClose} className="rounded-md bg-[var(--c-bg3)] px-3 py-1.5 text-xs text-[var(--c-text-secondary)] hover:bg-white/5">
              Annuler
            </button>
            <button
              onClick={() => onSave(value)}
              disabled={loading || saving}
              className="accent-surface rounded-md border px-3 py-1.5 text-xs font-medium disabled:opacity-50"
            >
              {saving ? "Enregistrement…" : "Enregistrer"}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
