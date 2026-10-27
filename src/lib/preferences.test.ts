import { describe, expect, it } from "vitest";
import { ACCENT_COLORS, DEFAULT_PREFERENCES, accentShade, migratePreferences } from "./preferences";

describe("migratePreferences — révision 2 du langage visuel", () => {
  it("remplace les anciens défauts, jamais choisis, par les nouveaux", () => {
    const migrated = migratePreferences({
      uiAccent: "blue",
      uiBg: "zinc",
      uiFontFamily: "system",
      terminalFontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    });
    expect(migrated.uiAccent).toBe(DEFAULT_PREFERENCES.uiAccent);
    expect(migrated.uiBg).toBe(DEFAULT_PREFERENCES.uiBg);
    expect(migrated.uiFontFamily).toBe(DEFAULT_PREFERENCES.uiFontFamily);
    expect(migrated.terminalFontFamily).toBe(DEFAULT_PREFERENCES.terminalFontFamily);
    expect(migrated.designRevision).toBe(2);
  });

  it("garde ce que l'utilisateur avait choisi", () => {
    const migrated = migratePreferences({ uiAccent: "rose", uiBg: "navy", uiFontFamily: "Verdana, Geneva, sans-serif", colorMode: "light" });
    expect(migrated.uiAccent).toBe("rose");
    expect(migrated.uiBg).toBe("navy");
    expect(migrated.uiFontFamily).toBe("Verdana, Geneva, sans-serif");
    expect(migrated.colorMode).toBe("light");
  });

  // Le cas qui justifie `designRevision` : sans lui, un bleu choisi après la
  // migration serait repris pour un ancien défaut au lancement suivant.
  it("ne repasse pas sur des préférences déjà migrées", () => {
    const chosenAfter = { designRevision: 2, uiAccent: "blue", uiBg: "zinc" };
    expect(migratePreferences(chosenAfter)).toEqual(chosenAfter);
  });

  it("donne la révision courante aux préférences neuves", () => {
    expect(DEFAULT_PREFERENCES.designRevision).toBe(2);
  });
});

describe("accentShade", () => {
  it("remplit l'indigo sombre d'un indigo clair, sous un texte sombre", () => {
    const shade = accentShade(ACCENT_COLORS.indigo, "dark");
    expect(shade.fill).toBe("#8b8cff");
    expect(shade.on).toBe("#0b0c0e");
  });

  it("garde un texte blanc sur les accents sans teinte propre", () => {
    const shade = accentShade(ACCENT_COLORS.blue, "dark");
    expect(shade.fill).toBe(ACCENT_COLORS.blue.c600);
    expect(shade.on).toBe("#ffffff");
    expect(shade.text).toBe(ACCENT_COLORS.blue.c300);
    expect(accentShade(ACCENT_COLORS.blue, "light").text).toBe(ACCENT_COLORS.blue.c600);
  });
});
