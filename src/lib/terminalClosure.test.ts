import { describe, expect, it } from "vitest";
import { MAX_RETRY_DELAY_SEC, nextClosureAction, type ClosureContext } from "./terminalClosure";

function context(extra: Partial<ClosureContext> = {}): ClosureContext {
  return { autoReconnect: false, attempt: 0, maxAttempts: 5, hasPersistentSession: false, ...extra };
}

describe("nextClosureAction", () => {
  it("réessaie tant qu'il reste des tentatives, avec un délai qui double", () => {
    expect(nextClosureAction(context({ autoReconnect: true, attempt: 0 })))
      .toEqual({ kind: "retry", attempt: 1, delaySec: 2 });
    expect(nextClosureAction(context({ autoReconnect: true, attempt: 1 })))
      .toEqual({ kind: "retry", attempt: 2, delaySec: 4 });
    expect(nextClosureAction(context({ autoReconnect: true, attempt: 3 })))
      .toEqual({ kind: "retry", attempt: 4, delaySec: 16 });
  });

  it("plafonne le délai", () => {
    const action = nextClosureAction(context({ autoReconnect: true, attempt: 9, maxAttempts: 20 }));
    expect(action).toEqual({ kind: "retry", attempt: 10, delaySec: MAX_RETRY_DELAY_SEC });
  });

  it("ferme l'onglet une fois les tentatives épuisées", () => {
    expect(nextClosureAction(context({ autoReconnect: true, attempt: 5, maxAttempts: 5 })))
      .toEqual({ kind: "close" });
  });

  // Le défaut de l'app : `autoReconnect` est désactivé, donc une coupure de
  // réseau arrive directement à la dernière décision. C'est ce chemin-là qui
  // compte le plus, pas le cas limite des tentatives épuisées.
  it("décide tout de suite quand la reconnexion automatique est désactivée", () => {
    expect(nextClosureAction(context({ autoReconnect: false }))).toEqual({ kind: "close" });
  });

  // Le cœur de la tranche : une session qui survit à sa connexion ne doit pas
  // partir avec l'onglet. Fermer emporterait la clé, et la session
  // continuerait de tourner sur l'hôte sans plus rien pour la retrouver.
  it("se détache au lieu de fermer quand la session est persistante", () => {
    expect(nextClosureAction(context({ hasPersistentSession: true })))
      .toEqual({ kind: "detach" });
    expect(nextClosureAction(context({ autoReconnect: true, attempt: 5, maxAttempts: 5, hasPersistentSession: true })))
      .toEqual({ kind: "detach" });
  });

  // Et l'ordre entre les deux règles : une session persistante ne court-circuite
  // pas la reconnexion automatique. Rattacher tout de suite vaut mieux que
  // repasser par une vignette à recliquer.
  it("réessaie avant de se détacher, même en session persistante", () => {
    expect(nextClosureAction(context({ autoReconnect: true, attempt: 0, hasPersistentSession: true })))
      .toEqual({ kind: "retry", attempt: 1, delaySec: 2 });
  });
});
