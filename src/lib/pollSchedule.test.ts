import { describe, expect, it } from "vitest";
import {
  POLL_BASE_MS,
  POLL_MAX_MS,
  afterAttempt,
  isDue,
  nextPollDelay,
  type HostPollState,
} from "./pollSchedule";

describe("nextPollDelay", () => {
  it("garde le rythme nominal tant que l'hôte répond", () => {
    expect(nextPollDelay(0)).toBe(POLL_BASE_MS);
  });

  it("double à chaque échec consécutif", () => {
    expect(nextPollDelay(1)).toBe(POLL_BASE_MS * 2);
    expect(nextPollDelay(2)).toBe(POLL_BASE_MS * 4);
    expect(nextPollDelay(3)).toBe(POLL_BASE_MS * 8);
  });

  it("plafonne, au lieu de laisser l'hôte devenir injoignable pour toujours", () => {
    // Sans plafond, un hôte éteint une nuit ne serait plus retenté avant
    // plusieurs jours : au retour, l'utilisateur verrait un indicateur mort
    // sans comprendre pourquoi.
    expect(nextPollDelay(20)).toBe(POLL_MAX_MS);
    expect(nextPollDelay(200)).toBe(POLL_MAX_MS);
  });

  it("ne déborde pas en Infinity ni en NaN sur un compteur absurde", () => {
    // `2 ** 2000` vaut Infinity, et c'est sans conséquence : `Math.min` rend
    // alors le plafond. Le test reste, parce que la propriété « le délai est
    // toujours un nombre fini » doit tenir quelle que soit l'implémentation —
    // mais il ne distingue pas deux écritures correctes, et ne prétend pas le
    // faire.
    const delay = nextPollDelay(2000);
    expect(Number.isFinite(delay)).toBe(true);
    expect(delay).toBe(POLL_MAX_MS);
  });
});

describe("afterAttempt", () => {
  const now = 1_000_000;

  it("remet le compteur à zéro dès qu'un hôte répond de nouveau", () => {
    const failing: HostPollState = { failures: 5, nextAttemptAt: now };
    const recovered = afterAttempt(failing, true, now);
    expect(recovered.failures).toBe(0);
    // Et le rythme nominal revient tout de suite : un hôte redémarré ne doit
    // pas rester puni du repli qu'il avait accumulé.
    expect(recovered.nextAttemptAt).toBe(now + POLL_BASE_MS);
  });

  it("accumule les échecs consécutifs", () => {
    let state = afterAttempt(undefined, false, now);
    expect(state.failures).toBe(1);
    state = afterAttempt(state, false, now);
    expect(state.failures).toBe(2);
    expect(state.nextAttemptAt).toBe(now + POLL_BASE_MS * 4);
  });

  it("traite un premier succès sans état antérieur", () => {
    expect(afterAttempt(undefined, true, now)).toEqual({ failures: 0, nextAttemptAt: now + POLL_BASE_MS });
  });
});

describe("isDue", () => {
  it("sonde tout de suite un hôte jamais vu", () => {
    expect(isDue(undefined, 0)).toBe(true);
  });

  it("attend l'échéance", () => {
    const state: HostPollState = { failures: 1, nextAttemptAt: 500 };
    expect(isDue(state, 499)).toBe(false);
    expect(isDue(state, 500)).toBe(true);
    expect(isDue(state, 501)).toBe(true);
  });
});

describe("le repli économise vraiment des connexions", () => {
  it("passe de 120 à 15 tentatives sur une heure pour un hôte éteint", () => {
    // Le chiffre qui justifie le changement. Chaque tentative ouvre une vraie
    // connexion — API Docker tunnelée par SSH, ou appel à l'API Kubernetes —
    // donc ce n'est pas un compteur abstrait.
    const HOUR = 3_600_000;
    let clock = 0;
    let attempts = 0;
    let state: HostPollState | undefined;
    while (clock < HOUR) {
      if (isDue(state, clock)) {
        attempts += 1;
        state = afterAttempt(state, false, clock);
      }
      clock += 1000;
    }
    const withoutBackoff = HOUR / POLL_BASE_MS;
    expect(withoutBackoff).toBe(120);
    expect(attempts).toBeLessThan(20);
    expect(attempts).toBeGreaterThan(5);
  });
});
