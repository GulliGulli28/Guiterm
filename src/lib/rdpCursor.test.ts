import { describe, expect, it } from "vitest";
import { MAX_CURSOR_SIZE, decodePointerPixels, pointerCss, type RdpPointerBitmap } from "./rdpCursor";

const bitmap = (over: Partial<RdpPointerBitmap> = {}): RdpPointerBitmap => ({
  width: 32,
  height: 32,
  hotspotX: 5,
  hotspotY: 11,
  pixelsBase64: "",
  ...over,
});

const fakeUrl = () => "data:image/png;base64,AAAA";

describe("pointerCss", () => {
  it("masque le curseur quand le serveur le cache", () => {
    expect(pointerCss({ bitmap: null, hidden: true }, fakeUrl)).toBe("none");
    // `hidden` l'emporte : le serveur peut cacher le curseur sans annuler la
    // forme qu'il avait envoyée avant.
    expect(pointerCss({ bitmap: bitmap(), hidden: true }, fakeUrl)).toBe("none");
  });

  it("revient au curseur système quand le serveur redemande le défaut", () => {
    expect(pointerCss({ bitmap: null, hidden: false }, fakeUrl)).toBe("default");
  });

  it("place le hotspot après l'URL, dans l'ordre attendu par CSS", () => {
    expect(pointerCss({ bitmap: bitmap(), hidden: false }, fakeUrl))
      .toBe('url("data:image/png;base64,AAAA") 5 11, default');
  });

  // Chacun des cas ci-dessous produirait, sans garde, une déclaration `cursor`
  // que le navigateur jette en silence — c'est-à-dire **aucun curseur du
  // tout**, strictement pire que le curseur système qu'on remplaçait.
  it("retombe sur le défaut plutôt que de laisser l'utilisateur sans curseur", () => {
    const cases: [string, ReturnType<typeof bitmap>][] = [
      ["largeur nulle", bitmap({ width: 0 })],
      ["hauteur nulle", bitmap({ height: 0 })],
      ["plus large que la limite navigateur", bitmap({ width: MAX_CURSOR_SIZE + 1 })],
      ["plus haut que la limite navigateur", bitmap({ height: MAX_CURSOR_SIZE + 1 })],
    ];
    for (const [label, bmp] of cases) {
      expect(pointerCss({ bitmap: bmp, hidden: false }, fakeUrl), label).toBe("default");
    }
    expect(pointerCss({ bitmap: bitmap(), hidden: false }, () => null), "encodage impossible").toBe("default");
  });

  it("serre un hotspot que le serveur place hors de l'image", () => {
    // Hors de l'image, CSS invalide la déclaration entière — hotspot compris,
    // donc l'image aussi. Serrer garde un curseur, au prix de quelques pixels
    // de visée.
    expect(pointerCss({ bitmap: bitmap({ hotspotX: 99, hotspotY: 99 }), hidden: false }, fakeUrl))
      .toBe('url("data:image/png;base64,AAAA") 31 31, default');
    expect(pointerCss({ bitmap: bitmap({ hotspotX: -4, hotspotY: -1 }), hidden: false }, fakeUrl))
      .toBe('url("data:image/png;base64,AAAA") 0 0, default');
  });

  it("accepte exactement la taille limite", () => {
    // Le test ci-dessus prouve qu'on rejette au-delà ; celui-ci qu'on ne
    // rejette pas la limite elle-même — sans quoi la borne pourrait être
    // décalée d'un pixel sans que rien ne le dise.
    const bmp = bitmap({ width: MAX_CURSOR_SIZE, height: MAX_CURSOR_SIZE });
    expect(pointerCss({ bitmap: bmp, hidden: false }, fakeUrl)).toContain("data:image/png");
  });
});

describe("decodePointerPixels", () => {
  it("rend les octets RGBA tels quels", () => {
    // Un pixel rouge à moitié transparent, alpha non prémultiplié : c'est ce
    // que produit `PointerBitmapTarget::Accelerated` et ce que `putImageData`
    // attend, donc la valeur doit traverser sans être touchée.
    const base64 = btoa(String.fromCharCode(255, 0, 0, 128));
    expect(Array.from(decodePointerPixels(base64))).toEqual([255, 0, 0, 128]);
  });

  it("rend un tableau de la bonne longueur pour un curseur 32×32", () => {
    const bytes = new Uint8Array(32 * 32 * 4).fill(7);
    const base64 = btoa(String.fromCharCode(...bytes));
    expect(decodePointerPixels(base64).length).toBe(32 * 32 * 4);
  });
});
