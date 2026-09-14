import type { Workspace } from "../lib/types";
import { useNetDiagSelection } from "../hooks/useNetDiagSelection";
import { FactFilterFields } from "./FactFilterFields";
import { TargetTreeList } from "./TargetTreeList";
import { IconRefresh, IconSearch } from "./ui-icons";

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
 * La mise en page est celle de `SftpPanel`, au détail près : `h-full` (et non
 * `flex-1`, qui ne contraint rien sous le conteneur en bloc de `Sidebar.tsx` —
 * l'arborescence débordait alors sans défiler), puis `sidebar-scroll` sur la
 * zone qui défile.
 *
 * L'en-tête suit le sens du diagnostic : ce ne sont pas les mêmes machines
 * qu'on coche selon qu'on demande « depuis ces hôtes, qu'est-ce qui répond ? »
 * ou « ces hôtes-là répondent-ils ? ».
 */
export function NetDiagTargetsPanel({ workspace, onOpenTab }: { workspace: Workspace; onOpenTab: () => void }) {
  const {
    direction, filter, setFilter, selected, rows, visibleKeys, toggle, toggleKeys, selectAll, selectNone,
    hasSshHosts, filters, setFilters, hasFacts, selectByFacts, collectingFacts, collectFacts,
  } = useNetDiagSelection();

  return (
    <div className="flex h-full min-w-0 flex-col gap-2">
      <div className="flex items-center justify-between pl-1">
        <span className="eyebrow">
          {direction === "from" ? "Sonder depuis" : "Hôtes à sonder"} <span className="font-mono normal-case tracking-normal text-[var(--c-text-secondary)]">{selected.size}</span>
        </span>
        {/* Le panneau reste utilisable quand l'onglet a été fermé : cocher des
            machines sans pouvoir rien lancer serait un cul-de-sac. */}
        <button onClick={onOpenTab} className="btn btn-ghost btn-sm text-[var(--c-accent-text)]">
          Ouvrir l'onglet
        </button>
      </div>

      <div className="relative">
        <div className="pointer-events-none absolute inset-y-0 left-2.5 flex items-center">
          <IconSearch size={13} className="text-[var(--c-text-muted)]" />
        </div>
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Rechercher un hôte…"
          className="input pl-8"
        />
      </div>

      <div className="flex gap-2 px-1 text-[11.5px]">
        <button onClick={selectAll} className="text-[var(--c-accent-text)] hover:underline">
          Tout ({visibleKeys.length})
        </button>
        <button onClick={selectNone} className="text-[var(--c-text-muted)] hover:underline">
          Aucun
        </button>
      </div>

      {/* Les mêmes critères que la flotte : « lesquels de mes hôtes tournent
          sous Debian, ou sont chargés ? » se pose aussi bien avant un
          diagnostic qu'avant une commande. Le bouton de collecte est là
          plutôt qu'ailleurs pour la même raison qu'il l'est côté flotte —
          sans état collecté, les critères ne peuvent que ne rien sélectionner,
          et renvoyer vers un autre panneau pour le faire serait un
          cul-de-sac. */}
      {hasSshHosts && (
        <div className="space-y-1.5 px-1">
          <button
            onClick={() => collectFacts()}
            disabled={collectingFacts}
            className="btn btn-secondary btn-sm w-full text-[var(--c-text-secondary)]"
          >
            <IconRefresh size={12} className={collectingFacts ? "animate-spin" : ""} />
            {collectingFacts ? "Collecte de l'état…" : "Collecter l'état (OS, RAM)"}
          </button>
          {hasFacts && (
            <FactFilterFields filters={filters} onChange={setFilters} onSelect={selectByFacts} />
          )}
        </div>
      )}

      <div className="sidebar-scroll -mx-1 min-h-0 min-w-0 flex-1 overflow-y-auto px-1 pb-2">
        <TargetTreeList
          rows={rows}
          hosts={workspace.hosts}
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
        />
      </div>
    </div>
  );
}
