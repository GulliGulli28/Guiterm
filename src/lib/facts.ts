import type { Host, HostId } from "./types";

/** Colour for a RAM-usage percentage: green under 70, amber under 85, red above. */
export function ramColor(pct: number): string {
  if (pct >= 85) return "#ef4444";
  if (pct >= 70) return "#f59e0b";
  return "#22c55e";
}

/** Un critère de sélection fondé sur l'état collecté. `enabled` décide si
 * [`hostsMatchingFactFilters`] le regarde : plusieurs critères se combinent
 * (ET) sans qu'un champ numérique ait besoin d'une valeur sentinelle
 * « désactivé ». Réservé aux hôtes SSH — les cibles Docker exec, K8s exec et
 * le terminal local n'ont pas de `lastFacts`. */
export interface FactFilters {
  ram: { enabled: boolean; value: number }; // RAM utilisée % > valeur
  cpu: { enabled: boolean; value: number }; // nombre de CPU >= valeur
  load1: { enabled: boolean; value: number }; // charge à 1 min > valeur
  uptimeDays: { enabled: boolean; value: number }; // uptime < valeur jours
  os: { enabled: boolean; value: string }; // nom/id d'OS contient valeur
}

export const DEFAULT_FACT_FILTERS: FactFilters = {
  ram: { enabled: false, value: 80 },
  cpu: { enabled: false, value: 2 },
  load1: { enabled: false, value: 1 },
  uptimeDays: { enabled: false, value: 7 },
  os: { enabled: false, value: "" },
};

export function anyFactFilterEnabled(filters: FactFilters): boolean {
  return filters.ram.enabled || filters.cpu.enabled || filters.load1.enabled
    || filters.uptimeDays.enabled || filters.os.enabled;
}

/**
 * Les hôtes dont le dernier état collecté satisfait *tous* les critères
 * cochés. Un critère décoché est ignoré, pas traité comme « n'importe quoi » —
 * la différence compte : cocher « RAM > 80 » seul ne doit pas exclure un hôte
 * parce que son OS ne correspond pas à un champ laissé vide.
 *
 * Un hôte sans état collecté ne correspond à rien : on ne sait pas s'il
 * satisfait le critère, et le supposer sélectionnerait des machines au hasard
 * pour une opération qui va s'exécuter dessus.
 *
 * Pure et sortie de `FleetTab` quand le diagnostic réseau a voulu les mêmes
 * critères : deux copies, c'était deux endroits décidant ce que « uptime < 7 »
 * veut dire quand `uptimeSecs` est absent.
 */
export function hostsMatchingFactFilters(hosts: Host[], filters: FactFilters): HostId[] {
  return hosts
    .filter((h) => {
      const f = h.lastFacts;
      if (!f) return false;
      if (filters.ram.enabled && !(f.memUsedPct != null && f.memUsedPct > filters.ram.value)) return false;
      if (filters.cpu.enabled && !(f.cpus != null && f.cpus >= filters.cpu.value)) return false;
      if (filters.load1.enabled && !(f.load1 != null && f.load1 > filters.load1.value)) return false;
      if (filters.uptimeDays.enabled) {
        const days = f.uptimeSecs != null ? f.uptimeSecs / 86400 : null;
        if (!(days != null && days < filters.uptimeDays.value)) return false;
      }
      if (filters.os.enabled) {
        const q = filters.os.value.trim().toLowerCase();
        if (!q) return false;
        const hay = `${f.osName ?? ""} ${f.osId ?? ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    })
    .map((h) => h.id);
}
