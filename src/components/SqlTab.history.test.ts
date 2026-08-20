import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// L'historique de requêtes a deux moitiés, et une seule est prouvée ailleurs.
//
// Le stockage est celui de `command_history`, déjà couvert côté Rust, et le
// scénario e2e vérifie la commande Tauri de bout en bout — mais il l'appelle
// par `invoke`, parce qu'ouvrir un vrai onglet SQL demanderait un serveur. Rien
// ne dirait donc que `SqlTab` appelle ces commandes : la fonctionnalité
// pourrait être entièrement fonctionnelle et entièrement inatteignable. C'est
// littéralement la panne MongoDB.
//
// Statique, et volontairement grossier : ce test ne prouve pas que l'affichage
// est correct, seulement que les deux appels existent là où ils doivent être.
// Le reste demande un serveur SQL, et il vaut mieux le dire que le simuler.

const source = readFileSync(fileURLToPath(new URL("./SqlTab.tsx", import.meta.url)), "utf8");

describe("câblage de l'historique de requêtes", () => {
  it("enregistre la requête après une exécution réussie", () => {
    expect(source).toContain("api.appendSqlHistory(");
  });

  it("relit l'historique pour l'afficher", () => {
    expect(source).toContain("api.sqlHistory()");
  });

  it("n'enregistre que depuis la branche de succès du bouton Exécuter", () => {
    // Ancré sur `const run =` et non sur le premier `api.runSqlQuery(` du
    // fichier : ce premier-là est l'aperçu d'une table (un `SELECT *` engendré
    // par un clic), qui n'a délibérément pas à entrer dans l'historique —
    // l'historique sert à rejouer ce qu'on a écrit. Une version précédente de
    // ce test découpait à partir de lui et échouait sur du code correct.
    const runBody = source.slice(source.indexOf("const run = () => {"));
    const thenPart = runBody.slice(0, runBody.indexOf(".catch("));
    expect(thenPart, "appendSqlHistory doit être dans le .then de run()").toContain("api.appendSqlHistory(");
  });

  it("laisse l'aperçu d'une table hors de l'historique", () => {
    const previewBody = source.slice(source.indexOf("api.runSqlQuery(sessionIdRef.current, `SELECT * FROM"));
    expect(previewBody.slice(0, previewBody.indexOf("};"))).not.toContain("appendSqlHistory");
  });

  it("remet une entrée choisie dans l'éditeur", () => {
    // Sans ça, la liste ne serait qu'un journal en lecture seule — l'intérêt
    // est de rejouer sans retaper.
    expect(source).toContain("setQuery(entry.command)");
  });

  it("lit bien le composant — sinon tout ce qui précède passerait à vide", () => {
    expect(source.length).toBeGreaterThan(10_000);
  });
});
