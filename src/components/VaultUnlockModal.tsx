import { useState } from "react";
import { useModalSurface } from "../hooks/useModalSurface";
import { IconShield } from "./ui-icons";

interface VaultUnlockModalProps {
  error: string | null;
  submitting: boolean;
  /** `null` when unlock is required at launch — no "Plus tard" escape then. */
  onDismiss: (() => void) | null;
  onSubmit: (password: string) => void;
}

/** Shown when the master-password vault exists but is locked (at launch, or
 * after auto-lock). Until unlocked, stored passwords/passphrases can't be read,
 * so connections needing them will fail — but the host list stays visible. */
export function VaultUnlockModal({ error, submitting, onDismiss, onSubmit }: VaultUnlockModalProps) {
  const { ref, dialogProps } = useModalSurface({ onClose: onDismiss ?? undefined, label: "Déverrouiller le coffre" });
  const [password, setPassword] = useState("");

  const submit = () => {
    if (password && !submitting) onSubmit(password);
  };

  return (
    <>
      <div className="fixed inset-0 z-[60] bg-black/70" onClick={() => onDismiss?.()} />
      <div ref={ref} {...dialogProps} className="fixed left-1/2 top-1/2 z-[61] w-full max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-lg bg-[var(--c-bg2)] p-5 shadow-[var(--shadow-lg)]">
        <div className="flex items-center gap-2.5">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--c-accent-dim)] text-[var(--c-accent-text)]">
            <IconShield size={18} />
          </div>
          <div>
            <h2 className="text-[15px] font-semibold text-[var(--c-text)]">Coffre verrouillé</h2>
            <p className="text-[12px] text-[var(--c-text-muted)]">Saisissez le mot de passe maître.</p>
          </div>
        </div>

        <input
          type="password"
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
          placeholder="Mot de passe maître"
          className="mt-4 w-full rounded-md bg-[var(--c-bg3)] px-3 py-2 text-[13px] text-[var(--c-text)] focus:outline-none focus:ring-1 focus:ring-[var(--c-accent-hover)]"
        />

        {error && (
          <p className="mt-2 rounded-md border border-rose-500/30 bg-rose-500/10 px-2.5 py-1.5 text-[12px] text-rose-200">{error}</p>
        )}

        <div className="mt-4 flex justify-end gap-2">
          {onDismiss && (
            <button onClick={onDismiss} className="rounded-md bg-[var(--c-bg3)] px-3 py-1.5 text-xs font-medium text-[var(--c-text-secondary)] hover:bg-white/5">
              Plus tard
            </button>
          )}
          <button
            onClick={submit}
            disabled={!password || submitting}
            className="rounded-md bg-[var(--c-accent)] px-3 py-1.5 text-xs font-medium text-white hover:bg-[var(--c-accent-hover)] disabled:opacity-50"
          >
            {submitting ? "Déverrouillage…" : "Déverrouiller"}
          </button>
        </div>
      </div>
    </>
  );
}
