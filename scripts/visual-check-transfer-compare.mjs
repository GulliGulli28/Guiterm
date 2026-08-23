// Contrôle du panneau de comparaison des deux arborescences.
//
// Ce qui s'y joue n'est ni du calcul ni de la mise en page mais un
// enchaînement : ce qui est pré-coché, ce qui est grisé parce que ça ne part
// pas dans le sens choisi, ce que le total annonce, et ce qui est réellement
// envoyé au clic. Une règle écrite à l'envers laisserait une ligne cochée qui
// ne partirait nulle part, sans que rien ne le signale.
//
// Usage : node scripts/visual-check-transfer-compare.mjs
import { createServer } from "vite";
import { chromium } from "playwright";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir } from "node:fs/promises";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const outDir = path.join(scriptDir, ".output");

const server = await createServer({ root: projectRoot, server: { port: 4324, strictPort: true } });
await server.listen();

const browser = await chromium.launch();
const errors = [];
const check = (condition, message) => { if (!condition) errors.push(message); };

try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 560 } });
  const consoleErrors = [];
  page.on("console", (msg) => { if (msg.type() === "error") consoleErrors.push(msg.text()); });
  page.on("pageerror", (err) => consoleErrors.push(String(err)));

  await page.goto("http://localhost:4324/scripts/visual-check-transfer-compare.html");
  await page.waitForSelector("[data-comparison-list]");
  await mkdir(outDir, { recursive: true });

  const line = (p) => `[data-difference="${p}"]`;
  const box = (p) => `${line(p)} input[type=checkbox]`;
  // Triés : l'ordre d'affichage n'est pas ce qu'on vérifie ici.
  const checkedPaths = () =>
    page.$$eval("[data-difference]", (rows) =>
      rows.filter((r) => r.querySelector("input")?.checked).map((r) => r.dataset.difference).sort());
  const disabledPaths = () =>
    page.$$eval("[data-difference]", (rows) =>
      rows.filter((r) => r.querySelector("input")?.disabled).map((r) => r.dataset.difference).sort());
  const syncs = () => page.evaluate(() => window.__syncs);
  // Un clic rend la main avant que React ait re-rendu : sans ce temps de
  // repos, on relit l'écran d'avant et le contrôle passe (ou échoue) pour la
  // mauvaise raison.
  const settle = () => page.waitForTimeout(150);

  await page.screenshot({ path: path.join(outDir, "transfer-compare.png") });

  // 1. Vers la droite (par défaut) : seul ce qui existe ou est plus récent à
  //    gauche part ; le reste est grisé, donc impossible à cocher par erreur.
  check(
    JSON.stringify(await checkedPaths()) === JSON.stringify(["app/main.py", "config/nginx.conf", "data.bin"]),
    `pré-cochage vers la droite : ${JSON.stringify(await checkedPaths())}`,
  );
  check(
    JSON.stringify(await disabledPaths()) === JSON.stringify(["app/vieux.py", "journal.log"]),
    `grisés vers la droite : ${JSON.stringify(await disabledPaths())}`,
  );

  // 2. Le total suit la sélection.
  const footer = () => page.locator("text=/fichier\\(s\\) ·/").first().innerText();
  check((await footer()).startsWith("3 fichier(s)"), `total initial : ${await footer()}`);
  await page.uncheck(box("data.bin"));
  await settle();
  check((await footer()).startsWith("2 fichier(s)"), `total après décochage : ${await footer()}`);

  // 3. Changer de sens réinverse ce qui est proposé.
  await page.click("[data-direction='left']");
  await settle();
  check(
    JSON.stringify(await checkedPaths()) === JSON.stringify(["app/vieux.py", "data.bin", "journal.log"]),
    `pré-cochage vers la gauche : ${JSON.stringify(await checkedPaths())}`,
  );
  check(
    JSON.stringify(await disabledPaths()) === JSON.stringify(["app/main.py", "config/nginx.conf"]),
    `grisés vers la gauche : ${JSON.stringify(await disabledPaths())}`,
  );

  // 4. Ce qui part est bien ce qui est coché, avec les tailles du bon côté.
  await page.uncheck(box("journal.log"));
  await settle();
  await page.click("[data-sync-run]");
  await settle();
  const sent = await syncs();
  check(sent.length === 1, `un envoi attendu : ${JSON.stringify(sent)}`);
  if (sent[0]) {
    check(
      JSON.stringify(sent[0].paths) === JSON.stringify(["app/vieux.py", "data.bin"]),
      `chemins envoyés : ${JSON.stringify(sent[0].paths)}`,
    );
    check(sent[0].direction === "left", `sens envoyé : ${sent[0].direction}`);
    // Les tailles doivent venir de la droite (la source dans ce sens) :
    // 600 + 20, et non 500 + 10.
    check(sent[0].bytes === 620, `tailles prises du bon côté : ${sent[0].bytes} au lieu de 620`);
  }

  // 5. Le bouton de diff n'existe que pour les fichiers présents des deux
  //    côtés : il n'y a rien à comparer avec un fichier qui n'existe pas.
  check(await page.locator("[data-diff-open]").count() === 3, `boutons de diff : ${await page.locator("[data-diff-open]").count()}`);
  check(await page.locator("[data-diff-open='journal.log']").count() === 0, "pas de diff pour un fichier absent d'un côté");
  await page.click("[data-diff-open='data.bin']");
  await settle();
  const opened = (await syncs()).filter((s) => s.direction === "diff");
  check(
    opened.length === 1 && opened[0].paths[0] === "data.bin",
    `ouverture du diff : ${JSON.stringify(opened)}`,
  );


  // 6. Tout décocher désactive le bouton d'envoi.
  await page.click("text=Tout décocher");
  await settle();
  check(await page.locator("[data-sync-run]").isDisabled(), "sans rien de coché, l'envoi doit être impossible");

  if (consoleErrors.length > 0) errors.push(`erreurs console : ${consoleErrors.join(" | ")}`);
} finally {
  await browser.close();
  await server.close();
}

if (errors.length > 0) {
  console.error("ÉCHEC :\n" + errors.map((e) => ` - ${e}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log("OK : comparaison — pré-cochage par sens, lignes grisées, total, tailles du bon côté, envoi.");
}
