import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Le garde-fou de l'instance unique de cibles.
//
// `useFleetTargets` interroge les démons Docker et les clusters Kubernetes en
// direct. Tant que l'arborescence de cibles vivait dans chaque onglet, deux
// appels du hook coexistaient sans conséquence visible : un seul onglet était
// monté à la fois la plupart du temps.
//
// Depuis que le choix des cibles est un panneau de barre latérale, le panneau
// et l'onglet sont montés **ensemble**. Deux appels, ce serait deux salves de
// requêtes au lancement et deux listes qui divergent dès qu'un conteneur
// démarre entre les deux — le panneau cocherait une cible que l'onglet ne
// connaît pas. D'où `TargetsProvider`, et d'où ce contrôle : rien, dans les
// types, n'empêche un futur composant de rappeler le hook directement.

const srcDir = fileURLToPath(new URL("..", import.meta.url));

/** Le seul fichier autorisé à appeler le hook : celui qui le définit et le
 * fournit. */
const PROVIDER_FILE = "hooks/useFleetTargets.tsx";

function sources(): string[] {
  return readdirSync(srcDir, { recursive: true, encoding: "utf8" })
    .filter((f) => (f.endsWith(".ts") || f.endsWith(".tsx")) && !f.endsWith(".test.ts") && !f.endsWith(".test.tsx"));
}

/** Un appel du hook, pas un simple import de son nom. */
function callsHookDirectly(source: string): boolean {
  return /\buseFleetTargets\s*\(/.test(source);
}

describe("liste de cibles partagée", () => {
  it("n'est interrogée que par son fournisseur", () => {
    const offenders = sources().filter(
      (f) => f !== PROVIDER_FILE && callsHookDirectly(readFileSync(path.join(srcDir, f), "utf8")),
    );
    expect(
      offenders,
      "ces fichiers rappellent useFleetTargets au lieu de useSharedTargets : deux listings Docker/K8s, "
      + `deux listes qui peuvent diverger — ${offenders.join(", ")}`,
    ).toEqual([]);
  });

  it("est bien fournie, et consommée par les deux magasins de sélection", () => {
    const provider = readFileSync(path.join(srcDir, PROVIDER_FILE), "utf8");
    expect(provider).toContain("export function TargetsProvider");
    for (const store of ["hooks/useFleetSelection.tsx", "hooks/useNetDiagSelection.tsx"]) {
      expect(readFileSync(path.join(srcDir, store), "utf8"), store).toContain("useSharedTargets()");
    }
  });

  // Le contrôle anti-vacuité : un détecteur qui ne reconnaît plus rien reste
  // vert pour toujours.
  it("détecte bien la forme qu'il interdit", () => {
    expect(callsHookDirectly('const { allTargets } = useFleetTargets(workspace);')).toBe(true);
    // Un import du type exporté à côté n'est pas un appel.
    expect(callsHookDirectly('import { useSharedTargets, type FleetTargetInfo } from "./useFleetTargets";')).toBe(false);
  });
});
