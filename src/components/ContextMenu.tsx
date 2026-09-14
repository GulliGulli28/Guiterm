import { useEffect, useRef, useState } from "react";

/** Une entrée de menu. `id` est facultatif : le menu n'en a besoin que pour sa
 * clé de rendu, et deux entrées du panneau de transfert n'en portent pas. Les
 * actions du bus d'objets, elles, en ont toutes un — voir `ObjectAction`. */
export interface ContextMenuItem {
  id?: string;
  label: string;
  run: () => void;
  disabled?: boolean;
  danger?: boolean;
}

/** Menu contextuel du clic droit. Positionné au curseur, replié dans la
 * fenêtre s'il déborde, fermé au moindre clic ailleurs, à Échap ou au
 * défilement — un menu resté ouvert au-dessus d'une liste qui a bougé
 * désignerait autre chose que ce qu'il annonce.
 *
 * Vivait dans `TransferTab.tsx`, sorti le 2026-09-08 pour le bus d'objets :
 * « Envoyer vers… » a besoin exactement de ce menu, et en écrire un second
 * aurait donné deux menus à garder d'accord sur le repli, la fermeture au
 * défilement et le clic-ailleurs. Extraction sans changement de comportement,
 * à `id` près. */
export function ContextMenu({
  x, y, items, header, onClose,
}: {
  x: number;
  y: number;
  items: ContextMenuItem[];
  /** Ce sur quoi le menu agit, quand ça ne se lit pas au point de clic. Le
   * menu du clic droit d'un panneau de fichiers s'en passe — la ligne est
   * sous le curseur ; celui du bus d'objets le porte, parce qu'il s'ouvre
   * aussi depuis un bouton de barre d'outils. */
  header?: string;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ x, y });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPosition({
      x: Math.min(x, window.innerWidth - rect.width - 8),
      y: Math.min(y, window.innerHeight - rect.height - 8),
    });
  }, [x, y]);

  useEffect(() => {
    const close = () => onClose();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("mousedown", close);
    window.addEventListener("wheel", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("wheel", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      data-context-menu
      style={{ left: position.x, top: position.y }}
      onMouseDown={(e) => e.stopPropagation()}
      className="popover fixed z-50 min-w-44 py-1 text-[12.5px]"
    >
      {header && (
        <p
          title={header}
          className="max-w-[22rem] truncate border-b border-[var(--c-border)] px-2.5 pb-1 pt-0.5 font-mono text-[10.5px] text-[var(--c-text-faint)]"
        >
          {header}
        </p>
      )}
      {items.map((item) => (
        <button
          key={item.id ?? item.label}
          disabled={item.disabled}
          onClick={() => { item.run(); onClose(); }}
          className={`menu-item disabled:opacity-40 disabled:hover:bg-transparent ${
            item.danger ? "text-[var(--c-danger)] hover:!text-[var(--c-danger)]" : ""
          }`}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
