import { describe, expect, it } from "vitest";
import { isTypingKey, neighbourPanel, nextZone, parentRow, sidebarButtonAt, stepCursor } from "./keyboardNav";

describe("nextZone", () => {
  it("tourne dans l'ordre de l'écran, en sautant les zones absentes", () => {
    expect(nextZone(["sidebar-nav", "sidebar-panel", "main"], "main", 1)).toBe("sidebar-nav");
    expect(nextZone(["sidebar-nav", "sidebar-panel", "main"], "sidebar-panel", 1)).toBe("main");
    expect(nextZone(["sidebar-nav", "main", "right"], "sidebar-nav", 1)).toBe("main");
    expect(nextZone(["sidebar-nav", "main", "right"], "main", -1)).toBe("sidebar-nav");
    expect(nextZone(["sidebar-nav", "main", "right"], "sidebar-nav", -1)).toBe("right");
  });
  it("sans zone courante, part du bord", () => {
    expect(nextZone(["main", "right"], null, 1)).toBe("main");
    expect(nextZone(["main", "right"], null, -1)).toBe("right");
    expect(nextZone([], "main", 1)).toBeNull();
  });
  it("une zone courante disparue de l'écran repart du bord", () => {
    expect(nextZone(["main"], "right", 1)).toBe("main");
  });
});

describe("stepCursor", () => {
  const ids = ["a", "b", "c"];
  it("descend, monte, et s'arrête aux bouts", () => {
    expect(stepCursor(ids, "a", "ArrowDown")).toBe("b");
    expect(stepCursor(ids, "c", "ArrowDown")).toBe("c");
    expect(stepCursor(ids, "b", "ArrowUp")).toBe("a");
    expect(stepCursor(ids, "a", "ArrowUp")).toBe("a");
    expect(stepCursor(ids, "b", "Home")).toBe("a");
    expect(stepCursor(ids, "b", "End")).toBe("c");
  });
  it("sans curseur, ou avec un curseur disparu, entre par le bon bout", () => {
    expect(stepCursor(ids, null, "ArrowDown")).toBe("a");
    expect(stepCursor(ids, null, "ArrowUp")).toBe("c");
    expect(stepCursor(ids, "zzz", "ArrowDown")).toBe("a");
    expect(stepCursor([], "a", "ArrowDown")).toBeNull();
  });
});

describe("parentRow", () => {
  const rows = [
    { id: "prod", depth: 0 },
    { id: "web", depth: 1 },
    { id: "bases", depth: 1 },
    { id: "pg", depth: 2 },
    { id: "nas", depth: 0 },
  ];
  it("remonte au dossier qui contient la ligne", () => {
    expect(parentRow(rows, "pg")).toBe("bases");
    expect(parentRow(rows, "web")).toBe("prod");
    expect(parentRow(rows, "nas")).toBeNull();
    expect(parentRow(rows, "prod")).toBeNull();
    expect(parentRow(rows, "absent")).toBeNull();
  });
});

describe("isTypingKey", () => {
  const k = (key: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean }> = {}) =>
    ({ key, ctrlKey: false, metaKey: false, altKey: false, ...mods });
  it("une lettre nue oui ; l'espace, une touche spéciale ou un raccourci non", () => {
    expect(isTypingKey(k("r"))).toBe(true);
    expect(isTypingKey(k("É"))).toBe(true);
    expect(isTypingKey(k(" "))).toBe(false);
    expect(isTypingKey(k("ArrowDown"))).toBe(false);
    expect(isTypingKey(k("c", { ctrlKey: true }))).toBe(false);
    expect(isTypingKey(k("1", { altKey: true }))).toBe(false);
  });
});

describe("sidebarButtonAt", () => {
  it("le n-ième bouton visible, ou rien au-delà", () => {
    expect(sidebarButtonAt(["hosts", "sftp"], 1)).toBe("hosts");
    expect(sidebarButtonAt(["hosts", "sftp"], 2)).toBe("sftp");
    expect(sidebarButtonAt(["hosts", "sftp"], 3)).toBeNull();
    expect(sidebarButtonAt(["hosts", "sftp"], 0)).toBeNull();
  });
});

describe("neighbourPanel", () => {
  const visible = ["hosts", "sftp", "guivault"];
  it("tourne en boucle dans les deux sens", () => {
    expect(neighbourPanel(visible, "hosts", 1)).toBe("sftp");
    expect(neighbourPanel(visible, "guivault", 1)).toBe("hosts");
    expect(neighbourPanel(visible, "hosts", -1)).toBe("guivault");
  });
  it("un panneau sans bouton (les Paramètres) entre par le bord", () => {
    expect(neighbourPanel(visible, null, 1)).toBe("hosts");
    expect(neighbourPanel(visible, null, -1)).toBe("guivault");
    expect(neighbourPanel([], "hosts", 1)).toBeNull();
  });
});
