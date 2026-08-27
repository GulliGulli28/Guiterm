import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Le garde-fou du « Réessayer » sur les écrans d'échec de session.
//
// Sept onglets ouvrent une session distante et peuvent échouer : SSH (avec
// ses variantes Docker/K8s exec), terminal local, aperçu RDP, SQL, Redis,
// MongoDB, panneaux de transfert. Chacun affichait son échec dans son coin,
// sans rien pour retenter — l'onglet était mort, il fallait le fermer et
// rouvrir la cible depuis la barre latérale.
//
// Rien, dans les types ni dans le compilateur, n'empêche le huitième d'être
// écrit pareil : un `<div>Erreur : {e}</div>` compile parfaitement. D'où ces
// contrôles sur les sources, dans l'esprit de `hostPickers.test.ts` : un
// détecteur (aucun nouvel écran d'échec ne repart sans réessai) et un
// inventaire (ceux qui l'ont le gardent, et leur bouton rejoue vraiment la
// connexion au lieu de n'être qu'un bouton).

const srcDir = fileURLToPath(new URL("..", import.meta.url));

function componentSources(): string[] {
  return readdirSync(srcDir, { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".tsx") && !f.endsWith(".test.tsx"));
}

/** Un composant qui bascule un état vers « échec de connexion ». */
function marksConnectionFailed(source: string): boolean {
  return /setStatus\(\s*"failed"\s*\)/.test(source);
}

function importsSharedScreen(source: string): boolean {
  return /from "\.\/ConnectionFailed"/.test(source);
}

/**
 * Le compteur d'essais est-il *réellement* branché sur l'effet de connexion ?
 *
 * C'est là qu'est le vrai risque : un bouton « Réessayer » qui incrémente un
 * état dont aucun effet ne dépend s'affiche, se clique, et ne reconnecte
 * rien — pire qu'un écran d'échec franchement mort, parce qu'il ment.
 */
function retryCounterDrivesAnEffect(source: string): boolean {
  return /const \[attempt, setAttempt\] = useState\(0\)/.test(source)
    && /\[[^[\]]*\battempt\b[^[\]]*\]\s*\)/.test(source);
}

describe("réessai des sessions", () => {
  // L'inventaire. Ces onglets ouvrent une session qui peut échouer.
  const SESSION_TABS = [
    "components/TerminalTab.tsx",
    "components/LocalTerminalTab.tsx",
    "components/RdpTab.tsx",
    "components/SqlTab.tsx",
    "components/RedisTab.tsx",
    "components/MongoTab.tsx",
    "components/TransferTab.tsx",
  ];

  it("offre un réessai sur chaque écran d'échec de session", () => {
    const missing = SESSION_TABS.filter((f) => !importsSharedScreen(readFileSync(path.join(srcDir, f), "utf8")));
    expect(
      missing,
      "ces onglets affichent un échec sans proposer de réessayer — passer par "
      + `ConnectionFailed (src/components/ConnectionFailed.tsx) : ${missing.join(", ")}`,
    ).toEqual([]);
  });

  // `TransferTab` est à part : son réessai est `onSourceChange(side,
  // pane.source)`, c'est-à-dire la réouverture que le sélecteur de source fait
  // déjà — il n'a pas de compteur à lui, et n'en a pas besoin.
  it("branche le compteur d'essais sur l'effet de connexion", () => {
    const inert = SESSION_TABS
      .filter((f) => f !== "components/TransferTab.tsx")
      .filter((f) => !retryCounterDrivesAnEffect(readFileSync(path.join(srcDir, f), "utf8")));
    expect(
      inert,
      "le bouton « Réessayer » de ces onglets n'est branché sur aucun effet : il "
      + `se clique sans rien reconnecter — ${inert.join(", ")}`,
    ).toEqual([]);
  });

  it("détecte un nouvel onglet de session qui repartirait sans réessai", () => {
    const offenders = componentSources().filter((f) => {
      const source = readFileSync(path.join(srcDir, f), "utf8");
      return marksConnectionFailed(source) && !importsSharedScreen(source);
    });
    expect(
      offenders,
      "ces composants basculent en « failed » sans écran de réessai — passer par "
      + `ConnectionFailed (src/components/ConnectionFailed.tsx) : ${offenders.join(", ")}`,
    ).toEqual([]);
  });

  // Le contrôle anti-vacuité : un test de forme qui ne détecte plus rien reste
  // vert pour toujours. Celui-ci échoue si les deux détecteurs ci-dessus
  // cessent de reconnaître exactement ce qu'ils ont servi à supprimer.
  it("détecte bien les formes qu'il interdit", () => {
    const deadEnd = `
      const [status, setStatus] = useState("connecting");
      api.openThing(id).catch((e) => { setError(String(e)); setStatus("failed"); });
      if (status === "failed") return <div>Erreur : {error}</div>;`;
    expect(marksConnectionFailed(deadEnd)).toBe(true);
    expect(importsSharedScreen(deadEnd)).toBe(false);
    // Et il laisse tranquille un composant qui ne parle pas de connexion.
    expect(marksConnectionFailed(`setPhase("failed"); setTransfer({ status: "failed" });`)).toBe(false);

    // Le compteur qui ne pilote rien : présent, incrémenté, mais absent de
    // toute liste de dépendances — exactement le bouton qui ment.
    const inertCounter = `
      const [attempt, setAttempt] = useState(0);
      useEffect(() => { connect(); }, [connection.id]);
      <button onClick={() => setAttempt((n) => n + 1)}>Réessayer</button>`;
    expect(retryCounterDrivesAnEffect(inertCounter)).toBe(false);
    expect(retryCounterDrivesAnEffect(inertCounter.replace("[connection.id]", "[connection.id, attempt]"))).toBe(true);
  });
});
