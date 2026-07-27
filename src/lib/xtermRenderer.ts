import type { Terminal } from "@xterm/xterm";

/** Live rendering cost, surfaced by [`attachRenderStats`] when the
 * `terminalRenderStats` preference is on. */
export interface RenderStats {
  /** Which renderer is actually in use — not what was asked for: WebGL falls
   * back to the DOM on its own when no context is available. */
  renderer: "webgl" | "dom";
  /** Rolling average of the interval between painted frames, in ms, while
   * output is flowing. ~16.7 means the terminal is keeping up with a 60 Hz
   * display; consistently higher means it is behind. */
  msPerFrame: number;
}

/** Turns on xterm's WebGL renderer for `term`, falling back silently to the
 * default DOM renderer if it can't be used.
 *
 * **Which renderer is faster genuinely depends on the machine**, which is why
 * this is driven by a preference (`terminalWebglRenderer`) rather than always
 * on. The WebGL renderer draws the viewport from a glyph atlas on the GPU, so
 * it should stay ahead under sustained output. But xterm's DOM renderer is
 * not the naive thing it sounds like — it only ever mounts the *visible*
 * viewport (~400 nodes, regardless of scrollback), and on a system without
 * usable hardware acceleration it beats WebGL comfortably: measured 6× faster
 * against a software (SwiftShader) GL backend by
 * `scripts/bench-terminal-render.mjs`, which is exactly what a badly
 * supported GPU degrades to.
 *
 * The addon is `import()`ed rather than imported statically: it's ~111 kB of
 * the main chunk otherwise (`TerminalTab` isn't lazy-loaded — it's the app's
 * primary view), and nothing needs it on the first frame. xterm renders
 * through the DOM until it resolves, then swaps renderer with no visible
 * transition — and the chunk is served from the local bundle, so "until it
 * resolves" is a few milliseconds against an SSH connect that takes orders of
 * magnitude longer.
 *
 * Three failure modes are handled, all by simply not having (or no longer
 * having) the addon loaded — xterm falls back to the DOM renderer on its own
 * as soon as the addon is disposed, so there is nothing to restore manually:
 *
 * - **Chunk fails to load.** Nothing to do; the terminal works, only slower.
 * - **No usable WebGL2 context.** A software/blocklisted GPU, a remote
 *   session, or a WebView2 running without hardware acceleration all make
 *   `loadAddon` throw. Not an error worth surfacing to the user.
 * - **Context loss while running.** The GPU driver can revoke the context at
 *   any time (driver update, GPU reset, laptop switching between integrated
 *   and discrete graphics). Without handling it the terminal would keep the
 *   dead addon loaded and render nothing at all — a blank terminal, which is
 *   far worse than a slow one.
 *
 * `onRenderer` reports which one ended up in use, once known.
 *
 * Returns a disposer to call when tearing the terminal down. Safe to call at
 * any point, including before the addon has finished loading (in which case
 * it's never attached at all).
 */
export function attachWebglRenderer(
  term: Terminal,
  options: { enabled: boolean; onRenderer?: (renderer: "webgl" | "dom") => void } = { enabled: true },
): () => void {
  let disposed = false;
  let dispose: (() => void) | null = null;

  const settle = (renderer: "webgl" | "dom") => {
    if (!disposed) options.onRenderer?.(renderer);
  };

  // Under WebDriver (`npm run test:e2e`), stay on the DOM renderer. The E2E
  // scenarios assert on real terminal output through the DOM
  // (`document.body.innerText`, `.xterm-rows`) — a WebGL canvas renders the
  // same characters as opaque pixels, so those assertions could no longer see
  // anything and the terminal-data IPC bridge would go untested. The tradeoff
  // is that E2E exercises the fallback renderer rather than the shipped one;
  // that's the right way round, since the fallback is the path that must keep
  // working when a user's GPU can't provide a context either.
  if (!options.enabled || navigator.webdriver) {
    settle("dom");
    return () => {};
  }

  void (async () => {
    try {
      const { WebglAddon } = await import("@xterm/addon-webgl");
      // The component may have unmounted (and `term` been disposed) while the
      // chunk was in flight — attaching to it now would throw.
      if (disposed) return;
      const addon = new WebglAddon();
      // Dispose on context loss so xterm reverts to the DOM renderer rather
      // than drawing to a dead context.
      addon.onContextLoss(() => {
        addon.dispose();
        settle("dom");
      });
      term.loadAddon(addon);
      dispose = () => addon.dispose();
      settle("webgl");
    } catch {
      settle("dom");
    }
  })();

  return () => {
    disposed = true;
    dispose?.();
    dispose = null;
  };
}

/** Samples how long the terminal actually takes per painted frame, so the two
 * renderers can be compared on the machine that matters — the user's.
 *
 * Measures the interval between xterm's own render events rather than a raw
 * `requestAnimationFrame` loop: an idle terminal renders nothing, and timing
 * frames it didn't paint would report a flat 16.7 ms whatever the renderer
 * does. Only reports while output is actually flowing.
 *
 * Costs nothing when off — the caller doesn't attach it at all.
 */
export function attachRenderStats(term: Terminal, onSample: (msPerFrame: number) => void): () => void {
  /** Frames averaged before reporting: enough to smooth out a single slow
   * frame, short enough to react while output is still on screen. */
  const WINDOW = 30;
  let last = 0;
  let total = 0;
  let count = 0;

  const sub = term.onRender(() => {
    const now = performance.now();
    if (last !== 0) {
      const delta = now - last;
      // Ignore gaps caused by the terminal simply being idle between bursts —
      // they are not a rendering cost. 250 ms is far longer than any single
      // frame while output is flowing.
      if (delta < 250) {
        total += delta;
        count += 1;
        if (count >= WINDOW) {
          onSample(total / count);
          total = 0;
          count = 0;
        }
      }
    }
    last = now;
  });

  return () => sub.dispose();
}
