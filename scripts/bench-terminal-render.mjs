#!/usr/bin/env node
// Measures what the WebGL renderer actually buys on terminal throughput,
// instead of taking it on faith.
//
// Drives a real xterm.js in Chromium (no Tauri — this exercises rendering
// only, same approach as `visual-check-ghost-text.mjs`), pushing an identical
// styled payload through it once with the DOM renderer and once with the
// WebGL one, and reports both.
//
// **Read the numbers with this caveat.** Headless Chromium has no GPU: its
// WebGL runs on SwiftShader, in software. That understates the WebGL renderer
// compared to a real desktop with hardware acceleration — so treat the WebGL
// figure here as a floor, not an estimate. What the run does establish
// reliably is the DOM renderer's cost and the DOM-node count, neither of
// which depends on the GPU.
//
// Usage:
//   node scripts/bench-terminal-render.mjs [--lines 4000] [--runs 3] [--headed]
import { createServer } from "vite";
import { chromium } from "playwright";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");

const args = process.argv.slice(2);
const readFlag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : Number(args[i + 1]);
};
const lines = readFlag("lines", 4000);
const runs = readFlag("runs", 3);
// Lines per write, each followed by a frame — see `runBench`'s doc comment for
// why this, not the total, decides what is being measured. 40 ≈ a screenful,
// i.e. roughly what a scrolling command emits between two repaints.
const chunkLines = readFlag("chunk", 40);
const headed = args.includes("--headed");

const server = await createServer({
  root: projectRoot,
  server: { port: 4321, strictPort: true },
  logLevel: "warn",
});
await server.listen();

const browser = await chromium.launch({ headless: !headed });
const results = { dom: [], webgl: [] };
let domNodes = { dom: 0, webgl: 0 };
let glRenderer = "inconnu";
let frames = 0;

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });

  await page.goto("http://localhost:4321/scripts/bench/terminal-render.html", { waitUntil: "load" });
  await page.waitForFunction(() => typeof window.runBench === "function", { timeout: 15_000 });

  // Report which GL backend actually answered, because it decides whether the
  // WebGL figure below means anything. On this WSL machine both headless and
  // headed Chromium resolve to SwiftShader (pure software), where WebGL is
  // *expected* to lose to the DOM renderer — a result that says nothing about
  // a user's machine running WebView2 on a real GPU.
  glRenderer = await page.evaluate(() => {
    const gl = document.createElement("canvas").getContext("webgl2");
    if (!gl) return "aucun contexte WebGL2";
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    return ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : "inconnu";
  });

  // Alternate the two renderers rather than running all of one then all of
  // the other, so a warming/throttling drift in the browser hits both equally.
  for (let i = 0; i < runs; i++) {
    for (const webgl of [false, true]) {
      const r = await page.evaluate((opts) => window.runBench(opts), { webgl, lines, chunkLines });
      results[r.renderer].push(r.ms);
      domNodes[r.renderer] = r.domNodes;
      frames = r.frames;
      // A fresh page per measurement would be cleaner still, but xterm is torn
      // down and rebuilt inside runBench; this just yields between runs.
      await page.waitForTimeout(150);
    }
  }

  if (errors.length > 0) {
    console.error("Erreurs de page :", errors.slice(0, 5));
  }
} finally {
  await browser.close();
  await server.close();
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

const domMs = median(results.dom);
const webglMs = median(results.webgl);

const software = /swiftshader|llvmpipe|softwarerasterizer/i.test(glRenderer);

console.log(`\nCharge : ${lines} lignes stylées en ${frames} écritures (${chunkLines}/frame), ${runs} exécutions par moteur`);
console.log(`Chromium : ${headed ? "avec fenêtre" : "headless"}`);
console.log(`Backend GL : ${glRenderer}\n`);
console.log(`  Rendu DOM    ${domMs.toFixed(0).padStart(6)} ms   ${domNodes.dom} nœuds DOM`);
console.log(`  Rendu WebGL  ${webglMs.toFixed(0).padStart(6)} ms   ${domNodes.webgl} nœuds DOM`);

const ratio = domMs / webglMs;
if (ratio >= 1.05) {
  console.log(`\n  → WebGL ${ratio.toFixed(2)}× plus rapide`);
} else if (ratio <= 0.95) {
  console.log(`\n  → WebGL ${(1 / ratio).toFixed(2)}× plus lent`);
} else {
  console.log("\n  → écart non significatif");
}

if (software) {
  console.log(
    "\n  ATTENTION : le backend GL est logiciel (pas de GPU). Le chiffre WebGL\n" +
      "  ci-dessus ne dit rien de ce que verra un utilisateur sous WebView2 avec\n" +
      "  une carte graphique — il ne peut servir qu'à établir le coût du rendu\n" +
      "  DOM et le nombre de nœuds, qui eux ne dépendent pas du GPU.",
  );
}
