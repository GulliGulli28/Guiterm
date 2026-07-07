// Headless visual/DOM check for the ghost-text overlay positioning technique
// used in LocalTerminalTab.tsx. Mounts a real xterm.js terminal (no Tauri
// needed — this only exercises rendering, not PTY/invoke() plumbing) and
// verifies the `.xterm-rows`-based cell-geometry math lines up with where
// xterm actually draws the cursor. Produces a PNG for visual inspection.
//
// Usage: node scripts/visual-check-ghost-text.mjs
import { createServer } from "vite";
import { chromium } from "playwright";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir } from "node:fs/promises";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const outDir = path.join(scriptDir, ".output");

const server = await createServer({ root: projectRoot, server: { port: 4319, strictPort: true } });
await server.listen();

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 700, height: 260 } });
  const consoleErrors = [];
  page.on("console", (msg) => { if (msg.type() === "error") consoleErrors.push(msg.text()); });
  page.on("pageerror", (err) => consoleErrors.push(String(err)));

  await page.goto("http://localhost:4319/scripts/visual-check-ghost-text.html");
  await page.waitForFunction(() => window.__ghostReady === true, { timeout: 5000 });
  const metrics = await page.evaluate(() => window.__ghostMetrics);

  await mkdir(outDir, { recursive: true });
  const screenshotPath = path.join(outDir, "ghost-text-check.png");
  await page.screenshot({ path: screenshotPath });

  console.log("metrics:", metrics);
  console.log("screenshot:", screenshotPath);

  const errors = [];
  if (consoleErrors.length > 0) errors.push(`console errors: ${consoleErrors.join(" | ")}`);
  if (!metrics) errors.push("window.__ghostMetrics was never set (`.xterm-rows` not found?)");
  else {
    if (!(metrics.cellWidth > 5 && metrics.cellWidth < 20)) errors.push(`cellWidth out of expected range: ${metrics.cellWidth}`);
    if (!(metrics.cellHeight > 10 && metrics.cellHeight < 30)) errors.push(`cellHeight out of expected range: ${metrics.cellHeight}`);
    // "user@host:~$ git s" is 18 characters — the cursor (and the ghost text) should sit right after it.
    if (metrics.cursorX !== 18) errors.push(`expected cursorX === 18 (end of "user@host:~$ git s"), got ${metrics.cursorX}`);
  }

  if (errors.length > 0) {
    console.error("FAIL:\n" + errors.map((e) => ` - ${e}`).join("\n"));
    process.exitCode = 1;
  } else {
    console.log("PASS: cell geometry and cursor position match expectations. Inspect the screenshot to confirm the ghost text visually lines up after \"git s\".");
  }
} finally {
  await browser.close();
  await server.close();
}
