// Monte la modale de comparaison de contenu, avec un diff fabriqué qui a la
// forme des vrais : deux passages éloignés, une ligne longue dont un détail
// a changé, et une ligne ajoutée sans contrepartie.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { FileDiffModal } from "../src/components/TransferTab";
import type { DiffLine, FileDiff } from "../src/lib/types";
import "../src/index.css";

const equal = (text: string, n: number): DiffLine => ({ kind: "equal", leftNo: n, rightNo: n, text, segments: [] });

const diff: FileDiff = {
  identical: false,
  truncated: false,
  leftLines: 40,
  rightLines: 41,
  hunks: [
    {
      lines: [
        equal("server {", 1),
        {
          kind: "deleted", leftNo: 2, rightNo: null,
          text: "  listen 127.0.0.1:8080 default_server;",
          segments: [
            { text: "  listen 127.0.0.1:", emphasis: false },
            { text: "8080", emphasis: true },
            { text: " default_server;", emphasis: false },
          ],
        },
        {
          kind: "inserted", leftNo: null, rightNo: 2,
          text: "  listen 127.0.0.1:9090 default_server;",
          segments: [
            { text: "  listen 127.0.0.1:", emphasis: false },
            { text: "9090", emphasis: true },
            { text: " default_server;", emphasis: false },
          ],
        },
        equal("  root /srv/app;", 3),
      ],
    },
    {
      lines: [
        equal("  location / {", 30),
        { kind: "inserted", leftNo: null, rightNo: 31, text: "    add_header X-Frame-Options DENY;", segments: [] },
        equal("  }", 31),
      ],
    },
  ],
};

declare global {
  interface Window {
    __diffEvents: string[];
  }
}
window.__diffEvents = [];

function Harness() {
  const [view, setView] = useState<"unified" | "split">("unified");
  const [sides, setSides] = useState<["left" | "right", "left" | "right"]>(["left", "right"]);
  return (
    <FileDiffModal
      state={{
        left: { side: sides[0], path: "config/nginx.conf" },
        right: { side: sides[1], path: "sauvegardes/nginx.conf.bak" },
        status: "done",
        diff,
      }}
      fontSize={13}
      labelOf={(pick) => `${pick.side === "left" ? "gauche" : "droite"} · ${pick.path}`}
      view={view}
      onViewChange={(next) => { window.__diffEvents.push(`view:${next}`); setView(next); }}
      onSwap={() => { window.__diffEvents.push("swap"); setSides(([a, b]) => [b, a]); }}
      onClose={() => window.__diffEvents.push("close")}
    />
  );
}

createRoot(document.getElementById("host")!).render(<Harness />);
