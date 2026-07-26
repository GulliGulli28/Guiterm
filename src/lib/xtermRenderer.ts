import type { Terminal } from "@xterm/xterm";

/** Turns on xterm's WebGL renderer for `term`, falling back silently to the
 * default DOM renderer if it can't be used.
 *
 * Why: the DOM renderer builds one element per styled run of cells, so a
 * terminal under sustained output (`cat` on a large file, `htop`, a verbose
 * build) spends most of its frame budget in layout/style recalculation. The
 * WebGL renderer draws the whole viewport from a glyph atlas instead, which
 * is what makes high-throughput output stay smooth.
 *
 * The addon is `import()`ed rather than imported statically: it's ~115 kB of
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
 * Returns a disposer to call when tearing the terminal down. Safe to call at
 * any point, including before the addon has finished loading (in which case
 * it's never attached at all).
 */
export function attachWebglRenderer(term: Terminal): () => void {
  let disposed = false;
  let dispose: (() => void) | null = null;

  // Under WebDriver (`npm run test:e2e`), stay on the DOM renderer. The E2E
  // scenarios assert on real terminal output through the DOM
  // (`document.body.innerText`, `.xterm-rows`) — a WebGL canvas renders the
  // same characters as opaque pixels, so those assertions could no longer see
  // anything and the terminal-data IPC bridge would go untested. The tradeoff
  // is that E2E exercises the fallback renderer rather than the shipped one;
  // that's the right way round, since the fallback is the path that must keep
  // working when a user's GPU can't provide a context either.
  if (navigator.webdriver) return () => {};

  void (async () => {
    try {
      const { WebglAddon } = await import("@xterm/addon-webgl");
      // The component may have unmounted (and `term` been disposed) while the
      // chunk was in flight — attaching to it now would throw.
      if (disposed) return;
      const addon = new WebglAddon();
      // Dispose on context loss so xterm reverts to the DOM renderer rather
      // than drawing to a dead context.
      addon.onContextLoss(() => addon.dispose());
      term.loadAddon(addon);
      dispose = () => addon.dispose();
    } catch {
      // Left on the DOM renderer.
    }
  })();

  return () => {
    disposed = true;
    dispose?.();
    dispose = null;
  };
}
