import { describe, expect, it } from "vitest";
import type { GroupId } from "./types";
import { HOST_TREE_MEMORY_KEY, pruneCollapsed, readHostTreeMemory, writeHostTreeMemory } from "./hostTreeState";

function fakeStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    dump: () => Object.fromEntries(store),
  };
}

describe("mémoire de l'arborescence d'hôtes", () => {
  it("rend ce qu'on lui a écrit", () => {
    const storage = fakeStorage();
    writeHostTreeMemory({ collapsed: ["g-a" as GroupId, "g-b" as GroupId], scroll: { hosts: 120, sftp: 0 } }, storage);
    expect(readHostTreeMemory(storage)).toEqual({ collapsed: ["g-a", "g-b"], scroll: { hosts: 120, sftp: 0 } });
  });

  it("vaut vide quand rien n'est enregistré", () => {
    expect(readHostTreeMemory(fakeStorage())).toEqual({ collapsed: [], scroll: {} });
  });

  it("tolère du JSON cassé ou d'une autre forme, sans lever", () => {
    expect(readHostTreeMemory(fakeStorage({ [HOST_TREE_MEMORY_KEY]: "{oops" }))).toEqual({ collapsed: [], scroll: {} });
    expect(readHostTreeMemory(fakeStorage({ [HOST_TREE_MEMORY_KEY]: "[1,2]" }))).toEqual({ collapsed: [], scroll: {} });
    expect(readHostTreeMemory(fakeStorage({ [HOST_TREE_MEMORY_KEY]: JSON.stringify({ collapsed: [1, "g" ], scroll: { hosts: "x", sftp: -4, ok: 12 } }) })))
      .toEqual({ collapsed: ["g"], scroll: { ok: 12 } });
  });

  it("oublie les dossiers qui n'existent plus", () => {
    expect(pruneCollapsed(["a", "b", "c"] as GroupId[], ["b"] as GroupId[])).toEqual(["b"]);
  });
});
