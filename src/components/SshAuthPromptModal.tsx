import { useEffect, useRef, useState } from "react";
import type { SshAuthPrompt } from "../lib/types";

interface SshAuthPromptModalProps {
  prompt: SshAuthPrompt;
  onSubmit: (answers: string[]) => void;
  onCancel: () => void;
}

/** Asks the questions a server sent during keyboard-interactive
 * authentication (MFA/OTP) — see `core::interactive_auth`.
 *
 * The number and wording of the fields come entirely from the server: it may
 * ask one thing or several, and the labels differ by deployment
 * ("Verification code:", "Duo passcode or option (1-3):"…). They're rendered
 * verbatim, since they're the only clue as to *which* factor is wanted.
 *
 * An SSH handshake is blocked for as long as this is open, so both outcomes
 * are always reachable: submitting, or cancelling (which fails that one
 * connection immediately rather than letting it wait out its timeout). */
export function SshAuthPromptModal({ prompt, onSubmit, onCancel }: SshAuthPromptModalProps) {
  const [answers, setAnswers] = useState<string[]>(() => prompt.request.prompts.map(() => ""));
  const firstFieldRef = useRef<HTMLInputElement>(null);

  // A new round replaces the previous one in place (same modal, new
  // questions), so the answers have to be reset — otherwise round two would
  // start pre-filled with round one's input.
  useEffect(() => {
    setAnswers(prompt.request.prompts.map(() => ""));
    firstFieldRef.current?.focus();
  }, [prompt.id, prompt.request.prompts]);

  const submit = () => onSubmit(answers);

  return (
    <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/60 p-6">
      <form
        className="w-full max-w-md space-y-4 rounded-xl bg-[var(--c-bg2)] p-5 shadow-[var(--shadow-md)]"
        onSubmit={(e) => { e.preventDefault(); submit(); }}
      >
        <div className="space-y-1">
          <h2 className="text-[15px] font-semibold text-[var(--c-text)]">
            Authentification — {prompt.hostLabel}
          </h2>
          <p className="text-[12px] text-[var(--c-text-muted)]">
            Le serveur demande une vérification supplémentaire.
          </p>
        </div>

        {/* Server-provided title/instructions, shown only when non-empty —
            most servers leave them blank. */}
        {prompt.request.name && (
          <p className="text-[13px] font-medium text-[var(--c-text-secondary)]">{prompt.request.name}</p>
        )}
        {prompt.request.instructions && (
          <p className="whitespace-pre-wrap text-[12px] leading-relaxed text-[var(--c-text-secondary)]">
            {prompt.request.instructions}
          </p>
        )}

        {prompt.request.prompts.map((field, i) => (
          <label key={i} className="block space-y-1">
            <span className="text-xs font-medium text-[var(--c-text-secondary)]">{field.prompt}</span>
            <input
              ref={i === 0 ? firstFieldRef : undefined}
              // `echo: false` is the server saying this is secret-like.
              type={field.echo ? "text" : "password"}
              value={answers[i] ?? ""}
              onChange={(e) => setAnswers((prev) => prev.map((a, j) => (j === i ? e.target.value : a)))}
              autoFocus={i === 0}
              autoComplete="one-time-code"
              className="w-full rounded-md border border-[var(--c-border)] bg-[var(--c-bg3)] px-3 py-2 text-[13px] text-[var(--c-text)] outline-none focus:border-[var(--c-accent)]"
            />
          </label>
        ))}

        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md bg-[var(--c-bg3)] px-3 py-1.5 text-xs text-[var(--c-text-secondary)] hover:bg-white/5"
          >
            Annuler
          </button>
          <button type="submit" className="accent-surface rounded-md border px-3 py-1.5 text-xs font-medium">
            Valider
          </button>
        </div>
      </form>
    </div>
  );
}
