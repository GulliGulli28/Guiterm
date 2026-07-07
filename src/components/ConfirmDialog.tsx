import { useEffect } from "react";

interface ConfirmDialogProps {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({ title, message, confirmLabel = "Confirmer", cancelLabel = "Annuler", danger, onConfirm, onCancel }: ConfirmDialogProps) {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
      if (e.key === "Enter") onConfirm();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onConfirm, onCancel]);

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/60" onClick={onCancel} />
      <div className="fixed left-1/2 top-1/2 z-50 w-full max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-lg bg-[var(--c-bg2)] p-4 shadow-[var(--shadow-lg)]">
        <h2 className="text-[15px] font-semibold text-[var(--c-text)]">{title}</h2>
        <p className="mt-1.5 text-[13px] leading-relaxed text-[var(--c-text-secondary)]">{message}</p>
        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onCancel} className="rounded-md bg-[var(--c-bg3)] px-3 py-1.5 text-xs font-medium text-[var(--c-text-secondary)] hover:bg-white/5">
            {cancelLabel}
          </button>
          <button
            onClick={onConfirm}
            autoFocus
            className={`rounded-md px-3 py-1.5 text-xs font-medium text-white ${danger ? "bg-rose-700 hover:bg-rose-600" : "bg-[var(--c-accent)] hover:bg-[var(--c-accent-hover)]"}`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </>
  );
}
