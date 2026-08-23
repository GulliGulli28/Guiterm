// Contrôle de la comparaison de contenu de deux fichiers.
//
// Ce qui s'y vérifie tient à la lecture, pas au calcul (le diff lui-même est
// testé en Rust) : les deux fichiers doivent être nommés — ils n'ont aucune
// raison de porter le même nom —, la partie réellement modifiée d'une ligne
// doit être soulignée, les deux lectures doivent montrer les mêmes lignes, et
// la vue côte à côte doit aligner l'avant et l'après au lieu de laisser les
// deux colonnes glisser l'une par rapport à l'autre.
//
// Usage : node scripts/visual-check-transfer-filediff.mjs
import { createServer } from "vite";
import { chromium } from "playwright";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir } from "node:fs/promises";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const outDir = path.join(scriptDir, ".output");

const server = await createServer({ root: projectRoot, server: { port: 4325, strictPort: true } });
await server.listen();

const browser = await chromium.launch();
const errors = [];
const check = (condition, message) => { if (!condition) errors.push(message); };

try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 640 } });
  const consoleErrors = [];
  page.on("console", (msg) => { if (msg.type() === "error") consoleErrors.push(msg.text()); });
  page.on("pageerror", (err) => consoleErrors.push(String(err)));

  await page.goto("http://localhost:4325/scripts/visual-check-transfer-filediff.html");
  await page.waitForSelector("[data-file-diff]");
  await mkdir(outDir, { recursive: true });
  const settle = () => page.waitForTimeout(150);
  const events = () => page.evaluate(() => window.__diffEvents);

  // 1. Les deux fichiers sont nommés, avec leur côté — ils ne portent pas le
  //    même nom, c'est tout l'intérêt.
  const header = await page.locator("[role=dialog] > div").first().innerText();
  check(header.includes("config/nginx.conf"), `fichier de gauche nommé : ${header}`);
  check(header.includes("sauvegardes/nginx.conf.bak"), `fichier de droite nommé : ${header}`);
  check(header.includes("gauche") && header.includes("droite"), `côtés indiqués : ${header}`);

  // 2. La partie modifiée d'une ligne longue est isolée, pas la ligne entière.
  const emphasised = await page.$$eval("[data-diff-kind='deleted'] span span", (spans) =>
    spans.filter((s) => s.className.includes("bg-rose-500/30")).map((s) => s.textContent));
  check(JSON.stringify(emphasised) === JSON.stringify(["8080"]), `partie soulignée : ${JSON.stringify(emphasised)}`);

  await page.screenshot({ path: path.join(outDir, "transfer-filediff-unified.png") });

  // 3. La navigation entre passages existe dès qu'il y en a plusieurs.
  check(await page.locator("[data-hunk-next]").count() === 1, "les passages doivent être parcourables");
  await page.click("[data-hunk-next]");
  await settle();
  check((await page.locator("[data-hunk]").count()) === 2, "deux passages");

  // 4. Passer côte à côte garde les mêmes lignes, et aligne l'avant et
  //    l'après sur la même rangée.
  const unifiedTexts = await page.$$eval("[data-file-diff] [data-diff-kind]", (rows) => rows.length);
  await page.click("[data-diff-view='split']");
  await settle();
  check(await page.locator("[data-file-diff='split']").count() === 1, "la vue côte à côte doit s'appliquer");
  const splitRows = await page.$$eval("[data-file-diff] [data-diff-kind]", (rows) =>
    rows.map((r) => r.innerText.replace(/\s+/g, " ").trim()));
  check(
    splitRows.some((t) => t.includes("8080") && t.includes("9090")),
    `l'avant et l'après doivent être sur la même rangée : ${JSON.stringify(splitRows)}`,
  );
  check(splitRows.length < unifiedTexts, "l'appariement réduit le nombre de rangées");
  check((await events()).includes("view:split"), "le choix de lecture doit être remonté pour être retenu");
  await page.screenshot({ path: path.join(outDir, "transfer-filediff-split.png") });

  // 5. Échanger les côtés est possible — on les désigne souvent à l'envers.
  await page.click("[role=dialog] button[title='Échanger les deux côtés']");
  await settle();
  check((await events()).includes("swap"), "l'échange des côtés doit être remonté");

  if (consoleErrors.length > 0) errors.push(`erreurs console : ${consoleErrors.join(" | ")}`);
} finally {
  await browser.close();
  await server.close();
}

if (errors.length > 0) {
  console.error("ÉCHEC :\n" + errors.map((e) => ` - ${e}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log("OK : comparaison de contenu — deux fichiers nommés, mot souligné, navigation, unifié/côte à côte, échange.");
}
