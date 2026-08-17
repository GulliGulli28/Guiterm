import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CORE_COMMAND_DOMAINS, MODULES } from "../modules/registry";

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
  // Non-greedy up to the first `>(` rather than "anything but `>`": a return
  // type with a generic of its own (`Record<string, string>`) contains `>`,
  // and the stricter form skipped the whole binding — reporting the Rust
  // command as unreachable when it was wired perfectly well. A guard that
  // cries wolf gets disabled, so its blind spots matter as much as its
  // catches.
  for (const m of source.matchAll(/invoke<[\s\S]*?>\(\s*"([a-z0-9_]+)"/g)) names.add(m[1]);
  for (const m of source.matchAll(/writeBytes\(\s*"([a-z0-9_]+)"/g)) names.add(m[1]);
  return names;
}

/** Command names registered in `tauri::generate_handler![...]`, which is the
 * only thing that actually makes a `#[tauri::command]` reachable. */
function handlerBlock(): string {
  const source = read("../../src-tauri/src/main.rs");
  const start = source.indexOf("generate_handler![");
  if (start === -1) throw new Error("generate_handler! introuvable dans src-tauri/src/main.rs");
  return source.slice(start, source.indexOf("])", start));
}

function registeredCommands(): Set<string> {
  return new Set([...handlerBlock().matchAll(/commands::[a-z0-9_]+::([a-z0-9_]+)/g)].map((m) => m[1]));
}

/** Les domaines (`commands::<domaine>::…`), c'est-à-dire un fichier de
 * `src-tauri/src/commands/`. */
function registeredDomains(): Set<string> {
  return new Set([...handlerBlock().matchAll(/commands::([a-z0-9_]+)::/g)].map((m) => m[1]));
}

describe("propriété des commandes", () => {
  // Le pendant backend du registre de modules. Côté frontend, `tsc` empêche
  // déjà un onglet ou un panneau d'exister sans module ; côté Rust rien
  // n'empêchait un domaine de commandes d'apparaître sans que personne ne le
  // possède. C'est pourtant la question à laquelle il faut savoir répondre
  // pour extraire un module en sidecar (étape 3) : quelles commandes partent
  // avec lui.
  const claimed = new Map<string, string>();
  for (const m of MODULES) {
    for (const domain of m.commandDomains ?? []) {
      const previous = claimed.get(domain);
      if (previous) throw new Error(`le domaine « ${domain} » est revendiqué par « ${previous} » et « ${m.id} »`);
      claimed.set(domain, m.id);
    }
  }

  it("attribue chaque domaine de commandes à un module ou au noyau", () => {
    const orphans = [...registeredDomains()]
      .filter((d) => !claimed.has(d) && !CORE_COMMAND_DOMAINS.includes(d))
      .sort();
    expect(orphans, `domaines enregistrés dans main.rs que personne ne possède : ${orphans.join(", ")}`).toEqual([]);
  });

  it("ne revendique pas de domaine qui n'existe plus côté Rust", () => {
    const registered = registeredDomains();
    const stale = [...claimed.keys(), ...CORE_COMMAND_DOMAINS].filter((d) => !registered.has(d)).sort();
    expect(stale, `domaines revendiqués mais absents de main.rs : ${stale.join(", ")}`).toEqual([]);
  });

  it("ne fait pas revendiquer un domaine à la fois par un module et par le noyau", () => {
    const both = CORE_COMMAND_DOMAINS.filter((d) => claimed.has(d)).sort();
    expect(both, `domaines à la fois noyau et module : ${both.join(", ")}`).toEqual([]);
  });

  it("n'est pas vide — sinon les trois contrôles ci-dessus passeraient à vide", () => {
    expect(registeredDomains().size).toBeGreaterThan(25);
    expect(claimed.size).toBeGreaterThan(20);
  });
});

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
