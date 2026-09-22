import type { KeyboardEvent } from "react";

/**
 * Les touches d'un menu contextuel (`role="menu"` + `.menu-item`) : ↑/↓
 * passent d'une entrée à l'autre en boucle, Début/Fin aux bouts, Échap
 * ferme. Entrée et Espace sont ceux du bouton focalisé, natifs. À poser en
 * `onKeyDown` sur le popover ; `focusFirstMenuItem` à l'ouverture, pour
 * qu'un menu ouvert au clavier (Maj+F10) se parcoure sans Tab.
 */
export function handleMenuKey(e: KeyboardEvent<HTMLElement>, onClose: () => void) {
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    // Le focus revient à la liste d'où le menu est parti (son curseur y est
    // encore) plutôt que de tomber sur `body`.
    const zone = e.currentTarget.closest<HTMLElement>(".nav-zone");
    onClose();
    zone?.focus();
    return;
  }
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
  e.preventDefault();
  // Le menu vit dans le DOM de sa liste : sans ça, ↓ ferait aussi avancer
  // le curseur de la liste dessous, qui reprendrait le focus au passage.
  e.stopPropagation();
  const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>(".menu-item:not(:disabled)"));
  if (items.length === 0) return;
  const idx = items.findIndex((el) => el === document.activeElement);
  const next = e.key === "Home" ? 0
    : e.key === "End" ? items.length - 1
    : e.key === "ArrowDown" ? (idx + 1) % items.length
    : (idx - 1 + items.length) % items.length;
  items[next].focus();
}

export function focusFirstMenuItem(menu: HTMLElement | null) {
  menu?.querySelector<HTMLElement>(".menu-item:not(:disabled)")?.focus();
}
