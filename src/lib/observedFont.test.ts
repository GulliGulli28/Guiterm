import { describe, expect, it } from "vitest";
import { MIN_OBSERVED_FONT_SIZE, observedFontSize, type ObservedFontInput } from "./observedFont";

function input(extra: Partial<ObservedFontInput> = {}): ObservedFontInput {
  return {
    baseFontSize: 14,
    currentFontSize: 14,
    proposedCols: 100,
    proposedRows: 30,
    targetCols: 100,
    targetRows: 30,
    ...extra,
  };
}

describe("observedFontSize", () => {
  it("ne touche à rien quand la grille tient déjà", () => {
    expect(observedFontSize(input())).toBeNull();
  });

  // Le cas qui justifie tout ce fichier : une session deux fois plus large que
  // la fenêtre. Sans réduction, on ne voit que la moitié gauche de l'écran de
  // quelqu'un d'autre.
  it("réduit la police pour faire tenir une session trop large", () => {
    expect(observedFontSize(input({ targetCols: 200 }))).toBe(7);
  });

  it("prend l'axe le plus contraignant", () => {
    // Un peu trop large (100/110 → 12), nettement trop haute (30/45 → 9) :
    // c'est la hauteur qui décide, sinon la grille déborderait en bas.
    expect(observedFontSize(input({ targetCols: 110, targetRows: 45 }))).toBe(9);
  });

  // Le sens du facteur est ce qu'on inverse sans s'en apercevoir : à l'envers,
  // la police grandit et le rognage empire.
  it("ne dépasse jamais la police voulue par l'utilisateur", () => {
    // La fenêtre est bien plus grande que la session : rien à gagner à grossir.
    const grown = observedFontSize(input({ proposedCols: 400, proposedRows: 120, currentFontSize: 7 }));
    expect(grown).toBe(14);
    expect(observedFontSize(input({ proposedCols: 400, proposedRows: 120 }))).toBeNull();
  });

  it("ne descend pas sous le seuil de lisibilité", () => {
    const tiny = observedFontSize(input({ targetCols: 5000 }));
    expect(tiny).toBe(MIN_OBSERVED_FONT_SIZE);
  });

  it("ne calcule rien sur des dimensions absurdes", () => {
    expect(observedFontSize(input({ proposedCols: 0 }))).toBeNull();
    expect(observedFontSize(input({ targetRows: 0 }))).toBeNull();
    expect(observedFontSize(input({ currentFontSize: 0 }))).toBeNull();
  });
});
