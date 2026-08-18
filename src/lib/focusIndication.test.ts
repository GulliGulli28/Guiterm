import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Un contrôle qu'on atteint au clavier doit montrer où est le focus. Trois
// façons d'y arriver dans ce dépôt, toutes acceptables :
//
//   1. ne rien faire — le navigateur dessine son liseré, qu'`index.css`
//      uniformise à la couleur d'accent via `:focus-visible` ;
//   2. `focus:ring-*`, l'anneau Tailwind, quand un liseré rectangulaire irait
//      mal (champ arrondi, bouton dans une barre dense) ;
//   3. `focus:outline-none` **accompagné** de l'un des deux.
//
// La faute est `focus:outline-none` tout seul : il supprime l'indication du
// navigateur sans rien mettre à la place, et la règle `:focus-visible` globale
// ne rattrape pas le coup — `.focus\:outline-none:focus` pèse deux classes de
// spécificité contre une, donc elle gagne quel que soit l'ordre source.
// Vingt-six occurrences existaient avant ce test.
//
// Statique, comme `tauriCommands.test.ts` : le vérifier dans une vraie fenêtre
// demanderait que `:focus-visible` réagisse à une touche synthétisée par
// WebDriver, ce que WebKitGTK ne fait pas de façon fiable — un premier jet de
// scénario e2e passait au vert puis rouge sans que le code bouge.

const srcDir = fileURLToPath(new URL("..", import.meta.url));

function sourceFiles(): string[] {
  return readdirSync(srcDir, { recursive: true, encoding: "utf8" })
    .filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f));
}

/** Les lignes qui coupent l'indication de focus sans en fournir une autre. */
function unmarkedFocusLines(): string[] {
  const offenders: string[] = [];
  for (const file of sourceFiles()) {
    const lines = readFileSync(path.join(srcDir, file), "utf8").split("\n");
    lines.forEach((line, i) => {
      if (!line.includes("focus:outline-none")) return;
      // `focus-visible:` compte aussi : c'est la même intention, en plus fin.
      if (/focus(-visible)?:ring/.test(line)) return;
      offenders.push(`${file}:${i + 1}`);
    });
  }
  return offenders;
}

describe("indication de focus clavier", () => {
  it("ne coupe jamais le liseré sans mettre un anneau à la place", () => {
    const offenders = unmarkedFocusLines();
    expect(
      offenders,
      `ces lignes posent focus:outline-none sans focus:ring — au clavier, plus rien n'indique où on est :\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("lit bien les sources — sinon le contrôle ci-dessus passerait à vide", () => {
    // Deux planchers : des fichiers trouvés, et la classe encore employée
    // quelque part. Si `focus:outline-none` disparaissait totalement du dépôt,
    // ce test cesserait de protéger quoi que ce soit sans le dire.
    expect(sourceFiles().length).toBeGreaterThan(50);
    const withRing = sourceFiles().filter((f) =>
      readFileSync(path.join(srcDir, f), "utf8").includes("focus:outline-none"),
    );
    expect(withRing.length).toBeGreaterThan(5);
  });
});
