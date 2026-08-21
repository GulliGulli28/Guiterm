import { useEffect, useRef, useState } from "react";
import type React from "react";
import type { Entry } from "../lib/types";

/** Glisser-déposer d'entrées entre les deux panneaux d'un onglet de transfert,
 * **à la souris** (`mousedown`/`mousemove`/`mouseup`) et non avec l'API HTML5
 * Drag and Drop.
 *
 * Ce n'est pas un choix de style : sous Windows, le glisser-déposer OS de
 * Tauri (`dragDropEnabled`, indispensable pour déposer un fichier depuis
 * l'Explorateur dans un panneau) désactive le drag HTML5 natif pour toute la
 * fenêtre. Un `draggable`/`onDragStart` classique ne se déclenche donc jamais
 * — c'est la raison pour laquelle le glisser-déposer entre panneaux n'a
 * jamais fonctionné. Voir CLAUDE.md, « Drag-and-drop natif vs Tauri ».
 *
 * Sorti de `TransferTab` pour être vérifiable : `scripts/visual-check-transfer-dnd.mjs`
 * monte deux panneaux avec ce hook dans un vrai navigateur et fait un vrai
 * glisser à la souris. Une plomberie de gestes ne se prouve pas en la lisant. */

export type PaneSide = "left" | "right";

/** Où un glisser atterrirait : un panneau, et éventuellement un dossier précis
 * de son listing (celui survolé au moment du lâcher). */
export interface PaneDropTarget {
  side: PaneSide;
  dir: string | null;
}

export interface PaneDragState {
  side: PaneSide;
  entries: Entry[];
  x: number;
  y: number;
  target: PaneDropTarget | null;
}

/** Distance à parcourir avant qu'un appui devienne un glisser. Sans elle, un
 * simple clic sur un nom de dossier partirait en glisser au moindre tremblement
 * de main. */
const DRAG_THRESHOLD_PX = 5;

export function usePaneDrag({
  paneRefs,
  onDrop,
}: {
  paneRefs: Record<PaneSide, React.RefObject<HTMLElement | null>>;
  /** Appelé seulement pour un dépôt qui veut dire quelque chose (voir la règle
   * dans `onUp` ci-dessous). */
  onDrop: (source: PaneSide, entries: Entry[], target: PaneDropTarget) => void;
}) {
  const sessionRef = useRef<{ side: PaneSide; entries: Entry[]; startX: number; startY: number; armed: boolean } | null>(null);
  /** Un vrai glisser vient de se terminer : le `click` que le navigateur émet
   * derrière ne doit pas être lu comme « ouvrir ce dossier ». */
  const justDraggedRef = useRef(false);
  const [drag, setDrag] = useState<PaneDragState | null>(null);

  // Les écouteurs sont posés une fois pour toutes ; `onDrop` et les refs
  // changent à chaque rendu, d'où le passage par une ref.
  const onDropRef = useRef(onDrop);
  onDropRef.current = onDrop;
  const paneRefsRef = useRef(paneRefs);
  paneRefsRef.current = paneRefs;

  const begin = (side: PaneSide, entries: Entry[], event: React.MouseEvent) => {
    if (event.button !== 0 || entries.length === 0) return;
    sessionRef.current = { side, entries, startX: event.clientX, startY: event.clientY, armed: false };
  };

  useEffect(() => {
    const targetAt = (x: number, y: number): PaneDropTarget | null => {
      for (const side of ["left", "right"] as const) {
        const el = paneRefsRef.current[side].current;
        if (!el) continue;
        const rect = el.getBoundingClientRect();
        if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) continue;
        // La vignette qui suit le curseur doit être `pointer-events-none`,
        // sans quoi elle serait toujours l'élément trouvé ici.
        const row = document.elementFromPoint(x, y)?.closest("[data-drop-dir]");
        const dir = row instanceof HTMLElement && row.dataset.dropSide === side ? row.dataset.dropDir ?? null : null;
        return { side, dir };
      }
      return null;
    };

    const onMove = (event: MouseEvent) => {
      const session = sessionRef.current;
      if (!session) return;
      if (!session.armed) {
        if (Math.hypot(event.clientX - session.startX, event.clientY - session.startY) < DRAG_THRESHOLD_PX) return;
        session.armed = true;
      }
      setDrag({
        side: session.side,
        entries: session.entries,
        x: event.clientX,
        y: event.clientY,
        target: targetAt(event.clientX, event.clientY),
      });
    };

    const onUp = (event: MouseEvent) => {
      const session = sessionRef.current;
      sessionRef.current = null;
      setDrag(null);
      if (!session || !session.armed) return;
      justDraggedRef.current = true;
      // Remis à false au tour de boucle suivant : le `click` du navigateur a
      // déjà été distribué à ce moment-là, mais aucun clic ultérieur ne doit
      // être avalé.
      setTimeout(() => { justDraggedRef.current = false; }, 0);

      const target = targetAt(event.clientX, event.clientY);
      if (!target) return;
      // Relâcher dans son propre panneau, ailleurs que sur un dossier, ne veut
      // rien dire — c'est le geste « finalement non ». Sur un de ses dossiers,
      // en revanche, c'est bien une copie dedans.
      if (target.side === session.side && !target.dir) return;
      onDropRef.current(session.side, session.entries, target);
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  return { drag, begin, justDraggedRef };
}
