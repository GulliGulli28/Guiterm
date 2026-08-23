// Rend un vrai `PaneView` (le panneau d'un onglet de transfert) dans le
// navigateur, sans Tauri : le composant ne parle à `invoke(...)` que par les
// callbacks qu'on lui passe, et ce contrôle n'en déclenche aucun. Piloté par
// `visual-check-transfer-columns.mjs`, qui appelle `window.__renderPane` puis
// mesure la géométrie réelle des colonnes.
import { createRoot } from "react-dom/client";
import { PaneView } from "../src/components/TransferTab";
import type { Entry, PaneState, Workspace } from "../src/lib/types";
import "../src/index.css";

/** Un listing volontairement hostile à la mise en page : le nom le plus long
 * possible, une date de l'année dernière (donc large), un type long
 * (« Dossier »), la plus grande taille affichable, et les cas où une ligne
 * porte moins de boutons d'action que sa voisine (dossier vs fichier, fichier
 * trop gros pour l'édition rapide) — c'est précisément ce dernier écart qui
 * décalait les colonnes d'une ligne à l'autre. */
const entries: Entry[] = [
  { name: "un-dossier-au-nom-vraiment-tres-long-pour-deborder", isDir: true, isSymlink: false, size: 4096, modified: 1_763_000_000, permissions: 0o755 },
  { name: "sauvegarde-2025-12-31.tar.gz", isDir: false, isSymlink: false, size: 1_098_765_432, modified: 1_735_600_000, permissions: 0o644 },
  { name: "notes.md", isDir: false, isSymlink: false, size: 1234, modified: 1_763_500_000, permissions: 0o644 },
  { name: "gros-fichier.iso", isDir: false, isSymlink: false, size: 4_500_000_000, modified: 1_700_000_000, permissions: 0o644 },
  { name: "sans-extension", isDir: false, isSymlink: false, size: 0, permissions: 0o600 },
];

const pane: PaneState = {
  source: { kind: "local" },
  status: "open",
  paneId: "verification",
  cwd: "/home/glorin/projets/guiterm",
  entries,
};

const workspace = { hosts: [], groups: [] } as unknown as Workspace;
const noop = () => {};
const host = document.getElementById("host")!;
const root = createRoot(host);

function measure() {
  const header = document.querySelector("[data-pane-header]");
  const rows = Array.from(document.querySelectorAll("[data-pane-row]"));
  if (!header || rows.length === 0) return null;

  const cells = (el: Element) =>
    Array.from(el.children).map((child) => {
      const rect = child.getBoundingClientRect();
      return {
        left: Math.round(rect.left * 10) / 10,
        right: Math.round(rect.right * 10) / 10,
        // `scrollWidth > clientWidth` : le contenu ne tient pas dans sa
        // colonne. Avec `truncate` ça se voit en « … », sans, ça débordait
        // sur la colonne d'à côté — les deux sont des bugs de largeur.
        clipped: child.scrollWidth > child.clientWidth + 1,
        text: (child.textContent ?? "").trim(),
      };
    });

  return {
    header: cells(header),
    rows: rows.map(cells),
    paneWidth: Math.round((header.parentElement ?? host).getBoundingClientRect().width),
  };
}

declare global {
  interface Window {
    __renderPane: (options: { fontSize: number; width: number }) => Promise<ReturnType<typeof measure>>;
  }
}

window.__renderPane = async ({ fontSize, width }) => {
  host.style.width = `${width}px`;
  root.render(
    <PaneView
      side="left"
      pane={pane}
      workspace={workspace}
      fontSize={fontSize}
      onNavigate={noop}
      onSourceChange={noop}
      onCopy={noop}
      onMkdir={noop}
      onCreateFile={noop}
      onRename={noop}
      onRemove={noop}
      onChmod={noop}
      onEdit={noop}
      onOpenInEditor={noop}
      onDirSize={() => Promise.resolve(0)}
      onDiskSpace={() => Promise.resolve(null)}
      onFind={() => Promise.resolve({ paths: [], truncated: false })}
      onArchive={noop}
      onExtract={noop}
      diffPick={null}
      diffArmed={false}
      showHidden
      onToggleHidden={noop}
      onDragStart={noop}
      justDraggedRef={{ current: false }}
      dragging={false}
      dropTarget={null}
    />,
  );
  // Deux images pour le rendu, puis un temps mort pour le `ResizeObserver`
  // qui décide des colonnes visibles à partir de la largeur réelle.
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  await new Promise((resolve) => setTimeout(resolve, 80));
  return measure();
};
