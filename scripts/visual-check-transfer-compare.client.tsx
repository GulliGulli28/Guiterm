// Monte le panneau de comparaison seul, avec un résultat fabriqué : ce qui
// s'y vérifie est le comportement de la case à cocher et du sens de copie,
// pas l'inventaire (couvert par les tests Rust).
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ComparisonPanel } from "../src/components/TransferTab";
import type { PaneComparison, SyncItem } from "../src/lib/types";
import "../src/index.css";

const result: PaneComparison = {
  identical: 42,
  truncated: false,
  differences: [
    { path: "config/nginx.conf", kind: "onlyLeft", left: { path: "config/nginx.conf", size: 1000, modified: 1_763_000_000 }, right: null },
    { path: "journal.log", kind: "onlyRight", left: null, right: { path: "journal.log", size: 2000, modified: 1_763_000_000 } },
    { path: "app/main.py", kind: "newerLeft", left: { path: "app/main.py", size: 3000, modified: 1_763_100_000 }, right: { path: "app/main.py", size: 2900, modified: 1_763_000_000 } },
    { path: "app/vieux.py", kind: "newerRight", left: { path: "app/vieux.py", size: 500, modified: 1_762_000_000 }, right: { path: "app/vieux.py", size: 600, modified: 1_763_000_000 } },
    { path: "data.bin", kind: "sizeDiffers", left: { path: "data.bin", size: 10, modified: 1_763_000_000 }, right: { path: "data.bin", size: 20, modified: 1_763_000_000 } },
  ],
};

declare global {
  interface Window {
    __syncs: { direction: string; paths: string[]; bytes: number }[];
  }
}
window.__syncs = [];

function Harness() {
  const [open, setOpen] = useState(true);
  if (!open) return <p data-closed style={{ color: "#888", padding: 16 }}>fermé</p>;
  return (
    <div style={{ position: "relative", height: "480px" }}>
      <ComparisonPanel
        state={{ status: "done", result }}
        leftCwd="/home/glorin/projet"
        rightCwd="/srv/app"
        fontSize={13}
        onSync={(direction: "left" | "right", items: SyncItem[]) => {
          window.__syncs.push({
            direction,
            paths: items.map((i) => i.path),
            bytes: items.reduce((sum, i) => sum + i.size, 0),
          });
        }}
        onClose={() => setOpen(false)}
        onRetry={() => {}}
      />
    </div>
  );
}

createRoot(document.getElementById("host")!).render(<Harness />);
