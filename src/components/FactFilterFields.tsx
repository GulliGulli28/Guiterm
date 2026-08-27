import type { FactFilters } from "../lib/facts";

interface FactFilterFieldsProps {
  filters: FactFilters;
  onChange: (update: (prev: FactFilters) => FactFilters) => void;
  /** Remplace la sélection par les hôtes correspondants. Remplace et n'ajoute
   * pas — la sélection par critères répond à « lesquels sont dans cet état ? »,
   * et y ajouter les cases déjà cochées rendrait la réponse illisible. Les
   * pastilles de compte AWS, elles, ajoutent : ce sont deux gestes différents. */
  onSelect: () => void;
}

/**
 * Les critères de sélection par état collecté : OS, RAM, CPU, charge, uptime.
 *
 * Écrits en dur dans le panneau de flotte jusqu'à ce que le diagnostic réseau
 * les demande aussi. Extraits plutôt que recopiés : ce sont cinq champs dont
 * chacun porte une comparaison précise (`>` pour la RAM et la charge, `>=`
 * pour les CPU, `<` pour l'uptime), et une deuxième copie aurait dérivé au
 * premier ajustement — l'écart entre `>` et `>=` ne se voit pas à la
 * relecture.
 *
 * Réservé aux hôtes SSH : eux seuls portent un `lastFacts`. L'appelant décide
 * quand afficher le bloc (voir `hasFacts`) — sans état collecté, ces critères
 * ne peuvent que ne rien sélectionner.
 */
export function FactFilterFields({ filters, onChange: setFilters, onSelect }: FactFilterFieldsProps) {
  return (
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
          onClick={onSelect}
          className="w-full rounded bg-[var(--c-accent-dim)] px-2 py-1 text-[var(--c-accent-text)] hover:bg-[var(--c-accent)] hover:text-white"
        >
          Sélectionner les hôtes correspondants
        </button>
      </div>
  );
}
