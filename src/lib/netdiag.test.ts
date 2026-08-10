import { describe, expect, it } from "vitest";
import { describeVerdict, diagRowKey, diagToolKey, diagToolLabel } from "./netdiag";
import type { DiagRow, DiagTool, DiagVerdict, HostId } from "./types";

describe("describeVerdict", () => {
  /** The distinction the whole feature exists for. Both are failures, but a
   * refusal means something answered — you are on the right machine — while a
   * silence means nothing did. Collapsing them into "✗" would throw away the
   * only thing that says what to fix. */
  it("dit un refus et un silence différemment", () => {
    const refused = describeVerdict({ kind: "refused", summary: "connexion refusée" });
    const silent = describeVerdict({ kind: "silent", summary: "aucune réponse" });

    expect(refused.detail).toContain("a répondu et a dit non");
    expect(silent.detail).toContain("rien n'a répondu");
    expect(refused.detail).not.toBe(silent.detail);
  });

  /** A missing tool is not a failed test: the machine is fine, the question
   * just can't be asked there. Colouring it like a failure would send someone
   * hunting a firewall rule that doesn't exist. */
  it("ne peint pas un outil absent comme un échec", () => {
    const unavailable = describeVerdict({ kind: "unavailable", tool: "dig" });
    expect(unavailable.tone).toBe("muted");
    expect(unavailable.detail).toContain("dig");

    expect(describeVerdict({ kind: "silent", summary: "x" }).tone).toBe("bad");
  });

  /** The bug found in use: a traceroute ending in asterisks was reported as a
   * silence, in red, next to an HTTPS 301 in green — a contradiction the app
   * invented. Most of the internet drops traceroute probes, so that outcome
   * settles nothing and must not read as a failure. */
  it("ne peint pas un traceroute non abouti comme une panne", () => {
    const inconclusive = describeVerdict({ kind: "inconclusive", summary: "limite de 30 sauts atteinte" });
    expect(inconclusive.tone).toBe("unknown");
    expect(inconclusive.tone).not.toBe("bad");
    expect(inconclusive.detail).toContain("ne veut pas dire que la destination est injoignable");
    expect(inconclusive.detail).toContain("autres colonnes");
  });

  it("sépare le DNS du réseau", () => {
    expect(describeVerdict({ kind: "unknownHost" }).detail).toContain("DNS");
    expect(describeVerdict({ kind: "unreachable" }).detail).toContain("route");
  });

  it("garde le message d'un échec plutôt que de l'avaler", () => {
    const failed = describeVerdict({ kind: "failed", message: "Connexion à la source impossible" });
    expect(failed.detail).toBe("Connexion à la source impossible");
  });

  it("montre le résumé d'un succès tel quel", () => {
    expect(describeVerdict({ kind: "ok", summary: "200 en 42 ms" }).label).toBe("200 en 42 ms");
    expect(describeVerdict({ kind: "ok", summary: "x" }).tone).toBe("ok");
  });

  /** The anti-vacuity check: proves the `assertNever` arm is reachable, so the
   * exhaustiveness guard isn't decorative. A verdict added in `core` and not
   * here must fail loudly rather than render an empty cell. */
  it("échoue bruyamment sur un verdict qu'aucune branche ne gère", () => {
    const rogue = { kind: "throttled", summary: "…" } as unknown as DiagVerdict;
    expect(() => describeVerdict(rogue)).toThrow(/cas non géré/);
  });
});

describe("diagToolKey", () => {
  /** The key indexes the result grid: two tools that differ must not collide,
   * or one column would silently overwrite the other's results. */
  it("distingue deux outils qui ne diffèrent que par un détail", () => {
    const keys = [
      diagToolKey({ kind: "tcp", port: 22 }),
      diagToolKey({ kind: "tcp", port: 443 }),
      diagToolKey({ kind: "dns" }),
      diagToolKey({ kind: "http", secure: false, port: null, path: "" }),
      diagToolKey({ kind: "http", secure: true, port: null, path: "" }),
      diagToolKey({ kind: "http", secure: true, port: 8443, path: "" }),
      diagToolKey({ kind: "http", secure: true, port: null, path: "/health" }),
      diagToolKey({ kind: "ping", count: 4 }),
      diagToolKey({ kind: "traceroute", maxHops: 15 }),
    ];
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("est stable pour un même outil", () => {
    const tool: DiagTool = { kind: "http", secure: true, port: 8443, path: "/x" };
    expect(diagToolKey(tool)).toBe(diagToolKey({ ...tool }));
  });

  /** `ping` used to stand in for the unknown variant here — until tranche 2
   * made it real and this test started failing, which is precisely what an
   * anti-vacuity check is for. `mtr` is the stand-in now. */
  it("échoue bruyamment sur un outil qu'aucune branche ne gère", () => {
    const rogue = { kind: "mtr", cycles: 10 } as unknown as DiagTool;
    expect(() => diagToolKey(rogue)).toThrow(/cas non géré/);
  });
});

describe("diagRowKey", () => {
  /** The two directions put different things on the rows, and a row from one
   * must never collide with a row from the other — a stale result would land
   * in the wrong cell. */
  it("ne confond pas une source et un hôte diagnostiqué", () => {
    const hostId = "11111111-2222-3333-4444-555555555555" as HostId;
    const from = diagRowKey({ kind: "from", target: { kind: "ssh", hostId } });
    const to = diagRowKey({ kind: "to", hostId });
    expect(from).not.toBe(to);
  });

  it("distingue deux hôtes", () => {
    const a = diagRowKey({ kind: "to", hostId: "aaaaaaaa-0000-0000-0000-000000000000" as HostId });
    const b = diagRowKey({ kind: "to", hostId: "bbbbbbbb-0000-0000-0000-000000000000" as HostId });
    expect(a).not.toBe(b);
  });

  it("échoue bruyamment sur une ligne qu'aucune branche ne gère", () => {
    const rogue = { kind: "between", a: 1, b: 2 } as unknown as DiagRow;
    expect(() => diagRowKey(rogue)).toThrow(/cas non géré/);
  });
});

describe("diagToolLabel", () => {
  /** Must agree with `DiagTool::label` in `core`, which is what results are
   * reported with — two spellings of the same column would read as two tools. */
  it("reprend les libellés du backend", () => {
    expect(diagToolLabel({ kind: "tcp", port: 443 })).toBe("TCP 443");
    expect(diagToolLabel({ kind: "dns" })).toBe("DNS");
    expect(diagToolLabel({ kind: "http", secure: true, port: null, path: "" })).toBe("HTTPS");
    expect(diagToolLabel({ kind: "http", secure: false, port: 8080, path: "" })).toBe("HTTP 8080");
    expect(diagToolLabel({ kind: "ping", count: 4 })).toBe("Ping");
    expect(diagToolLabel({ kind: "traceroute", maxHops: 15 })).toBe("Traceroute");
  });
});
