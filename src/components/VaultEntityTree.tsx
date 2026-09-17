import { useMemo, useState, type ReactNode } from "react";
import type { GuiVaultEntityKind } from "../lib/types";
import { KIND_LABELS, visibleRows, type VaultTreeRow } from "../lib/vaultTree";
import { BulkCheckbox, EntityRow, GroupRow } from "./EntityRow";
import { IconDatabase, IconFolder, IconHosts, IconKeychain, IconSnippets, IconVault } from "./ui-icons";

/**
 * L'arborescence à cocher du contenu des vaults — le contenu d'un vault dans
 * le panneau GuiVault, et le dialogue « Ajouter » qui montre les autres
 * emplacements.
 *
 * **Le même vocabulaire visuel que `HostsPanel` et `TargetTreeList`** :
 * mêmes lignes de dossier repliables avec leur chevron (`GroupRow`), mêmes
 * lignes d'entité (`EntityRow`), même indentation, mêmes cases — y compris
 * la case d'en-tête à trois états qui coche tout un dossier. Ce panneau
 * avait sa propre liste plate avec un `<select>` par ligne ; il se lit
 * désormais comme le reste de la barre latérale.
 *
 * Ne décide rien du contenu : `buildVaultTree` (`lib/vaultTree.ts`) a
 * produit les lignes ordonnées et indentées. Ici : replier, cocher, dessiner.
 */
interface VaultEntityTreeProps {
  rows: VaultTreeRow[];
  selected: ReadonlySet<string>;
  onToggle: (id: string) => void;
  onToggleKeys: (keys: string[], checked: boolean) => void;
  /** Sans cases : un vault où l'on ne fait que lire. */
  selectable?: boolean;
  /** Pour une ligne de section (`section:<clé>`) : son icône et une
   * étiquette (« lecture seule »). */
  sectionMeta?: (key: string) => { icon?: ReactNode; badge?: ReactNode } | undefined;
  emptyMessage?: string;
}

const KIND_ICONS: Record<GuiVaultEntityKind, (p: { size?: number }) => ReactNode> = {
  host: IconHosts,
  group: IconFolder,
  key: IconKeychain,
  snippet: IconSnippets,
  "sql-connection": IconDatabase,
};

const BUCKET_ICONS: Record<string, (p: { size?: number }) => ReactNode> = {
  "Clés": IconKeychain,
  "Snippets": IconSnippets,
};

export function VaultEntityTree({
  rows, selected, onToggle, onToggleKeys, selectable = true, sectionMeta, emptyMessage = "Rien ici pour l'instant.",
}: VaultEntityTreeProps) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggleCollapsed = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const visible = useMemo(() => visibleRows(rows, collapsed), [rows, collapsed]);
  const countChecked = (keys: string[]) => keys.reduce((n, k) => n + (selected.has(k) ? 1 : 0), 0);

  if (rows.length === 0) {
    return <p className="px-2 py-6 text-center text-[12px] text-[var(--c-text-muted)]">{emptyMessage}</p>;
  }

  const header = (row: Extract<VaultTreeRow, { kind: "section" | "folder" | "bucket" }>, name: string, icon: ReactNode, badge?: ReactNode, count?: number) => (
    <GroupRow
      key={row.id}
      depth={row.depth}
      expanded={!collapsed.has(row.id)}
      onToggle={() => toggleCollapsed(row.id)}
      icon={icon}
      name={name}
      count={count}
      badge={badge}
      leading={selectable && row.keys.length > 0 ? (
        <BulkCheckbox
          keys={row.keys}
          checkedCount={countChecked(row.keys)}
          onToggle={(checked) => onToggleKeys(row.keys, checked)}
          title={`Tout sélectionner — ${name}`}
        />
      ) : undefined}
    />
  );

  return (
    <div data-vault-tree="">
      {visible.map((row) => {
        if (row.kind === "section") {
          const meta = sectionMeta?.(row.id.slice("section:".length));
          return header(row, row.name, meta?.icon ?? <IconVault size={14} />, meta?.badge, row.count);
        }
        if (row.kind === "folder") {
          return header(row, row.entity.name, <IconFolder size={14} />, undefined, row.keys.length - 1);
        }
        if (row.kind === "bucket") {
          const Icon = BUCKET_ICONS[row.label] ?? IconFolder;
          return header(row, row.label, <Icon size={14} />, undefined, row.keys.length);
        }
        const { entity } = row;
        const Icon = KIND_ICONS[entity.kind];
        const checked = selected.has(entity.id);
        const where = entity.path ? ` — ${entity.path}` : "";
        return (
          <EntityRow
            key={row.id}
            depth={row.depth}
            active={checked}
            className={selectable ? "cursor-pointer" : ""}
            dataAttrs={{ "data-vault-entity": entity.name }}
            leading={selectable ? (
              <input
                type="checkbox"
                checked={checked}
                onChange={() => onToggle(entity.id)}
                aria-label={`Sélectionner ${entity.name}`}
              />
            ) : undefined}
            icon={<Icon size={13} />}
            title={entity.name}
            title_={`${KIND_LABELS[entity.kind]}${where}`}
            onClick={selectable ? () => onToggle(entity.id) : undefined}
          />
        );
      })}
    </div>
  );
}
