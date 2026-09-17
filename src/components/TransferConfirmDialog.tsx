import { useState } from "react";
import type { GuiVaultFollower } from "../lib/types";
import { KIND_LABELS } from "../lib/vaultTree";
import { useModalSurface } from "../hooks/useModalSurface";
import { KIND_ICONS } from "./VaultEntityTree";
import { IconLock } from "./ui-icons";

/**
 * « Ces entités suivront » : ce qu'un déplacement ou une copie emmène en
 * plus de la sélection, à confirmer avant d'agir.
 *
 * Une entité ne part jamais seule — sans son dossier un hôte arriverait
 * rangé nulle part, sans sa clé il ne s'authentifierait plus, sans son
 * bastion il ne serait plus joignable. Mais tout n'a pas à suivre : on peut
 * vouloir partager un hôte sans partager le bastion de toute l'équipe.
 * D'où deux niveaux, décidés par le backend (`transfer::plan`) : les
 * **obligatoires** (dossiers, contenu d'un dossier) sont listés verrouillés ;
 * le reste (clé, icône, bastion, relais Docker, hôte d'un tunnel) est coché
 * et se décoche. Rien n'est caché : la liste est ce qui va réellement bouger.
 */
export interface TransferConfirmDialogProps {
  /** « Déplacer 3 entités vers « Équipe infra » ». */
  title: string;
  confirmLabel: string;
  followers: GuiVaultFollower[];
  busy?: boolean;
  /** Les ids des suiveurs facultatifs **décochés** — le backend recalcule
   * tout le reste (voir `api.guivaultTransferEntities`). */
  onConfirm: (droppedIds: string[]) => void;
  onCancel: () => void;
}

export function TransferConfirmDialog({ title, confirmLabel, followers, busy, onConfirm, onCancel }: TransferConfirmDialogProps) {
  const { ref, dialogProps } = useModalSurface({ onClose: onCancel, label: title });
  const [dropped, setDropped] = useState<Set<string>>(new Set());
  const required = followers.filter((f) => f.required);
  const optional = followers.filter((f) => !f.required);
  const keptCount = followers.reduce((n, f) => n + (f.required || !dropped.has(f.entity.id) ? 1 + (f.brings?.length ?? 0) : 0), 0);

  const row = (f: GuiVaultFollower) => {
    const Icon = KIND_ICONS[f.entity.kind];
    const off = !f.required && dropped.has(f.entity.id);
    return (
      <label
        key={f.entity.id}
        className={`flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1 ${f.required ? "" : "cursor-pointer hover:bg-[var(--c-hover)]"} ${off ? "opacity-60" : ""}`}
        data-transfer-follower={f.entity.name}
      >
        {f.required ? (
          <IconLock size={12} className="shrink-0 text-[var(--c-text-muted)]" />
        ) : (
          <input
            type="checkbox"
            checked={!off}
            onChange={(e) => setDropped((d) => { const n = new Set(d); if (e.target.checked) n.delete(f.entity.id); else n.add(f.entity.id); return n; })}
            aria-label={`Emmener ${f.entity.name}`}
          />
        )}
        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-[var(--c-bg3)] text-[var(--c-text-secondary)]"><Icon size={11} /></span>
        <span className="min-w-0 flex-1 truncate text-[12.5px] text-[var(--c-text)]" title={KIND_LABELS[f.entity.kind]}>
          {f.entity.name}
          {f.brings && f.brings.length > 0 && (
            <span className="text-[var(--c-text-muted)]" title={f.brings.map((b) => `${KIND_LABELS[b.kind]} « ${b.name} »`).join(", ")}> — avec {f.brings.map((b) => b.name).join(", ")}</span>
          )}
        </span>
        <span className="shrink-0 truncate text-[11px] text-[var(--c-text-muted)]">{f.reason}</span>
      </label>
    );
  };

  return (
    <>
      <div className="fixed inset-0 z-[60] bg-black/50" onClick={onCancel} />
      <div ref={ref} {...dialogProps} className="modal fixed left-1/2 top-1/2 z-[70] flex max-h-[80vh] w-[480px] max-w-[92vw] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden" data-transfer-confirm="">
        <div className="px-4 pt-4">
          <h2 className="text-[14px] font-semibold text-[var(--c-text)]">{title}</h2>
          <p className="mt-1 text-[12px] leading-relaxed text-[var(--c-text-secondary)]">
            Ces entités suivront. Les dossiers sont indispensables pour que tout arrive rangé à sa place ; le reste est proposé — décochez ce qui doit rester où il est.
          </p>
        </div>
        <div className="sidebar-scroll min-h-0 flex-1 overflow-y-auto px-3 py-2">
          {required.length > 0 && (
            <>
              <p className="eyebrow px-1.5 pb-1 pt-1">Suivent toujours</p>
              {required.map(row)}
            </>
          )}
          {optional.length > 0 && (
            <>
              <p className="eyebrow px-1.5 pb-1 pt-2">Proposés</p>
              {optional.map(row)}
            </>
          )}
        </div>
        <div className="flex items-center gap-2 border-t border-[var(--c-border)] px-4 py-3">
          <span className="text-[11.5px] text-[var(--c-text-secondary)]">{keptCount} suiveur{keptCount > 1 ? "s" : ""}</span>
          <span className="ml-auto flex gap-1.5">
            <button onClick={onCancel} className="btn btn-ghost">Annuler</button>
            <button onClick={() => onConfirm([...dropped])} disabled={busy} autoFocus className="btn btn-primary">{confirmLabel}</button>
          </span>
        </div>
      </div>
    </>
  );
}
