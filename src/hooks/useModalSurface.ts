import { useCallback, useEffect, useRef } from "react";
import { FOCUSABLE_SELECTOR, nextTrappedIndex } from "../lib/focusTrap";

interface ModalSurfaceOptions {
  /** Fermeture demandée par l'utilisateur : Échap, ou clic hors de la boîte.
   * `undefined` pour une modale qu'on ne peut pas simplement écarter. */
  onClose?: () => void;
  /** Ce que le lecteur d'écran annonce à l'ouverture. */
  label: string;
}

/**
 * Le comportement commun des six boîtes de dialogue de l'app.
 *
 * Chacune réimplémentait sa touche Échap (l'une l'avait oubliée) et aucune ne
 * se déclarait comme dialogue ni ne retenait le focus. Trois manques, un seul
 * endroit désormais :
 *
 * - **`role="dialog"` + `aria-modal`** : sans eux, rien n'annonce qu'une boîte
 *   s'est ouverte, et un lecteur d'écran continue de lire la page derrière.
 * - **Focus piégé** : Tab boucle dans la modale au lieu d'en sortir vers des
 *   contrôles masqués par le voile.
 * - **Focus rendu à la fermeture** : on revient sur le bouton qui a ouvert la
 *   boîte, pas au début du document. C'est ce qui fait qu'ouvrir puis annuler
 *   ne coûte pas de se réorienter.
 */
export function useModalSurface<T extends HTMLElement = HTMLDivElement>({ onClose, label }: ModalSurfaceOptions) {
  // Générique sur l'élément : la boîte est un `<div>` cinq fois sur six, et un
  // `<form>` pour l'invite d'authentification.
  const ref = useRef<T>(null);
  // Capturé au montage : `document.activeElement` au moment où la modale
  // s'ouvre est le contrôle qui l'a déclenchée.
  const openerRef = useRef<Element | null>(null);

  const focusables = useCallback((): HTMLElement[] => {
    const root = ref.current;
    if (!root) return [];
    return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
      // `offsetParent === null` écarte ce qui est masqué (`hidden`,
      // `display:none`) : le piège doit suivre ce qui est réellement visible,
      // pas ce que le DOM contient.
      .filter((el) => el.offsetParent !== null || el === document.activeElement);
  }, []);

  useEffect(() => {
    openerRef.current = document.activeElement;
    const root = ref.current;
    // Rien de focalisable ? On focalise la boîte elle-même, sinon Tab repart
    // dans la page derrière dès la première frappe.
    if (root && focusables().length === 0) root.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && onClose) {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const items = focusables();
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const current = items.indexOf(document.activeElement as HTMLElement);
      const next = nextTrappedIndex(items.length, current, e.shiftKey);
      e.preventDefault();
      items[next]?.focus();
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      const opener = openerRef.current;
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, [onClose, focusables]);

  return {
    ref,
    /** À étaler sur le conteneur de la boîte, pas sur le voile. */
    dialogProps: {
      role: "dialog" as const,
      "aria-modal": true,
      "aria-label": label,
      // Focalisable par script (pour le repli ci-dessus) mais pas par Tab.
      tabIndex: -1,
    },
  };
}
