import { describe, expect, it } from "vitest";
import { RedisTabLazy, SqlConnectionTab, SqlTabLazy } from "./SqlConnectionTab";
import { UnavailableEngineTab } from "./UnavailableEngineTab";
import type { SqlConnection, SqlEngine } from "../lib/types";

// This is the test that was missing when MongoDB shipped unreachable: the
// backend, the Tauri commands, the api.ts bindings and the types were all
// complete and green, but `App.tsx` routed every non-Redis engine to `SqlTab`,
// so opening a MongoDB connection reported a connection failure. `tsc` now
// rejects an unhandled engine (see `lib/exhaustive.ts`); this pins the
// mapping itself, which no type can express — "handled" is not "handled
// *correctly*", and routing mongodb to `SqlTab` would type-check fine.
//
// The component is called as a plain function and its result inspected,
// rather than mounted: mounting would resolve the lazy chunks and immediately
// `invoke(...)` against a Tauri bridge that doesn't exist under vitest. What
// matters here is which component the engine selects, which is exactly what
// the returned element's `type` says.

/** A saved connection of the given engine, with only the fields that engine's
 * variant requires — the union makes anything else a type error. */
function connectionFor(engine: SqlEngine): SqlConnection {
  const common = { id: "c1", label: "test", tags: [] as string[] };
  const server = { address: "127.0.0.1", port: 5432, username: "u" };
  switch (engine) {
    case "mysql":
      return { ...common, engine: "mysql", ...server };
    case "postgres":
      return { ...common, engine: "postgres", ...server };
    case "redis":
      return { ...common, engine: "redis", ...server };
    case "sqlite":
      return { ...common, engine: "sqlite", path: "/tmp/t.sqlite" };
    case "mongodb":
      return { ...common, engine: "mongodb", connectionString: "mongodb://127.0.0.1:27017", username: "" };
  }
}

function componentFor(engine: SqlEngine): unknown {
  const element = SqlConnectionTab({
    connection: connectionFor(engine),
    hosts: [],
    onError: () => {},
  });
  return (element as { type: unknown }).type;
}

describe("SqlConnectionTab", () => {
  it("routes the three SQL engines to the SQL tab", () => {
    expect(componentFor("mysql")).toBe(SqlTabLazy);
    expect(componentFor("postgres")).toBe(SqlTabLazy);
    expect(componentFor("sqlite")).toBe(SqlTabLazy);
  });

  it("routes Redis to its own tab, not the SQL tab", () => {
    expect(componentFor("redis")).toBe(RedisTabLazy);
  });

  // Regression guard for the shipped bug. Update this to expect `MongoTab`
  // when it is written — do not delete it: falling back to `SqlTab` is what
  // made MongoDB look like a broken server rather than a missing screen.
  it("does not route MongoDB to the SQL tab while its own tab is unwritten", () => {
    expect(componentFor("mongodb")).not.toBe(SqlTabLazy);
    expect(componentFor("mongodb")).toBe(UnavailableEngineTab);
  });

  it("gives every engine a component, so none can reach a connection it cannot render", () => {
    const engines: SqlEngine[] = ["mysql", "postgres", "sqlite", "redis", "mongodb"];
    for (const engine of engines) {
      expect(componentFor(engine), `moteur ${engine}`).toBeTruthy();
    }
  });
});
