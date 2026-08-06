import type { HostDrift } from "./types";

/**
 * The hosts a drift check found actually drifted.
 *
 * The rule worth having in one place: **an unknown verdict is not drift.** It
 * must neither put a host on the list of things to repair nor take it off —
 * "we couldn't look" is evidence about the probe, not about the machine.
 * Getting this wrong in the direction of drift sends someone changing a host
 * nobody inspected; getting it wrong the other way reports a fleet as
 * compliant on the strength of checks that never ran.
 *
 * A host that couldn't be reached at all is likewise not drifted: its `error`
 * says so, and the panel shows it as unreachable rather than folding it in.
 */
export function driftedHosts(report: HostDrift[]): HostDrift[] {
  return report.filter((entry) => entry.checks.some((check) => check.verdict.kind === "drifted"));
}

/** How one host's result reads in a word. */
export type DriftSummary = "unreachable" | "drifted" | "matches";

/**
 * Summarises one host.
 *
 * Order matters: unreachable wins over everything (its checks say nothing),
 * then drift, then compliance. A host with only unknown verdicts reads as
 * `matches` — nothing contradicted the wanted state — but the panel shows the
 * unknown count alongside, because "conforme sur 2 lignes, 3 non vérifiables"
 * is a different fact from "conforme".
 */
export function summarise(entry: HostDrift): DriftSummary {
  if (entry.error) return "unreachable";
  return entry.checks.some((check) => check.verdict.kind === "drifted") ? "drifted" : "matches";
}
