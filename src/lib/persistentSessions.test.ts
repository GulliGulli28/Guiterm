import { describe, expect, it } from "vitest";
import { describeSession } from "./persistentSessions";
import type { RunningSession } from "./types";

function session(extra: Partial<RunningSession> = {}): RunningSession {
  return { key: "guiterm-abc", createdAtMs: Date.now(), windows: 1, attached: 0, width: 120, height: 30, ...extra };
}

describe("describeSession", () => {
  it("distingue une session que personne ne regarde d'une session ouverte ailleurs", () => {
    expect(describeSession(session({ attached: 0 })).meta).toContain("détachée");
    expect(describeSession(session({ attached: 1 })).meta).toContain("ouverte ailleurs");
  });

  // Ce que la ligne dit décide de ce qu'on ose terminer : « détachée » veut
  // dire que la fermer ne coupe personne, « ouverte ailleurs » que si.
  it("compte les clients attachés", () => {
    expect(describeSession(session({ attached: 2 })).meta).toContain("2 clients");
    expect(describeSession(session({ attached: 1 })).meta).toContain("1 client");
    expect(describeSession(session({ attached: 1 })).meta).not.toContain("1 clients");
  });

  it("accorde le pluriel des fenêtres", () => {
    expect(describeSession(session({ windows: 1 })).meta).toContain("1 fenêtre ");
    expect(describeSession(session({ windows: 3 })).meta).toContain("3 fenêtres");
  });

  // `null` veut dire « tmux ne l'a pas dit » — une vieille version, un champ de
  // format inconnu. Le traiter comme un instant daté afficherait « 01/01/1970 »
  // et ferait passer une session de ce matin pour une relique.
  it("ne date pas une session dont tmux n'a pas donné la date", () => {
    const described = describeSession(session({ createdAtMs: null }));
    expect(described.name).toBe("Session en cours");
    expect(described.name).not.toContain("1970");
  });

  it("date les autres relativement", () => {
    const twoHoursAgo = Date.now() - 2 * 3600 * 1000;
    expect(describeSession(session({ createdAtMs: twoHoursAgo })).name).toBe("Session ouverte il y a 2 h");
  });
});
