import { assertNever } from "./exhaustive";
import type { DiagTool, DiagVerdict } from "./types";

/** How a verdict reads in the grid. */
export interface DescribedVerdict {
  /** The short answer shown in the cell. */
  label: string;
  /** Which of four meanings it carries — what decides the colour. Kept coarse
   * on purpose: seven verdicts, four things to feel about them. */
  tone: "ok" | "bad" | "unknown" | "muted";
  /** Longer wording for a tooltip, when the label had to be short. */
  detail: string;
}

/** Turns a verdict into what the cell shows.
 *
 * The `switch` closes on {@link assertNever}: adding a verdict in `core`
 * without deciding how it reads becomes a `tsc` error rather than an empty
 * cell. That guard exists because a missing branch shipped once already — see
 * `exhaustive.ts`.
 *
 * The distinctions are the whole point of the feature and are preserved here
 * rather than flattened into ✓/✗: a refusal means something answered and you
 * are looking at the right machine; a silence means nothing did, and the
 * remedies have nothing in common.
 */
export function describeVerdict(verdict: DiagVerdict): DescribedVerdict {
  switch (verdict.kind) {
    case "ok":
      return { label: verdict.summary, tone: "ok", detail: verdict.summary };
    case "refused":
      return {
        label: verdict.summary,
        tone: "bad",
        detail: `${verdict.summary} — quelque chose a répondu et a dit non : la machine est la bonne, le service ou la règle ne l'est pas.`,
      };
    case "silent":
      return {
        label: verdict.summary,
        tone: "bad",
        detail: `${verdict.summary} — rien n'a répondu : paquet jeté en route (pare-feu, security group, route manquante).`,
      };
    case "unknownHost":
      return {
        label: "nom inconnu",
        tone: "unknown",
        detail: "Le nom ne se résout pas depuis cette machine — un problème de DNS, pas de réseau.",
      };
    case "unreachable":
      return {
        label: "réseau injoignable",
        tone: "bad",
        detail: "Aucune route vers ce réseau depuis cette machine.",
      };
    case "unavailable":
      return {
        label: "outil absent",
        tone: "muted",
        detail: `Rien ici pour répondre à cette question (${verdict.tool}). La machine va bien — c'est le test qui ne peut pas être fait.`,
      };
    case "failed":
      return { label: "échec", tone: "unknown", detail: verdict.message };
    default:
      return assertNever(verdict, "describeVerdict");
  }
}

/** A stable key for one tool, used to index the result grid. */
export function diagToolKey(tool: DiagTool): string {
  switch (tool.kind) {
    case "tcp":
      return `tcp:${tool.port}`;
    case "dns":
      return "dns";
    case "http":
      return `http:${tool.secure ? "s" : ""}:${tool.port ?? ""}:${tool.path}`;
    default:
      return assertNever(tool, "diagToolKey");
  }
}

/** The column heading for one tool. Mirrors `DiagTool::label` in `core`. */
export function diagToolLabel(tool: DiagTool): string {
  switch (tool.kind) {
    case "tcp":
      return `TCP ${tool.port}`;
    case "dns":
      return "DNS";
    case "http": {
      const scheme = tool.secure ? "HTTPS" : "HTTP";
      return tool.port === null ? scheme : `${scheme} ${tool.port}`;
    }
    default:
      return assertNever(tool, "diagToolLabel");
  }
}
