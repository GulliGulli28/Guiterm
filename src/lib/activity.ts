import { assertNever } from "./exhaustive";
import type { ActivityEvent, ActivityKind } from "./types";

/** How each trail is named in the filter bar and the table. Closed on
 * `assertNever`, so a fourth source can't be added without deciding how it
 * reads to the user. */
export function activityKindLabel(kind: ActivityKind): string {
  switch (kind) {
    case "fleetRun":
      return "Opération de flotte";
    case "command":
      return "Commande";
    case "recording":
      return "Enregistrement";
    default:
      return assertNever(kind, "type d'événement d'activité");
  }
}

/** Every kind, in the order the filter bar offers them — most significant
 * first. A plain array rather than `Object.keys` of something: this is the
 * display order, which no derivation would get right. */
export const ACTIVITY_KINDS: ActivityKind[] = ["fleetRun", "command", "recording"];

/** When an event happened, or an explicit statement that it isn't known.
 *
 * The whole reason this isn't `new Date(atMs).toLocaleString()` inline: `atMs`
 * is genuinely `null` for the ~1000 commands migrated from the format that
 * predated timestamps, and `new Date(null)` is 1 January 1970 — a plausible
 * looking date, in an audit log, for an event that happened last week. */
export function formatActivityTime(atMs: number | null): string {
  if (atMs === null) return "date inconnue";
  return new Date(atMs).toLocaleString("fr-FR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Groups events under a day heading, preserving the order they arrive in
 * (the backend already sorts newest first, dateless last).
 *
 * Dateless events land in their own trailing group rather than being folded
 * into today: they are not today, and a heading is the most visible place
 * that claim would be made. */
export function groupByDay(events: ActivityEvent[]): { day: string; events: ActivityEvent[] }[] {
  const groups: { day: string; events: ActivityEvent[] }[] = [];
  for (const event of events) {
    const day =
      event.atMs === null
        ? "Sans date"
        : new Date(event.atMs).toLocaleDateString("fr-FR", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.events.push(event);
    else groups.push({ day, events: [event] });
  }
  return groups;
}
