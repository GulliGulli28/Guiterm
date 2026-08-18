import { describe, expect, it } from "vitest";
import { FOCUSABLE_SELECTOR, nextTrappedIndex } from "./focusTrap";

describe("nextTrappedIndex", () => {
  it("avance et recule d'un cran", () => {
    expect(nextTrappedIndex(5, 1, false)).toBe(2);
    expect(nextTrappedIndex(5, 1, true)).toBe(0);
  });

  it("boucle aux deux bouts — c'est tout l'intérêt du piège", () => {
    expect(nextTrappedIndex(5, 4, false)).toBe(0);
    expect(nextTrappedIndex(5, 0, true)).toBe(4);
  });

  it("entre par le bon bout quand le focus vient de l'extérieur", () => {
    // -1 = focus hors de la modale, cas du tout premier Tab après ouverture.
    // Shift+Tab doit entrer par la fin, sans quoi remonter depuis le haut de la
    // boîte renverrait dans la page derrière.
    expect(nextTrappedIndex(5, -1, false)).toBe(0);
    expect(nextTrappedIndex(5, -1, true)).toBe(4);
  });

  it("ne rend jamais d'index négatif — un modulo naïf le ferait", () => {
    // `(0 - 1) % 5` vaut -1 en JavaScript, pas 4 : `items[-1]` serait
    // `undefined` et le focus partirait dans le vide.
    for (let count = 1; count <= 6; count++) {
      for (let current = -1; current < count; current++) {
        for (const shift of [false, true]) {
          const next = nextTrappedIndex(count, current, shift);
          expect(next, `count=${count} current=${current} shift=${shift}`).toBeGreaterThanOrEqual(0);
          expect(next).toBeLessThan(count);
        }
      }
    }
  });

  it("répond -1 sur une modale sans rien de focalisable", () => {
    expect(nextTrappedIndex(0, -1, false)).toBe(-1);
  });

  it("tourne en rond sans jamais sortir, sur un tour complet", () => {
    // La propriété qui compte vraiment : partir de n'importe où et tabuler
    // `count` fois doit ramener au point de départ, en passant par tout le
    // monde une seule fois.
    const count = 4;
    const visited = new Set<number>();
    let index = 0;
    for (let i = 0; i < count; i++) {
      visited.add(index);
      index = nextTrappedIndex(count, index, false);
    }
    expect(visited.size).toBe(count);
    expect(index).toBe(0);
  });
});

describe("FOCUSABLE_SELECTOR", () => {
  it("exclut tabindex=-1, qui désigne justement ce que Tab doit ignorer", () => {
    expect(FOCUSABLE_SELECTOR).toContain('[tabindex]:not([tabindex="-1"])');
  });

  it("ignore les contrôles désactivés", () => {
    // Un bouton grisé dans le piège ferait un arrêt mort dans la boucle Tab.
    for (const tag of ["button", "input", "select", "textarea"]) {
      expect(FOCUSABLE_SELECTOR).toContain(`${tag}:not([disabled])`);
    }
  });
});
