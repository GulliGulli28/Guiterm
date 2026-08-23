import { describe, expect, it } from "vitest";
import { DIFFERENCE_LABEL, movesInDirection } from "./paneSync";
import type { SyncDifferenceKind } from "./types";

const ALL: SyncDifferenceKind[] = ["onlyLeft", "onlyRight", "newerLeft", "newerRight", "sizeDiffers"];

describe("movesInDirection", () => {
  it("ne propose vers la droite que ce qui existe ou est plus récent à gauche", () => {
    expect(ALL.filter((k) => movesInDirection(k, "right"))).toEqual(["onlyLeft", "newerLeft", "sizeDiffers"]);
  });

  it("et symétriquement vers la gauche", () => {
    expect(ALL.filter((k) => movesInDirection(k, "left"))).toEqual(["onlyRight", "newerRight", "sizeDiffers"]);
  });

  it("laisse « taille différente » rattrapable des deux côtés", () => {
    // Même date, tailles différentes : rien ne dit lequel est le bon, c'est
    // l'utilisateur qui tranche — donc jamais grisé.
    expect(movesInDirection("sizeDiffers", "left")).toBe(true);
    expect(movesInDirection("sizeDiffers", "right")).toBe(true);
  });

  it("ne propose jamais une copie qui ne changerait rien", () => {
    // La propriété qui compte : ce qui n'existe que d'un côté ne peut pas
    // être « copié » depuis le côté où il n'est pas.
    expect(movesInDirection("onlyRight", "right")).toBe(false);
    expect(movesInDirection("onlyLeft", "left")).toBe(false);
    expect(movesInDirection("newerRight", "right")).toBe(false);
    expect(movesInDirection("newerLeft", "left")).toBe(false);
  });

  it("nomme chaque différence en français", () => {
    for (const kind of ALL) expect(DIFFERENCE_LABEL[kind]).toMatch(/[a-zà-ÿ]/);
  });
});
