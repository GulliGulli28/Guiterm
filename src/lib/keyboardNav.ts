/**
 * La navigation au clavier de l'app, côté logique pure — ce que
 * `hooks/useRowNavigation.ts` et `App.tsx` appliquent au DOM.
 *
 * Deux idées :
 *
 * - **Quatre zones**, dans l'ordre de l'écran : la bande de boutons de la
 *   barre latérale, le panneau ouvert, le contenu (terminal ou onglet), la
 *   colonne de droite (formulaire, « Coller depuis GuiVault »). F6 / Maj+F6
 *   passent de l'une à l'autre, Ctrl+Maj+Espace va droit au contenu, et
 *   Échap dans une liste y ramène aussi quand il n'y a rien d'autre à fermer.
 *   Chaque zone est un élément `[data-focus-zone="…"]` ; une zone absente
 *   de l'écran (colonne droite fermée, barre repliée) est sautée.
 *
 * - **Un curseur par liste.** Toute liste de la barre latérale est faite des
 *   mêmes lignes (`EntityRow`, `GroupRow`, `TargetTreeList`), qui portent
 *   `data-nav-row` : le curseur les parcourt dans l'ordre du DOM, Entrée
 *   déclenche l'action principale de la ligne, →/← déplie ou replie, Espace
 *   coche. Douze panneaux couverts par un seul hook, sans qu'aucun n'ait à
 *   savoir qu'il est navigable.
 */

export type FocusZone = "sidebar-nav" | "sidebar-panel" | "main" | "right";

/** L'ordre de F6 — celui de l'écran, de gauche à droite. */
export const ZONE_ORDER: readonly FocusZone[] = ["sidebar-nav", "sidebar-panel", "main", "right"];

/** La zone suivante (`1`) ou précédente (`-1`) parmi celles présentes, en
 * boucle. Sans zone courante, la première (ou la dernière) présente. */
export function nextZone(present: readonly FocusZone[], current: FocusZone | null, dir: 1 | -1): FocusZone | null {
  const ordered = ZONE_ORDER.filter((z) => present.includes(z));
  if (ordered.length === 0) return null;
  const idx = current ? ordered.indexOf(current) : -1;
  if (idx === -1) return dir === 1 ? ordered[0] : ordered[ordered.length - 1];
  return ordered[(idx + dir + ordered.length) % ordered.length];
}

export type CursorKey = "ArrowDown" | "ArrowUp" | "Home" | "End";

/** Un pas de curseur dans une liste d'ids ordonnés. Sans curseur (ou un
 * curseur qui n'est plus dans la liste), ↓ et Début vont au premier, ↑ et
 * Fin au dernier. Aux extrémités, on reste. */
export function stepCursor(ids: readonly string[], current: string | null, key: CursorKey): string | null {
  if (ids.length === 0) return null;
  const idx = current ? ids.indexOf(current) : -1;
  switch (key) {
    case "Home": return ids[0];
    case "End": return ids[ids.length - 1];
    case "ArrowDown": return idx === -1 ? ids[0] : ids[Math.min(ids.length - 1, idx + 1)];
    case "ArrowUp": return idx === -1 ? ids[ids.length - 1] : ids[Math.max(0, idx - 1)];
  }
}

/** Le dossier qui contient la ligne : la précédente de profondeur moindre.
 * `null` à la racine (ou sans profondeur connue). */
export function parentRow(rows: readonly { id: string; depth: number }[], current: string): string | null {
  const idx = rows.findIndex((r) => r.id === current);
  if (idx === -1) return null;
  const depth = rows[idx].depth;
  for (let i = idx - 1; i >= 0; i--) {
    if (rows[i].depth < depth) return rows[i].id;
  }
  return null;
}

/** Une touche qui, dans une liste, veut dire « je tape dans la recherche » :
 * un caractère seul, sans Ctrl/Alt/Meta. L'espace n'en est pas (il coche). */
export function isTypingKey(e: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean }): boolean {
  return e.key.length === 1 && e.key !== " " && !e.ctrlKey && !e.metaKey && !e.altKey;
}

/** Les raccourcis positionnels de la barre latérale : le n-ième bouton
 * visible. Rend l'id du bouton, ou `null` au-delà de la barre. */
export function sidebarButtonAt<T>(visible: readonly T[], position: number): T | null {
  return position >= 1 && position <= visible.length ? visible[position - 1] : null;
}

/** Le panneau voisin, en boucle — ce qu'Alt+Page suiv./préc. ouvre. Un
 * panneau courant hors de la liste (les Paramètres, qui n'ont pas de bouton
 * masquable) entre par le premier ou par le dernier. */
export function neighbourPanel<T>(visible: readonly T[], current: T | null, dir: 1 | -1): T | null {
  if (visible.length === 0) return null;
  const idx = current === null ? -1 : visible.indexOf(current);
  if (idx === -1) return dir === 1 ? visible[0] : visible[visible.length - 1];
  return visible[(idx + dir + visible.length) % visible.length];
}
