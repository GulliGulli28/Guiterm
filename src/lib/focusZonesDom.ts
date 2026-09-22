import { ZONE_ORDER, nextZone, type FocusZone } from "./keyboardNav";

/**
 * Les zones de focus telles qu'elles sont à l'écran — la partie DOM de
 * `keyboardNav.ts` (qui, elle, est testée sans navigateur).
 */

function zoneElement(zone: FocusZone): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-focus-zone="${zone}"]`);
}

/** Les zones présentes et visibles (une colonne fermée a une largeur nulle). */
export function presentZones(): FocusZone[] {
  return ZONE_ORDER.filter((z) => {
    const el = zoneElement(z);
    return !!el && el.offsetParent !== null && el.offsetWidth > 0;
  });
}

/** La zone qui contient le focus, ou `null`. */
export function currentZone(): FocusZone | null {
  const el = document.activeElement?.closest<HTMLElement>("[data-focus-zone]");
  return (el?.dataset.focusZone as FocusZone | undefined) ?? null;
}

/** Donne le focus à une zone : le terminal pour le contenu (`focusMain`
 * sait lequel), le conteneur navigable pour les listes, le premier champ
 * pour un formulaire. */
export function focusZone(zone: FocusZone, focusMain: () => void) {
  if (zone === "main") { focusMain(); return; }
  const el = zoneElement(zone);
  if (!el) return;
  if (zone === "right") {
    (el.querySelector<HTMLElement>("input:not([type=checkbox]), textarea, select, [tabindex='0']") ?? el).focus();
    return;
  }
  el.focus();
}

/** F6 / Maj+F6. */
export function cycleZone(dir: 1 | -1, focusMain: () => void) {
  const next = nextZone(presentZones(), currentZone(), dir);
  if (next) focusZone(next, focusMain);
}
