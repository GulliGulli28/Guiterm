// Contrôle DOM/visuel de l'alignement des colonnes du panneau de transfert.
//
// Pourquoi un vrai navigateur : c'est de la mise en page. Ni `tsc` ni vitest
// (pas de moteur de rendu) ne peuvent dire qu'une date de 16 caractères ne
// tient pas dans sa colonne à la taille de police choisie, ni qu'une ligne
// portant un bouton d'action de moins que sa voisine décale toutes ses
// colonnes. C'est exactement ce qui était cassé : en-tête et lignes
// empilaient chacun leurs propres largeurs, et le compte n'y était pas.
//
// Même montage que `visual-check-ghost-text.mjs` : Vite sert la page,
// Playwright la rend et mesure. Aucun Tauri, aucun `invoke(...)`.
//
// Usage : node scripts/visual-check-transfer-columns.mjs
import { createServer } from "vite";
import { chromium } from "playwright";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir } from "node:fs/promises";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const outDir = path.join(scriptDir, ".output");

/** Les colonnes de contenu fixe : elles ne doivent jamais être rognées, quelle
 * que soit la taille de police (`sftpFontSize` va de 10 à 20 dans les
 * préférences). La colonne « Nom », elle, a le droit d'être tronquée — un nom
 * de fichier n'a pas de longueur maximale. */
const FIXED_COLUMNS = ["Modifié", "Type", "Taille"];

// Largeurs de panneau réalistes : un panneau étroit (diviseur poussé à
// gauche), la moitié d'une fenêtre normale, et un panneau large.
const CASES = [
  { fontSize: 11, width: 320 },
  { fontSize: 13, width: 420 },
  { fontSize: 13, width: 700 },
  { fontSize: 16, width: 700 },
  { fontSize: 20, width: 900 },
];

const server = await createServer({ root: projectRoot, server: { port: 4321, strictPort: true } });
await server.listen();

const browser = await chromium.launch();
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 500 } });
  const consoleErrors = [];
  page.on("console", (msg) => { if (msg.type() === "error") consoleErrors.push(msg.text()); });
  page.on("pageerror", (err) => consoleErrors.push(String(err)));

  await page.goto("http://localhost:4321/scripts/visual-check-transfer-columns.html");
  await page.waitForFunction(() => typeof window.__renderPane === "function", { timeout: 10_000 });

  await mkdir(outDir, { recursive: true });

  for (const testCase of CASES) {
    const label = `police ${testCase.fontSize}px, panneau ${testCase.width}px`;
    const measured = await page.evaluate((options) => window.__renderPane(options), testCase);
    if (!measured) { errors.push(`${label} : rien n'a été rendu`); continue; }

    const headerLabels = measured.header.map((cell) => cell.text.replace(/[▲▼\s]+$/, ""));

    // 1. Même nombre de colonnes partout. Une colonne ajoutée d'un seul côté
    //    décale tout ce qui la suit.
    for (const [index, row] of measured.rows.entries()) {
      if (row.length !== measured.header.length) {
        errors.push(`${label} : la ligne ${index} a ${row.length} cellules, l'en-tête ${measured.header.length}`);
      }
    }

    // 2. Chaque colonne commence et finit au même endroit sur toutes les
    //    lignes ET dans l'en-tête. C'est *la* propriété que l'utilisateur voit.
    for (const [index, row] of measured.rows.entries()) {
      for (let col = 0; col < Math.min(row.length, measured.header.length); col += 1) {
        const drift = Math.abs(row[col].left - measured.header[col].left);
        if (drift > 0.6) {
          errors.push(
            `${label} : colonne ${col} (« ${headerLabels[col] || "—"} ») décalée de ${drift.toFixed(1)}px ` +
            `sur la ligne ${index} (« ${row[col].text.slice(0, 24)} »)`,
          );
        }
      }
    }

    // 3. Les colonnes de contenu fixe ne sont pas rognées. C'est le symptôme
    //    de départ : « les champs modifiés dépassent sur Type ».
    for (const [index, row] of measured.rows.entries()) {
      for (let col = 0; col < Math.min(row.length, headerLabels.length); col += 1) {
        if (!FIXED_COLUMNS.includes(headerLabels[col])) continue;
        if (row[col].clipped) {
          errors.push(
            `${label} : « ${row[col].text} » ne tient pas dans la colonne ${headerLabels[col]} (ligne ${index})`,
          );
        }
      }
    }

    const screenshot = path.join(outDir, `transfer-columns-${testCase.fontSize}-${testCase.width}.png`);
    await page.screenshot({ path: screenshot });
    console.log(`${label} (mesuré ${measured.paneWidth}px) : ${measured.header.length} colonnes [${headerLabels.join(", ")}] → ${screenshot}`);
  }

  if (consoleErrors.length > 0) errors.push(`erreurs console : ${consoleErrors.join(" | ")}`);
} finally {
  await browser.close();
  await server.close();
}

if (errors.length > 0) {
  console.error("ÉCHEC :\n" + errors.map((e) => ` - ${e}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log("OK : colonnes alignées entre l'en-tête et toutes les lignes, aucune colonne fixe rognée.");
}
