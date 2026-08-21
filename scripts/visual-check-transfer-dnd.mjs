// Contrôle du glisser-déposer entre les deux panneaux d'un onglet de transfert.
//
// Pourquoi un vrai navigateur : c'est un geste. Le code se lit très bien et ne
// marche pas pour autant — et c'est précisément ce qui s'était passé, le drag
// interne n'ayant jamais fonctionné (API HTML5 neutralisée par le
// glisser-déposer OS de Tauri, voir `usePaneDrag`). Playwright presse, déplace
// et relâche vraiment la souris ; on vérifie ce que le hook en conclut.
//
// Chromium, pas WebView2 : ce qui est testé ici est du `mousedown`/`mousemove`/
// `mouseup` + `elementFromPoint`, identique dans les deux. Le lancement du
// binaire Windows reste la vérification finale.
//
// Usage : node scripts/visual-check-transfer-dnd.mjs
import { createServer } from "vite";
import { chromium } from "playwright";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir } from "node:fs/promises";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const outDir = path.join(scriptDir, ".output");

const server = await createServer({ root: projectRoot, server: { port: 4322, strictPort: true } });
await server.listen();

const browser = await chromium.launch();
const errors = [];
const check = (condition, message) => { if (!condition) errors.push(message); };

try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 520 } });
  const consoleErrors = [];
  page.on("console", (msg) => { if (msg.type() === "error") consoleErrors.push(msg.text()); });
  page.on("pageerror", (err) => consoleErrors.push(String(err)));

  await page.goto("http://localhost:4322/scripts/visual-check-transfer-dnd.html");
  await page.waitForSelector("[data-pane='right'] [data-pane-row]");
  await mkdir(outDir, { recursive: true });

  const row = (side, name) => `[data-pane='${side}'] [data-row-name="${name}"]`;
  // Recalculé juste avant chaque geste, jamais réutilisé d'un scénario à
  // l'autre : sélectionner fait apparaître des boutons dans la barre du
  // panneau, et une coordonnée prise avant ne désigne plus la même ligne.
  const centre = async (selector) => {
    const box = await page.locator(selector).first().boundingBox();
    if (!box) throw new Error(`introuvable : ${selector}`);
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  };
  const drops = () => page.evaluate(() => window.__drops);
  const reset = () => page.evaluate(() => { window.__drops = []; });

  // 1. Un clic simple (appui/relâchement sans bouger) n'est pas un glisser.
  let notes = await centre(row("left", "notes.md"));
  await page.mouse.move(notes.x, notes.y);
  await page.mouse.down();
  await page.mouse.up();
  check((await drops()).length === 0, "un clic simple a été pris pour un glisser");

  // 2. Glisser un fichier du panneau gauche vers le panneau droit (dans le
  //    vide, donc son dossier courant).
  await reset();
  const vide = await page.locator("[data-pane='right']").boundingBox();
  notes = await centre(row("left", "notes.md"));
  await page.mouse.move(notes.x, notes.y);
  await page.mouse.down();
  await page.mouse.move(notes.x + 40, notes.y + 10, { steps: 5 });
  const dragging = await page.evaluate(() => window.__dragging);
  const ghost = await page.locator("[data-drag-ghost]").count();
  await page.mouse.move(vide.x + vide.width / 2, vide.y + vide.height - 40, { steps: 8 });
  await page.screenshot({ path: path.join(outDir, "transfer-dnd.png") });
  await page.mouse.up();
  check(dragging, "le glisser ne s'est pas armé après un déplacement franc");
  check(ghost === 1, "la vignette qui suit le curseur n'est pas apparue");
  let seen = await drops();
  check(seen.length === 1, `un dépôt attendu, ${seen.length} obtenu(s)`);
  if (seen[0]) {
    check(seen[0].source === "left" && seen[0].target.side === "right", `mauvais sens : ${JSON.stringify(seen[0])}`);
    check(seen[0].names.join() === "notes.md", `mauvaise entrée : ${JSON.stringify(seen[0].names)}`);
    check(seen[0].target.dir === null, `dépôt dans le vide : pas de dossier cible attendu (${seen[0].target.dir})`);
  }

  // 3. Déposer sur un dossier du panneau d'en face vise ce dossier.
  await reset();
  const depot = await centre(row("right", "depot"));
  notes = await centre(row("left", "notes.md"));
  await page.mouse.move(notes.x, notes.y);
  await page.mouse.down();
  await page.mouse.move(depot.x, depot.y, { steps: 10 });
  await page.mouse.up();
  seen = await drops();
  check(seen.length === 1 && seen[0].target.dir === "depot", `dépôt sur un dossier : ${JSON.stringify(seen)}`);

  // 4. Relâcher dans son propre panneau, hors d'un dossier, n'est pas une
  //    action — sinon un geste abandonné déclencherait une copie.
  await reset();
  const rapport = await centre(row("left", "rapport.pdf"));
  notes = await centre(row("left", "notes.md"));
  await page.mouse.move(notes.x, notes.y);
  await page.mouse.down();
  await page.mouse.move(rapport.x, rapport.y, { steps: 6 });
  await page.mouse.up();
  check((await drops()).length === 0, "un glisser abandonné dans son panneau a déclenché une copie");

  // 5. ... mais sur un dossier de son propre panneau, si : c'est une copie
  //    dedans.
  await reset();
  const projet = await centre(row("left", "projet"));
  notes = await centre(row("left", "notes.md"));
  await page.mouse.move(notes.x, notes.y);
  await page.mouse.down();
  await page.mouse.move(projet.x, projet.y, { steps: 6 });
  await page.mouse.up();
  seen = await drops();
  check(
    seen.length === 1 && seen[0].target.side === "left" && seen[0].target.dir === "projet",
    `dépôt sur un dossier du même panneau : ${JSON.stringify(seen)}`,
  );

  if (consoleErrors.length > 0) errors.push(`erreurs console : ${consoleErrors.join(" | ")}`);
} finally {
  await browser.close();
  await server.close();
}

if (errors.length > 0) {
  console.error("ÉCHEC :\n" + errors.map((e) => ` - ${e}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log("OK : glisser-déposer entre panneaux — seuil, vignette, panneau cible, dossier cible, geste abandonné.");
}
