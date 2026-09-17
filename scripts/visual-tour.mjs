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
    await page.waitForSelector("text=docker-compose", { timeout: 10_000 });
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
  ["16-menu-hote", async (page) => {
    await page.getByPlaceholder(/Rechercher/).first().fill("");
    await settle(page, 300);
    await page.locator("[data-host-row='pg-primary']").hover();
    await page.locator("[data-host-row='pg-primary'] button[title='Options']").click();
    await settle(page, 300);
  }],
  ["17-menu-ajouter", async (page) => {
    await page.keyboard.press("Escape");
    await page.mouse.click(700, 500);
    await settle(page, 200);
    await page.getByRole("button", { name: /^Ajouter/ }).first().click();
    await settle(page, 300);
  }],
  ["18-import-cloud", async (page) => {
    await page.getByRole("button", { name: /Importer depuis le cloud/ }).first().click();
    await settle(page, 500);
  }],
  ["19-nouvelle-base", async (page) => {
    await page.getByRole("button", { name: /Fermer/ }).first().click().catch(() => page.keyboard.press("Escape"));
    await settle(page, 300);
    await clickNav(page, "Bases de données");
    await page.getByRole("button", { name: /Nouvelle connexion/ }).first().click();
    await settle(page, 400);
  }],
  ["20-nouveau-dossier", async (page) => {
    await page.getByRole("button", { name: /Annuler/ }).first().click().catch(() => {});
    await clickNav(page, "Hôtes");
    await page.getByRole("button", { name: /^Ajouter/ }).first().click();
    await settle(page, 200);
    await page.getByRole("button", { name: /Nouveau dossier/ }).first().click();
    await settle(page, 400);
  }],
  ["21-confirmation", async (page) => {
    await page.getByRole("button", { name: /Annuler/ }).first().click().catch(() => {});
    await settle(page, 200);
    await page.locator("[data-tab-id]").first().locator("button[aria-label=\"Fermer l'onglet\"]").click({ force: true });
    await settle(page, 400);
  }],
  ["22-selection", async (page) => {
    await page.getByRole("button", { name: /^Annuler$/ }).first().click().catch(() => {});
    await settle(page, 200);
    await page.locator('button[title^="Sélectionner plusieurs hôtes"]').click();
    await settle(page, 200);
    for (const label of ["web-01", "pg-primary"]) {
      await page.locator(`[data-host-row='${label}'] input[type=checkbox]`).check();
    }
    await settle(page, 300);
  }],
  // Beaucoup d'onglets dans une fenêtre étroite : ils doivent rétrécir, pas
  // faire apparaître une barre de défilement à flèches.
  ["23-onglets-etroits", async (page) => {
    await page.locator('button[title="Quitter la sélection"]').click();
    await settle(page, 200);
    for (const label of ["web-02", "pg-primary", "docker-host", "bastion"]) {
      await page.locator(`[data-host-row='${label}'] > button`).first().click();
      await settle(page, 300);
    }
    await page.setViewportSize({ width: 1000, height: 700 });
    await settle(page, 500);
  }],
  // Panneau au plus étroit : les tags et le système passent à la ligne,
  // rien n'est tronqué sauf une adresse plus large que le panneau.
  ["23b-flotte-etroite", async (page) => {
    await clickNav(page, "Opérations de flotte");
    await settle(page, 400);
  }],
  ["24-panneau-etroit", async (page) => {
    await clickNav(page, "Hôtes");
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.evaluate(() => {
      const handle = document.querySelector(".cursor-col-resize");
      if (!handle) return;
      const rect = handle.getBoundingClientRect();
      handle.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: rect.left + 2, clientY: 300 }));
      window.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: rect.left - 80, clientY: 300 }));
      window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: rect.left - 80, clientY: 300 }));
    });
    await settle(page, 500);
  }],
  ["25-cles-etroit", async (page) => { await clickNav(page, "Clés"); }],
  ["26-bases-etroit", async (page) => { await clickNav(page, "Bases de données"); }],
  ["27-tunnels-etroit", async (page) => { await clickNav(page, "Tunnels"); }],
  ["28-snippets-etroit", async (page) => { await clickNav(page, "Snippets"); }],
  ["29-apparence", async (page) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await clickNav(page, "Paramètres");
    await settle(page, 400);
  }],
  // Dossiers au maximum, accent libre : le réglage doit se voir dans la liste.
  ["30-dossiers-grands", async (page) => {
    await page.locator('input[type="range"][aria-label="Taille du texte des dossiers"]').fill("18");
    await page.locator('input[type="range"][aria-label="Taille de l\'icône des dossiers"]').fill("26");
    await page.locator('input[type="range"][aria-label="Taille du texte des hôtes"]').fill("15");
    await page.locator('input[type="range"][aria-label="Taille de l\'icône des hôtes"]').fill("30");
    await page.locator('input[type="color"]').fill("#e11d48");
    await settle(page, 300);
    await clickNav(page, "Hôtes");
    await settle(page, 400);
  }],
  // Replier un dossier, défiler, recharger : l'arbre doit revenir tel quel.
  ["31-memoire-arbre", async (page) => {
    await page.locator('button[aria-label="Replier Labo"]').click();
    await page.locator('button[aria-label="Replier Préproduction"]').click();
    await settle(page, 300);
    await page.goto("http://localhost:4331/scripts/visual-tour.html?keep=1");
    await page.waitForSelector("text=web-01", { timeout: 15_000 });
    await settle(page, 600);
    const state = await page.evaluate(() => ({
      labo: !!document.querySelector('button[aria-label="Déplier Labo"]'),
      prepro: !!document.querySelector('button[aria-label="Déplier Préproduction"]'),
      prod: !!document.querySelector('button[aria-label="Replier Production"]'),
    }));
    if (!state.labo || !state.prepro || !state.prod) throw new Error(`dossiers non restaurés : ${JSON.stringify(state)}`);
  }],
  // GuiVault, à la largeur par défaut puis étroite : compte, invitation,
  // vaults, puis le détail d'un vault (contenu, membres, invitations).
  ["32-guivault", async (page) => {
    await clickNav(page, "GuiVault");
    await settle(page, 500);
  }],
  ["33-guivault-vault", async (page) => {
    await page.locator("[data-sidebar-panel] button", { hasText: "Équipe infra" }).first().click();
    await settle(page, 600);
    await page.getByRole("button", { name: /Depuis cet appareil/ }).first().click();
    await settle(page, 400);
  }],
  ["34-guivault-etroit", async (page) => {
    await page.setViewportSize({ width: 1000, height: 900 });
    await settle(page, 500);
  }],
  ["35-guivault-etroit-compte", async (page) => {
    await page.getByRole("button", { name: /Vaults/ }).first().click();
    await settle(page, 300);
    await page.getByRole("button", { name: /Plus d'options/ }).first().click();
    await settle(page, 500);
    await page.setViewportSize({ width: 1440, height: 900 });
  }],
  // Barre latérale à sa largeur minimale (260 px) : liste des vaults, détail
  // d'un vault, puis le panneau Hôtes avec le sélecteur de profil et les
  // étiquettes de vault.
  ["36-guivault-minimal", async (page) => {
    await page.evaluate(() => {
      const handle = document.querySelector(".cursor-col-resize");
      if (!handle) return;
      const rect = handle.getBoundingClientRect();
      handle.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: rect.left + 2, clientY: 300 }));
      window.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: rect.left - 400, clientY: 300 }));
      window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: rect.left - 400, clientY: 300 }));
    });
    await settle(page, 300);
    await page.getByRole("button", { name: /Masquer/ }).first().click();
    await settle(page, 400);
  }],
  ["37-guivault-minimal-vault", async (page) => {
    await page.locator("[data-sidebar-panel] button", { hasText: "Équipe infra" }).first().click();
    await settle(page, 600);
  }],
  ["38-hotes-minimal-vaults", async (page) => {
    await clickNav(page, "Hôtes");
    await settle(page, 400);
  }],
  // Mode « trier par vault » : une section par vault, dossiers dedans.
  ["39-hotes-par-vault", async (page) => {
    await page.evaluate(() => {
      const handle = document.querySelector(".cursor-col-resize");
      if (!handle) return;
      const rect = handle.getBoundingClientRect();
      handle.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: rect.left + 2, clientY: 300 }));
      window.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: rect.left + 120, clientY: 300 }));
      window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: rect.left + 120, clientY: 300 }));
    });
    await page.locator('button[title^="Trier par vault"]').click();
    await settle(page, 500);
    const sections = await page.evaluate(() => Array.from(document.querySelectorAll("[data-vault-section]")).map((e) => e.getAttribute("data-vault-section")));
    if (sections.length < 2) throw new Error(`sections de vault absentes : ${JSON.stringify(sections)}`);
  }],
  ["40-snippets-vaults", async (page) => {
    await page.locator('button[title^="Trier par dossier"]').click();
    await clickNav(page, "Snippets");
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
