#!/usr/bin/env node
// Runs every check the CI runs, in the same order, from one command.
//
// Why this exists: the checks live in two toolchains (Node and Cargo) and six
// separate commands, so "did I run them all?" was answered from memory. That
// is how a broken `npm run lint` went unnoticed — it was simply never part of
// anyone's habit. One command with one summary makes a skipped step visible.
//
// Runs everything even when a step fails (rather than stopping at the first),
// so one pass gives the full picture instead of one problem at a time. Exits
// non-zero if any step failed.
//
// Usage:
//   npm run verify           # everything except E2E (~2-4 min)
//   npm run verify -- --e2e  # also drives the real window via WebDriver
//   npm run verify -- --fast # type-check and lint only, no test suites
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const withE2e = args.includes("--e2e");
const fast = args.includes("--fast");

/** ANSI colours, skipped when the output isn't a terminal (CI logs, pipes). */
const useColour = process.stdout.isTTY;
const paint = (code, text) => (useColour ? `[${code}m${text}[0m` : text);
const bold = (t) => paint("1", t);
const green = (t) => paint("32", t);
const red = (t) => paint("31", t);
const grey = (t) => paint("90", t);

/** Every check, in CI order: cheapest and most likely to fail first, so a
 * typo surfaces in seconds rather than after the Rust test suite. */
const steps = [
  { name: "tsc", label: "Types TypeScript", cmd: "npx", args: ["tsc", "-b"], skipWhenFast: false },
  { name: "eslint", label: "ESLint", cmd: "npm", args: ["run", "lint"], skipWhenFast: false },
  { name: "vitest", label: "Tests frontend", cmd: "npm", args: ["run", "test"], skipWhenFast: true },
  {
    name: "clippy",
    label: "Clippy (workspace) — gate CI bloquant",
    cmd: "cargo",
    args: ["clippy", "--workspace", "--all-targets", "--", "-D", "warnings"],
    skipWhenFast: false,
  },
  {
    name: "clippy-sidecar",
    // rdp-sidecar is a separate Cargo workspace, so `--workspace` above never
    // reaches it — see CLAUDE.md's "Pourquoi un processus RDP séparé".
    label: "Clippy (rdp-sidecar)",
    cmd: "cargo",
    args: ["clippy", "--all-targets", "--", "-D", "warnings"],
    cwd: path.join(repoRoot, "rdp-sidecar"),
    skipWhenFast: false,
  },
  {
    name: "cargo-test",
    label: "Tests Rust (dont intégration sur un vrai sshd)",
    cmd: "cargo",
    args: ["test", "--workspace", "--all-targets"],
    skipWhenFast: true,
  },
];

if (withE2e) {
  steps.push({
    name: "e2e",
    label: "E2E (vraie fenêtre pilotée par WebDriver)",
    cmd: "node",
    args: [path.join(repoRoot, "scripts", "e2e-run.mjs")],
    skipWhenFast: true,
  });
}

function run(step) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(step.cmd, step.args, {
      cwd: step.cwd ?? repoRoot,
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    child.on("error", (e) => resolve({ ok: false, seconds: 0, detail: e.message }));
    child.on("close", (code) =>
      resolve({ ok: code === 0, seconds: (Date.now() - started) / 1000, detail: `code ${code}` }),
    );
  });
}

const results = [];
for (const step of steps) {
  if (fast && step.skipWhenFast) {
    results.push({ step, skipped: true });
    continue;
  }
  console.log(`\n${bold(`▶ ${step.label}`)}`);
  const result = await run(step);
  results.push({ step, ...result });
}

console.log(`\n${bold("── Récapitulatif ──")}`);
for (const r of results) {
  if (r.skipped) {
    console.log(`${grey("⊘")} ${r.step.label} ${grey("(ignoré : --fast)")}`);
    continue;
  }
  const mark = r.ok ? green("✔") : red("✘");
  console.log(`${mark} ${r.step.label} ${grey(`${r.seconds.toFixed(1)}s`)}`);
}

const failed = results.filter((r) => !r.skipped && !r.ok);
if (failed.length > 0) {
  console.log(`\n${red(`${failed.length} étape(s) en échec.`)}`);
  process.exit(1);
}

if (!withE2e) {
  console.log(
    `\n${green("Tout est vert.")} ${grey("E2E non exécuté — `npm run verify -- --e2e` pour piloter la vraie fenêtre.")}`,
  );
} else {
  console.log(`\n${green("Tout est vert, E2E compris.")}`);
}
