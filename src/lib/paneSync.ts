/** Ce que la comparaison de deux panneaux de transfert veut dire, côté
 * interface.
 *
 * Séparé du composant parce que c'est de la logique et non du rendu : le sens
 * dans lequel une différence peut être rattrapée est exactement le genre de
 * règle qu'on écrit à l'envers sans que rien ne le signale — un fichier
 * présent seulement à droite, « copié vers la droite », ne partirait nulle
 * part et la ligne resterait cochée sans effet. */
import type { SyncDifferenceKind } from "./types";

/** Une différence peut-elle être rattrapée en copiant vers `direction` ?
 *
 * `sizeDiffers` (même date, tailles différentes) est rattrapable dans les
 * deux sens : rien ne dit lequel des deux fichiers est le bon, c'est
 * l'utilisateur qui tranche. */
export function movesInDirection(kind: SyncDifferenceKind, direction: "left" | "right"): boolean {
  return direction === "right"
    ? kind === "onlyLeft" || kind === "newerLeft" || kind === "sizeDiffers"
    : kind === "onlyRight" || kind === "newerRight" || kind === "sizeDiffers";
}

export const DIFFERENCE_LABEL: Record<SyncDifferenceKind, string> = {
  onlyLeft: "seulement à gauche",
  onlyRight: "seulement à droite",
  newerLeft: "plus récent à gauche",
  newerRight: "plus récent à droite",
  sizeDiffers: "taille différente",
};
