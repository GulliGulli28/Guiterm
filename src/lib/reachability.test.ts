import { describe, expect, it } from "vitest";
import { describeVerdict, splitEndpoint } from "./reachability";

describe("describeVerdict", () => {
  // The distinction the whole feature exists for. If these two ever read the
  // same, the diagnostic is worth nothing: they send you to opposite places.
  it("oppose franchement un refus et un silence", () => {
    const refused = describeVerdict({ kind: "refused", via: "nc" });
    const filtered = describeVerdict({ kind: "filtered", via: "nc" });
    expect(refused.label).not.toBe(filtered.label);
    expect(refused.tone).not.toBe(filtered.tone);
    // Un refus dit que la machine est atteinte ; un silence dit l'inverse.
    expect(refused.detail).toMatch(/atteinte/);
    expect(filtered.detail).toMatch(/pare-feu|route/);
  });

  it("nomme l'outil qui a répondu quand la connexion passe", () => {
    expect(describeVerdict({ kind: "open", via: "bash" }).detail).toContain("bash");
    expect(describeVerdict({ kind: "open", via: "curl" }).tone).toBe("ok");
  });

  it("distingue un problème de DNS d'un problème de réseau", () => {
    expect(describeVerdict({ kind: "unknownHost", via: "bash" }).detail).toMatch(/DNS/);
    expect(describeVerdict({ kind: "unreachable", via: "bash" }).detail).toMatch(/route/);
  });

  it("garde le message brut quand la sonde elle-même a échoué", () => {
    expect(describeVerdict({ kind: "failed", message: "sh: not found" }).detail).toBe("sh: not found");
  });

  it("ne présente pas une sonde absente comme un verdict réseau", () => {
    const noTool = describeVerdict({ kind: "noTool" });
    expect(noTool.tone).toBe("idle");
    expect(noTool.detail).toMatch(/nc|curl/);
  });
});

describe("splitEndpoint", () => {
  it("accepte ce qu'on copie d'un log ou d'une conf", () => {
    expect(splitEndpoint("db-1.internal:5432")).toEqual({ host: "db-1.internal", port: 5432 });
    expect(splitEndpoint("  10.0.4.12:443 ")).toEqual({ host: "10.0.4.12", port: 443 });
    expect(splitEndpoint("[fe80::1]:22")).toEqual({ host: "fe80::1", port: 22 });
  });

  // A bare IPv6 literal is all colons; reading its last group as a port would
  // silently probe the wrong thing.
  it("ne prend pas un littéral IPv6 pour un couple hôte:port", () => {
    expect(splitEndpoint("fe80::1")).toEqual({ host: "fe80::1", port: null });
    expect(splitEndpoint("example.com")).toEqual({ host: "example.com", port: null });
  });
});
