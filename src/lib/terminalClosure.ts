/**
 * Ce qu'un terminal fait quand sa session se ferme sous lui.
 *
 * Trois issues, et elles s'enchaînent : réessayer, se détacher, ou fermer
 * l'onglet. La logique vivait dans `TerminalTab`, mêlée au rendu et à trois
 * refs, donc invérifiable — or elle porte des règles qui interagissent :
 * le repli exponentiel, l'épuisement des tentatives, et depuis les sessions
 * persistantes le fait qu'une connexion perdue ne veut plus dire « travail
 * perdu ».
 *
 * C'est la même forme que `pollSchedule.ts` ou `terminalZoom.ts` : une
 * décision pure, testée pour elle-même, appelée par le composant.
 */

export type ClosureAction =
  /** Retenter la connexion dans `delaySec` secondes. */
  | { kind: "retry"; attempt: number; delaySec: number }
  /** La session tourne toujours côté serveur : rendre l'onglet à l'état
   * « vignette » en gardant sa clé, plutôt que de le fermer avec. */
  | { kind: "detach" }
  /** Rien à garder : l'onglet s'en va. */
  | { kind: "close" };

export interface ClosureContext {
  autoReconnect: boolean;
  /** Tentatives déjà faites pour cette rupture. `0` à la première fermeture. */
  attempt: number;
  maxAttempts: number;
  /** Est-ce que ce terminal tourne dans une session qui survit à la connexion ? */
  hasPersistentSession: boolean;
}

/** Plafond du repli. Au-delà, l'attente coûte plus que le réseau ne met à
 * revenir. */
export const MAX_RETRY_DELAY_SEC = 30;

export function nextClosureAction(context: ClosureContext): ClosureAction {
  const { autoReconnect, attempt, maxAttempts, hasPersistentSession } = context;
  if (autoReconnect && attempt < maxAttempts) {
    const next = attempt + 1;
    return { kind: "retry", attempt: next, delaySec: Math.min(2 ** next, MAX_RETRY_DELAY_SEC) };
  }
  // Une session persistante ne se ferme pas avec sa connexion : elle continue
  // de tourner sur l'hôte. Fermer l'onglet emporterait la clé qui permet d'y
  // revenir — la vignette la garde. C'est le chemin **courant** et pas un cas
  // limite : la reconnexion automatique est désactivée par défaut, donc une
  // coupure de VPN arrive directement ici.
  return hasPersistentSession ? { kind: "detach" } : { kind: "close" };
}
