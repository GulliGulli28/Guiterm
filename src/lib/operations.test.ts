import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DSL_CONDITION_FIELDS, DSL_FUNCTIONS } from "./operations";

// This file is hand-maintained, kept in sync with `core::adaptive`'s actual
// grammar/function table (see that module's doc comment for the authoritative
// source) — nothing here is generated or validated by the Rust side at build
// time. A duplicate/malformed entry wouldn't fail to compile, it would just
// render wrong in the Fleet/Snippets cheat-sheet. These tests catch the kind of
// mistake that's easy to introduce by copy-pasting a new row (duplicate name,
// missing label, stray whitespace).
//
// The field list is checked against the Rust parser itself rather than against
// a list written twice: a condition field added to the DSL and not to this
// cheat-sheet is invisible — the parser accepts it, the UI never mentions it,
// and the AI that writes DSL text from a French instruction keeps producing
// the old grammar because that is what it is shown.

const read = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

/** The condition fields `adaptive::parse_condition` actually accepts, read
 * from its `match` arms — the authority, since it is what rejects everything
 * else. Synonyms count: several literals can share one arm
 * (`"profile" | "account" =>`). */
function parsedConditionFields(): Set<string> {
  const source = read("../../core/src/adaptive.rs");
  const start = source.indexOf("fn parse_condition(");
  if (start === -1) throw new Error("parse_condition introuvable dans core/src/adaptive.rs");
  const block = source.slice(start, source.indexOf("\n}", start));
  const fields = new Set<string>();
  for (const arm of block.matchAll(/^\s*((?:"[a-z]+"\s*\|\s*)*"[a-z]+")\s*=>/gm)) {
    for (const literal of arm[1].matchAll(/"([a-z]+)"/g)) fields.add(literal[1]);
  }
  return fields;
}

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

  // Guards against the vacuous green this whole check exists to prevent: a
  // regex that stops matching would make the comparison below pass against an
  // empty set.
  it("lit bien les champs du parseur Rust", () => {
    const parsed = parsedConditionFields();
    expect(parsed.size).toBeGreaterThanOrEqual(8);
    expect(parsed).toContain("os");
    expect(parsed).toContain("profile");
  });

  it("présente chaque champ que le parseur accepte, et aucun autre", () => {
    const parsed = parsedConditionFields();
    const shown = new Set(DSL_CONDITION_FIELDS.map((c) => c.field));
    // Synonyms need no row of their own — `account` is documented inside the
    // `profile` row rather than as a second entry that looks like a second
    // field. What must not happen is a field nobody can discover.
    const undocumented = [...parsed].filter((field) => !shown.has(field) && !SYNONYMS.has(field)).sort();
    expect(undocumented, `champs acceptés par le parseur mais absents de l'aide : ${undocumented.join(", ")}`).toEqual([]);

    const invented = [...shown].filter((field) => !parsed.has(field)).sort();
    expect(invented, `champs présentés à l'utilisateur mais refusés par le parseur : ${invented.join(", ")}`).toEqual([]);
  });
});

/** Accepted by the parser, deliberately folded into another field's row. */
const SYNONYMS = new Set(["account"]);
