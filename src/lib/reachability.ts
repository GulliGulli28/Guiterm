import { assertNever } from "./exhaustive";
import type { ReachabilityVerdict } from "./types";

export interface VerdictDisplay {
  /** `ok` reached it, `warn` got an answer that says no, `bad` got nothing
   * back, `idle` couldn't ask. */
  tone: "ok" | "warn" | "bad" | "idle";
  label: string;
  /** What it means, in the terms of what to go and fix. This is the whole
   * value of the feature: "ça ne marche pas" is what the user already knew. */
  detail: string;
}

/**
 * Puts a probe result into words that point at a remedy.
 *
 * The `refused` / `filtered` split is the reason this exists. Something
 * answering "no" means you are looking at the right machine and the service is
 * down; nothing answering means the packets never got there, and the machine is
 * not the place to look. Same symptom, opposite investigations.
 *
 * Closed with `assertNever`: a verdict added to the union without wording of
 * its own becomes a `tsc` error rather than a blank cell.
 */
export function describeVerdict(verdict: ReachabilityVerdict): VerdictDisplay {
  switch (verdict.kind) {
    case "open":
      return {
        tone: "ok",
        label: "Joignable",
        detail: `Connexion TCP établie (via ${verdict.via}).`,
      };
    case "refused":
      return {
        tone: "warn",
        label: "Refusé",
        detail: "Quelque chose a répondu non : port fermé ou service arrêté. La machine, elle, est bien atteinte.",
      };
    case "filtered":
      return {
        tone: "bad",
        label: "Silence",
        detail: "Rien n'a répondu du tout : les paquets sont jetés en route — pare-feu, security group, ou route manquante.",
      };
    case "unknownHost":
      return {
        tone: "warn",
        label: "Nom non résolu",
        detail: "Le nom ne se résout pas depuis cette source — problème de DNS, pas de réseau.",
      };
    case "unreachable":
      return {
        tone: "bad",
        label: "Pas de route",
        detail: "Aucune route vers ce réseau depuis cette source.",
      };
    case "noTool":
      return {
        tone: "idle",
        label: "Sonde indisponible",
        detail: "Ni bash+timeout, ni nc, ni curl sur cette source : rien pour tester.",
      };
    case "failed":
      return { tone: "idle", label: "Échec", detail: verdict.message };
    default:
      return assertNever(verdict, "verdict de joignabilité");
  }
}

/** The port people mean when they don't say. 22 rather than 80: this is opened
 * from a host in a terminal app, and "can that box reach my other box's SSH"
 * is the question that gets asked. */
export const DEFAULT_PROBE_PORT = 22;

/** Splits `host:port`, `[v6]:port` or a bare host, so pasting what you copied
 * from a log or a config lands in the right two fields instead of failing
 * validation on the colon. */
export function splitEndpoint(text: string): { host: string; port: number | null } {
  const trimmed = text.trim();
  const bracketed = /^\[(.+)\]:(\d{1,5})$/.exec(trimmed);
  if (bracketed) return { host: bracketed[1], port: Number(bracketed[2]) };
  // A bare IPv6 literal has several colons and no port; only a single trailing
  // `:digits` is a port.
  const withPort = /^([^:]+):(\d{1,5})$/.exec(trimmed);
  if (withPort) return { host: withPort[1], port: Number(withPort[2]) };
  return { host: trimmed, port: null };
}
