import { useEffect } from "react";
import { useModalSurface } from "../hooks/useModalSurface";

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
  const { ref, dialogProps } = useModalSurface({ onClose: onCancel, label: title });

  // Entrée reste ici : c'est propre à cette boîte (confirmer d'un geste), là où
  // Échap et le piège à focus valent pour toutes.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Enter") onConfirm();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onConfirm]);

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/60" onClick={onCancel} />
      <div ref={ref} {...dialogProps} className="modal fixed left-1/2 top-1/2 z-50 w-full max-w-sm -translate-x-1/2 -translate-y-1/2 p-4">
        <h2 className="text-[14px] font-semibold text-[var(--c-text)]">{title}</h2>
        <p className="mt-1.5 text-[12.5px] leading-relaxed text-[var(--c-text-secondary)]">{message}</p>
        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onCancel} className="btn btn-ghost">
            {cancelLabel}
          </button>
          <button
            onClick={onConfirm}
            autoFocus
            className={`btn ${danger ? "btn-danger" : "btn-primary"}`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </>
  );
}
