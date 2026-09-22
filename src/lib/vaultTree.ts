import type { GuiVaultEntity, GuiVaultEntityKind } from "./types";

/**
 * L'arborescence à cocher du contenu des vaults (panneau GuiVault : le
 * contenu d'un vault, et le dialogue « Ajouter » qui montre les autres
 * emplacements), préparée en une passe.
 *
 * **Le même geste que le menu d'hôtes.** `buildTargetTree` (`targetTree.ts`)
 * range des cibles de flotte par dossier ; ici ce sont des entités de vault
 * (`GuiVaultEntity`, telles que le backend les liste) — dont les dossiers
 * eux-mêmes sont des entités qu'on peut déplacer. D'où une troisième
 * fonction plutôt qu'une généralisation forcée : un dossier a ici sa propre
 * case (cocher un dossier, c'est le sélectionner lui *et* son sous-arbre,
 * exactement ce que le backend ferme de toute façon).
 *
 * Le résultat est une **liste plate de lignes déjà ordonnées et indentées**,
 * comme les deux autres : le composant ne fait que la parcourir.
 *
 * Forme, dans une section (un emplacement : cet appareil, personnel, un vault
 * partagé) :
 *
 *   ▾ Section                       [case : tout l'emplacement]
 *     hôte, connexion à la racine   [case]
 *     ▾ Dossier                     [case : le dossier et son sous-arbre]
 *        hôte                       [case]
 *        ▾ Sous-dossier             [case]
 *     ▾ Clés                        [case : toutes les clés]
 *        clé                        [case]
 *     ▾ Snippets                    [case]
 *        snippet                    [case]
 *
 * Sans section (le contenu d'un seul vault), la même chose à partir du
 * niveau 0.
 */

export const KIND_LABELS: Record<GuiVaultEntityKind, string> = {
  host: "hôte", group: "dossier", snippet: "snippet", key: "clé", "sql-connection": "connexion", icon: "icône",
  login: "identifiant", note: "note", card: "carte", identity: "identité",
};

/** Un emplacement à afficher comme un dossier de premier niveau. */
export interface VaultTreeSection {
  /** Unique parmi les sections (`local`, `personal`, l'id du vault). */
  key: string;
  name: string;
  entities: GuiVaultEntity[];
}

export type VaultTreeRow =
  /** Un emplacement. `keys` couvre tout ce qu'il contient. */
  | { kind: "section"; id: string; name: string; depth: number; keys: string[]; count: number }
  /** Un dossier — lui-même une entité. `keys` = lui et son sous-arbre. */
  | { kind: "folder"; id: string; entity: GuiVaultEntity; depth: number; keys: string[] }
  /** Un regroupement sans existence propre (« Clés », « Snippets »). `keys`
   * = ce qu'il contient. */
  | { kind: "bucket"; id: string; label: string; depth: number; keys: string[] }
  /** Une entité cochable. */
  | { kind: "entity"; id: string; entity: GuiVaultEntity; depth: number };

export interface VaultTree {
  rows: VaultTreeRow[];
  /** Les ids de toutes les entités retenues (dossiers compris), dans l'ordre
   * d'affichage — ce que « Tout » coche. */
  visibleKeys: string[];
}

const BUCKETS: { kind: GuiVaultEntityKind; label: string }[] = [
  { kind: "key", label: "Clés" },
  { kind: "snippet", label: "Snippets" },
];

/** Ce que le filtre compare — le nom, le chemin, le genre (« clé »), et ce
 * que la consultation ajoute (utilisateur, adresse, site, tags). */
function matches(e: GuiVaultEntity, terms: string[]): boolean {
  if (terms.length === 0) return true;
  const haystack = `${e.name} ${e.path} ${KIND_LABELS[e.kind]} ${e.search ?? ""} ${(e.tags ?? []).join(" ")}`.toLowerCase();
  return terms.every((t) => haystack.includes(t));
}

const byName = (a: GuiVaultEntity, b: GuiVaultEntity) => a.name.localeCompare(b.name);

/** Les lignes d'un emplacement, à partir de `depth`. Rend les ids retenus. */
function emitSection(scope: string, entities: GuiVaultEntity[], depth: number, terms: string[], rows: VaultTreeRow[], visibleKeys: string[]): string[] {
  const folders = new Map(entities.filter((e) => e.kind === "group").map((e) => [e.id, e]));
  // Un parent absent d'ici (dossier resté dans un autre vault, import
  // partiel) : l'entité monte à la racine plutôt que de disparaître — même
  // règle que `buildHostTree`. Un dossier pris dans un cycle de `parentId`
  // (donnée incohérente) monte aussi, sinon il n'aurait aucune racine.
  const parentOf = (e: GuiVaultEntity): string | null => {
    if (!e.parentId || !folders.has(e.parentId)) return null;
    const seen = new Set<string>([e.id]);
    let current: string | null = e.parentId;
    while (current !== null) {
      if (seen.has(current)) return null;
      seen.add(current);
      current = folders.get(current)?.parentId ?? null;
      if (current !== null && !folders.has(current)) break;
    }
    return e.parentId;
  };
  const foldersByParent = new Map<string | null, GuiVaultEntity[]>();
  const leavesByParent = new Map<string | null, GuiVaultEntity[]>();
  const bucketed = new Map<GuiVaultEntityKind, GuiVaultEntity[]>();
  for (const e of entities) {
    const bucket = BUCKETS.find((b) => b.kind === e.kind);
    if (bucket) {
      const list = bucketed.get(e.kind);
      if (list) list.push(e);
      else bucketed.set(e.kind, [e]);
      continue;
    }
    const map = e.kind === "group" ? foldersByParent : leavesByParent;
    const key = parentOf(e);
    const list = map.get(key);
    if (list) list.push(e);
    else map.set(key, [e]);
  }
  for (const list of foldersByParent.values()) list.sort(byName);
  for (const list of leavesByParent.values()) list.sort(byName);

  const kept: string[] = [];
  const seen = new Set<string>();

  /** `ancestorMatched` : un dossier qui correspond montre tout son contenu. */
  const emitFolder = (folder: GuiVaultEntity, d: number, ancestorMatched: boolean): string[] => {
    // Garde contre un `parentId` incohérent qui créerait un cycle.
    if (seen.has(folder.id)) return [];
    seen.add(folder.id);
    const self = ancestorMatched || matches(folder, terms);
    const headerIndex = rows.length;
    rows.push({ kind: "folder", id: folder.id, entity: folder, depth: d, keys: [] });
    const keys: string[] = [];
    for (const leaf of leavesByParent.get(folder.id) ?? []) {
      if (!self && !matches(leaf, terms)) continue;
      rows.push({ kind: "entity", id: leaf.id, entity: leaf, depth: d + 1 });
      keys.push(leaf.id);
    }
    for (const child of foldersByParent.get(folder.id) ?? []) keys.push(...emitFolder(child, d + 1, self));
    if (keys.length === 0 && !self) {
      rows.splice(headerIndex, 1);
      return [];
    }
    keys.unshift(folder.id);
    const header = rows[headerIndex];
    if (header.kind === "folder") header.keys = keys;
    kept.push(...keys);
    return keys;
  };

  for (const leaf of leavesByParent.get(null) ?? []) {
    if (!matches(leaf, terms)) continue;
    rows.push({ kind: "entity", id: leaf.id, entity: leaf, depth });
    kept.push(leaf.id);
  }
  for (const folder of foldersByParent.get(null) ?? []) emitFolder(folder, depth, false);
  for (const { kind, label } of BUCKETS) {
    const list = (bucketed.get(kind) ?? []).filter((e) => matches(e, terms)).sort(byName);
    if (list.length === 0) continue;
    rows.push({ kind: "bucket", id: `bucket:${scope}:${kind}`, label, depth, keys: list.map((e) => e.id) });
    for (const e of list) {
      rows.push({ kind: "entity", id: e.id, entity: e, depth: depth + 1 });
      kept.push(e.id);
    }
  }
  visibleKeys.push(...kept);
  return kept;
}

/** `query` est un filtre libre, découpé en mots : tous doivent correspondre. */
function parseTerms(query: string): string[] {
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

/** Le contenu d'un seul emplacement, à partir du niveau 0. */
export function buildVaultTree(entities: GuiVaultEntity[], query: string): VaultTree {
  const rows: VaultTreeRow[] = [];
  const visibleKeys: string[] = [];
  emitSection("", entities, 0, parseTerms(query), rows, visibleKeys);
  return { rows, visibleKeys };
}

/**
 * Plusieurs emplacements, chacun un dossier de premier niveau. Une section
 * vide reste affichée sans recherche (c'est un emplacement possible), mais
 * disparaît quand la recherche n'y retient rien.
 */
export function buildVaultTreeSections(sections: VaultTreeSection[], query: string): VaultTree {
  const terms = parseTerms(query);
  const rows: VaultTreeRow[] = [];
  const visibleKeys: string[] = [];
  for (const section of sections) {
    const headerIndex = rows.length;
    rows.push({ kind: "section", id: `section:${section.key}`, name: section.name, depth: 0, keys: [], count: section.entities.length });
    const keys = emitSection(section.key, section.entities, 1, terms, rows, visibleKeys);
    if (keys.length === 0 && terms.length > 0) {
      rows.splice(headerIndex, 1);
      continue;
    }
    const header = rows[headerIndex];
    if (header.kind === "section") header.keys = keys;
  }
  return { rows, visibleKeys };
}

/** Les lignes visibles une fois les en-têtes repliés — `collapsed` contient
 * les ids de lignes repliées. Replier = sauter ce qui suit un en-tête tant
 * que la profondeur reste supérieure à la sienne (même astuce que
 * `TargetTreeList`). */
export function visibleRows(rows: VaultTreeRow[], collapsed: ReadonlySet<string>): VaultTreeRow[] {
  const out: VaultTreeRow[] = [];
  let hiddenBelow: number | null = null;
  for (const row of rows) {
    if (hiddenBelow !== null) {
      if (row.depth > hiddenBelow) continue;
      hiddenBelow = null;
    }
    out.push(row);
    if (row.kind !== "entity" && collapsed.has(row.id)) hiddenBelow = row.depth;
  }
  return out;
}
