// Standalone harness that mounts a real @xterm/xterm Terminal (no Tauri
// involved) and reproduces the exact cell-geometry measurement technique
// used by LocalTerminalTab.tsx to position the ghost-text suggestion overlay.
// Run via scripts/visual-check-ghost-text.mjs (Playwright) to validate the
// `.xterm-rows`-based positioning assumption with a real browser layout.
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";

const term = new Terminal({
  cursorBlink: false,
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  fontSize: 14,
  theme: { background: "#020617", foreground: "#e2e8f0" },
});
term.open(document.getElementById("term"));

// Simulate a real prompt plus a partially typed command — the ghost text
// should render immediately after "git s", i.e. right where "tatus" would go.
term.write("user@host:~$ git s");

function positionGhost() {
  const rowsEl = document.querySelector("#term .xterm-rows");
  const wrap = document.getElementById("term-wrap");
  const ghost = document.getElementById("ghost");
  if (!rowsEl) return;

  const rowsRect = rowsEl.getBoundingClientRect();
  const wrapRect = wrap.getBoundingClientRect();
  const cellWidth = rowsRect.width / term.cols;
  const cellHeight = rowsRect.height / term.rows;
  const buf = term.buffer.active;

  const left = rowsRect.left - wrapRect.left + buf.cursorX * cellWidth;
  const top = rowsRect.top - wrapRect.top + buf.cursorY * cellHeight;

  ghost.style.left = `${left}px`;
  ghost.style.top = `${top}px`;
  ghost.style.lineHeight = `${cellHeight}px`;
  ghost.textContent = "tatus --short";

  window.__ghostMetrics = { cellWidth, cellHeight, left, top, cursorX: buf.cursorX, cursorY: buf.cursorY, cols: term.cols, rows: term.rows };
  window.__ghostReady = true;
}

// Two rAFs: xterm's DOM renderer applies writes on the next animation frame,
// so the first frame after write() can still reflect the pre-write layout.
requestAnimationFrame(() => requestAnimationFrame(positionGhost));
