import type { Group, GroupId, Host } from "./types";

/**
 * L'arbre hôtes/dossiers de la barre latérale, préparé en une passe.
 *
 * **Pourquoi une fonction pure plutôt que des closures dans le composant.**
 * `HostsPanel` calculait ça à l'affichage : `hostsIn(g)` refiltrait et retriait
 * *tout* `workspace.hosts` à chaque appel, `childGroups(g)` faisait de même sur
 * les dossiers, et `groupHasMatches` récursait en les rappelant à chaque nœud —
 * puis le rendu refaisait le même travail juste après pour afficher. Chaque
 * sous-arbre était donc reparcouru une fois par ancêtre, et rien n'étant
 * mémoïsé, tout se rejouait au survol d'un menu ou à l'entrée en mode
 * sélection, pas seulement à la frappe.
 *
 * Ici tout est indexé une fois : O(H + G) plus le coût des tris, recalculé
 * seulement quand les hôtes, les dossiers ou la recherche changent.
 */
export interface HostTree {
  /** Hôtes retenus par la recherche, par dossier (`null` = racine), triés par
   * libellé. Un dossier absent de la Map n'a aucun hôte correspondant. */
  hostsByGroup: Map<GroupId | null, Host[]>;
  /** Dossiers par parent (`null` = racine), triés par nom. */
  groupsByParent: Map<GroupId | null, Group[]>;
  /** Dossiers qui contiennent au moins un hôte correspondant, directement ou
   * dans un descendant — ce que `groupHasMatches` recalculait par récursion. */
  matchingGroups: Set<GroupId>;
}

/** Ce qu'une recherche compare — libellé, adresse, utilisateur, tags. */
function hostMatches(host: Host, query: string): boolean {
  if (!query) return true;
  return (
    host.label.toLowerCase().includes(query) ||
    host.address.toLowerCase().includes(query) ||
    host.username.toLowerCase().includes(query) ||
    host.tags.some((t) => t.toLowerCase().includes(query))
  );
}

/**
 * `query` est attendu déjà normalisé (trim + minuscules) : c'est ce que la
 * barre de recherche produit, et le refaire ici le referait à chaque hôte.
 */
export function buildHostTree(hosts: Host[], groups: Group[], query: string): HostTree {
  const hostsByGroup = new Map<GroupId | null, Host[]>();
  for (const host of hosts) {
    if (!hostMatches(host, query)) continue;
    const key = host.groupId ?? null;
    const bucket = hostsByGroup.get(key);
    if (bucket) bucket.push(host);
    else hostsByGroup.set(key, [host]);
  }
  for (const bucket of hostsByGroup.values()) {
    bucket.sort((a, b) => a.label.localeCompare(b.label));
  }

  const groupsByParent = new Map<GroupId | null, Group[]>();
  const parentOf = new Map<GroupId, GroupId | null>();
  for (const group of groups) {
    const key = group.parentId ?? null;
    parentOf.set(group.id, key);
    const bucket = groupsByParent.get(key);
    if (bucket) bucket.push(group);
    else groupsByParent.set(key, [group]);
  }
  for (const bucket of groupsByParent.values()) {
    bucket.sort((a, b) => a.name.localeCompare(b.name));
  }

  // Remontée depuis chaque dossier qui a des hôtes, plutôt qu'une descente
  // récursive par dossier : on s'arrête dès qu'un ancêtre est déjà marqué, donc
  // chaque dossier n'est visité qu'une fois au total.
  const matchingGroups = new Set<GroupId>();
  for (const groupId of hostsByGroup.keys()) {
    if (groupId === null) continue;
    // `seen` garde la remontée finie même si un `parentId` incohérent créait un
    // cycle — la version récursive précédente y bouclait indéfiniment.
    const seen = new Set<GroupId>();
    let current: GroupId | null = groupId;
    while (current !== null && !matchingGroups.has(current) && !seen.has(current)) {
      seen.add(current);
      matchingGroups.add(current);
      current = parentOf.get(current) ?? null;
    }
  }

  return { hostsByGroup, groupsByParent, matchingGroups };
}
