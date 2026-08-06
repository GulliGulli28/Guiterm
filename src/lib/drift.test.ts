import { describe, expect, it } from "vitest";
import { driftedHosts, summarise } from "./drift";
import type { HostDrift } from "./types";

const entry = (hostId: string, overrides: Partial<HostDrift> = {}): HostDrift => ({
  hostId,
  checks: [],
  ...overrides,
});

const matches = { operation: "install-package nginx", verdict: { kind: "matches" } } as const;
const drifted = { operation: "install-package nginx", verdict: { kind: "drifted" } } as const;
const unknown = {
  operation: "update-packages",
  verdict: { kind: "unknown", reason: "cette opération ne laisse pas d'état à comparer" },
} as const;

describe("driftedHosts", () => {
  it("retient les hôtes qui contredisent l'état voulu", () => {
    const report = [entry("a", { checks: [matches] }), entry("b", { checks: [matches, drifted] })];
    expect(driftedHosts(report).map((e) => e.hostId)).toEqual(["b"]);
  });

  // The rule the whole module exists for. Repairing on the strength of a check
  // that never ran would change a machine nobody inspected.
  it("ne compte jamais un indéterminé comme un écart", () => {
    const report = [entry("a", { checks: [unknown] }), entry("b", { checks: [matches, unknown] })];
    expect(driftedHosts(report)).toEqual([]);
  });

  // Symmetrically: an unknown next to a real drift must not mask it.
  it("n'efface pas un vrai écart parce qu'un indéterminé l'accompagne", () => {
    const report = [entry("a", { checks: [unknown, drifted] })];
    expect(driftedHosts(report).map((e) => e.hostId)).toEqual(["a"]);
  });

  it("laisse un hôte injoignable en dehors de la liste à corriger", () => {
    const report = [entry("a", { checks: [], error: "connexion refusée" })];
    expect(driftedHosts(report)).toEqual([]);
  });
});

describe("summarise", () => {
  it("dit injoignable avant tout le reste", () => {
    expect(summarise(entry("a", { checks: [drifted], error: "timeout" }))).toBe("unreachable");
  });

  it("distingue conforme et en écart", () => {
    expect(summarise(entry("a", { checks: [matches] }))).toBe("matches");
    expect(summarise(entry("a", { checks: [drifted] }))).toBe("drifted");
  });

  // Nothing contradicted the wanted state, so "matches" is the honest word —
  // the panel shows the unknown count next to it rather than inventing a
  // fourth status.
  it("lit un hôte sans contradiction comme conforme", () => {
    expect(summarise(entry("a", { checks: [unknown, unknown] }))).toBe("matches");
  });
});
