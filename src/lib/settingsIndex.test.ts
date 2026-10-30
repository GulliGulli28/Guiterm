import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SETTINGS_INDEX, searchSettings, type SettingsCategory } from "./settingsIndex";

const LABELS: Record<SettingsCategory, string> = {
  apparence: "Apparence", terminal: "Terminal", sftp: "SFTP", securite: "Sécurité",
  agent: "Agent SSH", raccourcis: "Raccourcis", notifications: "Notifications", general: "Général",
};

const source = (file: string) => readFileSync(fileURLToPath(new URL(`../components/${file}`, import.meta.url)), "utf8");

describe("index des réglages", () => {
  const sources = ["SettingsPanel.tsx", "VaultSettings.tsx", "SshAgentSettings.tsx"].map(source).join("\n");

  it("ne désigne que des libellés qui existent à l'écran", () => {
    // Un libellé renommé dans la page sans venir ici donnerait un résultat
    // de recherche qui ne mène à rien.
    const missing = SETTINGS_INDEX.filter((e) => !sources.includes(e.label)).map((e) => e.label);
    expect(missing).toEqual([]);
  });

  it("trouve sans tenir compte des accents ni de la casse", () => {
    expect(searchSettings("theme", LABELS).map((e) => e.label)).toContain("Mode d'affichage");
    expect(searchSettings("GPU", LABELS).map((e) => e.label)).toEqual(["Accélération GPU du terminal"]);
  });

  it("demande que chaque mot se retrouve", () => {
    expect(searchSettings("tmux souris", LABELS).map((e) => e.label)).toEqual(["Molette et souris dans les sessions tmux"]);
    expect(searchSettings("", LABELS)).toEqual([]);
  });
});
