import type { ReactNode } from "react";

/**
 * La ligne commune de toutes les listes de la barre latérale : un hôte, une
 * clé, une connexion SQL, un tunnel, un runbook, une clé d'hôte, une cible.
 *
 * Une seule anatomie, pour que d'un panneau à l'autre l'œil retrouve les
 * mêmes choses au même endroit :
 *
 *   [◻] [icône]  Titre  badges …………………… méta   [actions au survol]
 *                ligne secondaire (mono), tags, compléments — qui passent à
 *                la ligne quand ils ne tiennent pas, la ligne grandit
 *
 * Deux habillages : `row` (fond au survol seulement, pour les arbres
 * indentés — hôtes, SFTP, cibles) et `card` (bordée, pour les listes plates —
 * clés, bases, tunnels, snippets, runbooks). Le contenu et ses proportions
 * sont identiques dans les deux.
 *
 * Rien n'est tronqué par manque de largeur, sauf le titre s'il dépasse à lui
 * seul la ligne : c'est ce qui rend la barre latérale utilisable à 260 px
 * comme à 600. Les actions sont révélées au survol ou au focus clavier, pour
 * ne pas bruiter chaque ligne de trois boutons.
 */
export interface EntityRowProps {
  variant?: "row" | "card";
  /** Ce qui précède l'icône : une case à cocher, un chevron. */
  leading?: ReactNode;
  icon?: ReactNode;
  title: ReactNode;
  /** À côté du titre : compte de conteneurs, genre de connexion… */
  badges?: ReactNode;
  /** Calé à droite de la ligne de titre : un pourcentage, un état. */
  meta?: ReactNode;
  /** Sous le titre. Chaque élément est un morceau qui peut passer à la
   * ligne indépendamment (adresse, système, tags). */
  secondary?: ReactNode;
  /** Boutons à droite, révélés au survol. `alwaysVisibleActions` pour un
   * bouton qui doit rester là (« Démarrer » un tunnel). */
  actions?: ReactNode;
  alwaysVisibleActions?: ReactNode;
  /** Clic sur la zone principale (titre + secondaire). */
  onClick?: () => void;
  title_?: string;
  active?: boolean;
  /** Indentation d'un arbre, en niveaux. */
  depth?: number;
  className?: string;
  /** Sous la ligne, dans la même carte : un formulaire déplié. */
  children?: ReactNode;
  /** Attributs de données pour les tests. */
  dataAttrs?: Record<string, string | undefined>;
}

export function EntityRow({
  variant = "row", leading, icon, title, badges, meta, secondary, actions, alwaysVisibleActions,
  onClick, title_, active, depth = 0, className = "", children, dataAttrs,
}: EntityRowProps) {
  const surface = variant === "card"
    ? "card mb-2 px-3 py-2.5 transition-colors hover:border-[var(--c-border-strong)]"
    : "list-row mb-1 min-h-11 py-2";
  const body = (
    <>
      {icon && (
        <span className="relative mt-px flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-[var(--c-bg3)] text-[var(--c-text-secondary)]">
          {icon}
        </span>
      )}
      <span className="flex min-w-0 flex-1 flex-col justify-center gap-1 leading-tight">
        {/* Le titre garde la priorité : les badges et la méta passent à la
            ligne avant qu'il ne se tronque. */}
        <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
          <span className="max-w-full truncate text-[12.5px] font-medium text-[var(--c-text)]">{title}</span>
          {badges}
          {meta && <span className="ml-auto flex shrink-0 items-center gap-1.5 pl-2">{meta}</span>}
        </span>
        {secondary && (
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[10.5px] text-[var(--c-text-muted)]">
            {secondary}
          </span>
        )}
      </span>
    </>
  );
  return (
    <div
      {...dataAttrs}
      data-active={active ? "true" : undefined}
      // `flex-wrap` : quand le panneau est trop étroit pour le contenu et les
      // actions côte à côte, les actions passent dessous, alignées à droite —
      // le contenu garde au moins 8 rem et reste lisible.
      className={`group/entity relative flex flex-wrap items-start gap-x-2.5 gap-y-1.5 ${surface} ${className}`}
      style={depth ? { paddingLeft: (variant === "card" ? 12 : 10) + depth * 14 } : undefined}
    >
      {leading && <span className="mt-1 flex shrink-0 items-center gap-1">{leading}</span>}
      {onClick ? (
        <button onClick={onClick} title={title_} className="flex min-w-[8rem] flex-1 items-start gap-2.5 text-left">
          {body}
        </button>
      ) : (
        <span className="flex min-w-[8rem] flex-1 items-start gap-2.5">{body}</span>
      )}
      {(actions || alwaysVisibleActions) && (
        <span className="-mr-1 -mt-0.5 ml-auto flex shrink-0 items-center gap-0.5">
          {actions && (
            <span className="flex items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover/entity:opacity-100">
              {actions}
            </span>
          )}
          {alwaysVisibleActions}
        </span>
      )}
      {children && <div className="basis-full">{children}</div>}
    </div>
  );
}

/** Les étiquettes d'une ligne, dans la zone secondaire. */
export function EntityTags({ tags }: { tags: string[] }) {
  if (tags.length === 0) return null;
  return (
    <span className="flex flex-wrap gap-1">
      {tags.map((tag) => <span key={tag} className="tag">{tag}</span>)}
    </span>
  );
}

/** Une valeur en chasse fixe (adresse, chemin, clé publique) qui se coupe au
 * caractère plutôt que de se tronquer. */
export function EntityMono({ children, title }: { children: ReactNode; title?: string }) {
  return <span className="max-w-full break-all font-mono" title={title}>{children}</span>;
}

/** L'en-tête repliable d'un dossier dans un arbre. La taille suit
 * `--group-row-font`/`--group-row-h`, réglables dans les préférences. */
export function GroupRow({
  depth, expanded, onToggle, icon, name, count, actions, leading,
}: {
  depth: number;
  expanded: boolean;
  onToggle: () => void;
  icon: ReactNode;
  name: string;
  count?: number;
  actions?: ReactNode;
  leading?: ReactNode;
}) {
  return (
    <div
      style={{ paddingLeft: 4 + depth * 14 }}
      className="group/folder mb-1 mt-1.5 flex min-h-[var(--group-row-h)] items-center gap-1 rounded-md pr-1 hover:bg-[var(--c-hover)]"
    >
      <button
        onClick={onToggle}
        aria-label={expanded ? `Replier ${name}` : `Déplier ${name}`}
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded-sm text-[var(--c-text-muted)] hover:text-[var(--c-text)]"
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" className={`transition-transform ${expanded ? "rotate-90" : ""}`}>
          <path d="M6 3.5 10.5 8 6 12.5" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {leading}
      <button
        onClick={onToggle}
        className="flex min-w-0 flex-1 items-center gap-1.5 truncate text-left font-medium text-[var(--c-text-secondary)]"
        style={{ fontSize: "var(--group-row-font)" }}
      >
        <span className="shrink-0 text-[var(--c-text-muted)]">{icon}</span>
        <span className="truncate">{name}</span>
        {count != null && count > 0 && <span className="text-[10.5px] font-normal text-[var(--c-text-faint)]">{count}</span>}
      </button>
      {actions && (
        <span className="flex shrink-0 items-center opacity-0 focus-within:opacity-100 group-hover/folder:opacity-100">
          {actions}
        </span>
      )}
    </div>
  );
}
