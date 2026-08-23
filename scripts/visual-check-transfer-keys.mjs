// Contrôle de la sélection et du clavier dans un panneau de transfert.
//
// Même raison d'être que le contrôle du glisser-déposer, et même montage
// (la page de `visual-check-transfer-dnd.html`, qui monte deux vrais
// panneaux sans Tauri) : ce sont des interactions, elles se lisent très bien
// et ne marchent pas pour autant. Le point délicat est la cohabitation de
// deux gestes sur le même clic : un dossier s'ouvre au premier clic, mais
// Ctrl et Maj doivent sélectionner sans jamais ouvrir — sinon étendre une
// sélection à travers un dossier changerait de dossier en cours de route.
//
// Usage : node scripts/visual-check-transfer-keys.mjs
import { createServer } from "vite";
import { chromium } from "playwright";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir } from "node:fs/promises";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const outDir = path.join(scriptDir, ".output");

const server = await createServer({ root: projectRoot, server: { port: 4323, strictPort: true } });
await server.listen();

const browser = await chromium.launch();
const errors = [];
const check = (condition, message) => { if (!condition) errors.push(message); };

try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 520 } });
  const consoleErrors = [];
  page.on("console", (msg) => { if (msg.type() === "error") consoleErrors.push(msg.text()); });
  page.on("pageerror", (err) => consoleErrors.push(String(err)));

  await page.goto("http://localhost:4323/scripts/visual-check-transfer-dnd.html");
  await page.waitForSelector("[data-pane='left'] [data-pane-row]");
  await mkdir(outDir, { recursive: true });

  const pane = "[data-pane='left']";
  const row = (name) => `${pane} [data-row-name="${name}"]`;
  // Le listing du panneau gauche, dossiers d'abord : projet, notes.md, rapport.pdf.
  const selection = () =>
    page.$$eval(`${pane} [data-pane-row]`, (rows) =>
      rows.filter((r) => r.querySelector("input[type=checkbox]")?.checked).map((r) => r.dataset.rowName));
  const navigations = () => page.evaluate(() => window.__navigations);
  const resetNav = () => page.evaluate(() => { window.__navigations = []; });

  // 1. Un simple clic sélectionne cette ligne, et elle seule.
  await page.click(row("notes.md"));
  check(JSON.stringify(await selection()) === JSON.stringify(["notes.md"]), `clic simple : ${JSON.stringify(await selection())}`);

  // 2. Un dossier s'ouvre au premier clic.
  await resetNav();
  await page.click(row("projet"));
  const opened = await navigations();
  check(opened.some((n) => n.path.endsWith("projet")), `clic sur un dossier : ${JSON.stringify(opened)}`);

  // 3. Mais Ctrl+clic le sélectionne sans y entrer — sans quoi on ne pourrait
  //    plus archiver ni copier un dossier.
  await resetNav();
  await page.click(row("projet"), { modifiers: ["ControlOrMeta"] });
  check((await navigations()).length === 0, "Ctrl+clic sur un dossier ne doit pas l'ouvrir");
  check((await selection()).includes("projet"), `Ctrl+clic sélectionne : ${JSON.stringify(await selection())}`);

  // 4. Maj+clic étend depuis la dernière ligne cliquée, sans ouvrir non plus.
  await resetNav();
  await page.click(row("rapport.pdf"));
  await page.click(row("projet"), { modifiers: ["Shift"] });
  check((await navigations()).length === 0, "Maj+clic à travers un dossier ne doit pas l'ouvrir");
  await page.click(row("projet"), { modifiers: ["ControlOrMeta"] });
  await page.click(row("rapport.pdf"), { modifiers: ["Shift"] });
  check((await selection()).length === 3, `Maj+clic : ${JSON.stringify(await selection())}`);

  // 5. Ctrl+clic retire une ligne de la sélection sans toucher au reste.
  await page.click(row("notes.md"), { modifiers: ["ControlOrMeta"] });
  const afterCtrl = await selection();
  check(afterCtrl.length === 2 && !afterCtrl.includes("notes.md"), `Ctrl+clic : ${JSON.stringify(afterCtrl)}`);

  // 6. Ctrl+A prend tout, Échap ne garde rien.
  await page.click(row("notes.md"));
  await page.keyboard.press("ControlOrMeta+a");
  check((await selection()).length === 3, `Ctrl+A : ${JSON.stringify(await selection())}`);
  await page.keyboard.press("Escape");
  check((await selection()).length === 0, `Échap : ${JSON.stringify(await selection())}`);

  // 7. Les flèches déplacent la sélection d'une ligne, sans rien ouvrir.
  await resetNav();
  await page.click(row("projet"), { modifiers: ["ControlOrMeta"] });
  await page.keyboard.press("ArrowDown");
  check((await navigations()).length === 0, "les flèches ne doivent pas ouvrir de dossier");
  check(JSON.stringify(await selection()) === JSON.stringify(["notes.md"]), `flèche bas : ${JSON.stringify(await selection())}`);
  await page.keyboard.press("Shift+ArrowDown");
  check((await selection()).length === 2, `Maj+flèche étend : ${JSON.stringify(await selection())}`);

  // 8. Entrée ouvre la ligne courante ; Retour arrière remonte d'un dossier.
  await resetNav();
  await page.click(row("projet"), { modifiers: ["ControlOrMeta"] });
  await page.keyboard.press("Enter");
  await page.keyboard.press("Backspace");
  const keyNav = await navigations();
  check(keyNav.length === 2 && keyNav[0].path.endsWith("projet"), `Entrée puis Retour arrière : ${JSON.stringify(keyNav)}`);

  // 9. Le clic droit ouvre un menu, qui se referme à Échap.
  await page.click(row("notes.md"), { button: "right" });
  await page.waitForSelector("[data-context-menu]", { timeout: 2000 });
  await page.screenshot({ path: path.join(outDir, "transfer-context-menu.png") });
  await page.keyboard.press("Escape");
  check(await page.locator("[data-context-menu]").count() === 0, "le menu contextuel doit se refermer à Échap");

  if (consoleErrors.length > 0) errors.push(`erreurs console : ${consoleErrors.join(" | ")}`);
} finally {
  await browser.close();
  await server.close();
}

if (errors.length > 0) {
  console.error("ÉCHEC :\n" + errors.map((e) => ` - ${e}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log("OK : sélection (clic, Maj, Ctrl, Ctrl+A), flèches, Entrée, Retour arrière, Échap, menu contextuel.");
}
