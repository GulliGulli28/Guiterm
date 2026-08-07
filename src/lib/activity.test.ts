import { describe, expect, it } from "vitest";
import { ACTIVITY_KINDS, activityKindLabel, formatActivityTime, groupByDay } from "./activity";
import type { ActivityEvent, ActivityKind } from "./types";

// The hole these exist for is the same one MongoDB fell through: `tsc` rejects
// an *unhandled* union member, and nothing rejects one handled *wrongly*. The
// specific wrong handling here is dates — `atMs` is genuinely null for the
// commands migrated from the format that predated timestamps, and every
// natural way to render a date turns null into 1 January 1970: a plausible
// date, in an audit log, for something that happened last week.

function event(atMs: number | null, kind: ActivityKind = "command"): ActivityEvent {
  return { kind, atMs, summary: "ls -la", target: "web-01", hostIds: [], detail: "", failed: false };
}

describe("activityKindLabel", () => {
  it("names every kind", () => {
    // Iterating ACTIVITY_KINDS rather than listing them again: a kind added to
    // the union but forgotten in that array is caught by `tsc`, and one added
    // to the array without a label throws here.
    for (const kind of ACTIVITY_KINDS) {
      expect(activityKindLabel(kind)).toBeTruthy();
    }
    expect(ACTIVITY_KINDS).toHaveLength(3);
  });

  it("throws rather than inventing a label for an unknown kind", () => {
    expect(() => activityKindLabel("sacrifice" as ActivityKind)).toThrow();
  });
});

describe("formatActivityTime", () => {
  it("says the date is unknown instead of falling back to the epoch", () => {
    expect(formatActivityTime(null)).toBe("date inconnue");
    // The trap, spelled out: this is what the naive implementation produces.
    expect(new Date(null as unknown as number).getFullYear()).toBe(1970);
  });

  it("formats a real timestamp", () => {
    const formatted = formatActivityTime(Date.UTC(2026, 7, 7, 12, 0));
    expect(formatted).toContain("2026");
    expect(formatted).not.toBe("date inconnue");
  });
});

describe("groupByDay", () => {
  it("keeps the order it is given and starts a group per day", () => {
    // The backend sorts; this must not re-sort, or the two would disagree
    // about what "most recent first" means.
    //
    // Timestamps kept several days apart, and at midday: grouping is by
    // *local* date (which is what a user reads), so a UTC time near midnight
    // lands on a different day depending on the machine's zone. An earlier
    // version of this test used 23:00 UTC and passed only west of Greenwich.
    const events = [
      event(Date.UTC(2026, 7, 7, 12, 0)),
      event(Date.UTC(2026, 7, 7, 9, 0)),
      event(Date.UTC(2026, 7, 5, 12, 0)),
    ];

    const groups = groupByDay(events);

    expect(groups).toHaveLength(2);
    expect(groups[0].events).toHaveLength(2);
    expect(groups[1].events).toHaveLength(1);
  });

  it("puts dateless events in their own group rather than folding them into a day", () => {
    // A heading is the most visible place a false claim could be made: listing
    // a migrated command under "vendredi 7 août" states a date the entry
    // explicitly does not have.
    const groups = groupByDay([event(Date.UTC(2026, 7, 7, 10, 0)), event(null), event(null)]);

    expect(groups).toHaveLength(2);
    expect(groups[1].day).toBe("Sans date");
    expect(groups[1].events).toHaveLength(2);
  });

  it("returns nothing for no events", () => {
    expect(groupByDay([])).toEqual([]);
  });
});
