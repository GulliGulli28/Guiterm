import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type { FleetTarget, RunbookApprovalRequest } from "../lib/types";
import { fleetTargetKey } from "../lib/types";
import { assertNever } from "../lib/exhaustive";
import { useModalSurface } from "../hooks/useModalSurface";

interface Props {
  request: RunbookApprovalRequest;
  labelOf: (t: FleetTarget) => string;
  onApprove: () => void;
  onRefuse: () => void;
}

/** Le compte à rebours, en clair. Sans lui, « refusée par défaut » est une
 * phrase ; avec, c'est une échéance qu'on voit descendre — et la différence
 * compte quand on hésite à aller vérifier quelque chose avant de répondre. */
function useCountdown(seconds: number): number {
  const [left, setLeft] = useState(seconds);
  useEffect(() => {
    setLeft(seconds);
    const id = setInterval(() => setLeft((n) => (n > 0 ? n - 1 : 0)), 1000);
    return () => clearInterval(id);
  }, [seconds]);
  return left;
}

function formatCountdown(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * La pause d'approbation avant une étape sans retour.
 *
 * **Rendue dans un portail**, contrairement aux six autres boîtes de l'app, et
 * c'est la raison d'être du seul `createPortal` du dépôt : un onglet inactif
 * reste monté mais dans un conteneur `hidden` (voir `App.tsx`), donc une modale
 * rendue à sa place serait invisible dès que l'utilisateur regarde ailleurs —
 * et une demande qu'on ne voit pas finit refusée au bout du délai, sur une
 * procédure qu'on croyait en train de tourner. Le portail la sort du conteneur
 * masqué sans faire remonter les runbooks dans `App.tsx`, ce que le registre de
 * modules cherche justement à éviter.
 *
 * **Tout ce qui n'est pas un « oui » explicite est un non** : Échap, le clic
 * hors de la boîte et l'expiration du délai refusent tous les trois. C'est ce
 * qui fait qu'une pause oubliée arrête la procédure au lieu de la laisser
 * passer.
 */
export function RunbookApprovalModal({ request, labelOf, onApprove, onRefuse }: Props) {
  const { ref, dialogProps } = useModalSurface<HTMLDivElement>({
    onClose: onRefuse,
    label: `Approbation demandée : ${request.title}`,
  });
  const left = useCountdown(request.timeoutSecs);

  const targets = useMemo(
    () => request.commands.map((c) => ({ key: fleetTargetKey(c.target), label: labelOf(c.target), command: c.command })),
    [request.commands, labelOf],
  );

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onRefuse(); }}
    >
      <div
        ref={ref}
        {...dialogProps}
        className="flex max-h-[80vh] w-full max-w-xl flex-col overflow-hidden rounded-xl border border-[var(--c-border)] bg-[var(--c-bg2)] shadow-2xl"
      >
        <div className="border-b border-[var(--c-border)] px-4 py-3">
          <p className="text-sm font-semibold text-[var(--c-text)]">Approbation demandée</p>
          <p className="mt-0.5 text-[11px] text-[var(--c-text-muted)]">
            {request.runbookName} · étape {request.stepIndex + 1} : {request.title}
          </p>
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
          <ApprovalWhy reason={request.reason} />

          <div>
            <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--c-text-secondary)]">
              Ce qui partira ({targets.length} machine{targets.length > 1 ? "s" : ""})
            </p>
            <div className="space-y-1">
              {targets.map((t) => (
                <div key={t.key} className="rounded border border-[var(--c-border)] bg-[var(--c-bg3)] px-2 py-1.5">
                  <div className="text-[11px] text-[var(--c-text)]">{t.label}</div>
                  <pre className="mt-0.5 whitespace-pre-wrap break-all font-mono text-[10px] text-[var(--c-text-muted)]">
                    {t.command}
                  </pre>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2 border-t border-[var(--c-border)] px-4 py-3">
          <span className="text-[11px] text-[var(--c-text-muted)]">
            Sans réponse dans <span className="font-mono text-[var(--c-text)]">{formatCountdown(left)}</span>, l'étape
            est <strong>refusée</strong> et la procédure s'arrête.
          </span>
          <button
            onClick={onRefuse}
            className="ml-auto rounded border border-[var(--c-border)] px-3 py-1.5 text-xs text-[var(--c-text)] hover:border-[#ef4444]"
          >
            Refuser et arrêter
          </button>
          <button
            onClick={onApprove}
            className="rounded bg-[var(--c-accent)] px-3 py-1.5 text-xs text-white"
          >
            Approuver et continuer
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** Pourquoi on demande. `switch` fermé sur `assertNever` : une troisième raison
 * ajoutée côté Rust sans phrase ici deviendrait une erreur `tsc`, pas une boîte
 * qui demanderait sans dire quoi. */
function ApprovalWhy({ reason }: { reason: RunbookApprovalRequest["reason"] }) {
  switch (reason.kind) {
    case "irreversible":
      return (
        <div className="rounded border border-[#ef4444] bg-[#ef444411] px-3 py-2">
          <p className="text-[11px] font-semibold text-[#ef4444]">
            Cette étape fait des choses qui ne pourront pas être défaites.
          </p>
          <ul className="mt-1.5 space-y-1">
            {reason.operations.map((op) => (
              <li key={op.operation} className="text-[11px] text-[var(--c-text)]">
                <code className="font-mono">{op.operation}</code>
                <span className="text-[var(--c-text-muted)]"> — {op.reason}</span>
              </li>
            ))}
          </ul>
        </div>
      );
    case "requested":
      return (
        <p className="rounded border border-[var(--c-border)] bg-[var(--c-bg3)] px-3 py-2 text-[11px] text-[var(--c-text-muted)]">
          Cette étape est réglée sur « toujours demander » — un point de contrôle, pas un avertissement : rien ici
          n'est marqué comme irréversible.
        </p>
      );
    default:
      return assertNever(reason, "raison d approbation de runbook");
  }
}
