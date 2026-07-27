import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Every frontend feature reaches Rust through a command *name* in a string
// literal. Nothing checks those strings: `tsc` sees an opaque string, Rust
// sees an unused handler, and a rename, a typo or a command dropped from
// `generate_handler!` only surfaces when a user clicks the thing and gets
// "command not found" — the same frontend↔backend wiring gap that shipped
// MongoDB unreachable, one layer down. Comparing the two lists is cheap and
// catches it at `npm run test` instead.
//
// Static on purpose: proving a command exists at runtime would mean invoking
// it, and this repo's tests run against the developer's real profile
// (workspace, keychain), so probing 100+ commands is exactly the kind of
// side effect the E2E suite deliberately avoids.

const read = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

/** Command names the frontend invokes: `invoke<T>("name"` plus the raw-body
 * helper `writeBytes("name"` used for terminal keystrokes. */
function invokedCommands(): Set<string> {
  const source = read("./api.ts");
  const names = new Set<string>();
  for (const m of source.matchAll(/invoke<[^>]*>\(\s*"([a-z0-9_]+)"/g)) names.add(m[1]);
  for (const m of source.matchAll(/writeBytes\(\s*"([a-z0-9_]+)"/g)) names.add(m[1]);
  return names;
}

/** Command names registered in `tauri::generate_handler![...]`, which is the
 * only thing that actually makes a `#[tauri::command]` reachable. */
function registeredCommands(): Set<string> {
  const source = read("../../src-tauri/src/main.rs");
  const start = source.indexOf("generate_handler![");
  if (start === -1) throw new Error("generate_handler! introuvable dans src-tauri/src/main.rs");
  const block = source.slice(start, source.indexOf("])", start));
  return new Set([...block.matchAll(/commands::[a-z0-9_]+::([a-z0-9_]+)/g)].map((m) => m[1]));
}

describe("commandes Tauri", () => {
  // A regex that silently stops matching would make every assertion below
  // pass against empty sets — the vacuous green this whole file exists to
  // prevent. Pin a floor on both sides first.
  it("extrait bien les deux listes", () => {
    expect(invokedCommands().size).toBeGreaterThan(80);
    expect(registeredCommands().size).toBeGreaterThan(80);
  });

  it("n'invoque que des commandes réellement enregistrées côté Rust", () => {
    const registered = registeredCommands();
    const missing = [...invokedCommands()].filter((name) => !registered.has(name)).sort();
    expect(missing, `commandes invoquées depuis api.ts mais absentes de generate_handler! : ${missing.join(", ")}`).toEqual([]);
  });

  // The other direction: a command registered in Rust that no binding calls is
  // backend work the user cannot reach — the smell that MongoDB turned out to
  // be, one layer down. If this fails because a command is genuinely staged
  // ahead of its UI, add its `api.ts` binding (cheap, and makes the intent
  // explicit) rather than relaxing the test.
  it("n'enregistre pas de commande que le frontend n'atteint jamais", () => {
    const invoked = invokedCommands();
    const unreachable = [...registeredCommands()].filter((name) => !invoked.has(name)).sort();
    expect(unreachable, `commandes Rust qu'aucun binding api.ts n'appelle : ${unreachable.join(", ")}`).toEqual([]);
  });

  // `CLAUDE.md` states api.ts is the single frontend→Tauri passage point. That
  // is what makes the two checks above complete: a component importing
  // `invoke` directly would be invisible to them, so the lists could agree
  // while a real call bypassed both.
  it("garde api.ts comme unique point de passage vers Tauri", () => {
    const srcDir = fileURLToPath(new URL("..", import.meta.url));
    const offenders = readdirSync(srcDir, { recursive: true, encoding: "utf8" })
      // api.ts is the sanctioned importer; test files name the module only to
      // talk about it, as this very line does.
      .filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f) && f !== path.join("lib", "api.ts"))
      .filter((f) => readFileSync(path.join(srcDir, f), "utf8").includes("@tauri-apps/api/core"));
    expect(offenders, `ces fichiers importent @tauri-apps/api/core au lieu de passer par api.ts : ${offenders.join(", ")}`).toEqual([]);
  });
});
