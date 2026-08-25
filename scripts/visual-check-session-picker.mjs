// Contrôle DOM/visuel du sélecteur de sessions persistantes.
//
// Pourquoi un vrai navigateur : « le texte est rogné » est une affirmation sur
// une largeur rendue. Ni `tsc` ni vitest ne peuvent la vérifier, et le calcul
// dépend de choses qu'aucun test unitaire ne connaît — la police réelle, et le
// fait que les trois boutons d'action occupent leur largeur **même invisibles**
// (ils ne sont que transparents hors survol). C'est exactement ce qui rendait
// « Session ouverte il y a… » illisible.
//
// Usage : node scripts/visual-check-session-picker.mjs
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
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  const consoleErrors = [];
  page.on("console", (msg) => { if (msg.type() === "error") consoleErrors.push(msg.text()); });
  page.on("pageerror", (err) => consoleErrors.push(String(err)));

  await page.goto("http://localhost:4325/scripts/visual-check-session-picker.html");
  await page.waitForSelector("button");
  await mkdir(outDir, { recursive: true });
  await page.screenshot({ path: path.join(outDir, "session-picker.png") });

  // Chaque ligne : le bouton qui porte le nom et le sous-titre. `scrollWidth >
  // clientWidth` veut dire que le contenu ne tient pas dans sa boîte — avec
  // `truncate`, ça se voit en « … » et l'information est perdue.
  const rows = await page.evaluate(() => {
    const clipped = (el) => el.scrollWidth > el.clientWidth + 1;
    return Array.from(document.querySelectorAll("div.group")).map((row) => {
      const [name, meta] = Array.from(row.querySelectorAll("button span"));
      return {
        name: name?.textContent ?? "",
        meta: meta?.textContent ?? "",
        nameClipped: name ? clipped(name) : false,
        metaClipped: meta ? clipped(meta) : false,
        actions: Array.from(row.querySelectorAll("button")).slice(1).map((b) => b.textContent),
      };
    });
  });

  if (rows.length !== 3) errors.push(`3 lignes attendues, ${rows.length} rendues`);
  for (const row of rows) {
    if (row.nameClipped) errors.push(`nom rogné : « ${row.name} »`);
    if (row.metaClipped) errors.push(`sous-titre rogné : « ${row.meta} »`);
    // Les trois verbes doivent rester présents : c'est leur largeur qui a
    // causé le rognage, donc les perdre « réglerait » le problème pour de
    // mauvaises raisons.
    for (const verb of ["Observer", "Partager", "Terminer"]) {
      if (!row.actions.includes(verb)) errors.push(`action « ${verb} » absente de la ligne « ${row.name} »`);
    }
  }

  // L'avertissement de sécurité tient sur plusieurs lignes plutôt que d'être
  // coupé : il n'a de valeur que lu en entier.
  const warning = await page.evaluate(() => {
    const el = Array.from(document.querySelectorAll("p")).find((p) => (p.textContent || "").includes("barrière de sécurité"));
    return el ? { text: el.textContent, clipped: el.scrollHeight > el.clientHeight + 1 } : null;
  });
  if (!warning) errors.push("l'avertissement de sécurité n'est pas rendu");
  else if (warning.clipped) errors.push("l'avertissement de sécurité est tronqué");

  if (consoleErrors.length > 0) errors.push(`erreurs console : ${consoleErrors.join(" | ")}`);
} finally {
  await browser.close();
  await server.close();
}

if (errors.length > 0) {
  console.error("ÉCHEC :\n" + errors.map((e) => ` - ${e}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log("OK : lignes de session lisibles en entier, trois actions présentes, avertissement complet.");
}
