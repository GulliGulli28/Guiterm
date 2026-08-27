import { useCallback, useMemo, useState } from "react";
import { api } from "../lib/api";
import { anyFactFilterEnabled, DEFAULT_FACT_FILTERS, hostsMatchingFactFilters, type FactFilters } from "../lib/facts";
import { fleetTargetKey } from "../lib/types";
import type { Host, HostId, Workspace } from "../lib/types";

export interface FactSelection {
  filters: FactFilters;
  setFilters: (update: (prev: FactFilters) => FactFilters) => void;
  /** Au moins un hôte a-t-il un état collecté ? Sans ça les critères ne
   * peuvent que ne rien sélectionner, donc les afficher poserait une question
   * sans réponse possible. */
  hasFacts: boolean;
  anyFilterEnabled: boolean;
  /** Les clés de cibles correspondant aux critères cochés — au format des clés
   * de sélection, prêtes à remplacer la sélection courante. */
  matchingKeys: () => string[];
  collectingFacts: boolean;
  collectFacts: (hostIds?: HostId[]) => Promise<void>;
}

interface Options {
  sshHosts: Host[];
  onError: (message: string) => void;
  /** Appelé avec l'espace de travail frais après une collecte : `lastFacts`
   * est persisté sur chaque hôte, et le reste de l'app doit le reprendre. */
  onWorkspaceUpdate: (ws: Workspace) => void;
}

/**
 * Les critères de sélection par état collecté (OS, RAM, CPU, charge, uptime),
 * et la collecte qui les alimente.
 *
 * Sorti de `FleetTab` quand le diagnostic réseau a voulu les mêmes critères.
 * Une deuxième copie aurait été deux endroits décidant ce que « uptime < 7 »
 * veut dire pour un hôte jamais sondé, et surtout deux boutons de collecte
 * dont l'un aurait pu ne pas rafraîchir l'espace de travail — l'état est
 * persisté côté serveur sur `Host::lastFacts`, donc une collecte qui ne
 * remonterait pas le workspace laisserait l'autre panneau sur des chiffres
 * périmés sans que rien ne le dise.
 *
 * Réservé aux hôtes SSH, comme l'exécuteur de flotte : le terminal local et
 * les cibles Docker exec/K8s exec n'ont pas d'état collecté.
 */
export function useFactSelection({ sshHosts, onError, onWorkspaceUpdate }: Options): FactSelection {
  const [filters, setFilters] = useState<FactFilters>(DEFAULT_FACT_FILTERS);
  const [collectingFacts, setCollectingFacts] = useState(false);

  const hostById = useMemo(() => new Map(sshHosts.map((h) => [h.id, h])), [sshHosts]);
  const hasFacts = sshHosts.some((h) => h.lastFacts != null);
  const anyFilterEnabled = anyFactFilterEnabled(filters);

  const matchingKeys = useCallback(() => {
    if (!anyFilterEnabled) {
      onError("Coche au moins un critère avant de sélectionner");
      return [];
    }
    return hostsMatchingFactFilters(sshHosts, filters).map((hostId) => fleetTargetKey({ kind: "ssh", hostId }));
  }, [anyFilterEnabled, onError, sshHosts, filters]);

  const collectFacts = useCallback(async (hostIds?: HostId[]) => {
    if (collectingFacts) return;
    const ids = hostIds ?? sshHosts.map((h) => h.id);
    if (ids.length === 0) return;
    setCollectingFacts(true);
    try {
      const { outcomes, workspace: updated } = await api.collectFacts(ids);
      onWorkspaceUpdate(updated);
      const failed = outcomes.filter((o) => o.error != null);
      if (failed.length > 0) {
        const names = failed.map((o) => hostById.get(o.hostId)?.label ?? o.hostId).join(", ");
        onError(`${failed.length} hôte(s) n'ont pas répondu à la sonde d'état : ${names}`);
      }
    } catch (e) {
      onError(String(e));
    } finally {
      setCollectingFacts(false);
    }
  }, [collectingFacts, sshHosts, onWorkspaceUpdate, onError, hostById]);

  return { filters, setFilters, hasFacts, anyFilterEnabled, matchingKeys, collectingFacts, collectFacts };
}
