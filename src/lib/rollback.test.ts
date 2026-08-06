import { describe, expect, it } from "vitest";
import { hasSomethingToRun, rollbackAvailability } from "./rollback";
import type { FleetRun, RollbackPlan } from "./types";

const run = (overrides: Partial<FleetRun>): FleetRun => ({
  id: "run-1",
  startedAtMs: 1_700_000_000_000,
  command: "installer nginx",
  targets: [],
  outcomes: [],
  ...overrides,
});

const plan = (commands: (string | null)[]): RollbackPlan => ({
  programText: "remove-package nginx",
  groups: commands.map((command) => ({ command, hostIds: ["h1"], note: null })),
  unreversed: [],
});

describe("rollbackAvailability", () => {
  it("propose l'annulation d'un run enregistré avec son programme", () => {
    expect(rollbackAvailability(run({ programText: "install-package nginx" })).enabled).toBe(true);
  });

  // The rule the whole feature rests on: rendered shell is not enough to
  // invert, so a run carrying only that must not offer a button.
  it("refuse un run qui n'a que du shell rendu", () => {
    const legacy = run({ perHostCommands: { h1: "apt-get install -y nginx" } });
    const availability = rollbackAvailability(legacy);
    expect(availability.enabled).toBe(false);
    expect(availability.reason).toContain("non annulable");
  });

  it("refuse aussi un run en commande libre", () => {
    expect(rollbackAvailability(run({ command: "systemctl restart nginx" })).enabled).toBe(false);
  });

  // Greyed out with no explanation is the thing that makes people think the
  // app is broken; the reason is the point of disabling rather than hiding.
  it("dit toujours pourquoi, dans les deux cas", () => {
    expect(rollbackAvailability(run({ programText: "reboot" })).reason).not.toBe("");
    expect(rollbackAvailability(run({})).reason).not.toBe("");
  });
});

describe("hasSomethingToRun", () => {
  it("voit ce qu'il y a à exécuter", () => {
    expect(hasSomethingToRun(plan(["remove-package nginx"]))).toBe(true);
    expect(hasSomethingToRun(plan([null, "apt-get remove -y nginx"]))).toBe(true);
  });

  // A run can be undoable in principle and still produce nothing to run —
  // every operation irreversible, or none applying to these hosts any more.
  // Offering "Exécuter" there would do nothing and look broken.
  it("distingue « annulable » de « il y a quelque chose à faire »", () => {
    expect(hasSomethingToRun(plan([]))).toBe(false);
    expect(hasSomethingToRun(plan([null, null]))).toBe(false);
  });
});
