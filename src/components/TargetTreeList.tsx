import { useMemo, useState } from "react";
import type { CustomIcon, Host } from "../lib/types";
import type { TargetLike, TargetRow } from "../lib/targetTree";
import { hostKindMeta } from "../lib/hostKinds";
import { HostIcon } from "./icons";
import { IconChevronDown, IconChevronRight, IconFolder, IconTerminal } from "./ui-icons";

/**
 * Le rendu commun des listes de cibles à cocher (flotte, diagnostic réseau),
 * dans la barre latérale.
 *
 * **Volontairement le même vocabulaire visuel que `HostsPanel` et
 * `SftpPanel`** : mêmes cartes d'hôte (pastille d'icône de 44 px, libellé en
 * 14 px, adresse en chasse fixe), mêmes lignes de dossier repliables avec leur
 * chevron, même indentation de 14 px par niveau, mêmes pastilles de tags. Ces
 * arborescences vivaient dans un onglet et pouvaient se permettre un style à
 * elles ; depuis qu'elles sont un panneau de barre latérale, elles se lisent
 * juste au-dessus des deux autres et toute différence se voit comme une
 * incohérence. Ce qui s'y ajoute, et rien d'autre : les cases à cocher.
 *
 * Ne décide rien du contenu : `buildTargetTree` (`lib/targetTree.ts`) a déjà
 * produit les lignes ordonnées et indentées. L'appelant ne fournit que les
 * lignes *supplémentaires* d'une carte (`renderExtra`) — la flotte y montre
 * l'OS et la RAM collectés, le diagnostic réseau rien. Le libellé, le
 * sous-titre et les tags sont rendus ici, sans quoi la typographie
 * divergerait dès le premier ajustement d'un des deux appelants.
 */
interface TargetTreeListProps<T extends TargetLike> {
  rows: TargetRow<T>[];
  /** Pour retrouver l'icône et le genre (SSH, Docker exec, K8s exec) de l'hôte
   * auquel une cible se rattache — la carte les montre comme la barre
   * latérale. */
  hosts: Host[];
  customIcons: CustomIcon[];
  /** Est-ce que cette cible est cochée ? */
  isChecked: (target: T) => boolean;
  onToggle: (target: T) => void;
  /** Grisé et non cliquable — le mode « Langage » de la flotte, où la
   * sélection vient du programme. */
  isDisabled?: (target: T) => boolean;
  disabledTitle?: string;
  /** Sous le libellé et l'adresse, quand l'appelant a quelque chose de plus à
   * dire. */
  renderExtra?: (target: T) => React.ReactNode;
  /** Cocher/décocher tout un dossier ou tout un hôte relais. Absent = pas de
   * case sur les en-têtes. */
  onToggleKeys?: (keys: string[], checked: boolean) => void;
  /** Combien de clés de cet ensemble sont cochées — pour l'état de la case
   * d'en-tête (vide / indéterminée / pleine). */
  countChecked?: (keys: string[]) => number;
  emptyMessage?: string;
}

/** Étiquettes d'une ligne — au plus deux, le reste compté. */
function TagChips({ tags }: { tags: string[] }) {
  if (tags.length === 0) return null;
  return (
    <span className="flex shrink-0 gap-1">
      {tags.slice(0, 2).map((tag) => <span key={tag} className="tag">{tag}</span>)}
      {tags.length > 2 && <span className="tag" title={tags.slice(2).join(", ")}>+{tags.length - 2}</span>}
    </span>
  );
}

/** Case d'un en-tête : cochée si tout l'est, indéterminée si une partie
 * seulement — l'état intermédiaire n'existe qu'ici, `input.indeterminate`
 * n'étant pas un attribut mais une propriété, d'où le `ref`. */
function BulkCheckbox({
  keys, checkedCount, onToggle, title,
}: { keys: string[]; checkedCount: number; onToggle: (checked: boolean) => void; title: string }) {
  const all = checkedCount === keys.length && keys.length > 0;
  return (
    <input
      type="checkbox"
      title={title}
      checked={all}
      ref={(el) => { if (el) el.indeterminate = checkedCount > 0 && !all; }}
      onChange={(e) => onToggle(e.target.checked)}
      className="shrink-0"
    />
  );
}

/** L'icône d'une ligne — même pastille que dans la liste des hôtes. `host`
 * est absent pour le terminal local, qui n'est rattaché à aucune machine
 * enregistrée. */
function RowIcon({ host, customIcons, fallback }: { host: Host | undefined; customIcons: CustomIcon[]; fallback?: "terminal" }) {
  const kind = host?.kind ?? "ssh";
  const { label: kindLabel, Icon: KindIcon } = hostKindMeta(kind);
  return (
    <span title={host ? kindLabel : undefined} className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-[var(--c-bg3)] text-[var(--c-text-secondary)]">
      {host?.icon
        ? <HostIcon iconId={host.icon} customIcons={customIcons} size={16} />
        : fallback === "terminal" && !host ? <IconTerminal size={13} /> : <KindIcon size={13} />}
    </span>
  );
}

export function TargetTreeList<T extends TargetLike>({
  rows, hosts, customIcons, isChecked, onToggle, isDisabled, disabledTitle,
  renderExtra, onToggleKeys, countChecked, emptyMessage = "Aucune cible.",
}: TargetTreeListProps<T>) {
  // Replier un dossier, comme dans Hôtes et SFTP. L'état est local au
  // composant : c'est du confort d'affichage, il n'a rien à faire dans le
  // magasin de sélection ni sur le disque.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const hostById = useMemo(() => new Map(hosts.map((h) => [h.id, h])), [hosts]);

  const toggleCollapsed = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // `buildTargetTree` rend une liste plate ordonnée, avec la profondeur de
  // chaque ligne : replier revient donc à sauter tout ce qui suit un en-tête
  // replié tant que la profondeur reste supérieure à la sienne. Pas d'arbre à
  // reconstruire, et l'ordre reste exactement celui que le tri a produit.
  const visible = useMemo(() => {
    const out: TargetRow<T>[] = [];
    let hiddenBelow: number | null = null;
    for (const row of rows) {
      if (hiddenBelow !== null) {
        if (row.depth > hiddenBelow) continue;
        hiddenBelow = null;
      }
      out.push(row);
      if (row.kind !== "target" && collapsed.has(row.id)) hiddenBelow = row.depth;
    }
    return out;
  }, [rows, collapsed]);

  if (rows.length === 0) {
    return <p className="px-2 py-8 text-center text-[12px] text-[var(--c-text-muted)]">{emptyMessage}</p>;
  }

  return (
    <>
      {visible.map((row) => {
        // ── Dossier ────────────────────────────────────────────────────
        if (row.kind === "group") {
          const expanded = !collapsed.has(row.id);
          return (
            <div
              key={row.id}
              style={{ paddingLeft: 4 + row.depth * 14 }}
              className="flex h-7 items-center gap-1 rounded-md pr-1 hover:bg-[var(--c-hover)]"
            >
              <button
                onClick={() => toggleCollapsed(row.id)}
                aria-label={expanded ? `Replier ${row.group.name}` : `Déplier ${row.group.name}`}
                className="flex h-5 w-5 shrink-0 items-center justify-center rounded-sm text-[var(--c-text-muted)] hover:text-[var(--c-text)]"
              >
                {expanded ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
              </button>
              {onToggleKeys && countChecked && row.keys.length > 0 && (
                <BulkCheckbox
                  keys={row.keys}
                  checkedCount={countChecked(row.keys)}
                  onToggle={(checked) => onToggleKeys(row.keys, checked)}
                  title={`Tout sélectionner — ${row.group.name}`}
                />
              )}
              <button onClick={() => toggleCollapsed(row.id)} className="flex min-w-0 flex-1 items-center gap-1.5 truncate text-left text-[12.5px] font-medium text-[var(--c-text-secondary)]">
                {row.group.icon
                  ? <HostIcon iconId={row.group.icon} customIcons={customIcons} size={15} />
                  : <IconFolder size={14} className="shrink-0 text-[var(--c-text-muted)]" />}
                <span className="truncate">{row.group.name}</span>
              </button>
            </div>
          );
        }

        // ── Hôte relais (Docker exec, K8s exec) : l'en-tête de ses cibles,
        //    pas une cible en soi. Même ligne, avec le chevron à la place de
        //    la case individuelle. ─────────────────────────────────────────
        if (row.kind === "host") {
          const expanded = !collapsed.has(row.id);
          return (
            <div
              key={row.id}
              style={{ paddingLeft: 4 + row.depth * 14 }}
              className="list-row h-10 pr-1"
            >
              <button
                onClick={() => toggleCollapsed(row.id)}
                aria-label={expanded ? "Replier" : "Déplier"}
                className="flex h-5 w-5 shrink-0 items-center justify-center rounded-sm text-[var(--c-text-muted)] hover:text-[var(--c-text)]"
              >
                {expanded ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
              </button>
              {onToggleKeys && countChecked && row.keys.length > 0 && (
                <BulkCheckbox
                  keys={row.keys}
                  checkedCount={countChecked(row.keys)}
                  onToggle={(checked) => onToggleKeys(row.keys, checked)}
                  title={`Tout sélectionner — ${row.host.label}`}
                />
              )}
              <RowIcon host={row.host} customIcons={customIcons} />
              <span className="flex min-w-0 flex-1 flex-col justify-center gap-px leading-tight">
                <span className="truncate text-[12.5px] font-medium text-[var(--c-text)]">{row.host.label}</span>
                <span className="flex items-center gap-1.5">
                  <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-[var(--c-text-muted)]">{row.host.address}</span>
                  <TagChips tags={row.host.tags} />
                </span>
              </span>
            </div>
          );
        }

        // ── Cible cochable ─────────────────────────────────────────────
        const disabled = isDisabled?.(row.target) ?? false;
        const checked = isChecked(row.target);
        const host = row.target.hostId ? hostById.get(row.target.hostId) : undefined;
        const extra = renderExtra?.(row.target);
        return (
          <label
            key={row.id}
            title={disabled ? disabledTitle : undefined}
            data-active={checked ? "true" : undefined}
            style={{ paddingLeft: 8 + row.depth * 14 }}
            className={`list-row h-10 pr-2 ${disabled ? "opacity-50" : "cursor-pointer"}`}
          >
            <input
              type="checkbox"
              checked={checked}
              disabled={disabled}
              onChange={() => onToggle(row.target)}
              className="shrink-0"
            />
            <RowIcon host={host} customIcons={customIcons} fallback="terminal" />
            <span className="flex min-w-0 flex-1 flex-col justify-center gap-px leading-tight">
              <span className="flex items-center gap-1.5">
                <span className="truncate text-[12.5px] font-medium text-[var(--c-text)]">{row.target.label}</span>
                {extra && <span className="ml-auto flex shrink-0 items-center gap-1.5">{extra}</span>}
              </span>
              <span className="flex items-center gap-1.5">
                <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-[var(--c-text-muted)]">{row.target.sub ?? ""}</span>
                <TagChips tags={row.tags} />
              </span>
            </span>
          </label>
        );
      })}
    </>
  );
}
