import { describe, expect, it } from "vitest";
import { DSL_CONDITION_FIELDS, DSL_FUNCTIONS } from "./operations";

// This file is hand-maintained, kept in sync by eye with `core::adaptive`'s
// actual grammar/function table (see that module's doc comment for the
// authoritative source) — nothing here is generated or validated by the
// Rust side at build time. A duplicate/malformed entry wouldn't fail to
// compile, it would just render wrong in the Fleet/Snippets cheat-sheet.
// These tests catch the kind of mistake that's easy to introduce by
// copy-pasting a new row (duplicate name, missing label, stray whitespace)
// without needing to duplicate the grammar itself here.

describe("DSL_FUNCTIONS", () => {
  it("has no duplicate function names", () => {
    const names = DSL_FUNCTIONS.map((f) => f.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("every entry has a non-empty name and label", () => {
    for (const f of DSL_FUNCTIONS) {
      expect(f.name.trim()).toBe(f.name);
      expect(f.name.length).toBeGreaterThan(0);
      expect(f.label.length).toBeGreaterThan(0);
    }
  });

  it("function names are kebab-case (matches the DSL's actual syntax)", () => {
    for (const f of DSL_FUNCTIONS) {
      expect(f.name).toMatch(/^[a-z]+(-[a-z]+)*$/);
    }
  });

  it("args is either empty (no-argument function) or a single <placeholder>", () => {
    for (const f of DSL_FUNCTIONS) {
      expect(f.args === "" || /^<[a-z]+>$/.test(f.args)).toBe(true);
    }
  });
});

describe("DSL_CONDITION_FIELDS", () => {
  it("has no duplicate fields", () => {
    const fields = DSL_CONDITION_FIELDS.map((c) => c.field);
    expect(new Set(fields).size).toBe(fields.length);
  });

  it("every example actually starts with 'target <field>:', matching its own field", () => {
    for (const c of DSL_CONDITION_FIELDS) {
      expect(c.example.startsWith(`target ${c.field}:`)).toBe(true);
    }
  });

  it("covers exactly the seven condition fields the adaptive engine supports", () => {
    const fields = DSL_CONDITION_FIELDS.map((c) => c.field).sort();
    expect(fields).toEqual(["cpu", "load", "name", "os", "ram", "tag", "uptime"]);
  });
});
