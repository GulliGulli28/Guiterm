import type { Workspace } from "../lib/types";
import { ramColor } from "../lib/facts";
import { formatRelativeTime } from "../lib/format";
import { useFleetSelection } from "../hooks/useFleetSelection";
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
  <div className="flex min-h-0 flex-1 flex-col">
    <div className="flex items-center justify-between px-1 pb-2">
      <span className="text-xs font-semibold uppercase tracking-wide text-[var(--c-text-secondary)]">
        Cibles · {selected.size}/{allTargets.length}
      </span>
      {/* Le panneau reste utilisable quand l'onglet a été fermé : cocher
          des cibles sans pouvoir rien lancer serait un cul-de-sac. */}
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
          placeholder="Filtrer (nom, groupe, tag, profil AWS…)"
          className="w-full bg-transparent text-xs text-[var(--c-text)] placeholder:text-[var(--c-text-faint)]"
        />
      </div>
      <div className="mt-1.5 flex items-center gap-2 px-0.5">
        {mode === "command" ? (
          <>
            <button onClick={selectAll} className="text-[10px] text-[var(--c-accent-text)] hover:underline">
              Tout ({visibleKeys.length})
            </button>
            <button onClick={selectNone} className="text-[10px] text-[var(--c-text-muted)] hover:underline">
              Aucun
            </button>
          </>
        ) : (
          <span
            title="Calculée automatiquement d'après les « target … » du programme (hôtes SSH uniquement) — repasse en mode Commande pour sélectionner à la main"
            className="rounded bg-[var(--c-accent-dim)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--c-accent-text)]"
          >
            sélection automatique
          </span>
        )}
      </div>
    </div>
    {/* Only with imported hosts to group: on a workspace of hand-made
        hosts this row would be an empty toolbar asking a question nobody
        has. In "Langage" mode the selection is computed from the program's
        own `target …` lines, so a manual pick here would be overwritten. */}
    {mode === "command" && profiles.length > 0 && (
      <div className="flex flex-wrap items-center gap-1 px-1 pb-2">
        <span className="text-[10px] uppercase tracking-wide text-[var(--c-text-faint)]">Compte</span>
        {profiles.map((profile) => (
          <button
            key={profile}
            onClick={() => selectByProfile(profile)}
            title={`Sélectionner tout ce qui est joint via le profil ${profile}`}
            className="rounded-full border border-[var(--c-border)] bg-[var(--c-bg2)] px-2 py-0.5 text-[10px] text-[var(--c-text-secondary)] hover:border-[var(--c-accent)] hover:text-[var(--c-text)]"
          >
            {profile}
          </button>
        ))}
      </div>
    )}
    {(sshHosts.length > 0 || dockerHosts.length > 0 || k8sHosts.length > 0) && (
      <div className="mb-1 space-y-1.5 px-1 pb-1">
        {sshHosts.length > 0 && (
          <button
            onClick={() => collectFacts()}
            disabled={collectingFacts}
            className="flex w-full items-center justify-center gap-1.5 rounded-md border border-[var(--c-border)] bg-[var(--c-bg2)] px-2 py-1.5 text-xs text-[var(--c-text-secondary)] hover:bg-[var(--c-bg3)] disabled:opacity-50"
          >
            <IconRefresh size={12} className={collectingFacts ? "animate-spin" : ""} />
            {collectingFacts ? "Collecte de l'état…" : "Collecter l'état (OS, RAM)"}
          </button>
        )}
        {dockerHosts.length > 0 && (
          <button
            onClick={refreshContainers}
            disabled={loadingContainers}
            className="flex w-full items-center justify-center gap-1.5 rounded-md border border-[var(--c-border)] bg-[var(--c-bg2)] px-2 py-1.5 text-xs text-[var(--c-text-secondary)] hover:bg-[var(--c-bg3)] disabled:opacity-50"
          >
            <IconRefresh size={12} className={loadingContainers ? "animate-spin" : ""} />
            {loadingContainers ? "Actualisation…" : "Actualiser les conteneurs"}
          </button>
        )}
        {k8sHosts.length > 0 && (
          <button
            onClick={refreshPods}
            disabled={loadingPods}
            className="flex w-full items-center justify-center gap-1.5 rounded-md border border-[var(--c-border)] bg-[var(--c-bg2)] px-2 py-1.5 text-xs text-[var(--c-text-secondary)] hover:bg-[var(--c-bg3)] disabled:opacity-50"
          >
            <IconRefresh size={12} className={loadingPods ? "animate-spin" : ""} />
            {loadingPods ? "Actualisation…" : "Actualiser les pods"}
          </button>
        )}
        {mode === "intent" && (
          <p className="rounded-md border border-[var(--c-border)] bg-[var(--c-bg2)] px-2 py-1.5 text-[11px] text-[var(--c-text-faint)]">
            {hasTargetLine ? (
              <>Ciblage automatique (hôtes SSH uniquement) : les cases ci-dessous reflètent les hôtes dont l'état collecté correspond aux <code className="font-mono">target …</code> du programme.</>
            ) : (
              <>Aucun <code className="font-mono">target …</code> dans le programme : sélectionne librement les hôtes SSH ci-dessous (Docker exec/terminal local restent indisponibles en mode Langage).</>
            )}
          </p>
        )}
        {mode === "command" && hasFacts && (
          <div className="space-y-1 rounded-md border border-[var(--c-border)] bg-[var(--c-bg2)] p-1.5 text-[11px] text-[var(--c-text-muted)]">
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={filters.ram.enabled} onChange={(e) => setFilters((p) => ({ ...p, ram: { ...p.ram, enabled: e.target.checked } }))} className="accent-[var(--c-accent)]" />
              <span className="shrink-0">RAM utilisée &gt;</span>
              <input
                type="number" min={0} max={100} value={filters.ram.value}
                onChange={(e) => setFilters((p) => ({ ...p, ram: { ...p.ram, value: Number(e.target.value) } }))}
                className="w-12 rounded border border-[var(--c-border)] bg-[var(--c-bg3)] px-1 py-0.5 text-center text-[var(--c-text)] focus:border-[var(--c-accent)]"
              />
              <span>%</span>
            </label>
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={filters.cpu.enabled} onChange={(e) => setFilters((p) => ({ ...p, cpu: { ...p.cpu, enabled: e.target.checked } }))} className="accent-[var(--c-accent)]" />
              <span className="shrink-0">CPU ≥</span>
              <input
                type="number" min={1} value={filters.cpu.value}
                onChange={(e) => setFilters((p) => ({ ...p, cpu: { ...p.cpu, value: Number(e.target.value) } }))}
                className="w-12 rounded border border-[var(--c-border)] bg-[var(--c-bg3)] px-1 py-0.5 text-center text-[var(--c-text)] focus:border-[var(--c-accent)]"
              />
            </label>
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={filters.load1.enabled} onChange={(e) => setFilters((p) => ({ ...p, load1: { ...p.load1, enabled: e.target.checked } }))} className="accent-[var(--c-accent)]" />
              <span className="shrink-0">Charge (1 min) &gt;</span>
              <input
                type="number" min={0} step={0.1} value={filters.load1.value}
                onChange={(e) => setFilters((p) => ({ ...p, load1: { ...p.load1, value: Number(e.target.value) } }))}
                className="w-12 rounded border border-[var(--c-border)] bg-[var(--c-bg3)] px-1 py-0.5 text-center text-[var(--c-text)] focus:border-[var(--c-accent)]"
              />
            </label>
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={filters.uptimeDays.enabled} onChange={(e) => setFilters((p) => ({ ...p, uptimeDays: { ...p.uptimeDays, enabled: e.target.checked } }))} className="accent-[var(--c-accent)]" />
              <span className="shrink-0">Uptime &lt;</span>
              <input
                type="number" min={0} value={filters.uptimeDays.value}
                onChange={(e) => setFilters((p) => ({ ...p, uptimeDays: { ...p.uptimeDays, value: Number(e.target.value) } }))}
                className="w-12 rounded border border-[var(--c-border)] bg-[var(--c-bg3)] px-1 py-0.5 text-center text-[var(--c-text)] focus:border-[var(--c-accent)]"
              />
              <span>jours</span>
            </label>
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={filters.os.enabled} onChange={(e) => setFilters((p) => ({ ...p, os: { ...p.os, enabled: e.target.checked } }))} className="accent-[var(--c-accent)]" />
              <span className="shrink-0">OS contient</span>
              <input
                type="text" value={filters.os.value} placeholder="ubuntu…"
                onChange={(e) => setFilters((p) => ({ ...p, os: { ...p.os, value: e.target.value } }))}
                className="w-full min-w-0 rounded border border-[var(--c-border)] bg-[var(--c-bg3)] px-1.5 py-0.5 text-[var(--c-text)] placeholder:text-[var(--c-text-faint)] focus:border-[var(--c-accent)]"
              />
            </label>
            <button
              onClick={selectByFacts}
              className="w-full rounded bg-[var(--c-accent-dim)] px-2 py-1 text-[var(--c-accent-text)] hover:bg-[var(--c-accent)] hover:text-white"
            >
              Sélectionner les hôtes correspondants
            </button>
          </div>
        )}
      </div>
    )}
    <div className="min-h-0 flex-1 overflow-y-auto px-0.5 pb-2">
      <TargetTreeList
        rows={rows}
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
        renderTarget={(t) => {
          const f = t.facts;
          return (
            <>
              <span className="block truncate text-sm text-[var(--c-text)]">{t.label}</span>
              {t.sub && <span className="block truncate text-[11px] text-[var(--c-text-faint)]">{t.sub}</span>}
              {f && (
                <span className="mt-0.5 block space-y-0.5 text-[11px]">
                  {(f.osName || f.osId) && (
                    <span className="block truncate text-[var(--c-text-muted)]">{f.osName || f.osId}</span>
                  )}
                  <span className="flex items-center gap-2 truncate">
                    {f.memUsedPct != null && (
                      <span className="shrink-0 font-medium" style={{ color: ramColor(f.memUsedPct) }}>
                        RAM {Math.round(f.memUsedPct)}%
                      </span>
                    )}
                    {t.lastFactsAtMs != null && (
                      <span className="truncate text-[var(--c-text-faint)]">{formatRelativeTime(t.lastFactsAtMs)}</span>
                    )}
                  </span>
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
