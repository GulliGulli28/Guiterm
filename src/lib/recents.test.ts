import { describe, expect, it } from "vitest";
import { forgetSession, MAX_RECENTS, pruneRecents, recordRecent, type RecentEntry } from "./recents";

const term = (hostId: string, at: number, extra: Partial<RecentEntry> = {}): RecentEntry =>
  ({ kind: "terminal", hostId, at, ...extra }) as RecentEntry;

describe("recordRecent", () => {
  it("met la dernière connexion en tête, sans doublon", () => {
    const list = recordRecent([term("a", 1), term("b", 2)], term("a", 3));
    expect(list.map((e) => [e.kind === "database" ? e.connectionId : e.hostId, e.at])).toEqual([["a", 3], ["b", 2]]);
  });

  it("distingue un conteneur de son hôte", () => {
    const list = recordRecent([term("a", 1)], term("a", 2, { dockerContainerId: "c1" }));
    expect(list).toHaveLength(2);
  });

  it("ne confond pas un bureau à distance et un terminal du même hôte", () => {
    const list = recordRecent([term("a", 1)], { kind: "rdp", hostId: "a", at: 2 });
    expect(list).toHaveLength(2);
  });

  it("garde la session tmux retenue quand un shell ordinaire rouvre la même cible", () => {
    const list = recordRecent([term("a", 1, { sessionKey: "guiterm-x" })], term("a", 2));
    expect(list[0].sessionKey).toBe("guiterm-x");
  });

  it("borne la liste", () => {
    let list: RecentEntry[] = [];
    for (let i = 0; i < MAX_RECENTS + 5; i++) list = recordRecent(list, term(`h${i}`, i));
    expect(list).toHaveLength(MAX_RECENTS);
    expect(list[0].kind === "terminal" && list[0].hostId).toBe(`h${MAX_RECENTS + 4}`);
  });
});

describe("forgetSession / pruneRecents", () => {
  it("oublie la session sans oublier la cible", () => {
    const list = forgetSession([term("a", 1, { sessionKey: "guiterm-x" })], "guiterm-x");
    expect(list).toEqual([term("a", 1)]);
  });

  it("retire les hôtes et connexions supprimés", () => {
    const list = pruneRecents(
      [term("a", 1), term("gone", 2), { kind: "database", connectionId: "db", at: 3 }, { kind: "database", connectionId: "old", at: 4 }],
      new Set(["a"]), new Set(["db"]),
    );
    expect(list).toHaveLength(2);
  });
});
