import type { Group, GroupId, Host, HostId } from "./types";

/**
 * Les listes de cibles à cocher (flotte, diagnostic réseau) rangées dans
 * l'arborescence de dossiers, plutôt qu'à plat.
 *
 * **Pourquoi ici et pas dans `hostTree.ts`.** `buildHostTree` classe des
 * `Host` ; ces listes-là contiennent aussi ce qui n'est pas un hôte
 * enregistré : le terminal local, et surtout les conteneurs Docker / pods
 * Kubernetes, qui sont un *listing vivant* rattaché à un hôte relais. Un
 * conteneur n'a pas de `groupId` à lui — il hérite de la position de son hôte,
 * et se range sous lui. D'où une deuxième fonction, sur une entrée générique
 * (`TargetLike`) plutôt que sur `Host`, partagée par les deux onglets pour
 * qu'ils ne divergent pas sur ce qu'est « un dossier de cibles ».
 *
 * Le résultat est une **liste plate de lignes déjà ordonnées et indentées** :
 * le composant se contente de la parcourir, exactement comme il parcourait
 * `allTargets` avant. Aucune récursion dans le rendu.
 */

/** Le minimum qu'une cible doit exposer pour être rangée. `FleetTargetInfo`
 * le satisfait — volontairement structurel, pour ne pas faire dépendre `lib/`
 * d'un hook de `hooks/`. */
export interface TargetLike {
  key: string;
  label: string;
  sub: string;
  profile?: string | null;
  /** L'hôte enregistré auquel la cible se rattache : elle-même pour un hôte
   * SSH, l'hôte relais pour un conteneur Docker ou un pod K8s. Absent pour le
   * terminal local, qui n'appartient à aucun dossier. */
  hostId?: HostId | null;
}

export type TargetRow<T extends TargetLike> =
  /** Un dossier. `keys` couvre tout son sous-arbre, ce que coche « tout le
   * dossier ». */
  | { kind: "group"; id: string; group: Group; depth: number; keys: string[] }
  /** Un hôte relais (Docker/K8s) : pas une cible en soi, l'en-tête de ses
   * conteneurs. `keys` couvre ses enfants. */
  | { kind: "host"; id: string; host: Host; depth: number; keys: string[] }
  /** Une cible cochable. `tags` vient de l'hôte auquel elle se rattache. */
  | { kind: "target"; id: string; target: T; depth: number; tags: string[] };

/** Ce que le filtre textuel compare — le libellé, le sous-titre, le profil AWS
 * et les tags de l'hôte porteur. Les tags s'ajoutent ici et nulle part
 * ailleurs : les deux onglets filtraient déjà sur `label`/`sub`. */
function matches<T extends TargetLike>(target: T, tags: string[], terms: string[]): boolean {
  if (terms.length === 0) return true;
  const haystack = `${target.label} ${target.sub} ${target.profile ?? ""} ${tags.join(" ")}`.toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

interface BuildOptions<T extends TargetLike> {
  targets: T[];
  hosts: Host[];
  groups: Group[];
  /** Filtre libre, découpé en mots : tous doivent correspondre. */
  query: string;
  /** Les hôtes dont les cibles sont des enfants (Docker exec, K8s exec) —
   * ceux-là reçoivent une ligne d'en-tête. Les autres (SSH) sont eux-mêmes la
   * cible et n'en ont pas besoin. */
  hostIsContainerLike?: (host: Host) => boolean;
}

export interface TargetTree<T extends TargetLike> {
  rows: TargetRow<T>[];
  /** Les clés de toutes les cibles retenues, dans l'ordre d'affichage — ce que
   * « Tout sélectionner » coche, et ce que les compteurs comptent. */
  visibleKeys: string[];
}

export function buildTargetTree<T extends TargetLike>({
  targets, hosts, groups, query, hostIsContainerLike,
}: BuildOptions<T>): TargetTree<T> {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const hostById = new Map(hosts.map((h) => [h.id, h]));
  const isContainerLike = hostIsContainerLike ?? ((h: Host) => {
    const kind = h.kind ?? "ssh";
    return kind === "dockerExec" || kind === "k8sExec";
  });

  const tagsOf = (target: T): string[] => {
    const host = target.hostId ? hostById.get(target.hostId) : undefined;
    return host?.tags ?? [];
  };

  const kept = targets.filter((t) => matches(t, tagsOf(t), terms));

  // Cibles rattachées à un hôte, par hôte ; et celles qui n'ont pas d'hôte du
  // tout (le terminal local), épinglées en tête comme elles l'étaient.
  const byHost = new Map<HostId, T[]>();
  const hostless: T[] = [];
  for (const target of kept) {
    const host = target.hostId ? hostById.get(target.hostId) : undefined;
    if (!host) { hostless.push(target); continue; }
    const bucket = byHost.get(host.id);
    if (bucket) bucket.push(target);
    else byHost.set(host.id, [target]);
  }

  const groupsByParent = new Map<GroupId | null, Group[]>();
  for (const group of groups) {
    const key = group.parentId ?? null;
    const bucket = groupsByParent.get(key);
    if (bucket) bucket.push(group);
    else groupsByParent.set(key, [group]);
  }
  for (const bucket of groupsByParent.values()) bucket.sort((a, b) => a.name.localeCompare(b.name));

  // Les hôtes qui ont au moins une cible retenue, par dossier.
  const hostsByGroup = new Map<GroupId | null, Host[]>();
  for (const host of hosts) {
    if (!byHost.has(host.id)) continue;
    const key = host.groupId ?? null;
    const bucket = hostsByGroup.get(key);
    if (bucket) bucket.push(host);
    else hostsByGroup.set(key, [host]);
  }
  for (const bucket of hostsByGroup.values()) bucket.sort((a, b) => a.label.localeCompare(b.label));

  const rows: TargetRow<T>[] = [];
  const visibleKeys: string[] = [];

  for (const target of hostless) {
    rows.push({ kind: "target", id: target.key, target, depth: 0, tags: [] });
    visibleKeys.push(target.key);
  }

  /** Les lignes d'un hôte : soit la cible elle-même (SSH), soit un en-tête
   * suivi de ses conteneurs. Renvoie les clés produites, pour que les dossiers
   * ancêtres sachent ce que « tout le dossier » couvre. */
  const emitHost = (host: Host, depth: number): string[] => {
    const own = byHost.get(host.id) ?? [];
    const tags = host.tags;
    if (!isContainerLike(host)) {
      for (const target of own) {
        rows.push({ kind: "target", id: target.key, target, depth, tags });
        visibleKeys.push(target.key);
      }
      return own.map((t) => t.key);
    }
    const keys = own.map((t) => t.key);
    rows.push({ kind: "host", id: `host:${host.id}`, host, depth, keys });
    for (const target of own) {
      rows.push({ kind: "target", id: target.key, target, depth: depth + 1, tags });
      visibleKeys.push(target.key);
    }
    return keys;
  };

  /** Un dossier n'apparaît que s'il contient quelque chose de retenu — sinon
   * la recherche laisserait une file d'en-têtes vides. */
  const emitGroup = (group: Group, depth: number): string[] => {
    const headerIndex = rows.length;
    rows.push({ kind: "group", id: `group:${group.id}`, group, depth, keys: [] });
    const keys: string[] = [];
    for (const child of groupsByParent.get(group.id) ?? []) keys.push(...emitGroup(child, depth + 1));
    for (const host of hostsByGroup.get(group.id) ?? []) keys.push(...emitHost(host, depth + 1));
    if (keys.length === 0) {
      rows.splice(headerIndex, 1);
      return [];
    }
    const header = rows[headerIndex];
    if (header.kind === "group") header.keys = keys;
    return keys;
  };

  for (const group of groupsByParent.get(null) ?? []) emitGroup(group, 0);
  for (const host of hostsByGroup.get(null) ?? []) emitHost(host, 0);

  return { rows, visibleKeys };
}
