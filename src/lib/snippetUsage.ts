import type { Snippet, SnippetId } from "./types";

/**
 * Combien chaque snippet sert, pour les « Snippets fréquents » de l'accueil.
 *
 * Comme les récents (`lib/recents.ts`) : local à l'appareil, jamais
 * synchronisé. C'est un usage, pas une donnée — deux postes n'ont pas les
 * mêmes habitudes, et un compteur synchronisé ferait un conflit à chaque
 * exécution.
 *
 * Le classement est une fréquence **amortie** : chaque usage ajoute 1 à un
 * score qui perd la moitié de sa valeur toutes les deux semaines. Un compteur
 * brut garderait en tête pour toujours le snippet d'un chantier fini ; le
 * dernier utilisé seul ferait sauter la liste à chaque exécution.
 */
export interface SnippetUse {
  /** Score amorti à la date `at`. */
  score: number;
  /** Nombre total d'exécutions, pour l'affichage. */
  count: number;
  /** Dernière exécution, en millisecondes. */
  at: number;
}

export type SnippetUsage = Partial<Record<SnippetId, SnippetUse>>;

export const SNIPPET_USAGE_STORAGE_KEY = "gui-termius-snippet-usage";
export const HALF_LIFE_MS = 14 * 86_400_000;

/** Le score de `use` ramené à l'instant `now`. */
export function decayedScore(use: SnippetUse, now: number): number {
  const elapsed = Math.max(0, now - use.at);
  return use.score * 0.5 ** (elapsed / HALF_LIFE_MS);
}

export function recordSnippetUse(usage: SnippetUsage, id: SnippetId, now: number): SnippetUsage {
  const previous = usage[id];
  const next: SnippetUse = previous
    ? { score: decayedScore(previous, now) + 1, count: previous.count + 1, at: now }
    : { score: 1, count: 1, at: now };
  return { ...usage, [id]: next };
}

/** Les `limit` snippets les plus utilisés en ce moment, parmi ceux qui
 * existent encore. Un snippet jamais lancé n'y figure pas : la section
 * n'invente pas de favoris. */
export function frequentSnippets(usage: SnippetUsage, snippets: Snippet[], now: number, limit: number): { snippet: Snippet; use: SnippetUse }[] {
  return snippets
    .flatMap((snippet) => {
      const use = usage[snippet.id];
      return use ? [{ snippet, use, score: decayedScore(use, now) }] : [];
    })
    .sort((a, b) => b.score - a.score || b.use.at - a.use.at)
    .slice(0, limit)
    .map(({ snippet, use }) => ({ snippet, use }));
}

/** Oublie les snippets supprimés. */
export function pruneSnippetUsage(usage: SnippetUsage, ids: Set<string>): SnippetUsage {
  const kept: SnippetUsage = {};
  let changed = false;
  for (const [id, use] of Object.entries(usage) as [SnippetId, SnippetUse | undefined][]) {
    if (use && ids.has(id)) kept[id] = use;
    else changed = true;
  }
  return changed ? kept : usage;
}

function isUse(value: unknown): value is SnippetUse {
  if (!value || typeof value !== "object") return false;
  const u = value as Record<string, unknown>;
  return typeof u.score === "number" && typeof u.count === "number" && typeof u.at === "number";
}

export function loadSnippetUsage(): SnippetUsage {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(SNIPPET_USAGE_STORAGE_KEY) ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([, v]) => isUse(v))) as SnippetUsage;
  } catch {
    return {};
  }
}

export function saveSnippetUsage(usage: SnippetUsage): void {
  try {
    localStorage.setItem(SNIPPET_USAGE_STORAGE_KEY, JSON.stringify(usage));
  } catch { /* stockage indisponible : le compte vit le temps de la session */ }
}
