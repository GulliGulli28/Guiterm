import type { HostId, SqlConnectionId } from "./types";

/**
 * Les connexions récentes, pour la page d'accueil.
 *
 * Locales à l'appareil, jamais synchronisées : c'est un usage, pas une donnée
 * (`docs/refonte-ui.md`, tranche 3). Alimentées à la **réussite** d'une
 * connexion, pas à la tentative — une adresse qui ne répond pas n'a rien à
 * faire en tête de la liste qu'on rouvre chaque matin.
 *
 * Une entrée terminal peut porter la clé de sa session persistante : c'est ce
 * qui permet à l'accueil de proposer « Reprendre » une fois l'onglet fermé,
 * puisque fermer un onglet persistant détache tmux sans rien tuer.
 */
export type RecentTarget =
  | {
    kind: "terminal";
    hostId: HostId;
    dockerContainerId?: string;
    k8sPodName?: string;
    k8sContainerName?: string | null;
  }
  | { kind: "rdp"; hostId: HostId }
  | { kind: "database"; connectionId: SqlConnectionId };

export type RecentEntry = RecentTarget & {
  /** Dernière connexion réussie, en millisecondes. */
  at: number;
  /** Session tmux de cette connexion, si elle était persistante. */
  sessionKey?: string;
};

export const RECENTS_STORAGE_KEY = "gui-termius-recents";
/** Assez pour une semaine de travail ; l'accueil n'en montre qu'une partie. */
export const MAX_RECENTS = 20;

/** Deux entrées désignent-elles la même chose à rouvrir ? */
export function sameTarget(a: RecentTarget, b: RecentTarget): boolean {
  switch (a.kind) {
    case "terminal":
      return b.kind === "terminal" && a.hostId === b.hostId
        && (a.dockerContainerId ?? null) === (b.dockerContainerId ?? null)
        && (a.k8sPodName ?? null) === (b.k8sPodName ?? null)
        && (a.k8sContainerName ?? null) === (b.k8sContainerName ?? null);
    case "rdp":
      return b.kind === "rdp" && a.hostId === b.hostId;
    case "database":
      return b.kind === "database" && a.connectionId === b.connectionId;
  }
}

/** Place `entry` en tête, sans doublon, en gardant `MAX_RECENTS` entrées.
 *
 * Une reconnexion non persistante ne doit pas effacer la session retenue de
 * la même cible : un shell ordinaire ouvert en passant ne tue pas la session
 * tmux laissée plus tôt. */
export function recordRecent(list: RecentEntry[], entry: RecentEntry): RecentEntry[] {
  const previous = list.find((e) => sameTarget(e, entry));
  const merged: RecentEntry = { ...entry, sessionKey: entry.sessionKey ?? previous?.sessionKey };
  if (!merged.sessionKey) delete merged.sessionKey;
  return [merged, ...list.filter((e) => !sameTarget(e, entry))].slice(0, MAX_RECENTS);
}

/** Oublie une session (terminée, ou écartée depuis l'accueil). La cible reste
 * dans les récents. */
export function forgetSession(list: RecentEntry[], sessionKey: string): RecentEntry[] {
  return list.map((e) => {
    if (e.sessionKey !== sessionKey) return e;
    const { sessionKey: _dropped, ...rest } = e;
    return rest;
  });
}

/** Retire ce qui ne désigne plus rien : un hôte ou une connexion supprimés ne
 * doivent pas laisser une ligne morte sur l'accueil. */
export function pruneRecents(list: RecentEntry[], hostIds: Set<string>, connectionIds: Set<string>): RecentEntry[] {
  return list.filter((e) => (e.kind === "database" ? connectionIds.has(e.connectionId) : hostIds.has(e.hostId)));
}

function isEntry(value: unknown): value is RecentEntry {
  if (!value || typeof value !== "object") return false;
  const e = value as Record<string, unknown>;
  if (typeof e.at !== "number") return false;
  if (e.kind === "database") return typeof e.connectionId === "string";
  return (e.kind === "terminal" || e.kind === "rdp") && typeof e.hostId === "string";
}

export function loadRecents(): RecentEntry[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(RECENTS_STORAGE_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter(isEntry).slice(0, MAX_RECENTS) : [];
  } catch {
    return [];
  }
}

export function saveRecents(list: RecentEntry[]): void {
  try {
    localStorage.setItem(RECENTS_STORAGE_KEY, JSON.stringify(list));
  } catch { /* stockage indisponible : la liste vit le temps de la session */ }
}
