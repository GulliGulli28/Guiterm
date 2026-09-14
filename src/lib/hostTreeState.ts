import type { GroupId } from "./types";

/**
 * Ce que l'arborescence d'hôtes retient d'un lancement à l'autre : les
 * dossiers repliés, et jusqu'où la liste était défilée.
 *
 * Les dossiers repliés sont partagés entre les panneaux qui montrent le même
 * arbre (Hôtes, SFTP) : replier « Labo » dans l'un et le retrouver déplié dans
 * l'autre se lirait comme un oubli. Le défilement, lui, est propre à chaque
 * panneau — ils n'ont ni la même hauteur ni les mêmes lignes.
 *
 * Dans `localStorage`, comme les préférences : c'est de l'état d'affichage,
 * pas de la donnée, et il n'a rien à faire dans `workspace.json`.
 */
export interface HostTreeMemory {
  collapsed: GroupId[];
  /** Position de défilement par panneau (`hosts`, `sftp`…), en pixels. */
  scroll: Record<string, number>;
}

export const HOST_TREE_MEMORY_KEY = "gui-termius-host-tree";

const EMPTY: HostTreeMemory = { collapsed: [], scroll: {} };

/** Lit la mémoire, en tolérant tout ce qu'un `localStorage` peut contenir :
 * rien, du JSON d'une autre version, ou n'importe quoi. Un état illisible vaut
 * un état vide — jamais une exception au montage du panneau. */
export function readHostTreeMemory(storage: Pick<Storage, "getItem"> = localStorage): HostTreeMemory {
  try {
    const raw = storage.getItem(HOST_TREE_MEMORY_KEY);
    if (!raw) return EMPTY;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return EMPTY;
    const p = parsed as Partial<HostTreeMemory>;
    const collapsed = Array.isArray(p.collapsed) ? p.collapsed.filter((id): id is GroupId => typeof id === "string") : [];
    const scroll: Record<string, number> = {};
    if (p.scroll && typeof p.scroll === "object") {
      for (const [k, v] of Object.entries(p.scroll)) {
        if (typeof v === "number" && Number.isFinite(v) && v >= 0) scroll[k] = v;
      }
    }
    return { collapsed, scroll };
  } catch {
    return EMPTY;
  }
}

export function writeHostTreeMemory(memory: HostTreeMemory, storage: Pick<Storage, "setItem"> = localStorage): void {
  try {
    storage.setItem(HOST_TREE_MEMORY_KEY, JSON.stringify(memory));
  } catch {
    // Stockage plein ou interdit : on perd la mémoire, pas la liste.
  }
}

/** Retire de la mémoire les dossiers qui n'existent plus — sinon un identifiant
 * supprimé y resterait indéfiniment. */
export function pruneCollapsed(collapsed: readonly GroupId[], existing: readonly GroupId[]): GroupId[] {
  const known = new Set(existing);
  return collapsed.filter((id) => known.has(id));
}
