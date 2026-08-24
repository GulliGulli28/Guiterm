/**
 * Quelle taille de police pour afficher une session qu'on observe.
 *
 * **Le problème.** Un onglet en observation n'a pas le droit de redimensionner
 * la session : sa grille est celle de la session, pas celle de la fenêtre (voir
 * `persistent_shell`). Une session plus large que la fenêtre est donc rognée —
 * on ne voit qu'une partie de l'écran de quelqu'un d'autre, sans rien pour le
 * signaler.
 *
 * **La réponse.** Réduire la police jusqu'à ce que la grille tienne. C'est la
 * seule variable dont on dispose : la grille est fixée, la fenêtre aussi.
 *
 * Le calcul est ici, pur, parce qu'il est facile de s'y tromper en silence —
 * un facteur pris à l'envers donne une police qui grandit au lieu de rétrécir,
 * et le rognage empire au lieu de disparaître.
 */

/** Plancher : en dessous, le texte n'est plus lisible et mieux vaut rogner. */
export const MIN_OBSERVED_FONT_SIZE = 6;

export interface ObservedFontInput {
  /** La police voulue par l'utilisateur. On n'ira jamais au-dessus. */
  baseFontSize: number;
  /** Ce qui tient dans le conteneur **à la police actuelle**, tel que le
   * calcule `FitAddon.proposeDimensions()`. */
  proposedCols: number;
  proposedRows: number;
  /** La police à laquelle `proposed*` a été mesuré. */
  currentFontSize: number;
  /** La grille imposée par la session observée. */
  targetCols: number;
  targetRows: number;
}

/**
 * La police à appliquer, ou `null` s'il n'y a rien à changer.
 *
 * La largeur d'une cellule est proportionnelle à la taille de police : si
 * `proposedCols` colonnes tiennent à `currentFontSize`, alors `targetCols`
 * tiennent à `currentFontSize × proposedCols / targetCols`. On prend le plus
 * contraignant des deux axes, on plafonne à la police voulue — jamais plus
 * grand que ce que l'utilisateur a choisi — et on plancherise pour rester
 * lisible.
 */
export function observedFontSize(input: ObservedFontInput): number | null {
  const { baseFontSize, proposedCols, proposedRows, currentFontSize, targetCols, targetRows } = input;
  if (proposedCols <= 0 || proposedRows <= 0 || targetCols <= 0 || targetRows <= 0) return null;
  if (currentFontSize <= 0) return null;

  const scale = Math.min(proposedCols / targetCols, proposedRows / targetRows);
  const wanted = Math.max(
    MIN_OBSERVED_FONT_SIZE,
    Math.min(baseFontSize, Math.floor(currentFontSize * scale)),
  );
  return wanted === currentFontSize ? null : wanted;
}
