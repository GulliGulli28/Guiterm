import { useEffect, useRef, useState } from "react";
import { useModalSurface } from "../hooks/useModalSurface";

export interface PaletteCommand {
  id: string;
  label: string;
  hint?: string;
  /** Termes supplémentaires que la recherche accepte sans qu'ils soient
   * affichés — les tags et l'adresse d'un hôte, qui sont ce qu'on a en tête
   * quand on ne se souvient pas du libellé exact. */
  keywords?: string;
  /** La section où l'entrée s'affiche. Absente = « Actions ». */
  group?: PaletteGroup;
  /** Ce qui s'affiche en gras à la place de `label` — le nom d'un hôte, là
   * où `label` (« Se connecter — Production › web-01 ») reste le texte
   * cherché et lu par un lecteur d'écran. */
  title?: string;
  /** Une seconde ligne, en chasse fixe : `user@adresse · dossier`. */
  detail?: string;
  run: () => void;
}

export type PaletteGroup = "Hôtes" | "Actions" | "Panneaux";

/** L'ordre des sections. Sans recherche, les actions d'abord (c'est ce qu'on
 * ouvre la palette pour faire) ; dès qu'on tape, les hôtes d'abord — on
 * tape presque toujours un nom de machine. */
const ORDER_IDLE: PaletteGroup[] = ["Actions", "Panneaux", "Hôtes"];
const ORDER_SEARCH: PaletteGroup[] = ["Hôtes", "Actions", "Panneaux"];

interface CommandPaletteProps {
  commands: PaletteCommand[];
  /** Sur quoi porte cette liste, quand elle ne porte pas sur toute l'app.
   *
   * Le bus d'objets rouvre la même palette réduite aux actions d'une chose
   * précise — sans ce titre, une liste de trois entrées sortie de nulle part
   * ne dirait pas *sur quoi* elle agit, et c'est justement ce que l'utilisateur
   * vient de sélectionner du bout de la souris. */
  title?: string;
  placeholder?: string;
  onClose: () => void;
}

export function CommandPalette({ commands, title, placeholder, onClose }: CommandPaletteProps) {
  const { ref, dialogProps } = useModalSurface({ onClose, label: "Palette de commandes" });
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  useEffect(() => { inputRef.current?.focus(); }, []);

  // Mot à mot, comme les arborescences de l'app (`vaultTree`, `hostTree`) :
  // « panneau clés » doit trouver « Panneau — Clés », que la recherche d'un
  // seul bloc manquait à cause du tiret. Tous les mots doivent correspondre.
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matching = terms.length > 0
    ? commands.filter((c) => {
        const haystack = `${c.label} ${c.title ?? ""} ${c.keywords ?? ""}`.toLowerCase();
        return terms.every((t) => haystack.includes(t));
      })
    : commands;
  // Groupées par section, l'ordre d'origine gardé dans chacune. Une liste
  // sans aucun groupe (les actions d'un objet, les champs d'un item
  // GuiVault) reste telle quelle, sans en-tête.
  const grouped = commands.some((c) => c.group);
  const order = terms.length > 0 ? ORDER_SEARCH : ORDER_IDLE;
  const filtered = grouped
    ? order.flatMap((g) => matching.filter((c) => (c.group ?? "Actions") === g))
    : matching;

  useEffect(() => { setActiveIndex(0); }, [query]);
  useEffect(() => { itemRefs.current[activeIndex]?.scrollIntoView({ block: "nearest" }); }, [activeIndex]);

  const runAt = (index: number) => {
    const cmd = filtered[index];
    if (cmd) { cmd.run(); onClose(); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-[15vh]" onClick={onClose}>
      <div
        ref={ref}
        {...dialogProps}
        className="modal w-full max-w-[600px] overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {title && (
          <p className="eyebrow truncate border-b border-[var(--c-border)] px-4 pb-1.5 pt-2.5" title={title}>
            {title}
          </p>
        )}
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Escape") { e.preventDefault(); onClose(); }
            if (e.key === "ArrowDown") { e.preventDefault(); setActiveIndex((i) => Math.min(i + 1, filtered.length - 1)); }
            if (e.key === "ArrowUp") { e.preventDefault(); setActiveIndex((i) => Math.max(i - 1, 0)); }
            if (e.key === "Enter") { e.preventDefault(); runAt(activeIndex); }
          }}
          placeholder={placeholder ?? "Tapez une commande… (se connecter, fermer l'onglet, paramètres…)"}
          className="w-full border-b border-[var(--c-border)] bg-transparent px-4 py-3 text-[13.5px] text-[var(--c-text)] outline-none placeholder:text-[var(--c-text-muted)]"
        />
        <div className="sidebar-scroll max-h-[420px] overflow-y-auto py-1">
          {filtered.length === 0 && (
            <p className="px-4 py-6 text-center text-[12.5px] text-[var(--c-text-muted)]">
              {commands.length === 0 && title ? "Aucun onglet ne sait quoi faire de ça." : "Aucun résultat"}
            </p>
          )}
          {filtered.map((cmd, i) => {
            const group = cmd.group ?? "Actions";
            const header = grouped && (i === 0 || (filtered[i - 1].group ?? "Actions") !== group);
            return (
              <div key={cmd.id}>
                {header && <p className="px-4 pb-1 pt-2.5 text-[11.5px] font-medium text-[var(--c-text-faint)]">{group}</p>}
                <button
                  ref={(el) => { itemRefs.current[i] = el; }}
                  onClick={() => runAt(i)}
                  onMouseEnter={() => setActiveIndex(i)}
                  aria-label={cmd.title ? cmd.label : undefined}
                  className={`relative mx-1 flex w-[calc(100%-0.5rem)] items-center justify-between gap-3 rounded-md px-3 text-left text-[12.5px] transition-colors py-1.5 ${
                    i === activeIndex ? "bg-[var(--c-active)] text-[var(--c-text)]" : "text-[var(--c-text-secondary)]"
                  }`}
                >
                  {cmd.detail ? (
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate font-medium text-[var(--c-text)]">{cmd.title ?? cmd.label}</span>
                      <span className="truncate font-mono text-[11.5px] text-[var(--c-text-muted)]">{cmd.detail}</span>
                    </span>
                  ) : (
                    <span className="truncate">{cmd.title ?? cmd.label}</span>
                  )}
                  {cmd.hint && <span className="kbd shrink-0">{cmd.hint}</span>}
                </button>
              </div>
            );
          })}
        </div>
        {grouped && (
          <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-[var(--c-border)] px-4 py-2 text-[11.5px] text-[var(--c-text-muted)]">
            <span><span className="kbd">↑ ↓</span> parcourir</span>
            <span><span className="kbd">Entrée</span> ouvrir</span>
            <span><span className="kbd">Échap</span> fermer</span>
          </div>
        )}
      </div>
    </div>
  );
}
