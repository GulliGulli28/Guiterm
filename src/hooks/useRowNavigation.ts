import { useCallback, useEffect, useRef, type KeyboardEvent, type MouseEvent, type RefObject } from "react";
import { isTypingKey, parentRow, stepCursor, type CursorKey } from "../lib/keyboardNav";

/**
 * Le curseur clavier d'une liste — de **toutes** les listes de la barre
 * latérale, sans qu'aucune n'ait à s'en occuper.
 *
 * Le conteneur est la seule chose focalisable (`tabIndex={0}`) ; les lignes
 * (`[data-nav-row]`, posé par `EntityRow`, `GroupRow`, `TargetTreeList`) sont
 * lues dans le DOM à chaque touche, dans l'ordre de l'écran, replis compris
 * (une ligne masquée n'a pas d'`offsetParent`). Le curseur est l'élément
 * lui-même, marqué `data-nav-cursor` — pas un état React : les panneaux ne
 * savent pas quelles lignes ils ont, et le hook n'a pas besoin qu'ils le
 * disent.
 *
 * Touches, sur le conteneur ou sur un bouton d'une ligne (cliqué à la
 * souris) — jamais dans un champ de saisie du panneau, qui garde les
 * siennes :
 *
 * - ↑ ↓ Début Fin : le curseur ;
 * - Entrée : l'action principale de la ligne (`[data-nav-primary]`, sinon
 *   son premier bouton) — se connecter, ouvrir, déplier ;
 * - → : déplie (`[data-nav-toggle="collapsed"]`) ; ← : replie, ou remonte
 *   au dossier parent (`data-nav-depth`) ;
 * - Espace : coche (`[data-nav-check]`, sinon la première case) ;
 * - Maj+F10 ou touche Menu : le menu « … » (`[data-nav-menu]`), sinon le
 *   premier bouton d'action de la ligne (`[data-nav-actions]`) ;
 * - Échap : `onEscape` (retour au terminal, en pratique) ;
 * - une lettre : `onType` donne le focus à la recherche du panneau, et la
 *   touche y arrive d'elle-même — le navigateur insère le caractère dans ce
 *   qui a le focus *après* les gestionnaires de `keydown`, donc sans
 *   `preventDefault` ni écriture dans un état qu'on ne connaît pas.
 */
export interface RowNavigationOptions {
  onEscape?: () => void;
  /** Rend l'élément qui doit recevoir la frappe (la recherche), ou `null`. */
  onType?: () => HTMLElement | null;
}

const CURSOR_KEYS: ReadonlySet<string> = new Set(["ArrowDown", "ArrowUp", "Home", "End"]);

function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return el.matches("input, textarea, select, [contenteditable=''], [contenteditable='true']");
}

function visibleRows(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>("[data-nav-row]")).filter((el) => el.offsetParent !== null);
}

export function useRowNavigation(ref: RefObject<HTMLElement | null>, { onEscape, onType }: RowNavigationOptions = {}) {
  const cursorRef = useRef<HTMLElement | null>(null);

  /** `scroll` : amener la ligne à l'écran — au clavier seulement. Au clic,
   * faire défiler entre `mousedown` et `mouseup` déplacerait la case sous la
   * souris, et le clic n'arriverait jamais. */
  const mark = useCallback((el: HTMLElement | null, scroll = true) => {
    const container = ref.current;
    if (!container) return;
    for (const other of container.querySelectorAll<HTMLElement>("[data-nav-cursor]")) {
      if (other !== el) other.removeAttribute("data-nav-cursor");
    }
    if (el) {
      el.setAttribute("data-nav-cursor", "true");
      if (scroll) el.scrollIntoView({ block: "nearest" });
    }
    cursorRef.current = el;
  }, [ref]);

  // Le marqueur survit aux rendus : React ne touche pas à un attribut qu'il
  // ne gère pas, mais une ligne recréée (nouvelle `key`) repartirait sans.
  // Et un panneau qui arrive après le focus (module chargé à la demande,
  // liste reçue du backend) prend son curseur dès que ses lignes existent.
  useEffect(() => {
    const container = ref.current;
    if (!container) return;
    const settle = () => {
      const el = cursorRef.current;
      if (el && el.isConnected && container.contains(el)) {
        if (!el.hasAttribute("data-nav-cursor")) el.setAttribute("data-nav-cursor", "true");
        return;
      }
      if (document.activeElement === container) {
        const rows = visibleRows(container);
        if (rows.length > 0) mark(rows[0], false);
      }
    };
    settle();
    const observer = new MutationObserver(settle);
    observer.observe(container, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [ref, mark]);

  /** Le curseur, s'il est encore dans la liste ; sinon rien (↓ repartira du
   * haut). */
  const current = (rows: HTMLElement[]): HTMLElement | null => {
    const el = cursorRef.current;
    return el && rows.includes(el) ? el : null;
  };

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    const container = ref.current;
    if (!container) return;
    // Depuis la recherche du panneau, ↑/↓ reviennent à la liste — le
    // chemin inverse de la lettre qui y a mené. Les autres champs gardent
    // toutes leurs touches.
    const fromSearch = e.target instanceof HTMLElement && e.target.matches("[data-panel-search]") && (e.key === "ArrowDown" || e.key === "ArrowUp");
    if (isTypingTarget(e.target) && !fromSearch) return;
    // Un menu ou une modale ouverts dans le panneau ont leurs propres touches.
    if (e.target instanceof HTMLElement && e.target.closest("[role='menu'], [role='dialog'], .popover, .modal")) return;
    const rows = visibleRows(container);
    const cur = current(rows);

    if (CURSOR_KEYS.has(e.key)) {
      e.preventDefault();
      const ids = rows.map((_, i) => String(i));
      const next = stepCursor(ids, cur ? String(rows.indexOf(cur)) : null, e.key as CursorKey);
      mark(next === null ? null : rows[Number(next)]);
      container.focus();
      return;
    }
    if (e.key === "Escape") {
      if (onEscape) { e.preventDefault(); onEscape(); }
      return;
    }
    if (isTypingKey(e)) {
      onType?.()?.focus();
      return;
    }
    if (!cur) return;
    // Ce qui suit agit sur la ligne sous le curseur — mais Entrée et Espace
    // sur un bouton focalisé à la souris restent à ce bouton.
    const onSelf = e.target === container;
    if (e.key === "Enter" && onSelf) {
      e.preventDefault();
      // Une ligne qui est elle-même un bouton (la bande de la barre
      // latérale) est sa propre action principale.
      const primary = cur.matches("button, [data-nav-primary]")
        ? cur
        : cur.querySelector<HTMLElement>("[data-nav-primary]") ?? cur.querySelector<HTMLElement>("button");
      primary?.click();
      return;
    }
    if (e.key === "ArrowRight") {
      e.preventDefault();
      cur.querySelector<HTMLElement>("[data-nav-toggle='collapsed']")?.click();
      return;
    }
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      const expanded = cur.querySelector<HTMLElement>("[data-nav-toggle='expanded']");
      if (expanded) { expanded.click(); return; }
      const parent = parentRow(rows.map((r, i) => ({ id: String(i), depth: Number(r.dataset.navDepth ?? 0) })), String(rows.indexOf(cur)));
      if (parent !== null) mark(rows[Number(parent)]);
      return;
    }
    if (e.key === " " && onSelf) {
      e.preventDefault();
      (cur.querySelector<HTMLElement>("[data-nav-check]") ?? cur.querySelector<HTMLElement>("input[type=checkbox]"))?.click();
      return;
    }
    if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
      e.preventDefault();
      const menu = cur.querySelector<HTMLElement>("[data-nav-menu]");
      if (menu) { menu.click(); return; }
      cur.querySelector<HTMLElement>("[data-nav-actions] button")?.focus();
    }
  };

  /** Un clic pose le curseur sur la ligne cliquée, pour que les flèches
   * repartent de là. */
  const onMouseDownCapture = (e: MouseEvent<HTMLElement>) => {
    const row = (e.target as HTMLElement | null)?.closest?.<HTMLElement>("[data-nav-row]");
    if (row && ref.current?.contains(row)) mark(row, false);
  };

  /** À l'arrivée du focus sur le conteneur (F6, raccourci de panneau) : le
   * curseur se pose sur la première ligne s'il n'est nulle part, pour que
   * ↓ ne soit pas la première touche obligatoire. */
  const onFocus = (e: { target: EventTarget | null; currentTarget: EventTarget | null }) => {
    const container = ref.current;
    if (!container || e.target !== e.currentTarget) return;
    const rows = visibleRows(container);
    if (!current(rows) && rows.length > 0) mark(rows[0]);
  };

  return { onKeyDown, onMouseDownCapture, onFocus };
}
