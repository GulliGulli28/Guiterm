import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { Group, GroupId } from "../lib/types";
import { pruneCollapsed, readHostTreeMemory, writeHostTreeMemory } from "../lib/hostTreeState";

/**
 * Les dossiers repliés et la position de défilement d'une arborescence
 * d'hôtes, retenus d'un lancement à l'autre (voir `lib/hostTreeState`).
 *
 * `panel` nomme le panneau pour le défilement (`hosts`, `sftp`) ; les dossiers
 * repliés sont communs à tous. Le conteneur qui défile se déclare via `scrollRef`
 * — la position est restaurée une fois la liste rendue, et enregistrée à
 * chaque défilement (avec un léger délai, pour ne pas écrire à chaque pixel).
 */
export function useHostTreeMemory(panel: string, groups: readonly Group[], scrollRef: RefObject<HTMLElement | null>) {
  const [collapsed, setCollapsedState] = useState<Set<GroupId>>(() => new Set(readHostTreeMemory().collapsed));

  const persistCollapsed = useCallback((next: Set<GroupId>) => {
    const memory = readHostTreeMemory();
    writeHostTreeMemory({ ...memory, collapsed: [...next] });
  }, []);

  const setCollapsed = useCallback((update: (prev: Set<GroupId>) => Set<GroupId>) => {
    setCollapsedState((prev) => {
      const next = update(prev);
      persistCollapsed(next);
      return next;
    });
  }, [persistCollapsed]);

  const toggle = useCallback((id: GroupId) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    }), [setCollapsed]);

  // Un dossier supprimé n'a pas à rester en mémoire.
  useEffect(() => {
    const existing = groups.map((g) => g.id);
    setCollapsedState((prev) => {
      const pruned = pruneCollapsed([...prev], existing);
      if (pruned.length === prev.size) return prev;
      const next = new Set(pruned);
      persistCollapsed(next);
      return next;
    });
  }, [groups, persistCollapsed]);

  // Restauration du défilement : une seule fois, après le premier rendu de la
  // liste — d'où le `ref` de garde, `groups` pouvant changer ensuite.
  const restored = useRef(false);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || restored.current) return;
    const saved = readHostTreeMemory().scroll[panel];
    if (saved != null) el.scrollTop = saved;
    restored.current = true;
  }, [panel, scrollRef, groups]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const top = el.scrollTop;
    window.clearTimeout(scrollTimer.current);
    scrollTimer.current = window.setTimeout(() => {
      const memory = readHostTreeMemory();
      writeHostTreeMemory({ ...memory, scroll: { ...memory.scroll, [panel]: top } });
    }, 150);
  }, [panel, scrollRef]);
  const scrollTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(scrollTimer.current), []);

  return { collapsed, toggle, onScroll };
}
