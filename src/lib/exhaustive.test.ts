import { describe, expect, it } from "vitest";
import { assertNever } from "./exhaustive";
import type { SqlEngine } from "./types";

// The compile-time half of `assertNever` is what actually matters, and it is
// verified by `tsc` on every build rather than here: these tests only cover
// the runtime last-resort branch, plus one guard that the union it protects
// still lists every engine the backend can send.
describe("assertNever", () => {
  it("throws naming the context and the offending value", () => {
    // Only reachable by bypassing the type system, which is exactly what a
    // caller does here to exercise it.
    const rogue = "cassandra" as unknown as never;
    expect(() => assertNever(rogue, "moteur de base de données")).toThrow(
      /moteur de base de données : cas non géré — "cassandra"/,
    );
  });

  it("serializes an object value rather than printing [object Object]", () => {
    const rogue = { engine: "cassandra" } as unknown as never;
    expect(() => assertNever(rogue, "connexion")).toThrow(/\{"engine":"cassandra"\}/);
  });
});

describe("SqlEngine", () => {
  // A change to `SqlEngine` is what triggers the `tsc` failures `assertNever`
  // exists to produce, so pin the set here too: adding an engine should be a
  // deliberate act that updates this list *and* every dispatch, not a silent
  // widening. Mirrors `termius_core::model::SqlEngine`.
  it("lists exactly the engines the app knows how to dispatch", () => {
    const engines: Record<SqlEngine, true> = {
      mysql: true,
      postgres: true,
      sqlite: true,
      redis: true,
      mongodb: true,
    };
    expect(Object.keys(engines).sort()).toEqual(["mongodb", "mysql", "postgres", "redis", "sqlite"]);
  });
});
