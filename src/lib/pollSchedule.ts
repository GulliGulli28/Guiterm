/** Quand re-sonder un hôte, sachant combien de fois il a échoué d'affilée.
 *
 * Le sondage des hôtes Docker/K8s (`usePolledHostStat`) ouvre une vraie
 * connexion à chaque passe — API Docker tunnelée par SSH, ou appel à l'API
 * Kubernetes. Un hôte éteint était donc recontacté toutes les 30 secondes
 * indéfiniment : du trafic et une charge serveur pour un résultat connu
 * d'avance, et une pile de connexions refusées dans les journaux d'en face.
 */

/** Intervalle nominal, quand tout répond. */
export const POLL_BASE_MS = 30_000;

/** Plafond du repli. Cinq minutes : assez long pour qu'un hôte durablement
 * éteint ne coûte presque plus rien, assez court pour qu'un hôte redémarré
 * soit repris sans que l'utilisateur ait l'impression que l'app l'a oublié. */
export const POLL_MAX_MS = 300_000;

/** Délai avant la prochaine tentative.
 *
 * `failures` compte les échecs **consécutifs** : 0 juste après un succès, donc
 * l'intervalle nominal. Doublement à chaque échec, plafonné.
 */
export function nextPollDelay(
  failures: number,
  baseMs: number = POLL_BASE_MS,
  maxMs: number = POLL_MAX_MS,
): number {
  if (failures <= 0) return baseMs;
  // Pas de garde contre le débordement de `2 ** failures` : il vaut Infinity
  // au-delà de ~1024, et `Math.min(plafond, Infinity)` rend le plafond. Une
  // version précédente serrait `failures` d'abord, en croyant éviter un bug —
  // le retirer n'a fait échouer aucun test, ce qui était la bonne façon de
  // s'apercevoir qu'il ne servait à rien.
  return Math.min(maxMs, baseMs * 2 ** failures);
}

export interface HostPollState {
  /** Échecs consécutifs. Remis à zéro par un succès. */
  failures: number;
  /** Date (ms epoch) avant laquelle il ne faut pas retenter. */
  nextAttemptAt: number;
}

/** L'état d'un hôte après une tentative. */
export function afterAttempt(previous: HostPollState | undefined, ok: boolean, now: number): HostPollState {
  const failures = ok ? 0 : (previous?.failures ?? 0) + 1;
  return { failures, nextAttemptAt: now + nextPollDelay(failures) };
}

/** Cet hôte est-il dû ? Un hôte jamais sondé l'est toujours. */
export function isDue(state: HostPollState | undefined, now: number): boolean {
  return !state || now >= state.nextAttemptAt;
}
