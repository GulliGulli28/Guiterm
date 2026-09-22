import type { GuiVaultBrowseEntry, GuiVaultEntity, GuiVaultEntityKind } from "./types";
import type { VaultTreeSection } from "./vaultTree";

/**
 * Ce que le panneau « Coller depuis GuiVault » et la palette font de ce que
 * `guivaultBrowse` rend : une section par vault (le personnel en tête, dans
 * l'ordre du backend), le chemin de dossiers de chaque item, et un filtre
 * par type comme celui de l'extension web.
 *
 * Même arbre que le panneau GuiVault ensuite (`buildVaultTreeSections`) :
 * dossiers repliables, clés et snippets dans leurs compartiments — les
 * secrets de l'interface web (identifiants, notes, cartes, identités) se
 * rangent par dossier comme les hôtes.
 */

/** Les filtres proposés, dans l'ordre d'affichage. `group` n'en est pas un :
 * un dossier n'a rien à coller. */
export const BROWSE_FILTERS: { kind: GuiVaultEntityKind; label: string }[] = [
  { kind: "login", label: "Identifiants" },
  { kind: "note", label: "Notes" },
  { kind: "card", label: "Cartes" },
  { kind: "identity", label: "Identités" },
  { kind: "host", label: "Hôtes" },
  { kind: "sql-connection", label: "Connexions" },
  { kind: "key", label: "Clés" },
  { kind: "snippet", label: "Snippets" },
];

export type BrowseFilter = "all" | GuiVaultEntityKind;

/** Le chemin de dossiers d'un item (« Prod › Bases »), borné : un `parentId`
 * qui boucle ou qui pointe hors du vault s'arrête là. */
function pathOf(entry: GuiVaultBrowseEntry, groups: Map<string, GuiVaultBrowseEntry>): string {
  const names: string[] = [];
  const seen = new Set<string>();
  let current = entry.parentId;
  while (current && !seen.has(current)) {
    seen.add(current);
    const g = groups.get(current);
    if (!g) break;
    names.unshift(g.name);
    current = g.parentId;
  }
  return names.join(" › ");
}

/** Une entrée telle que l'arbre la veut. */
export function toEntity(entry: GuiVaultBrowseEntry, groups: Map<string, GuiVaultBrowseEntry>): GuiVaultEntity {
  return {
    id: entry.id,
    kind: entry.kind,
    name: entry.name,
    path: pathOf(entry, groups),
    parentId: entry.parentId,
    vaultId: entry.vaultId,
    search: entry.search,
    tags: entry.tags,
  };
}

/** Combien d'items de chaque type le compte contient — pour n'afficher que
 * les filtres qui retiendraient quelque chose. */
export function countByKind(entries: GuiVaultBrowseEntry[]): Partial<Record<GuiVaultEntityKind, number>> {
  const counts: Partial<Record<GuiVaultEntityKind, number>> = {};
  for (const e of entries) counts[e.kind] = (counts[e.kind] ?? 0) + 1;
  return counts;
}

/**
 * Les sections de l'arbre. Avec un filtre, seuls les items de ce type
 * restent, et les seuls dossiers gardés sont ceux qui en contiennent (eux
 * ou un sous-dossier) — un dossier vide sous « Identifiants » ne dirait
 * que « rien ici ». Un vault sans item du type voulu n'est pas listé.
 */
export function browseSections(entries: GuiVaultBrowseEntry[], filter: BrowseFilter): VaultTreeSection[] {
  const groupsByVault = new Map<string, Map<string, GuiVaultBrowseEntry>>();
  for (const e of entries) {
    if (e.kind !== "group") continue;
    let groups = groupsByVault.get(e.vaultId);
    if (!groups) {
      groups = new Map();
      groupsByVault.set(e.vaultId, groups);
    }
    groups.set(e.id, e);
  }
  // Les dossiers à garder : la chaîne d'ancêtres de chaque item retenu.
  const kept = new Set<string>();
  if (filter !== "all") {
    for (const e of entries) {
      if (e.kind !== filter) continue;
      const groups = groupsByVault.get(e.vaultId);
      const seen = new Set<string>();
      let current = e.parentId;
      while (current && groups?.has(current) && !seen.has(current)) {
        seen.add(current);
        kept.add(current);
        current = groups.get(current)!.parentId;
      }
    }
  }
  const sections: VaultTreeSection[] = [];
  const byKey = new Map<string, VaultTreeSection>();
  for (const e of entries) {
    if (filter !== "all" && e.kind !== filter && !(e.kind === "group" && kept.has(e.id))) continue;
    let section = byKey.get(e.vaultId);
    if (!section) {
      section = { key: e.vaultId, name: e.vaultName, entities: [] };
      byKey.set(e.vaultId, section);
      sections.push(section);
    }
    section.entities.push(toEntity(e, groupsByVault.get(e.vaultId) ?? new Map()));
  }
  return sections;
}

/** Ce que la palette liste : chaque item collable, avec son vault et son
 * chemin dans le libellé (deux « admin » de deux vaults doivent se
 * distinguer), et les mêmes termes de recherche que l'arbre. */
export function paletteRows(entries: GuiVaultBrowseEntry[]): { entry: GuiVaultBrowseEntry; label: string; keywords: string }[] {
  const groupsByVault = new Map<string, Map<string, GuiVaultBrowseEntry>>();
  for (const e of entries) {
    if (e.kind !== "group") continue;
    const groups = groupsByVault.get(e.vaultId) ?? new Map<string, GuiVaultBrowseEntry>();
    groups.set(e.id, e);
    groupsByVault.set(e.vaultId, groups);
  }
  return entries
    .filter((e) => e.kind !== "group" && e.fields.length > 0)
    .map((e) => {
      const path = pathOf(e, groupsByVault.get(e.vaultId) ?? new Map());
      return {
        entry: e,
        label: [e.vaultName, ...(path ? [path] : []), e.name].join(" › "),
        keywords: [e.search, ...e.tags].join(" "),
      };
    });
}
