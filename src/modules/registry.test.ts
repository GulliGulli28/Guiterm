import { describe, expect, it } from "vitest";
import type { TabMeta } from "../lib/types";
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
  const ctx = {} as AppContext;

  it("rend quelque chose pour chaque kind revendiqué", () => {
    for (const m of MODULES) {
      const out = renderModuleTab({ id: "t", kind: m.tab.kind, label: "x" } as TabMeta, ctx, true);
      // `undefined` signifierait « aucun module ne le revendique », ce qui
      // ferait retomber App.tsx dans une cascade qui ne le gère pas non plus :
      // l'onglet s'ouvrirait vide. C'est la panne à attraper ici.
      expect(out).toBeDefined();
    }
  });

  it("rend undefined — et non null — pour un kind resté dans App.tsx", () => {
    for (const kind of TABS_STILL_IN_APP) {
      expect(renderModuleTab({ kind } as TabMeta, ctx, true)).toBeUndefined();
    }
  });
});
