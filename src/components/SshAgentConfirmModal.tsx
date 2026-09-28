import { useState } from "react";
import { useModalSurface } from "../hooks/useModalSurface";
import type { SshAgentConfirm } from "../lib/types";

/** Ce que l'agent SSH s'apprête à signer, pour qu'on l'accepte en
 * connaissance de cause — voir `core::ssh_agent`. Le client (`ssh`, `git`…)
 * attend la réponse ; Échap ou « Refuser » la lui refusent tout de suite. */
export function SshAgentConfirmModal({ prompt, onAnswer }: { prompt: SshAgentConfirm; onAnswer: (allow: boolean, remember: boolean) => void }) {
  const [remember, setRemember] = useState(false);
  const refuse = () => onAnswer(false, false);
  const { ref, dialogProps } = useModalSurface<HTMLDivElement>({ label: "Agent SSH", onClose: refuse });
  const { request } = prompt;
  const p = request.purpose;

  let title: string;
  let detail: string | null = null;
  switch (p.kind) {
    case "sshLogin":
      title = p.hosts.length ? `Connexion SSH à ${p.hosts.map((h) => h.label).join(", ")}` : "Connexion SSH";
      detail = `en tant que « ${p.user} »${p.hosts.length === 0 ? (p.fingerprint ? ` — serveur inconnu de Guiterm (${p.fingerprint})` : " — serveur non annoncé par le client") : ""}`;
      break;
    case "gitSignature":
      title = "Signature d'un commit ou d'une étiquette Git";
      break;
    case "sshsig":
      title = `Signature SSH (espace « ${p.namespace} »)`;
      break;
    default:
      title = "Signature d'une donnée inconnue";
      detail = "Ni une connexion SSH, ni une signature reconnue : n'acceptez que si vous savez ce qui la demande.";
  }
  const who = request.client.program ? `${request.client.program}${request.client.pid ? ` (pid ${request.client.pid})` : ""}` : "un programme";

  return (
    <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/50 p-6">
      <div ref={ref} {...dialogProps} className="w-full max-w-md space-y-3 modal p-5">
        <div className="space-y-1">
          <p className="eyebrow">Agent SSH</p>
          <h2 className="text-[14px] font-semibold text-[var(--c-text)]">{title}</h2>
          {detail && <p className="text-[12px] text-[var(--c-text-muted)]">{detail}</p>}
        </div>
        <div className="space-y-1 rounded-md bg-[var(--c-bg3)] p-3 text-[12px] text-[var(--c-text-secondary)]">
          <p>
            Clé : <span className="font-medium text-[var(--c-text)]">{request.keyName}</span>
          </p>
          <p className="break-all font-mono text-[11px] text-[var(--c-text-muted)]">{request.keyFingerprint}</p>
          <p>Demandée par : {who}</p>
        </div>
        {request.forwarded && (
          <p className="text-[12px] text-[var(--c-warning,orange)]">
            Demande venue d'un serveur distant, par un agent transféré : n'importe quel administrateur de ce serveur pourrait l'émettre. L'accord vaut pour cette fois seulement.
          </p>
        )}
        {!request.forwarded && (
          <label className="flex items-center gap-2 text-[12px] text-[var(--c-text-secondary)]">
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} className="h-3.5 w-3.5" />
            Ne plus demander pour cette clé pendant 10 minutes
          </label>
        )}
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={refuse} className="btn btn-ghost">
            Refuser
          </button>
          <button type="button" onClick={() => onAnswer(true, remember)} className="btn btn-primary" autoFocus>
            Autoriser
          </button>
        </div>
      </div>
    </div>
  );
}
