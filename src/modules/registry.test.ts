import { describe, expect, it } from "vitest";
import type { TabMeta } from "../lib/types";
import { DEFAULT_PREFERENCES } from "../lib/preferences";
import type { SidebarPanelKind } from "../lib/sidebarButtons";
import { MODULES, renderModulePanel, renderModuleTab } from "./registry";
import type { SidebarActions } from "./types";
import type { AppContext } from "./types";

// Énumération à l'exécution des `kind` d'onglet — le `Record` fait échouer
// `tsc` si un `kind` est ajouté sans venir ici, ce qui rend les assertions
// ci-dessous incapables de passer à côté.
const EVERY_TAB_KIND: Record<TabMeta["kind"], true> = {
  terminal: true,
  transfer: true,
  "rdp-view": true,
  "local-terminal": true,
  fleet: true,
  activity: true,
  netdiag: true,
  sql: true,
};

const ALL_KINDS = Object.keys(EVERY_TAB_KIND) as TabMeta["kind"][];

// Même énumération, pour l'axe panneaux.
const EVERY_PANEL: Record<SidebarPanelKind, true> = {
  knownHosts: true,
  hosts: true,
  sftp: true,
  snippets: true,
  tunnels: true,
  keychain: true,
  database: true,
  aws: true,
  settings: true,
};

const ALL_PANELS = Object.keys(EVERY_PANEL) as SidebarPanelKind[];

describe("registre de modules", () => {
  const claimed = MODULES.flatMap((m) => ("tab" in m ? [m.tab.kind] : []));
  const claimedPanels = MODULES.flatMap((m) => ("panel" in m ? [m.panel.kind] : []));

  it("ne fait revendiquer un même kind par deux modules", () => {
    expect(new Set(claimed).size).toBe(claimed.length);
    expect(new Set(claimedPanels).size).toBe(claimedPanels.length);
  });

  it("couvre chaque kind d'onglet, exactement une fois", () => {
    // La version exécutable de ce que `_EveryTabKindHasAModule` prouve déjà à
    // la compilation — gardée parce qu'elle nomme le kind fautif, là où
    // l'erreur `tsc` dit seulement « ne satisfait pas la contrainte never ».
    // Depuis le commit 3, plus aucun onglet n'est rendu hors du registre :
    // c'est une couverture totale, plus une partition.
    expect([...claimed].sort()).toEqual([...ALL_KINDS].sort());
  });

  it("donne un id unique et un libellé à chaque module", () => {
    const ids = MODULES.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const m of MODULES) expect(m.label.trim()).not.toBe("");
  });

  it("couvre chaque panneau de barre latérale, exactement une fois", () => {
    // Version exécutable de `_EveryPanelHasAModule`. Un panneau sans module
    // s'afficherait vide : `Sidebar.tsx` n'a plus aucun dispatch de secours.
    expect([...claimedPanels].sort()).toEqual([...ALL_PANELS].sort());
  });

  it("n'est pas vide — sinon les couvertures ci-dessus se vérifieraient à vide", () => {
    expect(MODULES.length).toBeGreaterThanOrEqual(14);
    expect(ALL_KINDS.length).toBeGreaterThanOrEqual(8);
    expect(ALL_PANELS.length).toBeGreaterThanOrEqual(9);
  });
});

describe("renderModulePanel", () => {
  const ctx = {
    workspace: { hosts: [], sqlConnections: [], groups: [], snippets: [], keychain: [], portForwards: [] },
    preferences: DEFAULT_PREFERENCES,
    reportError: () => {},
    pushNotification: () => {},
    refreshWorkspace: () => {},
  } as unknown as AppContext;
  const actions = {} as SidebarActions;

  it("rend un contenu pour chaque panneau, sans exception", () => {
    for (const panel of ALL_PANELS) {
      const out = renderModulePanel(panel, ctx, actions);
      expect(out, `aucun rendu pour le panneau « ${panel} »`).toBeDefined();
      expect(out, `rendu vide pour le panneau « ${panel} »`).not.toBeNull();
    }
  });
});

describe("renderModuleTab", () => {
  const HOST_ID = "h1";
  // Contexte minimal mais **non vide** : les modules liés à un hôte lisent
  // `workspace.hosts` pour résoudre leur cible, donc un `{} as AppContext`
  // ferait échouer le rendu pour une raison qui n'a rien à voir avec ce qui
  // est testé ici.
  const CONNECTION_ID = "c1";
  const ctx = {
    workspace: {
      hosts: [{ id: HOST_ID, label: "srv" }],
      sqlConnections: [{ id: CONNECTION_ID, label: "db", engine: "postgres" }],
    },
    preferences: DEFAULT_PREFERENCES,
    reportError: () => {},
    pushNotification: () => {},
    refreshWorkspace: () => {},
    closeTab: () => {},
    notifyLongCommand: () => {},
    mirrorInput: () => {},
    registerTerminalHandle: () => {},
  } as unknown as AppContext;

  const tabOfKind = (kind: TabMeta["kind"], hostId = HOST_ID, sqlConnectionId = CONNECTION_ID) =>
    ({ id: "t", kind, label: "x", hostId, sqlConnectionId }) as unknown as TabMeta;

  it("rend un contenu pour chaque kind d'onglet, sans exception", () => {
    for (const kind of ALL_KINDS) {
      const out = renderModuleTab(tabOfKind(kind), ctx, true);
      // `undefined` signifierait « aucun module ne revendique ce kind » :
      // depuis que le dispatch d'App.tsx a disparu, l'onglet s'ouvrirait
      // définitivement vide. C'est la panne à attraper ici.
      expect(out, `aucun rendu pour l'onglet « ${kind} »`).toBeDefined();
      expect(out, `rendu vide pour l'onglet « ${kind} »`).not.toBeNull();
    }
  });

  it("rend null quand la cible de l'onglet a été supprimée", () => {
    // `null` et non `undefined` : la cible manquante est un état légitime
    // (hôte ou connexion effacé pendant que l'onglet était ouvert), là où
    // `undefined` signalerait un registre incohérent.
    for (const kind of ["terminal", "transfer", "rdp-view"] as const) {
      expect(renderModuleTab(tabOfKind(kind, "disparu"), ctx, true)).toBeNull();
    }
    expect(renderModuleTab(tabOfKind("sql", HOST_ID, "disparue"), ctx, true)).toBeNull();
  });
});
