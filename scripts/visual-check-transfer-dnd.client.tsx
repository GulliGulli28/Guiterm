// Deux panneaux de transfert côte à côte, branchés sur le vrai `usePaneDrag`,
// sans Tauri : ce contrôle vérifie le *geste* (appui, seuil, survol, lâcher),
// pas les transferts — le dépôt se contente d'être enregistré dans
// `window.__drops`, que `visual-check-transfer-dnd.mjs` relit.
import { useRef } from "react";
import { createRoot } from "react-dom/client";
import { PaneView } from "../src/components/TransferTab";
import { usePaneDrag } from "../src/hooks/usePaneDrag";
import type { PaneDropTarget, PaneSide } from "../src/hooks/usePaneDrag";
import type { Entry, PaneState, Workspace } from "../src/lib/types";
import "../src/index.css";

const leftEntries: Entry[] = [
  { name: "rapport.pdf", isDir: false, isSymlink: false, size: 120_000, modified: 1_763_000_000, permissions: 0o644 },
  { name: "notes.md", isDir: false, isSymlink: false, size: 1234, modified: 1_763_500_000, permissions: 0o644 },
  { name: "projet", isDir: true, isSymlink: false, size: 4096, modified: 1_763_000_000, permissions: 0o755 },
];
const rightEntries: Entry[] = [
  { name: "depot", isDir: true, isSymlink: false, size: 4096, modified: 1_763_000_000, permissions: 0o755 },
  { name: "lisez-moi.txt", isDir: false, isSymlink: false, size: 42, modified: 1_763_000_000, permissions: 0o644 },
];

const panes: Record<PaneSide, PaneState> = {
  left: { source: { kind: "local" }, status: "open", paneId: "gauche", cwd: "/home/glorin", entries: leftEntries },
  right: { source: { kind: "local" }, status: "open", paneId: "droit", cwd: "/srv/data", entries: rightEntries },
};

const workspace = { hosts: [], groups: [] } as unknown as Workspace;
const noop = () => {};

declare global {
  interface Window {
    __drops: { source: PaneSide; names: string[]; target: PaneDropTarget }[];
    __dragging: boolean;
  }
}
window.__drops = [];
window.__dragging = false;

function Harness() {
  const left = useRef<HTMLDivElement>(null);
  const right = useRef<HTMLDivElement>(null);
  const { drag, begin, justDraggedRef } = usePaneDrag({
    paneRefs: { left, right },
    onDrop: (source, entries, target) => {
      window.__drops.push({ source, names: entries.map((e) => e.name), target });
    },
  });
  window.__dragging = drag !== null;

  const paneProps = (side: PaneSide) => ({
    side,
    pane: panes[side],
    workspace,
    fontSize: 13,
    onNavigate: noop,
    onSourceChange: noop,
    onCopy: noop,
    onMkdir: noop,
    onCreateFile: noop,
    onRename: noop,
    onRemove: noop,
    onChmod: noop,
    onEdit: noop,
    onOpenInEditor: noop,
    onDirSize: () => Promise.resolve(0),
    onFind: () => Promise.resolve({ paths: [], truncated: false }),
    onArchive: noop,
    onDragStart: begin,
    justDraggedRef,
    dragging: drag !== null,
    dropTarget: drag && drag.target?.side === side ? drag.target : null,
  });

  return (
    <div style={{ display: "flex", height: "420px" }}>
      <div ref={left} data-pane="left" style={{ width: "50%", display: "flex", overflow: "hidden" }}>
        <PaneView {...paneProps("left")} />
      </div>
      <div ref={right} data-pane="right" style={{ width: "50%", display: "flex", overflow: "hidden" }}>
        <PaneView {...paneProps("right")} />
      </div>
      {drag && (
        <div
          className="pointer-events-none fixed z-50 rounded-md border px-2 py-1 text-xs"
          data-drag-ghost
          style={{ left: drag.x + 14, top: drag.y + 14, background: "#222", color: "#eee" }}
        >
          {drag.entries.length === 1 ? drag.entries[0].name : `${drag.entries.length} éléments`}
        </div>
      )}
    </div>
  );
}

createRoot(document.getElementById("host")!).render(<Harness />);
