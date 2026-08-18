/** Garder le focus clavier à l'intérieur d'une fenêtre modale.
 *
 * Sans ça, tabuler depuis une modale sort dessus — on se retrouve à parcourir
 * la liste d'hôtes ou la barre d'onglets pendant qu'une boîte de dialogue
 * couvre l'écran, sans voir où on est. Ce n'est pas une finesse d'accessibilité
 * mais un bug de navigation : les contrôles atteints sont derrière un voile
 * semi-opaque, et les activer agit sur une interface qu'on ne regarde pas.
 */

/** Ce qu'un utilisateur peut atteindre au clavier. `tabindex="-1"` est exclu :
 * il désigne précisément un élément focalisable par script mais pas par Tab. */
export const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

/** L'index à focaliser au prochain Tab, en bouclant.
 *
 * `currentIndex` vaut -1 quand le focus est hors de la modale (au premier Tab
 * après ouverture, par exemple) : on entre alors par le premier élément, ou par
 * le dernier si l'utilisateur remonte.
 */
export function nextTrappedIndex(count: number, currentIndex: number, shift: boolean): number {
  if (count <= 0) return -1;
  if (currentIndex < 0) return shift ? count - 1 : 0;
  // Le modulo suffirait vers l'avant ; écrit en deux branches parce que le
  // modulo d'un nombre négatif en JavaScript est négatif, et que `-1 % 5`
  // vaudrait -1 au lieu de 4.
  if (shift) return currentIndex === 0 ? count - 1 : currentIndex - 1;
  return currentIndex === count - 1 ? 0 : currentIndex + 1;
}
