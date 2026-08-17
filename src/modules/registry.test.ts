import { describe, expect, it } from "vitest";
import type { TabMeta } from "../lib/types";
import { DEFAULT_PREFERENCES } from "../lib/preferences";
import { MODULES, renderModuleTab } from "./registry";
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

  it("n'est pas vide — sinon la couverture ci-dessus se vérifierait à vide", () => {
    expect(MODULES.length).toBeGreaterThanOrEqual(8);
    expect(ALL_KINDS.length).toBeGreaterThanOrEqual(8);
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
