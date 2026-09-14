// Tour visuel : parcourt les écrans de l'application (montée sans Tauri par
// `visual-tour.client.tsx`) et dépose une capture par écran dans
// `scripts/.output/tour/`. C'est l'outil pour *regarder* une refonte
// d'interface — comparer avant/après, vérifier un thème, repérer un
// alignement qui déraille — là où `tsc` et vitest ne voient pas un pixel.
//
// Usage : node scripts/visual-tour.mjs [--light] [--scene=nom]
//
// Chaque scène part de l'état où la précédente l'a laissée, dans l'ordre
// ci-dessous — ce qui est voulu : un onglet terminal ouvert reste visible
// derrière le panneau des snippets, comme dans une vraie session.
import { createServer } from "vite";
import { chromium } from "playwright";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir } from "node:fs/promises";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const outDir = path.join(scriptDir, ".output", "tour");

const args = process.argv.slice(2);
const light = args.includes("--light");
const only = args.find((a) => a.startsWith("--scene="))?.slice("--scene=".length);
const suffix = light ? "-light" : "";

const server = await createServer({ root: projectRoot, server: { port: 4331, strictPort: true }, logLevel: "error" });
await server.listen();
const browser = await chromium.launch();
const errors = [];

const settle = (page, ms = 250) => page.waitForTimeout(ms);
const clickNav = async (page, title) => {
  await page.locator(`nav button[title^="${title}"]`).first().click();
  // Les panneaux sont chargés à la demande : attendre que le module soit là.
  await page.waitForFunction(() => !document.body.innerText.includes("Chargement"), null, { timeout: 10_000 }).catch(() => {});
  await settle(page, 400);
};

/** Chaque scène : un nom de fichier, et ce qu'il faut faire pour y arriver. */
const scenes = [
  ["01-accueil", async () => {}],
  ["02-terminal", async (page) => {
    await page.getByText("web-01", { exact: true }).first().click();
    await page.waitForSelector(".xterm-screen", { timeout: 10_000 });
    await settle(page, 600);
  }],
  ["03-nouvel-hote", async (page) => {
    await page.getByRole("button", { name: /Ajouter/ }).first().click();
    await settle(page);
    await page.getByRole("button", { name: /Nouvel hôte/ }).first().click();
    await settle(page, 400);
  }],
  ["04-transfert", async (page) => {
    await page.getByRole("button", { name: /Annuler/ }).first().click().catch(() => {});
    await clickNav(page, "SFTP");
    await page.locator("[data-sidebar-panel] button", { hasText: "pg-primary" }).first().click();
    await page.waitForSelector("text=docker-compose.yml", { timeout: 10_000 });
    await settle(page, 600);
  }],
  ["05-snippets", async (page) => { await clickNav(page, "Snippets"); }],
  ["06-tunnels", async (page) => { await clickNav(page, "Tunnels"); }],
  ["07-cles", async (page) => { await clickNav(page, "Clés"); }],
  ["08-bases", async (page) => { await clickNav(page, "Bases de données"); }],
  ["09-known-hosts", async (page) => { await clickNav(page, "Known Hosts"); }],
  ["10-flotte", async (page) => { await clickNav(page, "Opérations de flotte"); await settle(page, 500); }],
  ["11-runbooks", async (page) => { await clickNav(page, "Runbooks"); }],
  ["12-diagnostic", async (page) => { await clickNav(page, "Diagnostic réseau"); await settle(page, 500); }],
  ["13-parametres", async (page) => { await clickNav(page, "Paramètres"); await settle(page, 400); }],
  ["14-palette", async (page) => {
    await page.keyboard.press("Control+K");
    await settle(page, 400);
  }],
  ["15-hotes-recherche", async (page) => {
    await page.keyboard.press("Escape");
    await clickNav(page, "Hôtes");
    await page.getByPlaceholder(/Rechercher/).first().fill("nginx");
    await settle(page, 400);
  }],
];

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  page.on("console", (msg) => { if (msg.type() === "error") errors.push(msg.text()); });
  page.on("pageerror", (err) => errors.push(String(err)));

  await page.goto(`http://localhost:4331/scripts/visual-tour.html${light ? "?mode=light" : ""}`);
  await page.waitForSelector("text=web-01", { timeout: 15_000 });
  await settle(page, 500);
  await mkdir(outDir, { recursive: true });

  for (const [name, run] of scenes) {
    try {
      await run(page);
    } catch (e) {
      errors.push(`${name}: ${e.message.split("\n")[0]}`);
    }
    if (!only || name.includes(only)) {
      await page.screenshot({ path: path.join(outDir, `${name}${suffix}.png`) });
      console.log(`  ${name}${suffix}.png`);
    }
  }
} finally {
  await browser.close();
  await server.close();
}

if (errors.length) {
  console.error("\nIncidents pendant le tour :");
  for (const e of errors) console.error(`  - ${e}`);
}
