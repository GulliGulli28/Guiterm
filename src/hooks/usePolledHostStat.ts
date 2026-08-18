import { useEffect, useRef, useState } from "react";
import type { Host, HostId } from "../lib/types";
import { POLL_BASE_MS, afterAttempt, isDue, type HostPollState } from "../lib/pollSchedule";

/** Polls `fetchOne(host)` for every host matching `filter`, keyed by host id —
 * the "is this SSH host reachable" / "how many Docker containers are running" /
 * "how many K8s pods are ready" indicators shown inline in `HostsPanel`'s host
 * list, previously three near-identical copies of the same interval+cleanup
 * dance. Best-effort: a fetch that throws sets that host's value to `onError`
 * rather than failing the whole panel.
 *
 * Deux tempéraments, ajoutés le 2026-08-18, parce que chaque passe ouvre une
 * vraie connexion (API Docker tunnelée par SSH, appel à l'API Kubernetes) et
 * pas juste une lecture locale :
 *
 * - **Rien ne part quand la fenêtre est cachée.** Le panneau n'est pas regardé,
 *   donc le résultat ne serait vu par personne — on payait du réseau, de la
 *   batterie et de la charge sur les serveurs distants pour un affichage
 *   invisible. Au retour, la reprise est immédiate plutôt qu'à la fin du cycle
 *   en cours : sinon la première chose que verrait l'utilisateur serait un état
 *   figé pendant 30 secondes.
 * - **Repli exponentiel par hôte** (`lib/pollSchedule`). Un hôte éteint était
 *   recontacté toutes les 30 s indéfiniment ; il l'est maintenant de plus en
 *   plus rarement, jusqu'à cinq minutes, et repasse au rythme nominal dès qu'il
 *   répond.
 *
 * `filter`/`fetchOne` are read via closure, not tracked as effect dependencies
 * (only the host id list is) — same intentional omission the three original
 * copies already had: they only ever close over stable things (`host.kind`, the
 * `api` singleton), so a fresh closure identity each render never changes what
 * polling actually does. */
export function usePolledHostStat<T>(
  hosts: Host[],
  filter: (host: Host) => boolean,
  fetchOne: (host: Host) => Promise<T>,
  onError: T,
): Record<HostId, T> {
  const [values, setValues] = useState<Record<HostId, T>>({});
  // Un `ref` et non un state : le calendrier ne doit rien redessiner, et le
  // relire dans le state déclencherait une passe à chaque mise à jour.
  const schedule = useRef<Map<HostId, HostPollState>>(new Map());
  const hostIdsKey = hosts.map((h) => h.id).join(",");

  useEffect(() => {
    let cancelled = false;
    const targets = hosts.filter(filter);

    const tick = () => {
      if (cancelled || document.hidden) return;
      const now = Date.now();
      for (const host of targets) {
        if (!isDue(schedule.current.get(host.id), now)) continue;
        // Marqué comme tenté *avant* la réponse : sans ça, un appel plus long
        // que l'intervalle verrait le tick suivant en lancer un deuxième sur le
        // même hôte, et ainsi de suite.
        schedule.current.set(host.id, { failures: schedule.current.get(host.id)?.failures ?? 0, nextAttemptAt: now + POLL_BASE_MS });
        fetchOne(host)
          .then((value) => {
            if (cancelled) return;
            schedule.current.set(host.id, afterAttempt(schedule.current.get(host.id), true, Date.now()));
            setValues((prev) => ({ ...prev, [host.id]: value }));
          })
          .catch(() => {
            if (cancelled) return;
            schedule.current.set(host.id, afterAttempt(schedule.current.get(host.id), false, Date.now()));
            setValues((prev) => ({ ...prev, [host.id]: onError }));
          });
      }
    };

    tick();
    const interval = setInterval(tick, POLL_BASE_MS);
    // `visibilitychange` plutôt que `focus` : passer sur une autre fenêtre sans
    // masquer celle-ci laisse le panneau visible, et le figer là serait un bug
    // visible plutôt qu'une économie.
    document.addEventListener("visibilitychange", tick);
    return () => {
      cancelled = true;
      clearInterval(interval);
      document.removeEventListener("visibilitychange", tick);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostIdsKey]);

  return values;
}
