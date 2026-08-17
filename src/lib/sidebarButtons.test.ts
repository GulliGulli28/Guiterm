import { describe, expect, it } from "vitest";
import type { SidebarPanelKind } from "../components/Sidebar";
import {
  ALWAYS_VISIBLE_SIDEBAR_BUTTONS,
  SIDEBAR_BUTTONS,
  isSidebarButtonVisible,
  resolveVisiblePanel,
  type SidebarButtonId,
} from "./sidebarButtons";

// Le `Record` est ce qui fait travailler `tsc` : ajouter un `SidebarButtonId`
// sans l'ajouter ici est une erreur de compilation, et le test ci-dessous
// attrape alors l'oubli symétrique dans `SIDEBAR_BUTTONS`. C'est le seul
// moyen d'énumérer une union de littéraux à l'exécution.
const EVERY_BUTTON: Record<SidebarButtonId, true> = {
  knownHosts: true,
  hosts: true,
  sftp: true,
  snippets: true,
  tunnels: true,
  database: true,
  keychain: true,
  aws: true,
  fleet: true,
  netdiag: true,
};

// Même chose côté panneaux : un `SidebarPanelKind` sans bouton serait un
// panneau qu'aucun clic n'atteint — la façon exacte dont MongoDB était devenu
// inatteignable.
const EVERY_PANEL: Record<Exclude<SidebarPanelKind, "settings">, true> = {
  knownHosts: true,
  hosts: true,
  sftp: true,
  snippets: true,
  tunnels: true,
  database: true,
  keychain: true,
  aws: true,
};

describe("catalogue des boutons de barre latérale", () => {
  const ids = SIDEBAR_BUTTONS.map((b) => b.id);

  it("couvre chaque bouton connu, exactement une fois", () => {
    expect([...ids].sort()).toEqual(Object.keys(EVERY_BUTTON).sort());
  });

  it("donne un bouton à chaque panneau — aucun panneau inatteignable", () => {
    for (const panel of Object.keys(EVERY_PANEL)) {
      expect(ids).toContain(panel);
    }
  });

  it("n'est pas vide — sinon les deux contrôles ci-dessus passent à vide", () => {
    expect(SIDEBAR_BUTTONS.length).toBeGreaterThanOrEqual(10);
    expect(Object.keys(EVERY_PANEL).length).toBeGreaterThanOrEqual(8);
  });

  it("donne un libellé non vide à chaque bouton", () => {
    for (const b of SIDEBAR_BUTTONS) expect(b.label.trim()).not.toBe("");
  });
});

describe("visibilité", () => {
  it("masque ce que l'utilisateur a décoché", () => {
    expect(isSidebarButtonVisible("aws", ["aws", "netdiag"])).toBe(false);
    expect(isSidebarButtonVisible("sftp", ["aws", "netdiag"])).toBe(true);
  });

  it("affiche tout quand rien n'est masqué — le défaut d'une installation existante", () => {
    for (const b of SIDEBAR_BUTTONS) expect(isSidebarButtonVisible(b.id, [])).toBe(true);
  });

  it("garde les boutons du noyau visibles même listés comme masqués", () => {
    // Un `localStorage` recopié d'une version future, ou édité à la main, ne
    // doit pas pouvoir enfermer l'utilisateur dans une app sans point d'entrée.
    for (const id of ALWAYS_VISIBLE_SIDEBAR_BUTTONS) {
      expect(isSidebarButtonVisible(id, [id])).toBe(true);
    }
    expect(ALWAYS_VISIBLE_SIDEBAR_BUTTONS).toContain("hosts");
  });
});

describe("resolveVisiblePanel", () => {
  it("laisse le panneau ouvert tel quel quand il est visible", () => {
    expect(resolveVisiblePanel("tunnels", ["aws"])).toBe("tunnels");
  });

  it("retombe sur les hôtes quand le panneau ouvert vient d'être masqué", () => {
    expect(resolveVisiblePanel("tunnels", ["tunnels"])).toBe("hosts");
  });

  it("garde les paramètres accessibles — c'est d'où on décoche", () => {
    // `settings` n'est pas masquable, mais il traverse la même fonction : s'il
    // retombait sur « Hôtes », le réglage se refermerait au premier clic.
    expect(resolveVisiblePanel("settings", ["tunnels", "aws"])).toBe("settings");
  });
});
