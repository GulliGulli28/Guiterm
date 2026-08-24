import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Deux règles d'accessibilité qu'on peut vérifier sur les sources, sans lecteur
// d'écran ni moteur de rendu.
//
// Sur la portée, parce qu'elle a été mal estimée une première fois : « 70
// boutons à icône contre 17 aria-label » laissait croire à un défaut massif.
// En réalité `title` fournit déjà un nom accessible, et seuls **quatre**
// boutons n'avaient aucun nom du tout. La règle ci-dessous est donc
// délibérément étroite — un bouton dont la totalité du contenu est une icône —
// plutôt que large et bruyante : un garde-fou qui signale des faux positifs se
// fait désactiver, et ne protège alors plus rien.

const srcDir = fileURLToPath(new URL("..", import.meta.url));

function componentSources(): string[] {
  return readdirSync(srcDir, { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".tsx") && !f.endsWith(".test.tsx"));
}

describe("nom accessible des boutons", () => {
  it("ne laisse aucun bouton réduit à une icône sans aria-label ni title", () => {
    // `(?:[^>]|=>)` et non `[^>]` : la première version s'arrêtait au premier
    // `>` rencontré, donc sur la flèche de `onClick={(e) => …}` — c'est-à-dire
    // sur la quasi-totalité des boutons. Elle n'en voyait que 4 sur 11.
    // Trouvé parce qu'un scénario e2e cherchait un bouton de menu par son
    // titre et ne le trouvait pas : le test disait « rien à signaler » sur un
    // bouton qui n'avait effectivement aucun nom.
    const pattern = /<button\b((?:[^>]|=>)*?)>\s*(<Icon\w+[^>]*\/>)\s*<\/button>/gs;
    const offenders: string[] = [];
    for (const file of componentSources()) {
      const source = readFileSync(path.join(srcDir, file), "utf8");
      for (const match of source.matchAll(pattern)) {
        const attrs = match[1];
        if (attrs.includes("aria-label") || attrs.includes("title=")) continue;
        offenders.push(`${file}:${source.slice(0, match.index).split("\n").length} — ${match[2].trim()}`);
      }
    }
    expect(
      offenders,
      `ces boutons n'ont que leur icône : rien ne les annonce, et leur infobulle n'existe pas non plus :\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("lit bien les sources", () => {
    expect(componentSources().length).toBeGreaterThan(50);
  });
});

describe("sémantique des fenêtres modales", () => {
  // Une modale qui n'est ni annoncée comme telle ni fermée sur le focus est le
  // vrai défaut trouvé pendant l'audit — bien plus que les boutons ci-dessus.
  // Tabuler depuis une boîte de dialogue partait sur les contrôles cachés
  // derrière le voile, ce qui est un bug de navigation avant d'être une
  // question d'accessibilité.
  // Frontière de mot obligatoire : un simple `includes("useModalSurface")`
  // acceptait `useModalSurfaceXX`, donc renommer le hook sans le brancher
  // laissait le test vert. Constaté en le cassant.
  const USES_HOOK = /useModalSurface(?![A-Za-z0-9_])\s*[<(]/;

  const MODALS = [
    "components/CommandPalette.tsx",
    "components/ConfirmDialog.tsx",
    "components/ConnectionPickerModal.tsx",
    // `HostTreeModal` — l'arborescence d'hôtes servie en boîte de dialogue,
    // pour les parcours qui demandent l'hôte avant toute autre chose.
    "components/HostTreePicker.tsx",
    "components/QuickEditModal.tsx",
    "components/SshAuthPromptModal.tsx",
    // Pas un fichier « Modal » : l'onglet de transfert porte la boîte qui
    // demande quoi faire d'un nom déjà pris à destination. Listé ici pour la
    // même raison que les autres — la liste s'appuie sur le hook, pas sur le
    // nom du fichier, précisément parce que chercher les modales par leur nom
    // en avait laissé passer seize.
    "components/TransferTab.tsx",
    "components/VaultUnlockModal.tsx",
  ];

  it("fait passer chaque modale par useModalSurface", () => {
    const missing = MODALS.filter(
      (f) => !USES_HOOK.test(readFileSync(path.join(srcDir, f), "utf8")),
    );
    expect(
      missing,
      `ces modales n'ont ni rôle de dialogue, ni piège à focus, ni retour du focus à la fermeture : ${missing.join(", ")}`,
    ).toEqual([]);
  });

  // Les autres surfaces qui posent un voile plein écran. Elles n'ont pas encore
  // de rôle de dialogue ni de piège à focus, et la plupart n'ont même pas Échap.
  //
  // Cette liste est faite pour **rétrécir**, comme l'était `TABS_STILL_IN_APP`
  // pendant la migration du registre. Elle existe parce que l'audit du
  // 2026-08-18 a cherché les modales par nom de fichier (`*Modal*`, `Dialog`,
  // `Palette`) et en a donc trouvé six sur vingt-deux : plutôt que de refaire
  // la même erreur en silence, le reste est nommé ici, et une **nouvelle**
  // surface ne peut plus passer inaperçue.
  const OVERLAYS_WITHOUT_TRAP = [
    "components/AnsibleImportPanel.tsx",
    "components/AwsDatabaseImportPanel.tsx",
    "components/AwsImportPanel.tsx",
    "components/AwsSsoSetupPanel.tsx",
    "components/AzureSignInPanel.tsx",
    "components/BulkEditPanel.tsx",
    "components/CloudImportBits.tsx",
    "components/CloudProviderPicker.tsx",
    "components/FleetTab.tsx",
    "components/HostsPanel.tsx",
    "components/KnownHostsPanel.tsx",
    "components/RemoteSavePathPicker.tsx",
    "components/RemoteSearchPanel.tsx",
    "components/SnippetPicker.tsx",
    "components/SqliteRemoteFilePicker.tsx",
    "hooks/useContainerPicker.tsx",
  ];

  it("ne laisse aucune surface à voile hors inventaire", () => {
    const suspects = componentSources().filter((f) => {
      const source = readFileSync(path.join(srcDir, f), "utf8");
      return /fixed inset-0/.test(source) && /bg-black\//.test(source);
    });
    const unlisted = suspects.filter(
      (f) => !MODALS.includes(f) && !OVERLAYS_WITHOUT_TRAP.includes(f),
    );
    expect(
      unlisted,
      `surfaces à voile ni traitées ni inventoriées — piège à focus à poser, ou à ajouter à la liste en connaissance de cause : ${unlisted.join(", ")}`,
    ).toEqual([]);
  });

  it("ne laisse pas la liste d'attente se périmer", () => {
    // Une entrée qui a été traitée doit sortir de la liste, sinon celle-ci
    // cesse de mesurer le travail restant.
    const stale = OVERLAYS_WITHOUT_TRAP.filter((f) =>
      USES_HOOK.test(readFileSync(path.join(srcDir, f), "utf8")),
    );
    expect(stale, `déjà traitées, à retirer de OVERLAYS_WITHOUT_TRAP : ${stale.join(", ")}`).toEqual([]);
  });
});
