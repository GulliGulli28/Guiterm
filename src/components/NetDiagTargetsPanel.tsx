import type { Workspace } from "../lib/types";
import { useNetDiagSelection } from "../hooks/useNetDiagSelection";
import { TargetTreeList } from "./TargetTreeList";
import { IconSearch } from "./ui-icons";

/**
 * Les machines que le diagnostic réseau interroge, dans la barre latérale.
 *
 * Cette colonne vivait dans l'onglet. Elle en est sortie pour la raison qui
 * vaut aussi pour `FleetTargetsPanel` : l'app affiche déjà l'arborescence des
 * hôtes dans la barre latérale (Hôtes, SFTP), et en avoir une deuxième, plus
 * étroite, à l'intérieur d'un onglet demandait de choisir ses machines à un
 * endroit différent selon ce qu'on voulait en faire. L'onglet ne garde que la
 * question posée et la grille de réponses.
 *
 * L'en-tête suit le sens du diagnostic : ce ne sont pas les mêmes machines
 * qu'on coche selon qu'on demande « depuis ces hôtes, qu'est-ce qui répond ? »
 * ou « ces hôtes-là répondent-ils ? ».
 */
export function NetDiagTargetsPanel({ workspace, onOpenTab }: { workspace: Workspace; onOpenTab: () => void }) {
  const {
    direction, filter, setFilter, selected, rows, visibleKeys, toggle, toggleKeys, selectAll, selectNone,
  } = useNetDiagSelection();

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between px-1 pb-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-[var(--c-text-secondary)]">
          {direction === "from" ? "Sonder depuis" : "Hôtes à sonder"} · {selected.size}
        </span>
        {/* Le panneau reste utilisable quand l'onglet a été fermé : cocher des
            machines sans pouvoir lancer quoi que ce soit serait un cul-de-sac. */}
        <button
          onClick={onOpenTab}
          className="rounded px-1.5 py-0.5 text-[11px] text-[var(--c-accent-text)] hover:bg-[var(--c-bg3)]"
        >
          Ouvrir l'onglet
        </button>
      </div>

      <div className="px-1 pb-2">
        <div className="flex items-center gap-2 rounded-md border border-[var(--c-border)] bg-[var(--c-bg2)] px-2 py-1.5">
          <IconSearch size={13} className="text-[var(--c-text-faint)]" />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filtrer (nom, dossier, tag…)"
            className="w-full bg-transparent text-xs text-[var(--c-text)] placeholder:text-[var(--c-text-faint)]"
          />
        </div>
        <div className="mt-1.5 flex gap-2 px-0.5">
          <button onClick={selectAll} className="text-[10px] text-[var(--c-accent-text)] hover:underline">
            Tout ({visibleKeys.length})
          </button>
          <button onClick={selectNone} className="text-[10px] text-[var(--c-text-muted)] hover:underline">
            Aucun
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-0.5 pb-2">
        <TargetTreeList
          rows={rows}
          customIcons={workspace.customIcons}
          isChecked={(t) => selected.has(t.key)}
          onToggle={(t) => toggle(t.key)}
          onToggleKeys={toggleKeys}
          countChecked={(keys) => keys.reduce((n, key) => n + (selected.has(key) ? 1 : 0), 0)}
          emptyMessage={
            filter.trim()
              ? "Aucune cible ne correspond."
              : direction === "to"
                ? "Aucun hôte SSH enregistré — ce sens sonde l'adresse d'un hôte, que le terminal local et les conteneurs n'ont pas."
                : "Aucune cible."
          }
          renderTarget={(t) => (
            <>
              <span className="block truncate text-[12px] text-[var(--c-text)]">{t.label}</span>
              {t.sub && <span className="block truncate text-[10px] text-[var(--c-text-muted)]">{t.sub}</span>}
            </>
          )}
        />
      </div>
    </div>
  );
}
