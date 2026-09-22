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
  // Le formulaire d'un hôte à mot de passe montre la valeur enregistrée
  // derrière l'œil : sans ça, un champ vide ne dit pas si un mot de passe est
  // enregistré, et « je l'ai changé mais rien ne change » est invérifiable.
  ["16b-formulaire-mot-de-passe", async (page) => {
    await page.locator('[role="menu"] button', { hasText: "Modifier" }).click();
    await settle(page, 500);
    const before = await page.evaluate(() => {
      const input = document.querySelector("[data-form] [data-testid='host-secret']");
      return { type: input?.type, value: input?.value };
    });
    if (before.type !== "password" || before.value !== "hunter2-mais-plus-long") throw new Error(`mot de passe enregistré non chargé : ${JSON.stringify(before)}`);
    await page.locator('[data-form] button[aria-label="Afficher le mot de passe"]').click();
    await settle(page, 200);
    const after = await page.evaluate(() => document.querySelector("[data-form] [data-testid='host-secret']")?.type);
    if (after !== "text") throw new Error(`l'œil n'affiche pas le mot de passe : type=${after}`);
  }],
  ["17-menu-ajouter", async (page) => {
    await page.locator("[data-form] button", { hasText: "Annuler" }).click();
    await settle(page, 200);
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
  // Coller depuis GuiVault : le bouton de la barre d'onglets ouvre le
  // panneau à droite du terminal — une section par vault, les identifiants
  // de l'interface web rangés par dossier comme les hôtes ; un item cliqué
  // montre ses champs, jamais leurs valeurs, avec Copier / Coller / Coller
  // puis Entrée, et le code TOTP en direct.
  ["43-coller-guivault", async (page) => {
    // L'onglet actif est une vignette restaurée : le reconnecter donne un
    // vrai terminal (factice) dans lequel coller.
    await page.locator("button", { hasText: "Reconnecter" }).first().click();
    await page.waitForSelector(".xterm-screen", { timeout: 10_000 });
    await settle(page, 400);
    await page.locator("[data-vault-browser-toggle]").click();
    await settle(page, 500);
    const tree = await page.evaluate(() => Array.from(document.querySelectorAll("[data-vault-browser] [data-vault-entity]")).map((e) => e.getAttribute("data-vault-entity")));
    for (const name of ["GitHub", "Procédure astreinte", "Visa pro", "web-01", "deploy-ed25519", "Journal nginx"]) {
      if (!tree.includes(name)) throw new Error(`arbre du panneau : ${name} manque dans ${JSON.stringify(tree)}`);
    }
    await page.locator("[data-vault-browser] [data-vault-entity='GitHub'] button").first().click();
    await settle(page, 400);
    const fields = await page.evaluate(() => ({
      labels: Array.from(document.querySelectorAll("[data-browse-fields] li")).map((li) => li.querySelector("span span")?.textContent ?? ""),
      totp: document.querySelector("[data-totp-code]")?.getAttribute("data-totp-code"),
      pasteButtons: document.querySelectorAll("[data-browse-fields] button[aria-label^='Coller']").length,
      text: document.querySelector("[data-browse-fields]")?.textContent ?? "",
      masked: document.querySelectorAll("[data-browse-value='masked']").length,
    }));
    if (fields.labels.join("|") !== "Utilisateur|Mot de passe|Code TOTP|Site") throw new Error(`champs de GitHub : ${JSON.stringify(fields.labels)}`);
    if (fields.totp !== "492817") throw new Error("le code TOTP ne s'affiche pas");
    if (fields.pasteButtons !== 8) throw new Error(`boutons Coller : ${fields.pasteButtons}`);
    // Les valeurs sont là — l'utilisateur et le site en clair, le mot de
    // passe masqué jusqu'à l'œil.
    if (!/alice/.test(fields.text) || !/github\.com/.test(fields.text)) throw new Error(`valeurs en clair absentes : ${fields.text}`);
    if (/s3cret/.test(fields.text) || fields.masked !== 1) throw new Error("le mot de passe devrait être masqué");
    await page.locator("[data-browse-fields] button[aria-label='Afficher Mot de passe']").click();
    await settle(page, 200);
    const revealed = await page.evaluate(() => document.querySelector("[data-browse-fields]")?.textContent ?? "");
    if (!/s3cret-hunter2/.test(revealed)) throw new Error("l'œil ne révèle pas le mot de passe");
    const footer = await page.evaluate(() => document.querySelector("[data-vault-browser]")?.textContent ?? "");
    if (!/Coller écrit dans web-01/.test(footer)) throw new Error(`le panneau ne dit pas dans quel terminal il colle : ${footer.slice(-80)}`);
    // Coller « Utilisateur », puis « Mot de passe » avec Entrée : la valeur
    // est demandée au moment de l'appui et arrive dans la session par le
    // chemin d'un collage (xterm → onData → write_terminal), l'Entrée derrière.
    await page.locator("[data-browse-fields] button[aria-label='Coller Utilisateur']").click();
    await settle(page, 300);
    await page.locator("[data-browse-fields] button[aria-label='Coller Mot de passe puis Entrée']").click();
    await settle(page, 300);
    const written = await page.evaluate(() => (window.__tourWritten ?? []).join(""));
    if (!/alice/.test(written) || !/s3cret-hunter2\r/.test(written)) throw new Error(`collage dans le terminal : ${JSON.stringify(written)}`);
  }],
  // Tout au clavier, sans quitter l'arbre : ↓ depuis la recherche, Entrée
  // ouvre, ↓ descend dans les champs, Entrée colle, Espace révèle,
  // Maj+Entrée colle puis Entrée — et le focus est resté dans l'arbre.
  ["43a-coller-guivault-clavier", async (page) => {
    // GitHub est resté ouvert de la scène précédente : le refermer (un clic
    // sur son en-tête), puis repartir de la recherche.
    await page.locator("[data-vault-browser] [data-vault-entity='GitHub'] > button").click();
    await settle(page, 200);
    await page.locator("[data-vault-browser] input[aria-label='Rechercher dans les vaults']").click();
    await page.evaluate(() => { window.__tourWritten = []; });
    await page.keyboard.press("ArrowDown");
    await settle(page, 100);
    // Le curseur est resté sur GitHub (le dernier item cliqué) : ↓ mène à
    // Registre Docker, juste en dessous.
    await page.keyboard.press("ArrowDown");
    await settle(page, 60);
    let cursor = await page.evaluate(() => document.querySelector("[data-browse-entity][data-cursor]")?.getAttribute("data-vault-entity"));
    if (cursor !== "Registre Docker") throw new Error(`curseur après ↓ : ${cursor}`);
    await page.keyboard.press("ArrowUp");
    await settle(page, 60);
    cursor = await page.evaluate(() => document.querySelector("[data-browse-entity][data-cursor]")?.getAttribute("data-vault-entity"));
    if (cursor !== "GitHub") throw new Error(`curseur après ↑ : ${cursor}`);
    await page.keyboard.press("Enter");
    await settle(page, 400);
    await page.keyboard.press("ArrowDown");
    await settle(page, 100);
    let field = await page.evaluate(() => document.querySelector("[data-browse-field][data-cursor]")?.getAttribute("data-browse-field"));
    if (field !== "username") throw new Error(`champ sous le curseur : ${field}`);
    await page.keyboard.press("Enter");
    await settle(page, 200);
    await page.keyboard.press("ArrowDown");
    await settle(page, 100);
    field = await page.evaluate(() => document.querySelector("[data-browse-field][data-cursor]")?.getAttribute("data-browse-field"));
    if (field !== "password") throw new Error(`champ sous le curseur : ${field}`);
    await page.keyboard.press("Space");
    await settle(page, 100);
    await page.keyboard.press("Shift+Enter");
    await settle(page, 200);
    const after = await page.evaluate(() => ({
      written: (window.__tourWritten ?? []).join(""),
      focus: document.activeElement?.getAttribute("role"),
      shown: document.querySelector("[data-browse-field='password'] [data-browse-value]")?.getAttribute("data-browse-value"),
    }));
    if (!/^alice/.test(after.written) || !/s3cret-hunter2\r$/.test(after.written)) throw new Error(`collage au clavier : ${JSON.stringify(after.written)}`);
    if (after.focus !== "tree") throw new Error(`le focus a quitté l'arbre : ${after.focus}`);
    if (after.shown !== "shown") throw new Error("Espace n'a pas révélé le mot de passe");
    // ↓ continue après le dernier champ vers l'item suivant.
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await settle(page, 100);
    cursor = await page.evaluate(() => document.querySelector("[data-browse-entity][data-cursor]")?.getAttribute("data-vault-entity"));
    if (cursor !== "Registre Docker") throw new Error(`curseur après les champs : ${cursor}`);
    // Une lettre ramène à la recherche.
    await page.keyboard.press("r");
    await settle(page, 200);
    const search = await page.evaluate(() => ({ focus: document.activeElement?.getAttribute("aria-label"), value: document.activeElement?.value }));
    if (search.focus !== "Rechercher dans les vaults" || search.value !== "r") throw new Error(`retour à la recherche : ${JSON.stringify(search)}`);
    await page.keyboard.press("Escape");
    await settle(page, 100);
  }],
  // Le filtre par type et la recherche.
  ["43b-coller-guivault-filtre", async (page) => {
    await page.locator("[data-vault-browser] button", { hasText: "Identifiants" }).click();
    await settle(page, 300);
    const only = await page.evaluate(() => Array.from(document.querySelectorAll("[data-vault-browser] [data-vault-entity]")).map((e) => e.getAttribute("data-vault-entity")));
    if (only.join("|") !== "GitHub|Registre Docker|Console cloud") throw new Error(`filtre Identifiants : ${JSON.stringify(only)}`);
    // Sous « Notes », la note est à la racine : aucun dossier ne reste.
    await page.locator("[data-vault-browser] button", { hasText: "Notes" }).click();
    await settle(page, 300);
    const folders = await page.evaluate(() => Array.from(document.querySelectorAll("[data-vault-browser] button[aria-label^='Replier']")).map((b) => b.getAttribute("aria-label")));
    if (folders.join("|") !== "Replier Personnel") throw new Error(`filtre Notes garde des dossiers : ${JSON.stringify(folders)}`);
    await page.locator("[data-vault-browser] button", { hasText: "Identifiants" }).click();
    await settle(page, 300);
    await page.locator("[data-vault-browser] input[aria-label='Rechercher dans les vaults']").fill("robot");
    await settle(page, 300);
    const found = await page.evaluate(() => Array.from(document.querySelectorAll("[data-vault-browser] [data-vault-entity]")).map((e) => e.getAttribute("data-vault-entity")));
    if (found.join("|") !== "Registre Docker") throw new Error(`recherche par utilisateur : ${JSON.stringify(found)}`);
  }],
  // Tout au clavier : Ctrl+Maj+P liste les items, Entrée sur l'un liste ses
  // champs (coller, coller puis Entrée, copier).
  ["44-coller-guivault-palette", async (page) => {
    await page.locator("[data-vault-browser] button[aria-label='Fermer le panneau GuiVault']").click();
    await settle(page, 300);
    await page.keyboard.press("Control+Shift+P");
    await settle(page, 500);
    await page.keyboard.type("console");
    await settle(page, 200);
    const items = await page.evaluate(() => Array.from(document.querySelectorAll(".modal button")).map((b) => b.textContent ?? ""));
    if (items.length !== 1 || !/Équipe infra › Production › Console cloud/.test(items[0])) throw new Error(`palette des items : ${JSON.stringify(items)}`);
    await page.keyboard.press("Enter");
    await settle(page, 300);
    const actions = await page.evaluate(() => ({
      title: document.querySelector(".modal .eyebrow")?.textContent ?? "",
      rows: Array.from(document.querySelectorAll(".modal button")).map((b) => b.querySelector("span")?.textContent ?? ""),
    }));
    if (!/Console cloud/.test(actions.title)) throw new Error(`titre de la palette des champs : ${actions.title}`);
    const expected = ["Coller « Utilisateur »", "Coller « Utilisateur » puis Entrée", "Copier « Utilisateur »", "Coller « Mot de passe »", "Coller « Mot de passe » puis Entrée", "Copier « Mot de passe »"];
    if (actions.rows.join("|") !== expected.join("|")) throw new Error(`palette des champs : ${JSON.stringify(actions.rows)}`);
  }],
  // ── Navigation au clavier de l'app entière ─────────────────────────
  // Alt+N ouvre le n-ième panneau visible et lui donne le focus, curseur sur
  // la première ligne ; le même Alt+N rend la main au terminal.
  ["45-clavier-panneaux", async (page) => {
    await page.keyboard.press("Escape");
    await settle(page, 200);
    await page.keyboard.press("Alt+3");
    await settle(page, 400);
    const sftp = await page.evaluate(() => ({
      panel: document.querySelector("[data-sidebar-panel]")?.getAttribute("data-sidebar-panel"),
      focus: document.activeElement?.getAttribute("data-focus-zone"),
      cursor: !!document.querySelector("[data-focus-zone='sidebar-panel'] [data-nav-cursor]"),
      title: document.querySelector("[data-sidebar-button='sftp']")?.getAttribute("title"),
    }));
    if (sftp.panel !== "sftp" || sftp.focus !== "sidebar-panel" || !sftp.cursor) throw new Error(`Alt+3 : ${JSON.stringify(sftp)}`);
    if (!/Alt\+3/.test(sftp.title ?? "")) throw new Error(`l'infobulle ne dit pas le raccourci : ${sftp.title}`);
    await page.keyboard.press("Alt+3");
    await settle(page, 200);
    const back = await page.evaluate(() => document.activeElement?.closest(".xterm") !== null);
    if (!back) throw new Error("le second Alt+3 n'a pas rendu le focus au terminal");
    await page.keyboard.press("Alt+2");
    await settle(page, 400);
  }],
  // Dans le panneau Hôtes : ↑/↓ parcourent dossiers et hôtes, → déplie, ←
  // replie puis remonte, Entrée se connecte, une lettre va à la recherche
  // et ↓ en revient, Échap rend le terminal.
  ["46-clavier-hotes", async (page) => {
    const cursorText = () => page.evaluate(() => document.querySelector("[data-focus-zone='sidebar-panel'] [data-nav-cursor]")?.textContent?.trim().slice(0, 30) ?? null);
    const panel = await page.evaluate(() => document.querySelector("[data-sidebar-panel]")?.getAttribute("data-sidebar-panel"));
    if (panel !== "hosts") throw new Error(`panneau attendu : Hôtes, vu ${panel}`);
    await page.keyboard.press("Home");
    const first = await cursorText();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    const third = await cursorText();
    if (!first || !third || first === third) throw new Error(`le curseur ne bouge pas : ${first} → ${third}`);
    // Un dossier : ← le replie, → le redéplie ; le nombre de lignes visibles
    // le prouve.
    await page.keyboard.press("Home");
    const folderRow = await page.evaluate(() => {
      const row = document.querySelector("[data-focus-zone='sidebar-panel'] [data-nav-cursor]");
      return { folder: !!row?.querySelector("[data-nav-toggle]"), state: row?.querySelector("[data-nav-toggle]")?.getAttribute("data-nav-toggle") };
    });
    if (!folderRow.folder) throw new Error("la première ligne du panneau Hôtes devrait être un dossier");
    const count = () => page.evaluate(() => Array.from(document.querySelectorAll("[data-focus-zone='sidebar-panel'] [data-nav-row]")).filter((r) => r.offsetParent !== null).length);
    const before = await count();
    await page.keyboard.press(folderRow.state === "expanded" ? "ArrowLeft" : "ArrowRight");
    await settle(page, 200);
    const after = await count();
    if (after === before) throw new Error(`←/→ n'a pas replié/déplié le dossier (${before} → ${after})`);
    await page.keyboard.press(folderRow.state === "expanded" ? "ArrowRight" : "ArrowLeft");
    await settle(page, 200);
    // ← sur un hôte remonte à son dossier.
    await page.keyboard.press("ArrowDown");
    const child = await cursorText();
    await page.keyboard.press("ArrowLeft");
    const parent = await cursorText();
    if (parent === child) throw new Error("← sur un hôte devrait remonter au dossier");
    // Une lettre va à la recherche, et la reçoit ; ↓ revient à la liste.
    await page.keyboard.press("w");
    await settle(page, 200);
    const search = await page.evaluate(() => ({ focused: document.activeElement?.hasAttribute("data-panel-search"), value: document.activeElement?.value }));
    if (!search.focused || search.value !== "w") throw new Error(`la lettre n'est pas allée à la recherche : ${JSON.stringify(search)}`);
    await page.keyboard.type("eb-01");
    await settle(page, 300);
    await page.keyboard.press("ArrowDown");
    await settle(page, 100);
    const focusBack = await page.evaluate(() => document.activeElement?.getAttribute("data-focus-zone"));
    if (focusBack !== "sidebar-panel") throw new Error(`↓ depuis la recherche ne revient pas à la liste : ${focusBack}`);
    // Entrée sur l'hôte trouvé : un onglet de plus, le terminal a le focus.
    await page.keyboard.press("End");
    const target = await cursorText();
    if (!/web-01/.test(target ?? "")) throw new Error(`le curseur devrait être sur web-01 : ${target}`);
    const tabsBefore = await page.evaluate(() => document.querySelectorAll("[data-tab-id]").length);
    await page.keyboard.press("Enter");
    await settle(page, 1200);
    const tabsAfter = await page.evaluate(() => document.querySelectorAll("[data-tab-id]").length);
    if (tabsAfter <= tabsBefore) throw new Error(`Entrée n'a pas ouvert d'onglet (${tabsBefore} → ${tabsAfter})`);
    // Le focus est dans le nouveau terminal.
    const inTerm = await page.evaluate(() => document.activeElement?.closest(".xterm") !== null);
    if (!inTerm) throw new Error("après connexion, le focus devrait être dans le terminal");
  }],
  // Maj+F10 ouvre le menu « … » de l'hôte sous le curseur, ↓ y circule,
  // Échap le ferme.
  ["46b-clavier-menu-hote", async (page) => {
    await page.keyboard.press("Alt+2");
    await settle(page, 300);
    await page.keyboard.press("End");
    await settle(page, 100);
    const where = await page.evaluate(() => ({ zone: document.activeElement?.closest("[data-focus-zone]")?.getAttribute("data-focus-zone"), cursor: document.querySelector("[data-focus-zone='sidebar-panel'] [data-nav-cursor]")?.textContent?.trim().slice(0, 20), menuBtn: !!document.querySelector("[data-focus-zone='sidebar-panel'] [data-nav-cursor] [data-nav-menu]") }));
    await page.keyboard.press("Shift+F10");
    await settle(page, 300);
    const menu = await page.evaluate(() => ({
      open: !!document.querySelector("[role='menu']"),
      focused: document.activeElement?.classList.contains("menu-item"),
      first: document.activeElement?.textContent?.trim(),
      where: null,
    }));
    menu.where = where;
    if (!menu.open || !menu.focused) throw new Error(`Maj+F10 : ${JSON.stringify(menu)}`);
    await page.keyboard.press("ArrowDown");
    const second = await page.evaluate(() => document.activeElement?.textContent?.trim());
    if (second === menu.first) throw new Error("↓ dans le menu ne bouge pas");
    await page.keyboard.press("Escape");
    await settle(page, 200);
    const closed = await page.evaluate(() => !document.querySelector("[role='menu']"));
    if (!closed) throw new Error("Échap ne ferme pas le menu");
    // Le focus est revenu à la liste, curseur toujours sur l'hôte.
    const backInList = await page.evaluate(() => document.activeElement?.getAttribute("data-focus-zone"));
    if (backInList !== "sidebar-panel") throw new Error(`après le menu, le focus devrait revenir à la liste : ${backInList}`);
  }],
  // F6 fait le tour des zones ; Ctrl+Maj+Espace va droit au terminal ;
  // Ctrl+, ouvre les paramètres avec le focus, et les referme.
  ["47-clavier-zones", async (page) => {
    await page.keyboard.press("Control+Shift+Space");
    await settle(page, 100);
    const zone = () => page.evaluate(() => document.activeElement?.closest("[data-focus-zone]")?.getAttribute("data-focus-zone") ?? null);
    if ((await zone()) !== "main") throw new Error(`Ctrl+Maj+Espace : ${await zone()}`);
    await page.keyboard.press("F6");
    await settle(page, 100);
    const z1 = await zone();
    await page.keyboard.press("F6");
    await settle(page, 100);
    const z2 = await zone();
    await page.keyboard.press("F6");
    await settle(page, 100);
    const z3 = await zone();
    if ([z1, z2, z3].join(">") !== "sidebar-nav>sidebar-panel>main") throw new Error(`F6 : ${[z1, z2, z3].join(">")}`);
    await page.keyboard.press("Shift+F6");
    await settle(page, 100);
    if ((await zone()) !== "sidebar-panel") throw new Error(`Maj+F6 : ${await zone()}`);
    // Dans la bande : ↓ puis Entrée ouvre un autre panneau.
    await page.keyboard.press("Shift+F6");
    await settle(page, 100);
    await page.keyboard.press("Home");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await settle(page, 300);
    const opened = await page.evaluate(() => document.querySelector("[data-sidebar-panel]")?.getAttribute("data-sidebar-panel"));
    if (opened !== "snippets") throw new Error(`Entrée dans la bande : ${opened}`);
    // Les paramètres, aller-retour.
    await page.keyboard.press("Control+,");
    await settle(page, 400);
    const settings = await page.evaluate(() => ({ panel: document.querySelector("[data-sidebar-panel]")?.getAttribute("data-sidebar-panel"), zone: document.activeElement?.closest("[data-focus-zone]")?.getAttribute("data-focus-zone") }));
    if (settings.panel !== "settings" || settings.zone !== "sidebar-panel") throw new Error(`Ctrl+, : ${JSON.stringify(settings)}`);
    await page.keyboard.press("Control+,");
    await settle(page, 400);
    const closed = await page.evaluate(() => ({ panel: document.querySelector("[data-sidebar-panel]")?.getAttribute("data-sidebar-panel"), inTerm: document.activeElement?.closest(".xterm") !== null }));
    if (closed.panel !== "snippets" || !closed.inTerm) throw new Error(`second Ctrl+, : ${JSON.stringify(closed)}`);
    await page.keyboard.press("Alt+2");
    await settle(page, 300);
  }],
  // Tous les panneaux sont atteignables : Alt+0 ouvre le dixième, Alt+Page
  // suiv./préc. atteint les onzième et douzième (Diagnostic réseau,
  // GuiVault), et la palette les liste tous par leur nom.
  ["48-clavier-tous-les-panneaux", async (page) => {
    const panel = () => page.evaluate(() => document.querySelector("[data-sidebar-panel]")?.getAttribute("data-sidebar-panel"));
    const zone = () => page.evaluate(() => document.activeElement?.getAttribute("data-focus-zone"));
    await page.keyboard.press("Alt+0");
    await settle(page, 400);
    if ((await panel()) !== "runbook") throw new Error(`Alt+0 devrait ouvrir le dixième panneau (Runbooks) : ${await panel()}`);
    if ((await zone()) !== "sidebar-panel") throw new Error("Alt+0 n'a pas donné le focus au panneau");
    await page.keyboard.press("Alt+PageDown");
    await settle(page, 500);
    if ((await panel()) !== "netdiag") throw new Error(`Alt+Page suiv. : ${await panel()}`);
    await page.keyboard.press("Alt+PageDown");
    await settle(page, 500);
    if ((await panel()) !== "guivault") throw new Error(`Alt+Page suiv. ×2 : ${await panel()}`);
    await page.keyboard.press("Alt+PageUp");
    await settle(page, 400);
    if ((await panel()) !== "netdiag") throw new Error(`Alt+Page préc. : ${await panel()}`);
    // Et par son nom dans la palette.
    await page.keyboard.press("Control+k");
    await settle(page, 300);
    await page.keyboard.type("panneau");
    await settle(page, 200);
    const rows = await page.evaluate(() => Array.from(document.querySelectorAll(".modal button")).map((b) => b.querySelector("span")?.textContent ?? ""));
    for (const expected of ["Panneau — Runbooks", "Panneau — Diagnostic réseau", "Panneau — GuiVault"]) {
      if (!rows.includes(expected)) throw new Error(`« ${expected} » absent de la palette : ${JSON.stringify(rows)}`);
    }
    await page.keyboard.type(" clés");
    await settle(page, 200);
    await page.keyboard.press("Enter");
    await settle(page, 500);
    if ((await panel()) !== "keychain" || (await zone()) !== "sidebar-panel") throw new Error(`la palette n'a pas ouvert et focalisé le panneau : ${await panel()} / ${await zone()}`);
  }],
  // Dans la bande, Entrée ouvre le panneau **et y va** ; dans les
  // Paramètres, ↑/↓ et Entrée passent d'une catégorie à l'autre.
  ["49-clavier-parametres", async (page) => {
    await page.keyboard.press("Escape");
    await settle(page, 200);
    await page.keyboard.press("F6");
    await settle(page, 150);
    await page.keyboard.press("Home");
    await page.keyboard.press("Enter");
    await settle(page, 400);
    const afterEnter = await page.evaluate(() => ({
      panel: document.querySelector("[data-sidebar-panel]")?.getAttribute("data-sidebar-panel"),
      zone: document.activeElement?.getAttribute("data-focus-zone"),
    }));
    if (afterEnter.panel !== "knownHosts" || afterEnter.zone !== "sidebar-panel") throw new Error(`Entrée dans la bande : ${JSON.stringify(afterEnter)}`);
    // Les paramètres : le focus arrive dedans, ↓ et Entrée changent de
    // catégorie, et le titre de droite suit.
    await page.keyboard.press("Control+,");
    await settle(page, 500);
    const current = () => page.evaluate(() => document.querySelector("[data-settings-category][data-active='true']")?.getAttribute("data-settings-category"));
    const first = await current();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await settle(page, 300);
    const moved = await current();
    if (!first || moved === first) throw new Error(`↑/↓ + Entrée ne changent pas de catégorie : ${first} → ${moved}`);
    const heading = await page.evaluate(() => document.querySelector("[data-sidebar-panel='settings'] .sidebar-scroll p")?.textContent?.trim());
    const label = await page.evaluate((k) => document.querySelector(`[data-settings-category='${k}']`)?.textContent?.trim(), moved);
    if (heading !== label) throw new Error(`le contenu ne suit pas la catégorie : « ${heading} » pour « ${label} »`);
    await page.keyboard.press("Control+,");
    await settle(page, 400);
    await page.keyboard.press("Alt+2");
    await settle(page, 300);
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
