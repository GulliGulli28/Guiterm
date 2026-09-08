import { describe, expect, it } from "vitest";
import { fleetTargetKey, isSshTargetKey } from "./types";
import type { FleetTarget } from "./types";

/** Un exemplaire de chacune des quatre formes de cible. Le `Record` fait
 * échouer `tsc` si une variante est ajoutée sans venir ici — sans quoi la
 * vérification ci-dessous se ferait sur un sous-ensemble en croyant couvrir
 * tout. */
const SAMPLES: Record<FleetTarget["kind"], FleetTarget> = {
  ssh: { kind: "ssh", hostId: "h1" },
  docker: { kind: "docker", hostId: "h1", containerId: "abc123" },
  k8s: { kind: "k8s", hostId: "h1", podName: "api-0", containerName: null },
  local: { kind: "local" },
};

describe("isSshTargetKey", () => {
  /** Le couplage que ce test tient : `isSshTargetKey` lit le format que
   * `fleetTargetKey` écrit, et les deux vivent côte à côte pour cette raison.
   * Le diagnostic réseau s'en sert pour écarter ce qu'il ne sait pas viser —
   * s'il se trompait, il ouvrirait un onglet avec des cases impossibles à
   * cocher, en annonçant un nombre d'hôtes faux. */
  it("reconnaît exactement les hôtes SSH, sur les quatre formes de cible", () => {
    for (const [kind, target] of Object.entries(SAMPLES)) {
      const key = fleetTargetKey(target);
      expect(isSshTargetKey(key), `« ${key} » (${kind})`).toBe(kind === "ssh");
    }
  });

  it("ne se laisse pas prendre par un identifiant qui contient « ssh »", () => {
    // Un conteneur peut très bien s'appeler `ssh-bastion` : c'est le début de
    // la clé qui décide, pas sa présence quelque part dedans.
    expect(isSshTargetKey(fleetTargetKey({ kind: "docker", hostId: "h1", containerId: "ssh-bastion" }))).toBe(false);
  });
});
