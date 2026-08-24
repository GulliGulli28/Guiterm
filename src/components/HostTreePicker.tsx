import { useEffect, useMemo, useRef, useState } from "react";
import type { CustomIcon, Group, GroupId, Host, HostId } from "../lib/types";
import { buildHostTree } from "../lib/hostTree";
import { hostKindMeta } from "../lib/hostKinds";
import { HostIcon } from "./icons";
import { IconChevronDown, IconChevronRight, IconFolder, IconHosts, IconSearch } from "./ui-icons";
import { useModalSurface } from "../hooks/useModalSurface";

/**
 * Le choix d'un hôte, partout, sous la forme de l'arborescence de la barre
 * latérale — pas d'une liste plate.
 *
 * **Pourquoi un composant maison plutôt qu'un `<select>`.** Les onze champs
 * de sélection d'hôte de l'app affichaient `workspace.hosts` à plat, dans
 * l'ordre de stockage : ni les dossiers, ni les tags, ni même de quoi
 * distinguer deux machines qui portent le même libellé dans deux dossiers
 * différents. Un `<option>` natif ne peut contenir que du texte — pas une
 * pastille de tag, pas une icône, pas une indentation fiable (`<optgroup>`
 * ne s'imbrique pas, or les dossiers de ce projet sont récursifs). D'où une
 * liste construite à la main.
 *
 * Trois enveloppes partagent le même corps (`HostTreeList`) :
 * - `HostTreePicker` — un bouton qui ouvre la liste en popup (remplace les
 *   `<select>`) ;
 * - `HostTreeModal` — la même liste dans une boîte de dialogue (remplace les
 *   `ConnectionPickerModal` qui listaient des hôtes enregistrés) ;
 * - `HostTreeList` — exporté tel quel pour les panneaux qui l'intègrent
 *   directement (flotte, diagnostic réseau) avec leurs propres cases à cocher.
 *
 * La recherche vient de `lib/hostTree.ts`, déjà utilisée par `HostsPanel` :
 * elle compare libellé, adresse, utilisateur **et tags**, donc taper « prod »
 * retrouve les hôtes tagués `prod` sans que ce composant en sache rien.
 */

/** Une entrée qui n'est pas un hôte enregistré — « Local », « Tous les hôtes »,
 * « Aucun ». Épinglée en tête de liste, jamais filtrée par la recherche : c'est
 * une option de la commande, pas une machine à retrouver. */
export interface HostTreeSpecialEntry {
  /** Valeur rendue par `onChange`. `null` sert la sémantique « rien ». */
  value: string | null;
  label: string;
  /** Court texte grisé sous le libellé. */
  hint?: string;
  icon?: React.ReactNode;
}

interface HostTreeListProps {
  hosts: Host[];
  groups: Group[];
  customIcons: CustomIcon[];
  /** Hôte sélectionné, ou la valeur d'une entrée spéciale. */
  value: string | null;
  onPick: (value: string | null) => void;
  specials?: HostTreeSpecialEntry[];
  emptyMessage?: string;
  /** Hauteur max de la zone défilante. */
  maxHeightClass?: string;
}

/** Pastilles de tags, telles que la barre latérale les dessine. */
function TagChips({ tags }: { tags: string[] }) {
  if (tags.length === 0) return null;
  return (
    <span className="mt-1 flex flex-wrap gap-1">
      {tags.map((tag) => (
        <span
          key={tag}
          data-host-tree-tag={tag}
          className="rounded-full border border-[var(--c-border)] bg-[var(--c-bg3)] px-1.5 py-0.5 text-[10px] leading-none text-[var(--c-text-secondary)]"
        >
          {tag}
        </span>
      ))}
    </span>
  );
}

/** `user@adresse` — ce qu'un `<option>` ne pouvait pas montrer sans allonger
 * le libellé, et exactement ce qui départage deux hôtes homonymes. */
export function hostSubtitle(host: Host): string {
  const kind = host.kind ?? "ssh";
  if (kind === "dockerExec") return host.address;
  if (kind === "k8sExec") return `Contexte : ${host.address}`;
  const defaultPort = kind === "rdp" ? 3389 : 22;
  return `${host.username}@${host.address}${host.port !== defaultPort ? `:${host.port}` : ""}`;
}

export function HostTreeList({
  hosts, groups, customIcons, value, onPick, specials = [],
  emptyMessage = "Aucun hôte", maxHeightClass = "max-h-72",
}: HostTreeListProps) {
  const [rawQuery, setRawQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Set<GroupId>>(new Set());
  const searchRef = useRef<HTMLInputElement>(null);

  // Le champ de recherche prend le focus à l'ouverture : sur un dépôt d'une
  // trentaine de machines, taper trois lettres reste plus rapide que dérouler.
  useEffect(() => { searchRef.current?.focus(); }, []);

  const query = rawQuery.trim().toLowerCase();
  const { hostsByGroup, groupsByParent, matchingGroups } = useMemo(
    () => buildHostTree(hosts, groups, query),
    [hosts, groups, query],
  );

  const childGroups = (parentId: GroupId | null) => groupsByParent.get(parentId) ?? [];
  const hostsIn = (groupId: GroupId | null) => hostsByGroup.get(groupId) ?? [];
  // Pendant une recherche les dossiers restent ouverts : replier ce qu'on
  // vient de retrouver n'aurait aucun sens (même règle que `HostsPanel`).
  const isExpanded = (id: GroupId) => (query !== "" ? true : !collapsed.has(id));

  const toggleGroup = (id: GroupId) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const totalMatches = useMemo(
    () => [...hostsByGroup.values()].reduce((n, bucket) => n + bucket.length, 0),
    [hostsByGroup],
  );

  /** Les hôtes **dans l'ordre où ils sont dessinés**, dossiers repliés exclus.
   * Sert la touche Entrée : `hostsByGroup` est indexé par dossier, donc son
   * premier élément est le premier *inséré*, pas le premier affiché — deux
   * choses différentes dès qu'il y a plus d'un dossier. */
  const orderedHosts = (): Host[] => {
    const out: Host[] = [];
    const walk = (parentId: GroupId | null) => {
      for (const group of childGroups(parentId)) {
        if (query !== "" && !matchingGroups.has(group.id)) continue;
        if (!isExpanded(group.id)) continue;
        walk(group.id);
        out.push(...hostsIn(group.id));
      }
    };
    walk(null);
    out.push(...hostsIn(null));
    return out;
  };

  const renderHost = (host: Host, depth: number) => {
    const selected = value === host.id;
    const kind = host.kind ?? "ssh";
    const { label: kindLabel, Icon: KindIcon } = hostKindMeta(kind);
    return (
      <div key={host.id}>
        <div
          data-host-tree-row="host"
          data-host-tree-depth={depth}
          data-host-tree-label={host.label}
          className={`flex items-start gap-1.5 pr-1.5 ${selected ? "bg-[var(--c-accent-dim)]" : "hover:bg-white/5"}`}
          style={{ paddingLeft: `${8 + depth * 14}px` }}
        >
          <button
            type="button"
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); onPick(host.id); }}
            title={`${host.label} — ${hostSubtitle(host)}`}
            className="flex min-w-0 flex-1 items-start gap-2 py-1.5 text-left"
          >
            <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center">
              {host.icon
                ? <HostIcon iconId={host.icon} customIcons={customIcons} size={14} />
                : <IconHosts size={12} className="text-[var(--c-text-muted)]" />}
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5">
                <span className={`truncate text-[12.5px] ${selected ? "text-[var(--c-accent-text)]" : "text-[var(--c-text)]"}`}>
                  {host.label}
                </span>
                {kind !== "ssh" && (
                  <span title={kindLabel} className="flex shrink-0 items-center text-[var(--c-text-faint)]">
                    <KindIcon size={10} />
                  </span>
                )}
              </span>
              <span className="block truncate font-mono text-[10.5px] text-[var(--c-text-muted)]">
                {hostSubtitle(host)}
              </span>
              <TagChips tags={host.tags} />
            </span>
            {selected && <span className="mt-0.5 shrink-0 text-[10px] text-[var(--c-accent-text)]">✓</span>}
          </button>
        </div>
      </div>
    );
  };

  const renderGroup = (group: Group, depth: number): React.ReactNode => {
    // Un dossier sans aucune correspondance disparaît pendant une recherche,
    // au lieu de rester comme un en-tête vide.
    if (query !== "" && !matchingGroups.has(group.id)) return null;
    const expanded = isExpanded(group.id);
    return (
      <div key={group.id}>
        <div
          data-host-tree-row="group"
          data-host-tree-depth={depth}
          data-host-tree-label={group.name}
          className="flex items-center gap-1 pr-1.5 hover:bg-white/5"
          style={{ paddingLeft: `${4 + depth * 14}px` }}
        >
          <button
            type="button"
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); toggleGroup(group.id); }}
            className="flex min-w-0 flex-1 items-center gap-1.5 py-1.5 text-left"
          >
            <span className="shrink-0 text-[var(--c-text-faint)]">
              {expanded ? <IconChevronDown size={11} /> : <IconChevronRight size={11} />}
            </span>
            {group.icon
              ? <HostIcon iconId={group.icon} customIcons={customIcons} size={13} />
              : <IconFolder size={12} className="shrink-0 text-[var(--c-text-muted)]" />}
            <span className="truncate text-[11.5px] font-medium uppercase tracking-wide text-[var(--c-text-secondary)]">
              {group.name}
            </span>
          </button>
        </div>
        {expanded && (
          <>
            {childGroups(group.id).map((child) => renderGroup(child, depth + 1))}
            {hostsIn(group.id).map((host) => renderHost(host, depth + 1))}
          </>
        )}
      </div>
    );
  };

  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex items-center gap-1.5 border-b border-[var(--c-border)] px-2 py-1.5">
        <IconSearch size={12} className="shrink-0 text-[var(--c-text-faint)]" />
        <input
          ref={searchRef}
          value={rawQuery}
          onChange={(e) => setRawQuery(e.target.value)}
          onKeyDown={(e) => {
            // Entrée choisit la première correspondance : sur un dépôt de
            // trente machines, taper trois lettres puis Entrée doit suffire.
            if (e.key !== "Enter") return;
            e.preventDefault();
            const first = orderedHosts()[0];
            if (first) onPick(first.id);
          }}
          placeholder="Rechercher un hôte, une adresse, un tag…"
          className="min-w-0 flex-1 rounded bg-transparent px-1 py-0.5 text-[12px] text-[var(--c-text)] placeholder:text-[var(--c-text-faint)] focus:outline-none focus:ring-1 focus:ring-[var(--c-accent-hover)]"
        />
      </div>
      <div className={`${maxHeightClass} overflow-y-auto py-1`}>
        {specials.map((special) => {
          const selected = value === special.value;
          return (
            <button
              key={special.value ?? "__none__"}
              type="button"
              data-host-tree-row="special"
              data-host-tree-label={special.label}
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); onPick(special.value); }}
              className={`flex w-full items-center gap-2 px-2 py-1.5 text-left ${selected ? "bg-[var(--c-accent-dim)]" : "hover:bg-white/5"}`}
            >
              <span className="flex h-4 w-4 shrink-0 items-center justify-center text-[var(--c-text-muted)]">
                {special.icon}
              </span>
              <span className="min-w-0 flex-1">
                <span className={`block truncate text-[12.5px] ${selected ? "text-[var(--c-accent-text)]" : "text-[var(--c-text)]"}`}>
                  {special.label}
                </span>
                {special.hint && (
                  <span className="block truncate text-[10.5px] text-[var(--c-text-muted)]">{special.hint}</span>
                )}
              </span>
              {selected && <span className="shrink-0 text-[10px] text-[var(--c-accent-text)]">✓</span>}
            </button>
          );
        })}
        {specials.length > 0 && (hosts.length > 0) && <div className="my-1 border-t border-[var(--c-border)]" />}
        {childGroups(null).map((group) => renderGroup(group, 0))}
        {hostsIn(null).map((host) => renderHost(host, 0))}
        {totalMatches === 0 && (
          <p className="px-3 py-3 text-[11.5px] text-[var(--c-text-muted)]">
            {query !== "" ? "Aucun hôte ne correspond." : emptyMessage}
          </p>
        )}
      </div>
    </div>
  );
}

interface HostTreePickerProps {
  hosts: Host[];
  groups: Group[];
  customIcons: CustomIcon[];
  value: string | null;
  onChange: (value: string | null) => void;
  specials?: HostTreeSpecialEntry[];
  /** Texte du bouton quand `value` ne correspond à rien de connu. */
  placeholder?: string;
  disabled?: boolean;
  /** Classes du bouton, pour épouser le champ qu'il remplace. */
  className?: string;
  title?: string;
}

const DEFAULT_BUTTON_CLASS =
  "flex w-full items-center justify-between gap-2 rounded-md bg-[var(--c-bg3)] px-2.5 py-1.5 text-left text-sm text-[var(--c-text)] focus:outline-none focus:ring-1 focus:ring-[var(--c-accent-hover)] disabled:opacity-60";

export function HostTreePicker({
  hosts, groups, customIcons, value, onChange, specials = [],
  placeholder = "Choisir un hôte…", disabled, className, title,
}: HostTreePickerProps) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const [dropdownStyle, setDropdownStyle] = useState<React.CSSProperties>({});

  const selectedHost = value ? hosts.find((h) => h.id === value) ?? null : null;
  const selectedSpecial = specials.find((s) => s.value === value) ?? null;

  // Même mécanique que `GroupTreePicker` : positionnement `fixed` calculé à
  // l'ouverture, pour que la liste ne soit pas rognée par l'`overflow` d'un
  // panneau parent — ce qui arrive dès que le champ est dans une barre
  // d'outils ou un formulaire défilant.
  const openDropdown = () => {
    const rect = btnRef.current?.getBoundingClientRect();
    if (rect) {
      const dropdownMaxH = 340;
      const spaceBelow = window.innerHeight - rect.bottom;
      const width = Math.max(rect.width, 260);
      setDropdownStyle(
        spaceBelow < dropdownMaxH && rect.top > dropdownMaxH
          ? { position: "fixed", bottom: window.innerHeight - rect.top + 4, left: rect.left, width, zIndex: 9999 }
          : { position: "fixed", top: rect.bottom + 4, left: rect.left, width, zIndex: 9999 },
      );
    }
    setOpen(true);
  };

  const pick = (next: string | null) => {
    onChange(next);
    setOpen(false);
  };

  return (
    <div className="relative">
      <button
        ref={btnRef}
        type="button"
        disabled={disabled}
        title={title ?? (selectedHost ? hostSubtitle(selectedHost) : undefined)}
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); if (open) setOpen(false); else openDropdown(); }}
        className={className ?? DEFAULT_BUTTON_CLASS}
      >
        <span className="flex min-w-0 items-center gap-1.5 truncate">
          {selectedHost ? (
            <>
              {selectedHost.icon
                ? <HostIcon iconId={selectedHost.icon} customIcons={customIcons} size={13} />
                : <IconHosts size={12} className="shrink-0 text-[var(--c-text-muted)]" />}
              <span className="truncate">{selectedHost.label}</span>
              {selectedHost.tags.length > 0 && (
                <span className="shrink-0 truncate text-[10px] text-[var(--c-text-faint)]">
                  {selectedHost.tags.join(" · ")}
                </span>
              )}
            </>
          ) : selectedSpecial ? (
            <>
              {selectedSpecial.icon}
              <span className="truncate">{selectedSpecial.label}</span>
            </>
          ) : (
            <span className="truncate text-[var(--c-text-muted)]">{placeholder}</span>
          )}
        </span>
        <IconChevronDown size={10} className="shrink-0 text-[var(--c-text-faint)]" />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-[9998]" onClick={() => setOpen(false)} />
          <div
            style={dropdownStyle}
            onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); setOpen(false); } }}
            className="overflow-hidden rounded-md border border-[var(--c-border)] bg-[var(--c-bg2)] shadow-[var(--shadow-lg)]"
          >
            <HostTreeList
              hosts={hosts}
              groups={groups}
              customIcons={customIcons}
              value={value}
              onPick={pick}
              specials={specials}
            />
          </div>
        </>
      )}
    </div>
  );
}

interface HostTreeModalProps {
  title: string;
  hosts: Host[];
  groups: Group[];
  customIcons: CustomIcon[];
  onPick: (hostId: HostId) => void;
  onClose: () => void;
  emptyMessage?: string;
}

/** La même arborescence dans une boîte de dialogue — pour les parcours qui
 * demandent l'hôte avant toute autre chose (choisir où enregistrer, quel
 * fichier SQLite ouvrir). */
export function HostTreeModal({ title, hosts, groups, customIcons, onPick, onClose, emptyMessage }: HostTreeModalProps) {
  const { ref, dialogProps } = useModalSurface({ onClose, label: title });
  return (
    <>
      <div className="fixed inset-0 z-30 bg-black/50" onClick={onClose} />
      <div
        ref={ref}
        {...dialogProps}
        className="fixed left-1/2 top-1/2 z-40 flex max-h-[80vh] w-[400px] max-w-[90vw] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-lg bg-[var(--c-bg2)] shadow-[var(--shadow-lg)]"
      >
        <div className="border-b border-[var(--c-border)] px-4 py-3">
          <p className="text-[14px] font-medium text-[var(--c-text)]">{title}</p>
        </div>
        <HostTreeList
          hosts={hosts}
          groups={groups}
          customIcons={customIcons}
          value={null}
          onPick={(v) => { if (v) onPick(v as HostId); }}
          emptyMessage={emptyMessage}
          maxHeightClass="max-h-[60vh]"
        />
        <div className="border-t border-[var(--c-border)] p-2">
          <button
            onClick={onClose}
            className="w-full rounded-md bg-[var(--c-bg3)] py-1.5 text-center text-[12px] text-[var(--c-text-secondary)] hover:bg-white/5"
          >
            Fermer
          </button>
        </div>
      </div>
    </>
  );
}
