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
  // Le panneau Transfert range aussi ses hôtes par vault : un hôte partagé
  // y est, sous son vault — il n'y était pas quand son dossier manquait.
  ["04b-transfert-vaults", async (page) => {
    const sections = await page.evaluate(() => Array.from(document.querySelectorAll('[data-sidebar-panel="sftp"] [data-vault-section]')).map((e) => ({
      name: e.getAttribute("data-vault-section"),
      hosts: Array.from(e.querySelectorAll("button")).map((b) => b.textContent ?? "").filter((t) => /pg-primary|bastion|web-01/.test(t)).length,
    })));
    const infra = sections.find((s) => s.name === "Équipe infra");
    if (sections[0]?.name !== "Personnel" || !infra || infra.hosts === 0) throw new Error(`panneau Transfert par vault : ${JSON.stringify(sections)}`);
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
  // Le contenu d'un vault : arborescence à cocher, barre de sélection avec
  // Déplacer / Copier / Supprimer. Cocher un dossier coche son sous-arbre.
  ["33-guivault-vault", async (page) => {
    await page.locator("[data-sidebar-panel] button", { hasText: "Équipe infra" }).first().click();
    await settle(page, 600);
    await page.locator('[data-vault-tree] input[aria-label="Tout sélectionner — Production"]').click();
    await settle(page, 300);
    const state = await page.evaluate(() => ({
      entities: Array.from(document.querySelectorAll("[data-vault-tree] [data-vault-entity]")).map((e) => e.getAttribute("data-vault-entity")),
      checked: Array.from(document.querySelectorAll('[data-vault-tree] input[type="checkbox"]:checked')).length,
      bar: document.querySelector("[data-vault-selection-bar]")?.textContent ?? "",
    }));
    if (!state.entities.includes("web-01") || !state.entities.includes("deploy-ed25519")) throw new Error(`arbre du vault incomplet : ${JSON.stringify(state.entities)}`);
    // Le dossier, son sous-dossier, deux hôtes et une connexion : 5 entités
    // sélectionnées, et les deux cases de dossier passent à « tout ».
    if (state.checked < 5) throw new Error(`cocher le dossier n'a pas coché son sous-arbre : ${state.checked}`);
    if (!/5 sélectionnés/.test(state.bar)) throw new Error(`barre de sélection : « ${state.bar} »`);
    await page.getByRole("button", { name: /^Déplacer/ }).first().click();
    await settle(page, 300);
    const menu = await page.evaluate(() => Array.from(document.querySelectorAll('[role="menu"] [role="menuitem"]')).map((e) => e.textContent?.trim()));
    if (!menu.some((m) => /personnel/i.test(m ?? "")) || !menu.some((m) => /appareil/i.test(m ?? ""))) throw new Error(`destinations : ${JSON.stringify(menu)}`);
    // Un vault en lecture seule n'est pas une destination.
    if (menu.some((m) => /bancaire/i.test(m ?? ""))) throw new Error("un vault en lecture seule est proposé comme destination");
  }],
  // Choisir une destination ouvre « Ces entités suivront » : dossier
  // verrouillé, clé / icône / bastion cochés et décochables.
  ["33a-guivault-suiveurs", async (page) => {
    await page.locator('[role="menu"] [role="menuitem"]', { hasText: "Vault personnel" }).click();
    await settle(page, 500);
    const state = await page.evaluate(() => {
      const d = document.querySelector("[data-transfer-confirm]");
      return {
        present: !!d,
        names: Array.from(d?.querySelectorAll("[data-transfer-follower]") ?? []).map((e) => e.getAttribute("data-transfer-follower")),
        boxes: d?.querySelectorAll('input[type="checkbox"]').length ?? 0,
        text: d?.textContent ?? "",
      };
    });
    if (!state.present) throw new Error("dialogue « Ces entités suivront » absent");
    if (state.names[0] !== "Production") throw new Error(`l'obligatoire n'est pas en tête : ${JSON.stringify(state.names)}`);
    if (state.boxes !== 3) throw new Error(`3 cases attendues pour les facultatifs, ${state.boxes} trouvées`);
    if (!/bastion de « web-01 »/.test(state.text)) throw new Error("la raison du bastion manque");
    await page.locator('[data-transfer-confirm] input[aria-label="Emmener bastion-infra"]').click();
    await settle(page, 200);
    const kept = await page.evaluate(() => document.querySelector("[data-transfer-confirm]")?.textContent ?? "");
    if (!/3 suiveurs/.test(kept)) throw new Error(`décocher le bastion : « ${kept.match(/\d+ suiveurs?/)?.[0]} »`);
  }],
  // « Ajouter… » : le même arbre, un dossier par origine — cet appareil, le
  // vault personnel, les autres vaults (« copie seulement » en lecteur).
  ["33b-guivault-ajouter", async (page) => {
    await page.keyboard.press("Escape");
    await settle(page, 300);
    if (await page.locator("[data-transfer-confirm]").count()) throw new Error("Échap n'a pas fermé la confirmation");
    await page.getByRole("button", { name: /Ajouter…/ }).first().click();
    await settle(page, 600);
    const dialog = await page.evaluate(() => {
      const d = document.querySelector("[data-vault-add-dialog]");
      const headers = Array.from(d?.querySelectorAll('button[aria-label^="Replier"], button[aria-label^="Déplier"]') ?? []).map((b) => b.getAttribute("aria-label")?.replace(/^(Replier|Déplier) /, ""));
      return { present: !!d, headers, entities: Array.from(d?.querySelectorAll("[data-vault-entity]") ?? []).map((e) => e.getAttribute("data-vault-entity")) };
    });
    if (!dialog.present) throw new Error("dialogue « Ajouter » absent");
    for (const expected of ["Cet appareil (local)", "Vault personnel", "Lecture seule — prod bancaire"]) {
      if (!dialog.headers.includes(expected)) throw new Error(`origine manquante dans « Ajouter » : ${expected} — ${JSON.stringify(dialog.headers)}`);
    }
    if (dialog.headers.includes("Équipe infra")) throw new Error("le vault de destination est proposé comme origine");
    if (!dialog.entities.includes("nas-maison") || !dialog.entities.includes("labo-1") || !dialog.entities.includes("core-banking-01")) throw new Error(`entités des origines : ${JSON.stringify(dialog.entities)}`);
    // Cocher une entité d'un vault en lecture seule : copier oui, déplacer non.
    await page.locator('[data-vault-add-dialog] input[aria-label="Sélectionner core-banking-01"]').click();
    await settle(page, 200);
    const moveDisabled = await page.locator('[data-vault-add-dialog] button', { hasText: /Déplacer ici/ }).isDisabled();
    const copyDisabled = await page.locator('[data-vault-add-dialog] button', { hasText: /Copier ici/ }).isDisabled();
    if (!moveDisabled || copyDisabled) throw new Error(`lecture seule : déplacer ${moveDisabled ? "désactivé" : "actif"}, copier ${copyDisabled ? "désactivé" : "actif"}`);
  }],
  ["33c-guivault-ajouter-recherche", async (page) => {
    await page.locator('[data-vault-add-dialog] input[aria-label="Rechercher"]').fill("nas");
    await settle(page, 300);
    const left = await page.evaluate(() => Array.from(document.querySelectorAll("[data-vault-add-dialog] [data-vault-entity]")).map((e) => e.getAttribute("data-vault-entity")));
    if (left.join() !== "nas-maison") throw new Error(`recherche dans « Ajouter » : ${JSON.stringify(left)}`);
  }],
  ["34-guivault-etroit", async (page) => {
    await page.keyboard.press("Escape");
    await settle(page, 200);
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
  // d'un vault, puis le panneau Hôtes avec la barre de profil et les
  // dossiers de vault.
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
  // Compte affiché : chaque vault est un dossier de premier niveau de l'arbre
  // (Personnel, puis les partagés), avec son menu « … » ; plus d'étiquette.
  ["39-hotes-par-vault", async (page) => {
    await page.evaluate(() => {
      const handle = document.querySelector(".cursor-col-resize");
      if (!handle) return;
      const rect = handle.getBoundingClientRect();
      handle.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: rect.left + 2, clientY: 300 }));
      window.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: rect.left + 120, clientY: 300 }));
      window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: rect.left + 120, clientY: 300 }));
    });
    await settle(page, 500);
    const sections = await page.evaluate(() => Array.from(document.querySelectorAll('[data-sidebar-panel="hosts"] [data-vault-section]')).map((e) => e.getAttribute("data-vault-section")));
    if (sections[0] !== "Personnel" || !sections.includes("Équipe infra")) throw new Error(`dossiers de vault : ${JSON.stringify(sections)}`);
    const chips = await page.evaluate(() => Array.from(document.querySelectorAll('[data-sidebar-panel="hosts"] .tag')).map((e) => e.textContent).filter((t) => t === "Équipe infra"));
    if (chips.length) throw new Error("une étiquette de vault subsiste sur une ligne d'hôte");
    // L'hôte partagé est bien sous son vault, pas sous Personnel.
    const under = await page.evaluate(() => {
      const sec = Array.from(document.querySelectorAll('[data-sidebar-panel="hosts"] [data-vault-section]')).find((e) => e.getAttribute("data-vault-section") === "Équipe infra");
      return Array.from(sec?.querySelectorAll("[data-host-row]") ?? []).map((e) => e.getAttribute("data-host-row"));
    });
    if (!under.includes("web-01") || under.includes("bastion")) throw new Error(`contenu du dossier « Équipe infra » : ${JSON.stringify(under)}`);
    await page.locator('button[aria-label="Options de Équipe infra"]').click({ force: true });
    await settle(page, 300);
    const menu = await page.evaluate(() => Array.from(document.querySelectorAll('[role="menu"] [role="menuitem"]')).map((e) => e.textContent?.trim()));
    if (!menu.some((m) => /Nouvel hôte ici/.test(m ?? "")) || !menu.some((m) => /Ouvrir le vault/.test(m ?? ""))) throw new Error(`menu du vault : ${JSON.stringify(menu)}`);
  }],
  // Le menu « … » d'un hôte propose « Déplacer vers » les autres vaults où
  // l'on écrit — pas le vault lu, pas celui où il est déjà.
  ["39a-menu-hote-deplacer", async (page) => {
    await page.keyboard.press("Escape");
    await page.mouse.click(700, 500);
    await settle(page, 200);
    await page.locator("[data-host-row='web-01']").hover();
    await page.locator("[data-host-row='web-01'] button[title='Options']").click();
    await settle(page, 300);
    const targets = await page.evaluate(() => Array.from(document.querySelectorAll("[data-move-to-vault]")).map((e) => e.getAttribute("data-move-to-vault")));
    if (targets.join() !== "Personnel") throw new Error(`destinations du menu de l'hôte : ${JSON.stringify(targets)}`);
    await page.locator("[data-move-to-vault='Personnel']").click();
    await settle(page, 500);
    if (!(await page.locator("[data-transfer-confirm]").count())) throw new Error("« Ces entités suivront » ne s'est pas ouvert depuis le menu de l'hôte");
    await page.keyboard.press("Escape");
    await settle(page, 200);
    // Un vault que le compte ne liste plus : sa section, et « Rapatrier ».
    const stray = await page.evaluate(() => {
      const sec = Array.from(document.querySelectorAll('[data-sidebar-panel="hosts"] [data-vault-section]')).find((e) => e.getAttribute("data-vault-section") === "Vault inaccessible");
      return { present: !!sec, hosts: Array.from(sec?.querySelectorAll("[data-host-row]") ?? []).map((e) => e.getAttribute("data-host-row")) };
    });
    if (!stray.present || !stray.hosts.includes("prod-cluster")) throw new Error(`section inaccessible : ${JSON.stringify(stray)}`);
    await page.locator('[data-vault-section="Vault inaccessible"] button', { hasText: "Rapatrier" }).click({ force: true });
    await settle(page, 500);
    const after = await page.evaluate(() => Array.from(document.querySelectorAll('[data-sidebar-panel="hosts"] [data-vault-section]')).map((e) => e.getAttribute("data-vault-section")));
    if (after.includes("Vault inaccessible")) throw new Error("la section inaccessible est toujours là après Rapatrier");
  }],
  // Un hôte d'un vault lu : formulaire grisé, et un bandeau qui dit pourquoi.
  ["39a2-formulaire-lecture-seule", async (page) => {
    await page.locator("[data-host-row='workstation-win']").hover();
    await page.locator("[data-host-row='workstation-win'] button[title='Options']").click();
    await settle(page, 200);
    await page.locator('[role="menu"] button', { hasText: "Modifier" }).click();
    await settle(page, 500);
    const form = await page.evaluate(() => {
      const f = document.querySelector("[data-form]");
      return {
        notice: !!f?.querySelector("[data-vault-read-only]"),
        nameDisabled: f?.querySelector("input")?.matches(":disabled") ?? false,
        vaultDisabled: (f?.querySelector("[data-vault-field]") ?? null)?.disabled ?? false,
      };
    });
    if (!form.notice || !form.nameDisabled || !form.vaultDisabled) throw new Error(`formulaire lecture seule : ${JSON.stringify(form)}`);
  }],
  // Et un hôte d'un vault où l'on écrit : le champ Vault, modifiable.
  ["39a3-formulaire-champ-vault", async (page) => {
    await page.locator("[data-form] button", { hasText: "Annuler" }).click();
    await settle(page, 200);
    await page.locator("[data-host-row='web-01']").hover();
    await page.locator("[data-host-row='web-01'] button[title='Options']").click();
    await settle(page, 200);
    await page.locator('[role="menu"] button', { hasText: "Modifier" }).click();
    await settle(page, 400);
    const editable = await page.evaluate(() => {
      const f = document.querySelector("[data-form]");
      const sel = f?.querySelector("[data-vault-field]");
      return { notice: !!f?.querySelector("[data-vault-read-only]"), vault: sel?.value, disabled: sel?.disabled };
    });
    if (editable.notice || editable.vault !== "v-infra" || editable.disabled) throw new Error(`formulaire d'un hôte partagé : ${JSON.stringify(editable)}`);
  }],
  // « Ouvrir le vault » mène au détail de ce vault dans le panneau GuiVault.
  ["39b-ouvrir-le-vault", async (page) => {
    await page.locator("[data-form] button", { hasText: "Annuler" }).click();
    await settle(page, 200);
    await page.locator('button[aria-label="Options de Équipe infra"]').click({ force: true });
    await settle(page, 300);
    await page.locator('[role="menu"] [role="menuitem"]', { hasText: "Ouvrir le vault" }).click();
    await settle(page, 600);
    const title = await page.evaluate(() => document.querySelector('[data-sidebar-panel="guivault"]')?.textContent ?? "");
    if (!/Équipe infra/.test(title) || !/Membres/.test(title)) throw new Error("le détail du vault ne s'est pas ouvert");
  }],
  // Clés, snippets, bases : les mêmes dossiers de vault.
  ["40-snippets-vaults", async (page) => {
    await clickNav(page, "Snippets");
    await settle(page, 300);
    const sections = await page.evaluate(() => Array.from(document.querySelectorAll('[data-sidebar-panel="snippets"] [data-vault-section]')).map((e) => e.getAttribute("data-vault-section")));
    if (sections[0] !== "Personnel" || !sections.includes("Équipe infra")) throw new Error(`dossiers de vault (snippets) : ${JSON.stringify(sections)}`);
  }],
  ["41-cles-vaults", async (page) => {
    await clickNav(page, "Clés");
    await settle(page, 300);
    const sections = await page.evaluate(() => Array.from(document.querySelectorAll('[data-sidebar-panel="keychain"] [data-vault-section]')).map((e) => e.getAttribute("data-vault-section")));
    if (!sections.includes("Lecture seule — prod bancaire")) throw new Error(`dossiers de vault (clés) : ${JSON.stringify(sections)}`);
    // La barre de profil est globale : présente ici comme sur Hôtes, et elle
    // dit l'état du compte.
    const bar = await page.evaluate(() => ({
      value: document.querySelector('[data-profile-bar] select')?.value,
      state: document.querySelector("[data-profile-state]")?.textContent ?? "",
    }));
    if (bar.value !== "account" || !/Synchronisé/.test(bar.state)) throw new Error(`barre de profil : ${JSON.stringify(bar)}`);
  }],
  ["42-bases-vaults", async (page) => {
    await clickNav(page, "Bases de données");
    await settle(page, 300);
    const sections = await page.evaluate(() => Array.from(document.querySelectorAll('[data-sidebar-panel="database"] [data-vault-section]')).map((e) => e.getAttribute("data-vault-section")));
    if (!sections.includes("Équipe infra")) throw new Error(`dossiers de vault (bases) : ${JSON.stringify(sections)}`);
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
