import type { Workspace } from "../lib/types";
import { ramColor } from "../lib/facts";
import { formatRelativeTime } from "../lib/format";
import { useFleetSelection } from "../hooks/useFleetSelection";
import { FactFilterFields } from "./FactFilterFields";
import { TargetTreeList } from "./TargetTreeList";
import { IconRefresh, IconSearch } from "./ui-icons";

/**
 * Les cibles d'une opération de flotte, dans la barre latérale.
 *
 * Cette colonne vivait dans l'onglet. Elle en est sortie parce que l'app
 * affiche déjà l'arborescence des hôtes dans la barre latérale (Hôtes, SFTP) :
 * en avoir une deuxième, plus étroite, à l'intérieur d'un onglet demandait de
 * choisir ses machines à un endroit différent selon ce qu'on voulait en faire.
 * L'onglet ne garde que la composition de la commande et les résultats.
 *
 * Tout ce qui sert à *choisir* est venu d'un bloc — filtre, « Tout / Aucun »,
 * pastilles de compte AWS, collecte d'état, filtres par état collecté et
 * arborescence : les couper en deux aurait laissé la sélection pilotable depuis
 * deux endroits qui ne sont plus côte à côte.
 *
 * La mise en page est celle de `SftpPanel`/`HostsPanel`, au détail près :
 * `h-full` (et non `flex-1`, qui ne contraint rien sous le conteneur en bloc de
 * `Sidebar.tsx` — l'arborescence débordait alors sans défiler), puis
 * `sidebar-scroll` sur la zone qui défile.
 */
export function FleetTargetsPanel({ workspace, onOpenTab }: { workspace: Workspace; onOpenTab: () => void }) {
  const {
    allTargets, sshHosts, dockerHosts, k8sHosts, rows, visibleKeys, profiles,
    loadingContainers, loadingPods, refreshContainers, refreshPods,
    filter, setFilter, selected, toggle, toggleKeys, selectAll, selectNone, selectByProfile,
    filters, setFilters, hasFacts, selectByFacts, collectingFacts, collectFacts,
    mode, hasTargetLine,
  } = useFleetSelection();

  return (
  <div className="flex h-full min-w-0 flex-col gap-2">
    <div className="flex items-center justify-between pl-1">
      <span className="eyebrow">
        Cibles <span className="font-mono normal-case tracking-normal text-[var(--c-text-secondary)]">{selected.size}/{allTargets.length}</span>
      </span>
      {/* Le panneau reste utilisable quand l'onglet a été fermé : cocher
          des cibles sans pouvoir rien lancer serait un cul-de-sac. */}
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
        // Le même libellé que `SftpPanel`, et pour la même raison : la barre
        // latérale est étroite, une énumération des champs cherchés y est
        // tronquée avant d'être lue. Ce qui est couvert (dossier, tag, profil
        // AWS) l'est aussi côté SFTP sans être annoncé.
        placeholder="Rechercher un hôte…"
        className="input pl-8"
      />
    </div>

    <div className="flex items-center gap-2 px-1 text-[11.5px]">
      {mode === "command" ? (
        <>
          <button onClick={selectAll} className="text-[var(--c-accent-text)] hover:underline">
            Tout ({visibleKeys.length})
          </button>
          <button onClick={selectNone} className="text-[var(--c-text-muted)] hover:underline">
            Aucun
          </button>
        </>
      ) : (
        <span
          title="Calculée automatiquement d'après les « target … » du programme (hôtes SSH uniquement) — repasse en mode Commande pour sélectionner à la main"
          className="tag tag-accent"
        >
          sélection automatique
        </span>
      )}
    </div>
    {/* Only with imported hosts to group: on a workspace of hand-made
        hosts this row would be an empty toolbar asking a question nobody
        has. In "Langage" mode the selection is computed from the program's
        own `target …` lines, so a manual pick here would be overwritten. */}
    {mode === "command" && profiles.length > 0 && (
      <div className="flex flex-wrap items-center gap-1 px-1 pb-1">
        <span className="eyebrow mr-1">Compte</span>
        {profiles.map((profile) => (
          <button
            key={profile}
            onClick={() => selectByProfile(profile)}
            title={`Sélectionner tout ce qui est joint via le profil ${profile}`}
            className="btn btn-secondary btn-sm h-5 px-1.5 text-[10.5px] text-[var(--c-text-secondary)]"
          >
            {profile}
          </button>
        ))}
      </div>
    )}
    {(sshHosts.length > 0 || dockerHosts.length > 0 || k8sHosts.length > 0) && (
      <div className="space-y-1.5 px-1">
        {/* Les trois rafraîchissements sur une ligne : ce sont des actions
            d'appoint, pas ce qu'on vient faire ici. */}
        <div className="flex flex-wrap gap-1.5">
          {sshHosts.length > 0 && (
            <button
              onClick={() => collectFacts()}
              disabled={collectingFacts}
              title="Collecter l'état des hôtes SSH (OS, RAM, charge)"
              className="btn btn-secondary btn-sm flex-1 text-[var(--c-text-secondary)]"
            >
              <IconRefresh size={12} className={collectingFacts ? "animate-spin" : ""} />
              {collectingFacts ? "Collecte…" : "État"}
            </button>
          )}
          {dockerHosts.length > 0 && (
            <button
              onClick={refreshContainers}
              disabled={loadingContainers}
              title="Actualiser la liste des conteneurs"
              className="btn btn-secondary btn-sm flex-1 text-[var(--c-text-secondary)]"
            >
              <IconRefresh size={12} className={loadingContainers ? "animate-spin" : ""} />
              Conteneurs
            </button>
          )}
          {k8sHosts.length > 0 && (
            <button
              onClick={refreshPods}
              disabled={loadingPods}
              title="Actualiser la liste des pods"
              className="btn btn-secondary btn-sm flex-1 text-[var(--c-text-secondary)]"
            >
              <IconRefresh size={12} className={loadingPods ? "animate-spin" : ""} />
              Pods
            </button>
          )}
        </div>
        {mode === "intent" && (
          <p className="callout text-[11.5px]">
            {hasTargetLine ? (
              <>Ciblage automatique (hôtes SSH uniquement) : les cases ci-dessous reflètent les hôtes dont l'état collecté correspond aux <code className="font-mono">target …</code> du programme.</>
            ) : (
              <>Aucun <code className="font-mono">target …</code> dans le programme : sélectionne librement les hôtes SSH ci-dessous (Docker exec/terminal local restent indisponibles en mode Langage).</>
            )}
          </p>
        )}
        {mode === "command" && hasFacts && (
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
        // En mode « Langage », seules les cases SSH deviennent
        // sélectionnables (Docker exec/K8s exec/local ne sont pas
        // représentables dans un run adaptatif — voir le commentaire de
        // `run_adaptive_plan`), et même celles-là restent pilotées par le
        // programme tant qu'il porte une ligne `target`
        // (`hasTargetLine`/`programHasTargetLine`).
        isDisabled={(t) => mode === "intent" && (hasTargetLine || t.target.kind !== "ssh")}
        disabledTitle="Sélection automatique en mode Langage"
        onToggleKeys={mode === "command" ? toggleKeys : undefined}
        countChecked={(keys) => keys.reduce((n, key) => n + (selected.has(key) ? 1 : 0), 0)}
        emptyMessage={filter.trim() ? "Aucune cible ne correspond." : "Aucune cible."}
        // Libellé, adresse et tags sont rendus par la carte commune ; ce qui
        // reste ici est ce que la flotte, et elle seule, a de plus à dire —
        // l'état collecté. Même typographie que les lignes d'état de
        // `HostsPanel`.
        renderExtra={(t) => {
          const f = t.facts;
          if (!f) return null;
          return (
            <>
              {(f.osName || f.osId) && (
                <span className="truncate text-[10.5px] text-[var(--c-text-faint)]" title={t.lastFactsAtMs != null ? `état ${formatRelativeTime(t.lastFactsAtMs)}` : undefined}>{f.osName || f.osId}</span>
              )}
              {f.memUsedPct != null && (
                <span className="shrink-0 font-mono text-[10.5px] font-medium tabular-nums" style={{ color: ramColor(f.memUsedPct) }}>
                  {Math.round(f.memUsedPct)}%
                </span>
              )}
            </>
          );
        }}
      />
    </div>
  </div>
  );
}
