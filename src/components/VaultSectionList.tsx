import { useMemo, useState, type ReactNode } from "react";
import type { VaultId } from "../lib/types";
import { sectionRoleLabel, splitByVault, type VaultSection } from "../lib/vaultSections";
import { GroupRow } from "./EntityRow";
import { IconVault } from "./ui-icons";

/**
 * Une liste plate d'entités (clés, snippets, connexions), rangée sous un
 * dossier de vault repliable par vault quand un compte GuiVault est affiché —
 * le même en-tête que les sections du panneau Hôtes, pour qu'un vault se
 * reconnaisse d'un panneau à l'autre. Sans compte (`sections` absent), la
 * liste reste à plat, exactement comme avant.
 *
 * Ne dessine pas les entités : chaque panneau garde sa carte (`render`).
 */
export function VaultSectionList<T extends { id: string }>({
  items, bindings, sections, render, emptyMessage = "Vide.",
}: {
  items: readonly T[];
  bindings: Record<string, VaultId> | undefined;
  sections: readonly VaultSection[] | null | undefined;
  render: (item: T) => ReactNode;
  /** Sous l'en-tête d'un vault qui n'a rien ici. */
  emptyMessage?: string;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const buckets = useMemo(() => (sections ? splitByVault(items, bindings, sections) : null), [items, bindings, sections]);
  if (!buckets) return <>{items.map(render)}</>;
  return (
    <>
      {buckets.map(({ section, items: inside }) => {
        const key = section.id ?? "personal";
        const expanded = !collapsed.has(key);
        const roleLabel = sectionRoleLabel(section);
        return (
          <div key={key} data-vault-section={section.name}>
            <GroupRow
              depth={0}
              expanded={expanded}
              onToggle={() => setCollapsed((c) => { const n = new Set(c); if (n.has(key)) n.delete(key); else n.add(key); return n; })}
              icon={<IconVault size={14} />}
              name={section.name}
              count={inside.length}
              badge={roleLabel ? <span className="tag" title="Vous ne faites que lire ce vault">{roleLabel}</span> : undefined}
            />
            {expanded && (
              <div className="pl-2">
                {inside.length === 0 && <p className="px-2 pb-2 pt-0.5 text-[11.5px] text-[var(--c-text-muted)]">{emptyMessage}</p>}
                {inside.map(render)}
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}
