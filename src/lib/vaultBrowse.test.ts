import { describe, expect, it } from "vitest";
import type { GuiVaultBrowseEntry, GuiVaultBrowseField } from "./types";
import { browseSections, countByKind, paletteRows } from "./vaultBrowse";
import { buildVaultTreeSections, type VaultTreeRow } from "./vaultTree";

// Ce que `guivault_browse` rend : le vault personnel puis un vault partagé,
// des dossiers, un identifiant de l'interface web rangé dans un dossier, un
// hôte, une note à la racine, une clé.
const field = (key: string, secret = false): GuiVaultBrowseField => ({ key, label: key, secret, multiline: false, totp: false });
function entry(id: string, kind: GuiVaultBrowseEntry["kind"], name: string, vault: "perso" | "equipe", parentId: string | null = null, extra: Partial<GuiVaultBrowseEntry> = {}): GuiVaultBrowseEntry {
  return {
    id, kind, name, parentId, vaultId: `v-${vault}`, vaultName: vault === "perso" ? "Personnel" : "Équipe infra",
    tags: [], search: "", fields: kind === "group" ? [] : [field("username"), field("password", true)], ...extra,
  };
}

const prod = entry("g-prod", "group", "Prod", "perso");
const bases = entry("g-bases", "group", "Bases", "perso", "g-prod");
const github = entry("l-gh", "login", "GitHub", "perso", "g-bases", { search: "alice github.com", tags: ["dev"] });
const web = entry("h-web", "host", "web-01", "perso", "g-prod", { search: "10.0.0.5 deploy" });
const note = entry("n-1", "note", "Procédure", "perso", null, { fields: [{ key: "content", label: "Contenu", secret: false, multiline: true, totp: false }] });
const key = entry("k-1", "key", "deploy", "perso", null, { fields: [field("passphrase", true)] });
const sharedGroup = entry("g-shared", "group", "Comptes", "equipe");
const sharedLogin = entry("l-shared", "login", "admin", "equipe", "g-shared");
const emptyKey = entry("k-empty", "key", "sans-rien", "equipe", null, { fields: [] });
const all = [prod, bases, github, web, note, key, sharedGroup, sharedLogin, emptyKey];

const shape = (rows: VaultTreeRow[]) =>
  rows.map((r) => `${"  ".repeat(r.depth)}${r.kind === "entity" ? r.entity.name : r.kind === "folder" ? `▾ ${r.entity.name}` : r.kind === "bucket" ? `▾ ${r.label}` : `§ ${r.name}`}`);

describe("browseSections", () => {
  it("fait une section par vault, dans l'ordre reçu, avec le chemin de chaque item", () => {
    const sections = browseSections(all, "all");
    expect(sections.map((s) => s.name)).toEqual(["Personnel", "Équipe infra"]);
    const gh = sections[0].entities.find((e) => e.id === "l-gh")!;
    expect(gh.path).toBe("Prod › Bases");
    expect(gh.search).toBe("alice github.com");
    expect(gh.tags).toEqual(["dev"]);
    // Et l'arbre habituel s'en sert tel quel : un identifiant se range par
    // dossier comme un hôte.
    const { rows } = buildVaultTreeSections(sections, "");
    expect(shape(rows)).toEqual([
      "§ Personnel",
      "  Procédure",
      "  ▾ Prod",
      "    web-01",
      "    ▾ Bases",
      "      GitHub",
      "  ▾ Clés",
      "    deploy",
      "§ Équipe infra",
      "  ▾ Comptes",
      "    admin",
      "  ▾ Clés",
      "    sans-rien",
    ]);
  });

  it("un filtre par type ne garde que ce type et ses dossiers, et tait un vault qui n'en a pas", () => {
    const sections = browseSections(all, "note");
    expect(sections.map((s) => s.name)).toEqual(["Personnel"]);
    expect(sections[0].entities.map((e) => e.kind).sort()).toEqual(["group", "group", "note"]);
    const logins = browseSections(all, "login");
    expect(logins.map((s) => s.entities.filter((e) => e.kind === "login").map((e) => e.name))).toEqual([["GitHub"], ["admin"]]);
  });

  it("la recherche de l'arbre trouve un identifiant par son utilisateur, son site ou son tag", () => {
    const sections = browseSections(all, "all");
    for (const q of ["alice", "github.com", "dev"]) {
      const { rows } = buildVaultTreeSections(sections, q);
      expect(rows.filter((r) => r.kind === "entity").map((r) => r.entity.name), q).toEqual(["GitHub"]);
    }
    const { rows } = buildVaultTreeSections(sections, "identifiant");
    expect(rows.filter((r) => r.kind === "entity").map((r) => r.entity.name)).toEqual(["GitHub", "admin"]);
  });

  it("un parent qui boucle ou qui manque n'empêche pas le chemin", () => {
    const a = entry("g-a", "group", "A", "perso", "g-b");
    const b = entry("g-b", "group", "B", "perso", "g-a");
    const orphan = entry("l-o", "login", "orphelin", "perso", "g-nope");
    const inLoop = entry("l-l", "login", "bouclé", "perso", "g-a");
    const sections = browseSections([a, b, orphan, inLoop], "all");
    expect(sections[0].entities.find((e) => e.id === "l-o")!.path).toBe("");
    expect(sections[0].entities.find((e) => e.id === "l-l")!.path).toBe("B › A");
  });
});

describe("countByKind", () => {
  it("compte chaque type, dossiers compris", () => {
    expect(countByKind(all)).toEqual({ group: 3, login: 2, host: 1, note: 1, key: 2 });
  });
});

describe("paletteRows", () => {
  it("liste chaque item collable avec vault et chemin dans le libellé, jamais un dossier ni un item sans champ", () => {
    const rows = paletteRows(all);
    expect(rows.map((r) => r.label)).toEqual([
      "Personnel › Prod › Bases › GitHub",
      "Personnel › Prod › web-01",
      "Personnel › Procédure",
      "Personnel › deploy",
      "Équipe infra › Comptes › admin",
    ]);
    expect(rows[0].keywords).toBe("alice github.com dev");
  });
});
