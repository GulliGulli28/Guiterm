// Contrôle DOM/visuel du sélecteur d'hôtes arborescent (`HostTreePicker`).
//
// Pourquoi un vrai navigateur : ce qui a changé est de l'affichage. « Les
// dossiers apparaissent » veut dire qu'une ligne enfant est décalée vers la
// droite de sa parente ; « les tags apparaissent » veut dire qu'une pastille
// a une largeur non nulle. Ni `tsc` ni vitest (pas de moteur de rendu) ne
// peuvent l'affirmer, et la liste ne se déploie qu'au clic — c'est exactement
// le trou que `lib/targetTree.test.ts` et `lib/hostTree.test.ts` ne couvrent
// pas, eux ne testant que le calcul de l'arbre.
//
// Usage : node scripts/visual-check-host-picker.mjs
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

/** Les lignes de l'arbre telles qu'elles sont réellement dessinées. */
const readRows = (page) =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll("[data-host-tree-row]")).map((el) => {
      const rect = el.getBoundingClientRect();
      return {
        kind: el.getAttribute("data-host-tree-row"),
        label: el.getAttribute("data-host-tree-label"),
        depth: Number(el.getAttribute("data-host-tree-depth") ?? -1),
        left: Math.round(rect.left * 10) / 10,
        // Le décalage d'un niveau est une `padding-left` sur la ligne : c'est
        // donc son contenu qui bouge, pas sa boîte. Mesurer `rect.left` de la
        // ligne donnerait la même valeur à toutes les profondeurs.
        contentLeft: Math.round((el.firstElementChild ?? el).getBoundingClientRect().left * 10) / 10,
        width: Math.round(rect.width * 10) / 10,
        tags: Array.from(el.querySelectorAll("[data-host-tree-tag]")).map((tag) => ({
          text: tag.getAttribute("data-host-tree-tag"),
          width: Math.round(tag.getBoundingClientRect().width * 10) / 10,
        })),
      };
    }),
  );

try {
  const page = await browser.newPage({ viewport: { width: 500, height: 640 } });
  const consoleErrors = [];
  page.on("console", (msg) => { if (msg.type() === "error") consoleErrors.push(msg.text()); });
  page.on("pageerror", (err) => consoleErrors.push(String(err)));

  await page.goto("http://localhost:4324/scripts/visual-check-host-picker.html");
  await page.waitForFunction(() => typeof window.__pickerState === "function", { timeout: 10_000 });
  await mkdir(outDir, { recursive: true });

  // Fermé, rien de l'arbre n'est monté — c'est un bouton, pas une liste.
  if ((await readRows(page)).length > 0) errors.push("la liste est déployée avant tout clic");

  await page.click("button");
  await page.waitForSelector("[data-host-tree-row]");
  await page.screenshot({ path: path.join(outDir, "host-picker-open.png") });
  const rows = await readRows(page);

  // 1. L'entrée spéciale est épinglée en tête, avant tout hôte.
  if (rows[0]?.kind !== "special" || rows[0]?.label !== "Local") {
    errors.push(`la première ligne devrait être « Local », c'est ${JSON.stringify(rows[0])}`);
  }

  // 2. L'arborescence est là : les deux dossiers racine, le sous-dossier, les
  //    trois hôtes. Une liste plate n'aurait que les hôtes.
  const shape = rows.filter((r) => r.kind !== "special").map((r) => `${r.kind}:${r.label}@${r.depth}`);
  const expected = [
    "group:Labo@0", "host:api@1",
    "group:Prod@0", "group:Web@1", "host:api@2",
    "host:sans-dossier@0",
  ];
  if (shape.join(" | ") !== expected.join(" | ")) {
    errors.push(`arborescence inattendue :\n      obtenu  ${shape.join(" | ")}\n      attendu ${expected.join(" | ")}`);
  }

  // 3. L'indentation est réelle, pas seulement déclarée : chaque niveau est
  //    plus à droite que le précédent. C'est ce qu'un `<option>` ne peut pas
  //    faire et la seule preuve visible que l'arbre est un arbre.
  const byDepth = new Map();
  for (const row of rows) {
    if (row.depth < 0) continue;
    byDepth.set(row.depth, Math.min(byDepth.get(row.depth) ?? Infinity, row.contentLeft));
  }
  const depths = [...byDepth.keys()].sort((a, b) => a - b);
  for (let i = 1; i < depths.length; i += 1) {
    const previous = byDepth.get(depths[i - 1]);
    const current = byDepth.get(depths[i]);
    if (!(current > previous + 4)) {
      errors.push(`profondeur ${depths[i]} pas décalée par rapport à ${depths[i - 1]} (${current}px vs ${previous}px)`);
    }
  }

  // 4. Les tags sont dessinés, avec une largeur — une pastille vide ou
  //    repliée à zéro ne servirait à rien.
  const prodApi = rows.find((r) => r.kind === "host" && r.depth === 2);
  const prodTags = (prodApi?.tags ?? []).map((t) => t.text);
  if (prodTags.join(",") !== "prod,eu-west") {
    errors.push(`tags attendus « prod, eu-west » sur l'hôte de Prod › Web, obtenu « ${prodTags.join(", ")} »`);
  }
  for (const tag of prodApi?.tags ?? []) {
    if (tag.width < 10) errors.push(`la pastille « ${tag.text} » ne fait que ${tag.width}px de large`);
  }

  // 5. Entrée choisit la **première ligne affichée**, pas la première rangée
  //    en mémoire : « h-api- » retient les deux homonymes par leur adresse, et
  //    Labo étant trié avant Prod, c'est son « api » qui doit sortir.
  await page.fill("input[placeholder^=\"Rechercher\"]", "h-api-");
  await page.waitForFunction(() => document.querySelectorAll("[data-host-tree-row='host']").length === 2, { timeout: 3000 });
  await page.press("input[placeholder^=\"Rechercher\"]", "Enter");
  const afterEnter = await page.evaluate(() => window.__pickerState());
  if (afterEnter.picked !== "h-api-lab") {
    errors.push(`Entrée devrait choisir le premier hôte affiché (h-api-lab), obtenu ${afterEnter.picked}`);
  }
  await page.click("button");
  await page.waitForSelector("[data-host-tree-row]");

  // 6. La recherche par tag : « eu-west » n'est ni un libellé ni une adresse.
  //    Elle doit garder l'hôte tagué (et ses dossiers), et écarter son
  //    homonyme rangé ailleurs — ce que la liste plate ne pouvait pas faire.
  await page.fill("input[placeholder^=\"Rechercher\"]", "eu-west");
  await page.waitForFunction(
    () => document.querySelectorAll("[data-host-tree-row='host']").length === 1,
    { timeout: 3000 },
  ).catch(() => {});
  const filtered = await readRows(page);
  const filteredShape = filtered.filter((r) => r.kind !== "special").map((r) => `${r.kind}:${r.label}@${r.depth}`);
  if (filteredShape.join(" | ") !== "group:Prod@0 | group:Web@1 | host:api@2") {
    errors.push(`recherche « eu-west » : obtenu ${filteredShape.join(" | ") || "(rien)"}`);
  }
  await page.screenshot({ path: path.join(outDir, "host-picker-filtered.png") });

  // 7. Cliquer sur un hôte le sélectionne, par son identifiant — le seul
  //    endroit où deux homonymes se départagent.
  await page.click("[data-host-tree-row='host'] button");
  const state = await page.evaluate(() => window.__pickerState());
  if (state.picked !== "h-api-prod") {
    errors.push(`le clic devrait choisir h-api-prod (l'« api » de Prod › Web), obtenu ${state.picked}`);
  }
  if ((await readRows(page)).length > 0) errors.push("la liste reste ouverte après un choix");

  // 8. Rien ne déborde en largeur : le champ vit dans des barres serrées.
  const overflow = await page.evaluate(() => document.body.scrollWidth > document.body.clientWidth);
  if (overflow) errors.push("le sélecteur déborde horizontalement de son conteneur de 260px");

  if (consoleErrors.length > 0) errors.push(`erreurs console : ${consoleErrors.join(" | ")}`);
} finally {
  await browser.close();
  await server.close();
}

if (errors.length > 0) {
  console.error("ÉCHEC :\n" + errors.map((e) => ` - ${e}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log("OK : dossiers imbriqués et indentés, tags dessinés, Entrée sur la première ligne, recherche par tag, choix par identifiant.");
}
