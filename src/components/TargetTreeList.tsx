import { useMemo, useState } from "react";
import type { CustomIcon, Host } from "../lib/types";
import type { TargetLike, TargetRow } from "../lib/targetTree";
import { hostKindMeta } from "../lib/hostKinds";
import { HostIcon } from "./icons";
import { IconChevronDown, IconChevronRight, IconFolder, IconHosts } from "./ui-icons";

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

/** Pastilles de tags, comme `SftpPanel` : sous la carte, pas dans son corps. */
function TagChips({ tags }: { tags: string[] }) {
  if (tags.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1 px-3 pb-2.5">
      {tags.map((tag) => (
        <span key={tag} className="rounded-full bg-[var(--c-bg2)] px-1.5 py-0.5 text-[10px] text-[var(--c-text-secondary)]">
          {tag}
        </span>
      ))}
    </div>
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
      className="shrink-0 accent-[var(--c-accent)]"
    />
  );
}

/** La pastille d'icône d'une carte — reprise de `SftpPanel`, badge de genre
 * compris. `host` est absent pour le terminal local, qui n'est rattaché à
 * aucune machine enregistrée. */
function CardIcon({ host, customIcons }: { host: Host | undefined; customIcons: CustomIcon[] }) {
  const kind = host?.kind ?? "ssh";
  const { label: kindLabel, Icon: KindIcon } = hostKindMeta(kind);
  return (
    <div className="relative flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-[var(--c-accent-dim)]">
      {host?.icon
        ? <HostIcon iconId={host.icon} customIcons={customIcons} size={24} />
        : <IconHosts size={18} className="text-[var(--c-accent-text)]" />}
      {host && kind !== "ssh" && (
        <span
          title={kindLabel}
          className="absolute -left-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full border-2 border-[var(--c-bg3)] bg-[var(--c-bg2)] text-[var(--c-text-secondary)]"
        >
          <KindIcon size={9} />
        </span>
      )}
    </div>
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
    return <p className="px-1 py-4 text-center text-[13px] text-[var(--c-text-muted)]">{emptyMessage}</p>;
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
              style={{ marginLeft: row.depth * 14 }}
              className="flex items-center gap-0.5 rounded-md px-1 py-1 hover:bg-white/5"
            >
              <button
                onClick={() => toggleCollapsed(row.id)}
                className="flex w-4 shrink-0 items-center justify-center text-[var(--c-text-muted)]"
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
              <span className="flex min-w-0 flex-1 items-center gap-1.5 truncate text-[13px] font-medium text-[var(--c-text-secondary)]">
                {row.group.icon
                  ? <HostIcon iconId={row.group.icon} customIcons={customIcons} size={20} />
                  : <IconFolder size={18} className="text-[var(--c-text-muted)]" />}
                {row.group.name}
              </span>
            </div>
          );
        }

        // ── Hôte relais (Docker exec, K8s exec) : l'en-tête de ses cibles,
        //    pas une cible en soi. Même carte, avec le chevron à la place de
        //    la case individuelle. ─────────────────────────────────────────
        if (row.kind === "host") {
          const expanded = !collapsed.has(row.id);
          const { label: kindLabel } = hostKindMeta(row.host.kind ?? "ssh");
          return (
            <div
              key={row.id}
              style={{ marginLeft: row.depth * 14 }}
              className="rounded-xl border border-transparent bg-[var(--c-bg3)] transition-all hover:border-white/15"
            >
              <div className="flex items-stretch">
                <button
                  onClick={() => toggleCollapsed(row.id)}
                  title={expanded ? "Replier" : "Déplier"}
                  className="flex shrink-0 items-center pl-3 text-[var(--c-text-muted)]"
                >
                  {expanded ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
                </button>
                {onToggleKeys && countChecked && row.keys.length > 0 && (
                  <label className="flex shrink-0 cursor-pointer items-center pl-2">
                    <BulkCheckbox
                      keys={row.keys}
                      checkedCount={countChecked(row.keys)}
                      onToggle={(checked) => onToggleKeys(row.keys, checked)}
                      title={`Tout sélectionner — ${row.host.label}`}
                    />
                  </label>
                )}
                <div className="flex min-w-0 flex-1 items-center gap-2.5 p-3 text-left">
                  <CardIcon host={row.host} customIcons={customIcons} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[14px] font-medium text-[var(--c-text)]">{row.host.label}</div>
                    <div className="truncate font-mono text-[11px] text-[var(--c-text-muted)]" title={kindLabel}>
                      {row.host.address}
                    </div>
                  </div>
                </div>
              </div>
              <TagChips tags={row.host.tags} />
            </div>
          );
        }

        // ── Cible cochable ─────────────────────────────────────────────
        const disabled = isDisabled?.(row.target) ?? false;
        const checked = isChecked(row.target);
        const host = row.target.hostId ? hostById.get(row.target.hostId) : undefined;
        return (
          <label
            key={row.id}
            title={disabled ? disabledTitle : undefined}
            style={{ marginLeft: row.depth * 14 }}
            className={`block rounded-xl border transition-all ${
              checked
                ? "glow-ring border-transparent"
                : disabled
                  ? "border-transparent opacity-60"
                  : "cursor-pointer border-transparent hover:border-white/15"
            } bg-[var(--c-bg3)]`}
          >
            <div className="flex items-stretch">
              <span className="flex shrink-0 items-center pl-3">
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={disabled}
                  onChange={() => onToggle(row.target)}
                  className="accent-[var(--c-accent)] disabled:opacity-60"
                />
              </span>
              <div className="flex min-w-0 flex-1 items-center gap-2.5 p-3 text-left">
                <CardIcon host={host} customIcons={customIcons} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[14px] font-medium text-[var(--c-text)]">{row.target.label}</div>
                  {row.target.sub && (
                    <div className="truncate font-mono text-[11px] text-[var(--c-text-muted)]">{row.target.sub}</div>
                  )}
                  {renderExtra?.(row.target)}
                </div>
              </div>
            </div>
            <TagChips tags={row.tags} />
          </label>
        );
      })}
    </>
  );
}
