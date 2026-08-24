import type { CustomIcon, Group, Host } from "../lib/types";
import type { TargetLike, TargetRow } from "../lib/targetTree";
import { hostKindMeta } from "../lib/hostKinds";
import { HostIcon } from "./icons";
import { IconFolder } from "./ui-icons";

/**
 * Le rendu commun des listes de cibles à cocher (flotte, diagnostic réseau) :
 * dossiers, hôtes relais, cibles indentées, tags.
 *
 * Ne décide rien : `buildTargetTree` (`lib/targetTree.ts`) a déjà produit les
 * lignes ordonnées et indentées, et l'appelant fournit le contenu de chaque
 * ligne de cible (`renderTarget`) — les deux onglets n'y affichent pas la même
 * chose (l'un montre l'OS et la RAM collectés, l'autre non).
 */

interface TargetTreeListProps<T extends TargetLike> {
  rows: TargetRow<T>[];
  customIcons: CustomIcon[];
  /** Est-ce que cette cible est cochée ? */
  isChecked: (target: T) => boolean;
  onToggle: (target: T) => void;
  /** Grisé et non cliquable — le mode « Langage » de la flotte, où la
   * sélection vient du programme. */
  isDisabled?: (target: T) => boolean;
  disabledTitle?: string;
  /** Le corps de la ligne, à droite de la case. */
  renderTarget: (target: T, tags: string[]) => React.ReactNode;
  /** Cocher/décocher tout un dossier ou tout un hôte relais. Absent = pas de
   * case sur les en-têtes. */
  onToggleKeys?: (keys: string[], checked: boolean) => void;
  /** Combien de clés de cet ensemble sont cochées — pour l'état de la case
   * d'en-tête (vide / indéterminée / pleine). */
  countChecked?: (keys: string[]) => number;
  emptyMessage?: string;
}

/** Pastilles de tags, comme la barre latérale et `HostTreePicker`. */
function TagChips({ tags }: { tags: string[] }) {
  if (tags.length === 0) return null;
  return (
    <span className="mt-0.5 flex flex-wrap gap-1">
      {tags.map((tag) => (
        <span
          key={tag}
          className="rounded-full border border-[var(--c-border)] bg-[var(--c-bg3)] px-1.5 py-0.5 text-[10px] leading-none text-[var(--c-text-secondary)]"
        >
          {tag}
        </span>
      ))}
    </span>
  );
}

/** Case d'un en-tête : cochée si tout l'est, indéterminée si une partie
 * seulement — l'état intermédiaire n'existe qu'ici, `input.indeterminate`
 * n'étant pas un attribut mais une propriété, d'où le `ref`. */
function BulkCheckbox({
  keys, checkedCount, onToggle, title,
}: { keys: string[]; checkedCount: number; onToggle: (checked: boolean) => void; title: string }) {
  const all = keys.length > 0 && checkedCount === keys.length;
  const some = checkedCount > 0 && !all;
  return (
    <input
      type="checkbox"
      title={title}
      aria-label={title}
      checked={all}
      ref={(el) => { if (el) el.indeterminate = some; }}
      onChange={() => onToggle(!all)}
      className="accent-[var(--c-accent)]"
    />
  );
}

function HostHeader({ host, customIcons }: { host: Host; customIcons: CustomIcon[] }) {
  const { label: kindLabel, Icon: KindIcon } = hostKindMeta(host.kind ?? "ssh");
  return (
    <>
      {host.icon
        ? <HostIcon iconId={host.icon} customIcons={customIcons} size={13} />
        : <KindIcon size={12} className="shrink-0 text-[var(--c-text-muted)]" />}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[11.5px] font-medium text-[var(--c-text-secondary)]" title={kindLabel}>
          {host.label}
        </span>
        <TagChips tags={host.tags} />
      </span>
    </>
  );
}

function GroupHeader({ group, customIcons }: { group: Group; customIcons: CustomIcon[] }) {
  return (
    <>
      {group.icon
        ? <HostIcon iconId={group.icon} customIcons={customIcons} size={13} />
        : <IconFolder size={12} className="shrink-0 text-[var(--c-text-muted)]" />}
      <span className="min-w-0 flex-1 truncate text-[11px] font-medium uppercase tracking-wide text-[var(--c-text-muted)]">
        {group.name}
      </span>
    </>
  );
}

export function TargetTreeList<T extends TargetLike>({
  rows, customIcons, isChecked, onToggle, isDisabled, disabledTitle,
  renderTarget, onToggleKeys, countChecked, emptyMessage = "Aucune cible.",
}: TargetTreeListProps<T>) {
  if (rows.length === 0) {
    return <p className="px-3 py-3 text-[11.5px] text-[var(--c-text-muted)]">{emptyMessage}</p>;
  }
  return (
    <>
      {rows.map((row) => {
        if (row.kind === "group" || row.kind === "host") {
          const label = row.kind === "group" ? row.group.name : row.host.label;
          return (
            <div
              key={row.id}
              style={{ paddingLeft: `${4 + row.depth * 12}px` }}
              className="flex items-center gap-1.5 py-1 pr-2"
            >
              {onToggleKeys && countChecked && row.keys.length > 0 && (
                <BulkCheckbox
                  keys={row.keys}
                  checkedCount={countChecked(row.keys)}
                  onToggle={(checked) => onToggleKeys(row.keys, checked)}
                  title={`Tout sélectionner — ${label}`}
                />
              )}
              {row.kind === "group"
                ? <GroupHeader group={row.group} customIcons={customIcons} />
                : <HostHeader host={row.host} customIcons={customIcons} />}
            </div>
          );
        }
        const disabled = isDisabled?.(row.target) ?? false;
        const checked = isChecked(row.target);
        return (
          <label
            key={row.id}
            title={disabled ? disabledTitle : undefined}
            style={{ paddingLeft: `${6 + row.depth * 12}px` }}
            className={`flex items-start gap-2 rounded-md py-1.5 pr-2 ${!disabled ? "cursor-pointer" : ""} ${
              checked ? "bg-[var(--c-accent-dim)]" : !disabled ? "hover:bg-[var(--c-bg3)]" : ""
            }`}
          >
            <input
              type="checkbox"
              checked={checked}
              disabled={disabled}
              onChange={() => onToggle(row.target)}
              className="mt-0.5 accent-[var(--c-accent)] disabled:opacity-60"
            />
            <span className="min-w-0 flex-1">
              {renderTarget(row.target, row.tags)}
              <TagChips tags={row.tags} />
            </span>
          </label>
        );
      })}
    </>
  );
}
