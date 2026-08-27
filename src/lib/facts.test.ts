import { describe, expect, it } from "vitest";
import { anyFactFilterEnabled, DEFAULT_FACT_FILTERS, hostsMatchingFactFilters, type FactFilters } from "./facts";
import type { Host, HostFacts, HostId } from "./types";

// Ces cinq critères ne portent pas la même comparaison — `>` pour la RAM et la
// charge, `>=` pour les CPU, `<` pour l'uptime, sous-chaîne pour l'OS — et
// l'écart entre `>` et `>=` ne se voit pas à la relecture. Le sélecteur vivait
// écrit en dur dans `FleetTab` ; il est partagé avec le diagnostic réseau
// depuis qu'il pose les mêmes questions, donc une dérive toucherait les deux.

/** Un hôte complet, pas un cast partiel : le matcher ne lit que `lastFacts` et
 * `id`, mais construire un vrai `Host` fait échouer la compilation le jour où
 * il lira autre chose, au lieu de laisser un `as` l'avaler. */
function host(id: string, facts: Partial<HostFacts> | null): Host {
  return {
    id: id as HostId,
    label: id,
    address: "10.0.0.1",
    port: 22,
    username: "root",
    auth: "agent",
    groupId: null,
    jumpVia: [],
    tags: [],
    startupSnippets: [],
    envVars: [],
    lastFacts: facts as HostFacts | null,
  };
}

const filters = (over: Partial<FactFilters>): FactFilters => ({ ...DEFAULT_FACT_FILTERS, ...over });

describe("sélection par état collecté", () => {
  it("ignore un hôte jamais sondé plutôt que de le supposer conforme", () => {
    const hosts = [host("sondé", { memUsedPct: 90 }), host("jamais", null)];
    expect(hostsMatchingFactFilters(hosts, filters({ ram: { enabled: true, value: 80 } }))).toEqual(["sondé"]);
  });

  it("compare la RAM et la charge en strict, les CPU en large, l'uptime en dessous", () => {
    const exact = [host("h", { memUsedPct: 80, cpus: 2, load1: 1, uptimeSecs: 7 * 86400 })];
    // RAM > 80 : 80 ne passe pas.
    expect(hostsMatchingFactFilters(exact, filters({ ram: { enabled: true, value: 80 } }))).toEqual([]);
    // CPU >= 2 : 2 passe.
    expect(hostsMatchingFactFilters(exact, filters({ cpu: { enabled: true, value: 2 } }))).toEqual(["h"]);
    // Charge > 1 : 1 ne passe pas.
    expect(hostsMatchingFactFilters(exact, filters({ load1: { enabled: true, value: 1 } }))).toEqual([]);
    // Uptime < 7 jours : exactement 7 jours ne passe pas.
    expect(hostsMatchingFactFilters(exact, filters({ uptimeDays: { enabled: true, value: 7 } }))).toEqual([]);
  });

  it("combine les critères cochés en ET, et ignore ceux qui ne le sont pas", () => {
    const hosts = [
      host("chargé-debian", { memUsedPct: 90, osName: "Debian GNU/Linux" }),
      host("chargé-ubuntu", { memUsedPct: 90, osName: "Ubuntu" }),
      host("calme-debian", { memUsedPct: 10, osName: "Debian GNU/Linux" }),
    ];
    const both = filters({
      ram: { enabled: true, value: 80 },
      os: { enabled: true, value: "debian" },
    });
    expect(hostsMatchingFactFilters(hosts, both)).toEqual(["chargé-debian"]);
    // Le critère OS décoché n'exclut personne, il disparaît de la question.
    expect(hostsMatchingFactFilters(hosts, filters({ ram: { enabled: true, value: 80 } })))
      .toEqual(["chargé-debian", "chargé-ubuntu"]);
  });

  it("cherche l'OS sans casse, dans le nom comme dans l'identifiant", () => {
    const hosts = [host("par-id", { osId: "ubuntu" }), host("par-nom", { osName: "Ubuntu 24.04" })];
    expect(hostsMatchingFactFilters(hosts, filters({ os: { enabled: true, value: "UBUNTU" } })))
      .toEqual(["par-id", "par-nom"]);
    // Un champ OS coché mais vide ne sélectionne rien plutôt que tout : c'est
    // une question inachevée, pas « n'importe lequel ».
    expect(hostsMatchingFactFilters(hosts, filters({ os: { enabled: true, value: "  " } }))).toEqual([]);
  });

  it("sait dire qu'aucun critère n'est coché", () => {
    expect(anyFactFilterEnabled(DEFAULT_FACT_FILTERS)).toBe(false);
    expect(anyFactFilterEnabled(filters({ cpu: { enabled: true, value: 4 } }))).toBe(true);
  });
});
