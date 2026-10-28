import { describe, expect, it } from "vitest";
import { decayedScore, frequentSnippets, HALF_LIFE_MS, pruneSnippetUsage, recordSnippetUse, type SnippetUsage } from "./snippetUsage";
import type { Snippet } from "./types";

const snippet = (id: string): Snippet => ({ id, name: id, command: `echo ${id}`, tags: [] });
const DAY = 86_400_000;

describe("recordSnippetUse", () => {
  it("compte chaque exécution", () => {
    let usage: SnippetUsage = {};
    usage = recordSnippetUse(usage, "a", 0);
    usage = recordSnippetUse(usage, "a", 1);
    expect(usage.a?.count).toBe(2);
    expect(usage.a?.at).toBe(1);
  });

  it("amortit le score : la moitié au bout d'une demi-vie", () => {
    const usage = recordSnippetUse({}, "a", 0);
    expect(decayedScore(usage.a!, HALF_LIFE_MS)).toBeCloseTo(0.5);
  });
});

describe("frequentSnippets", () => {
  it("classe par usage, et ignore ce qui n'a jamais servi", () => {
    let usage: SnippetUsage = {};
    for (let i = 0; i < 3; i++) usage = recordSnippetUse(usage, "b", i);
    usage = recordSnippetUse(usage, "a", 10);
    const top = frequentSnippets(usage, [snippet("a"), snippet("b"), snippet("c")], 20, 5);
    expect(top.map((t) => t.snippet.id)).toEqual(["b", "a"]);
  });

  it("laisse passer devant un snippet récent un ancien favori oublié", () => {
    let usage: SnippetUsage = {};
    for (let i = 0; i < 5; i++) usage = recordSnippetUse(usage, "vieux", i);
    const now = 60 * DAY;
    usage = recordSnippetUse(usage, "neuf", now);
    usage = recordSnippetUse(usage, "neuf", now);
    const top = frequentSnippets(usage, [snippet("vieux"), snippet("neuf")], now, 5);
    expect(top[0].snippet.id).toBe("neuf");
  });

  it("ne montre pas un snippet supprimé, et borne la liste", () => {
    let usage: SnippetUsage = {};
    for (const id of ["a", "b", "c", "gone"]) usage = recordSnippetUse(usage, id, 0);
    const top = frequentSnippets(usage, [snippet("a"), snippet("b"), snippet("c")], 0, 2);
    expect(top).toHaveLength(2);
    expect(top.some((t) => t.snippet.id === "gone")).toBe(false);
  });
});

describe("pruneSnippetUsage", () => {
  it("oublie les snippets supprimés et rend la même référence sinon", () => {
    const usage = recordSnippetUse(recordSnippetUse({}, "a", 0), "b", 0);
    expect(Object.keys(pruneSnippetUsage(usage, new Set(["a"])))).toEqual(["a"]);
    expect(pruneSnippetUsage(usage, new Set(["a", "b"]))).toBe(usage);
  });
});
