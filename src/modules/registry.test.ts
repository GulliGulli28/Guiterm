import { describe, expect, it } from "vitest";
import type { TabMeta } from "../lib/types";
import { DEFAULT_PREFERENCES } from "../lib/preferences";
import { MODULES, TABS_STILL_IN_APP, isTabStillInApp, renderModuleTab } from "./registry";
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

describe("registre de modules", () => {
  const claimed = MODULES.map((m) => m.tab.kind);

  it("ne fait revendiquer un même kind par deux modules", () => {
    expect(new Set(claimed).size).toBe(claimed.length);
  });

  it("partitionne les kinds : modules et reliquat, sans trou ni recouvrement", () => {
    // La version exécutable de ce que `_AllTabKindsCovered` prouve déjà à la
    // compilation — gardée parce qu'elle nomme le kind fautif, là où l'erreur
    // `tsc` dit seulement « ne satisfait pas la contrainte never ».
    expect([...claimed, ...TABS_STILL_IN_APP].sort()).toEqual([...ALL_KINDS].sort());
  });

  it("donne un id unique et un libellé à chaque module", () => {
    const ids = MODULES.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const m of MODULES) expect(m.label.trim()).not.toBe("");
  });

  it("n'est pas vide — sinon la partition ci-dessus se vérifierait à vide", () => {
    expect(MODULES.length).toBeGreaterThanOrEqual(3);
    expect(ALL_KINDS.length).toBeGreaterThanOrEqual(8);
  });
});

describe("isTabStillInApp", () => {
  it("reconnaît ce qu'App.tsx rend encore", () => {
    for (const kind of TABS_STILL_IN_APP) {
      expect(isTabStillInApp({ kind } as TabMeta)).toBe(true);
    }
  });

  it("rejette ce qu'un module a repris", () => {
    for (const m of MODULES) {
      expect(isTabStillInApp({ kind: m.tab.kind } as TabMeta)).toBe(false);
    }
  });
});

describe("renderModuleTab", () => {
  const HOST_ID = "h1";
  // Contexte minimal mais **non vide** : les modules liés à un hôte lisent
  // `workspace.hosts` pour résoudre leur cible, donc un `{} as AppContext`
  // ferait échouer le rendu pour une raison qui n'a rien à voir avec ce qui
  // est testé ici.
  const ctx = {
    workspace: { hosts: [{ id: HOST_ID, label: "srv" }] },
    preferences: DEFAULT_PREFERENCES,
    reportError: () => {},
    pushNotification: () => {},
    refreshWorkspace: () => {},
    closeTab: () => {},
    notifyLongCommand: () => {},
    mirrorInput: () => {},
    registerTerminalHandle: () => {},
  } as unknown as AppContext;

  const tabOfKind = (kind: TabMeta["kind"], hostId = HOST_ID) =>
    ({ id: "t", kind, label: "x", hostId }) as unknown as TabMeta;

  it("rend quelque chose pour chaque kind revendiqué", () => {
    for (const m of MODULES) {
      const out = renderModuleTab(tabOfKind(m.tab.kind), ctx, true);
      // `undefined` signifierait « aucun module ne le revendique », ce qui
      // ferait retomber App.tsx dans un `assertNever` : l'onglet ne
      // s'afficherait pas. C'est la panne à attraper ici.
      expect(out).toBeDefined();
      expect(out).not.toBeNull();
    }
  });

  it("rend null — pas undefined — quand l'hôte visé a été supprimé", () => {
    // La distinction est porteuse : `undefined` renverrait App.tsx vers un
    // `assertNever` sur un onglet parfaitement légitime, simplement parce que
    // son hôte n'existe plus.
    for (const kind of ["terminal", "transfer", "rdp-view"] as const) {
      expect(renderModuleTab(tabOfKind(kind, "disparu"), ctx, true)).toBeNull();
    }
  });

  it("rend undefined — et non null — pour un kind resté dans App.tsx", () => {
    for (const kind of TABS_STILL_IN_APP) {
      expect(renderModuleTab(tabOfKind(kind), ctx, true)).toBeUndefined();
    }
  });
});
