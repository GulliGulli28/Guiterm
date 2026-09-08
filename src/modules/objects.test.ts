import { describe, expect, it, vi } from "vitest";
import type { AppObject } from "../lib/appObject";
import { DEFAULT_PREFERENCES } from "../lib/preferences";
import { MODULES, actionsForObject } from "./registry";
import type { AppContext, TabOpeners } from "./types";

// Énumération à l'exécution des `kind` d'objet — le `Record` fait échouer
// `tsc` si un `kind` est ajouté sans venir ici, ce qui rend l'anti-vacuité
// plus bas incapable de passer à côté. Même mécanique que `EVERY_TAB_KIND`
// dans `registry.test.ts`, et pour la même raison : un registre consulté à
// l'exécution est invisible pour le compilateur.
const EVERY_OBJECT_KIND: Record<AppObject["kind"], true> = {
  remotePath: true,
};

const HOST_ID = "h1";

const ctx = {
  workspace: {
    hosts: [{ id: HOST_ID, label: "srv" }],
    sqlConnections: [],
    groups: [],
    snippets: [],
    keychain: [],
    portForwards: [],
  },
  preferences: DEFAULT_PREFERENCES,
  reportError: () => {},
  pushNotification: () => {},
  refreshWorkspace: () => {},
  objectActions: () => [],
} as unknown as AppContext;

/** Un exemplaire de chaque `kind`, pour vérifier qu'il a un destinataire.
 *
 * Le `Record` ci-dessus garantit qu'aucun `kind` n'échappe à cette table :
 * `tsc` réclame la clé manquante avant que le test ne tourne. */
const SAMPLES: Record<AppObject["kind"], AppObject> = {
  remotePath: { kind: "remotePath", source: { kind: "remote", hostId: HOST_ID }, path: "/etc/nginx/nginx.conf", isDir: false },
};

/** Des ouvreurs qui enregistrent au lieu d'ouvrir. Un `{} as TabOpeners` ne
 * suffirait pas : le test exécute réellement le `run()` de chaque action pour
 * vérifier qu'elle appelle quelque chose. */
function spyOpeners(): TabOpeners {
  return new Proxy({} as TabOpeners, {
    get: () => vi.fn(),
  });
}

describe("bus d'objets", () => {
  const kinds = Object.keys(EVERY_OBJECT_KIND) as AppObject["kind"][];

  it("donne au moins une action à chaque kind d'objet", () => {
    // **Le garde-fou central.** Un `kind` que personne n'accepte compile
    // parfaitement et affiche un menu vide — la panne MongoDB sous une autre
    // forme, et la seule que `tsc` ne peut pas voir ici : `actionsFor` est une
    // fonction, pas une déclaration que le compilateur peut recouper.
    //
    // Il vaut aussi comme frein : ajouter une variante d'`AppObject` sans
    // décider qui la reçoit fait rouge, donc `endpoint`, `targets` et `text`
    // n'arriveront qu'avec leur tranche.
    for (const kind of kinds) {
      const actions = actionsForObject(SAMPLES[kind], ctx, spyOpeners());
      expect(actions.length, `aucun module n'accepte un objet « ${kind} »`).toBeGreaterThan(0);
    }
  });

  it("préfixe chaque id d'action par l'id d'un module réel", () => {
    // Un menu agrège les propositions de dix-sept modules : sans préfixe, deux
    // actions homonymes venues de deux modules seraient indiscernables dans un
    // rapport de bug. Et le préfixe *vérifié* attrape le copier-coller d'une
    // action d'un module à l'autre, qui autrement ne se voit nulle part.
    const moduleIds = new Set(MODULES.map((m) => m.id));
    for (const kind of kinds) {
      for (const action of actionsForObject(SAMPLES[kind], ctx, spyOpeners())) {
        const prefix = action.id.split(".")[0];
        expect(moduleIds.has(prefix), `« ${action.id} » n'est préfixé par aucun module`).toBe(true);
        expect(action.label.trim(), `« ${action.id} » n'a pas de libellé`).not.toBe("");
      }
    }
  });

  it("ne fait proposer un même id par deux modules", () => {
    for (const kind of kinds) {
      const ids = actionsForObject(SAMPLES[kind], ctx, spyOpeners()).map((a) => a.id);
      expect(new Set(ids).size, `ids en double pour « ${kind} » : ${ids.join(", ")}`).toBe(ids.length);
    }
  });

  it("fait passer un chemin de fichier par son dossier, jamais par lui-même", () => {
    // Ce que les deux destinataires de `remotePath` promettent : « ouvrir un
    // terminal dans son dossier » sur `/etc/nginx/nginx.conf` doit viser
    // `/etc/nginx`. Un `cd` vers un fichier échouerait dans le shell, en
    // silence, une fois la session déjà ouverte.
    const openTerminalIn = vi.fn();
    const openTransferIn = vi.fn();
    const openers = { openTerminalIn, openTransferIn } as unknown as TabOpeners;
    for (const action of actionsForObject(SAMPLES.remotePath, ctx, openers)) action.run();
    expect(openTerminalIn).toHaveBeenCalledWith({ kind: "remote", hostId: HOST_ID }, "/etc/nginx");
    expect(openTransferIn).toHaveBeenCalledWith({ kind: "remote", hostId: HOST_ID }, "/etc/nginx");
  });

  it("n'est pas vide — sinon les vérifications ci-dessus se feraient à vide", () => {
    expect(kinds.length).toBeGreaterThanOrEqual(1);
    expect(MODULES.some((m) => "objects" in m && m.objects)).toBe(true);
  });
});
