import { describe, expect, it } from "vitest";
import type { GuiVaultEntity } from "./types";
import { buildVaultTree, buildVaultTreeSections, visibleRows, type VaultTreeRow } from "./vaultTree";

// Le contenu d'un vault tel que le backend le liste : un dossier « Prod »
// avec un sous-dossier « Bases », des hôtes dedans et à la racine, une
// connexion, deux clés, un snippet.
function entity(id: string, kind: GuiVaultEntity["kind"], name: string, parentId: string | null = null, path = ""): GuiVaultEntity {
  return { id, kind, name, path, parentId, vaultId: null };
}

const prod = entity("g-prod", "group", "Prod");
const bases = entity("g-bases", "group", "Bases", "g-prod", "Prod");
const web = entity("h-web", "host", "web-01", "g-prod", "Prod");
const pg = entity("h-pg", "host", "pg-primary", "g-bases", "Prod / Bases");
const nas = entity("h-nas", "host", "nas", null);
const conn = entity("c-1", "sql-connection", "métriques", "g-bases", "Prod / Bases");
const key1 = entity("k-1", "key", "deploy-ed25519");
const key2 = entity("k-2", "key", "admin-rsa");
const snip = entity("s-1", "snippet", "maj système");
const all = [pg, key2, prod, snip, conn, web, nas, bases, key1];

const shape = (rows: VaultTreeRow[]) =>
  rows.map((r) => `${"  ".repeat(r.depth)}${r.kind === "entity" ? r.entity.name : r.kind === "folder" ? `▾ ${r.entity.name}` : r.kind === "bucket" ? `▾ ${r.label}` : `§ ${r.name}`}`);

describe("buildVaultTree", () => {
  it("range hôtes et connexions sous leurs dossiers, clés et snippets dans leur regroupement", () => {
    const { rows, visibleKeys } = buildVaultTree(all, "");
    expect(shape(rows)).toEqual([
      "nas",
      "▾ Prod",
      "  web-01",
      "  ▾ Bases",
      "    métriques",
      "    pg-primary",
      "▾ Clés",
      "  admin-rsa",
      "  deploy-ed25519",
      "▾ Snippets",
      "  maj système",
    ]);
    // Tout, dossiers compris : ce que « Tout » coche.
    expect(new Set(visibleKeys)).toEqual(new Set(all.map((e) => e.id)));
  });

  it("la case d'un dossier couvre le dossier lui-même et tout son sous-arbre", () => {
    const { rows } = buildVaultTree(all, "");
    const folder = rows.find((r) => r.kind === "folder" && r.entity.id === "g-prod");
    expect(folder?.kind === "folder" && new Set(folder.keys)).toEqual(new Set(["g-prod", "h-web", "g-bases", "c-1", "h-pg"]));
    const bucket = rows.find((r) => r.kind === "bucket" && r.label === "Clés");
    expect(bucket?.kind === "bucket" && bucket.keys).toEqual(["k-2", "k-1"]);
  });

  it("une entité dont le dossier n'est pas ici monte à la racine au lieu de disparaître", () => {
    const orphan = entity("h-orph", "host", "orphelin", "g-ailleurs", "Ailleurs");
    const { rows } = buildVaultTree([orphan, prod], "");
    expect(shape(rows)).toEqual(["orphelin", "▾ Prod"]);
  });

  it("la recherche garde les dossiers qui mènent à une correspondance, et vide ceux qui n'en ont pas", () => {
    const { rows, visibleKeys } = buildVaultTree(all, "pg");
    expect(shape(rows)).toEqual(["▾ Prod", "  ▾ Bases", "    pg-primary"]);
    expect(visibleKeys).toContain("h-pg");
    // Un dossier gardé pour son contenu reste cochable (il suivrait de toute
    // façon l'hôte au déplacement).
    expect(visibleKeys).toContain("g-prod");
  });

  it("un dossier qui correspond montre tout son contenu", () => {
    const { rows } = buildVaultTree(all, "bases");
    expect(shape(rows)).toEqual(["▾ Prod", "  ▾ Bases", "    métriques", "    pg-primary"]);
  });

  it("le genre est un critère de recherche (« clé »), et plusieurs mots se cumulent", () => {
    expect(shape(buildVaultTree(all, "clé").rows)).toEqual(["▾ Clés", "  admin-rsa", "  deploy-ed25519"]);
    expect(shape(buildVaultTree(all, "clé deploy").rows)).toEqual(["▾ Clés", "  deploy-ed25519"]);
    expect(buildVaultTree(all, "introuvable").rows).toEqual([]);
  });

  it("ne boucle pas sur un parentId cyclique", () => {
    const a = entity("g-a", "group", "A", "g-b");
    const b = entity("g-b", "group", "B", "g-a");
    const { rows } = buildVaultTree([a, b], "");
    expect(shape(rows)).toEqual(["▾ A", "▾ B"]);
  });
});

describe("buildVaultTreeSections", () => {
  const sections = [
    { key: "local", name: "Cet appareil", entities: [nas, snip] },
    { key: "personal", name: "Personnel", entities: [] },
    { key: "v-infra", name: "Équipe infra", entities: [prod, web, key1] },
  ];

  it("chaque emplacement est un dossier de premier niveau, vide compris", () => {
    const { rows } = buildVaultTreeSections(sections, "");
    expect(shape(rows)).toEqual([
      "§ Cet appareil",
      "  nas",
      "  ▾ Snippets",
      "    maj système",
      "§ Personnel",
      "§ Équipe infra",
      "  ▾ Prod",
      "    web-01",
      "  ▾ Clés",
      "    deploy-ed25519",
    ]);
    const local = rows[0];
    expect(local.kind === "section" && local.keys).toEqual(["h-nas", "s-1"]);
    expect(local.kind === "section" && local.count).toBe(2);
  });

  it("en recherche, un emplacement sans correspondance disparaît", () => {
    const { rows } = buildVaultTreeSections(sections, "web");
    expect(shape(rows)).toEqual(["§ Équipe infra", "  ▾ Prod", "    web-01"]);
  });

  it("les regroupements ont un id stable par emplacement, pour que replier survive à une recherche", () => {
    const ids = (q: string) => buildVaultTreeSections(sections, q).rows.filter((r) => r.kind === "bucket").map((r) => r.id);
    expect(ids("")).toEqual(["bucket:local:snippet", "bucket:v-infra:key"]);
    expect(ids("deploy")).toEqual(["bucket:v-infra:key"]);
  });
});

describe("visibleRows", () => {
  it("replier un en-tête cache tout ce qui est plus profond, jusqu'au suivant de même niveau", () => {
    const { rows } = buildVaultTree(all, "");
    expect(shape(visibleRows(rows, new Set(["g-prod"])))).toEqual([
      "nas", "▾ Prod", "▾ Clés", "  admin-rsa", "  deploy-ed25519", "▾ Snippets", "  maj système",
    ]);
    expect(shape(visibleRows(rows, new Set(["g-bases", "bucket::key"])))).toEqual([
      "nas", "▾ Prod", "  web-01", "  ▾ Bases", "▾ Clés", "▾ Snippets", "  maj système",
    ]);
  });
});
