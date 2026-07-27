// Page side of `scripts/bench-terminal-render.mjs`. Exposes `window.runBench`,
// which mounts a real xterm terminal, pushes a fixed payload through it, and
// reports how long xterm took to accept and render all of it.
//
// The payload deliberately mixes plain text with SGR colour changes: a styled
// run is what forces the DOM renderer to open a new element, so an all-plain
// payload would flatter it in a way real terminal output (ls --color, build
// logs, htop) does not.
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";

const COLOURS = [31, 32, 33, 34, 35, 36, 91, 92, 93, 94, 95, 96];

/** One line of ~100 visible columns carrying several styled runs. */
function line(i) {
  const c1 = COLOURS[i % COLOURS.length];
  const c2 = COLOURS[(i + 5) % COLOURS.length];
  const size = String((i * 7919) % 100000).padStart(8);
  return (
    `\x1b[${c1}mdrwxr-xr-x\x1b[0m  \x1b[1m${String(i % 40).padStart(3)}\x1b[0m ` +
    `\x1b[${c2}mglorin\x1b[0m glorin ${size} 2026-07-27 09:${String(i % 60).padStart(2, "0")} ` +
    `\x1b[${c1}mfichier-de-test-numero-${i}.txt\x1b[0m\r\n`
  );
}

/**
 * `chunkLines` drives what this actually measures, and it matters:
 *
 * - a single huge write (`chunkLines >= lines`) measures parsing plus **one**
 *   repaint. xterm coalesces everything into one frame, so the renderer is
 *   barely exercised — this flatters whichever renderer parses fastest;
 * - writing in chunks with a frame between each reproduces what a terminal
 *   under real load does (`cat` on a big file, `htop`, a verbose build):
 *   dozens of repaints per second. That per-frame cost is the thing the WebGL
 *   renderer exists to reduce, so it's the honest comparison.
 *
 * @param {{ webgl: boolean, lines: number, chunkLines: number }} options
 * @returns {Promise<{ ms: number, frames: number, bytes: number, domNodes: number, renderer: string }>}
 */
window.runBench = async ({ webgl, lines, chunkLines }) => {
  const host = document.getElementById("term");
  host.innerHTML = "";

  const term = new Terminal({
    cols: 200,
    rows: 50,
    // A real scrollback, like the app's: it is part of what the renderer has
    // to manage, and setting it to 0 would make this measure something else.
    scrollback: 1000,
    fontFamily: "monospace",
    fontSize: 13,
    theme: { background: "#020617", foreground: "#e2e8f0" },
  });
  term.open(host);

  let renderer = "dom";
  if (webgl) {
    const { WebglAddon } = await import("@xterm/addon-webgl");
    const addon = new WebglAddon();
    term.loadAddon(addon);
    renderer = "webgl";
  }

  const perChunk = Math.max(1, chunkLines);
  const chunks = [];
  for (let start = 0; start < lines; start += perChunk) {
    const upto = Math.min(start + perChunk, lines);
    let text = "";
    for (let i = start; i < upto; i++) text += line(i);
    chunks.push(text);
  }
  const bytes = new TextEncoder().encode(chunks.join("")).length;

  // Let the terminal settle (fonts measured, first frame drawn) so startup
  // cost doesn't land inside the measurement.
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

  const started = performance.now();
  for (const chunk of chunks) {
    await new Promise((resolve) => term.write(chunk, resolve));
    // Yield a frame so this chunk is actually painted before the next one is
    // queued — otherwise xterm merges them and the repaint cost disappears.
    await new Promise((r) => requestAnimationFrame(r));
  }
  const ms = performance.now() - started;

  const domNodes = host.querySelectorAll("*").length;
  return { ms, frames: chunks.length, bytes, domNodes, renderer };
};
