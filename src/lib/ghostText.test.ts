import { describe, expect, it, vi } from "vitest";
import { createGhostTextController, type GhostSuggestion, type GhostTextDeps } from "./ghostText";
import type { Terminal } from "@xterm/xterm";

// createGhostTextController is deliberately built around injected
// dependencies (GhostTextDeps) rather than reaching into a real xterm
// instance/DOM directly — exactly so it can be exercised like this, with
// small fakes standing in for the terminal and its DOM refs, in the
// project's "node" vitest environment (no jsdom, see tabPersistence.test.ts
// for the same reasoning applied to `localStorage`).

function makeFakeTerm(overrides: { cols?: number; rows?: number; viewportY?: number; baseY?: number; cursorX?: number; cursorY?: number } = {}) {
  const { cols = 80, rows = 24, viewportY = 0, baseY = 0, cursorX = 0, cursorY = 0 } = overrides;
  return { cols, rows, buffer: { active: { viewportY, baseY, cursorX, cursorY } } } as unknown as Terminal;
}

// A `.xterm-rows` element sized so each cell is exactly 10x20px, offset by
// (2, 4) from the outer wrapper — fixed numbers chosen to make the expected
// left/top trivial to hand-check: left = 2 + cursorX*10, top = 4 + cursorY*20.
function makeRefs(hasRows: boolean) {
  const rowsEl = { getBoundingClientRect: () => ({ width: 800, height: 480, left: 12, top: 24 }) };
  const containerEl = { querySelector: (sel: string) => (hasRows && sel === ".xterm-rows" ? rowsEl : null) };
  const outerEl = { getBoundingClientRect: () => ({ left: 10, top: 20 }) };
  return {
    containerRef: { current: containerEl as unknown as HTMLDivElement },
    outerRef: { current: outerEl as unknown as HTMLDivElement },
  };
}

function makeEnv(opts: { history?: string[]; enabled?: boolean; disposed?: boolean; hasRows?: boolean; term?: Terminal } = {}) {
  const { history = [], hasRows = true } = opts;
  let enabled = opts.enabled ?? true;
  let disposed = opts.disposed ?? false;
  const term = opts.term ?? makeFakeTerm();
  const { containerRef, outerRef } = makeRefs(hasRows);
  const suggestions: (GhostSuggestion | null)[] = [];
  const sendInput = vi.fn();
  const appendHistory = vi.fn().mockResolvedValue(undefined);
  const deps: GhostTextDeps = {
    term,
    containerRef,
    outerRef,
    isEnabled: () => enabled,
    isDisposed: () => disposed,
    sendInput,
    getHistory: () => Promise.resolve([...history]),
    appendHistory,
    setSuggestion: (s) => suggestions.push(s),
  };
  return {
    term, containerRef, outerRef, deps, suggestions, sendInput, appendHistory,
    setEnabled: (v: boolean) => { enabled = v; },
    setDisposed: (v: boolean) => { disposed = v; },
  };
}

// getHistory() is hydrated via a microtask chain (`.then`) run right inside
// createGhostTextController — flush it before asserting on anything that
// depends on `history` being populated.
const flush = () => new Promise((r) => setTimeout(r, 0));

function type(ctrl: ReturnType<typeof createGhostTextController>, text: string) {
  for (const ch of text) ctrl.handleOnData(ch);
}

describe("createGhostTextController", () => {
  it("shows a suggestion once history is hydrated and the typed line matches", async () => {
    const env = makeEnv({ history: ["git status", "git push"], term: makeFakeTerm({ cursorX: 5 }) });
    const ctrl = createGhostTextController(env.deps);
    await flush();

    type(ctrl, "git s");
    ctrl.handleOutputWritten();

    const last = env.suggestions.at(-1);
    expect(last).toEqual({ text: "tatus", left: 2 + 5 * 10, top: 4, cellHeight: 20 });
  });

  it("does not suggest before getHistory() has resolved", () => {
    const env = makeEnv({ history: ["git status"], term: makeFakeTerm({ cursorX: 5 }) });
    const ctrl = createGhostTextController(env.deps);
    // No flush() — the hydration microtask hasn't run yet.

    type(ctrl, "git s");
    ctrl.handleOutputWritten();

    expect(env.suggestions.at(-1)).toBeNull();
  });

  it("drops the hydrated history if the controller is disposed before getHistory() resolves", async () => {
    const env = makeEnv({ history: ["git status"], term: makeFakeTerm({ cursorX: 5 }) });
    const ctrl = createGhostTextController(env.deps);
    env.setDisposed(true);
    await flush();
    env.setDisposed(false); // re-enable so updateSuggestion() itself doesn't short-circuit on isDisposed()

    type(ctrl, "git s");
    ctrl.handleOutputWritten();

    expect(env.suggestions.at(-1)).toBeNull();
  });

  it("clears the suggestion synchronously (no handleOutputWritten needed) once the line empties", async () => {
    const env = makeEnv({ history: ["git status"], term: makeFakeTerm({ cursorX: 5 }) });
    const ctrl = createGhostTextController(env.deps);
    await flush();
    type(ctrl, "git s");
    ctrl.handleOutputWritten();
    expect(env.suggestions.at(-1)?.text).toBe("tatus");

    ctrl.handleOnData("\x03"); // Ctrl+C clears the shadowed line
    expect(env.suggestions.at(-1)).toBeNull();
  });

  it("submits the trimmed line to history on Enter and records it via appendHistory", async () => {
    const env = makeEnv({ history: [] });
    const ctrl = createGhostTextController(env.deps);
    await flush();

    type(ctrl, "git status");
    ctrl.handleOnData("\r");

    expect(env.appendHistory).toHaveBeenCalledWith("git status");
    // The line is now empty post-submit, so no lingering suggestion either.
    expect(env.suggestions.at(-1)).toBeNull();
  });

  it("moves a re-submitted command to the end of history rather than duplicating it", async () => {
    const env = makeEnv({ history: ["git status", "ls -la"], term: makeFakeTerm({ cursorX: 5 }) });
    const ctrl = createGhostTextController(env.deps);
    await flush();

    type(ctrl, "ls -la");
    ctrl.handleOnData("\r");
    // "ls -la" moved to the end of the (in-memory) history — typing "ls" no
    // longer suggests it ahead of anything shorter/more-recent that matches.
    type(ctrl, "git s");
    ctrl.handleOutputWritten();
    expect(env.suggestions.at(-1)?.text).toBe("tatus");
  });

  it("returns no suggestion while the user has scrolled the scrollback up", async () => {
    const env = makeEnv({ history: ["git status"], term: makeFakeTerm({ cursorX: 5, viewportY: 3, baseY: 10 }) });
    const ctrl = createGhostTextController(env.deps);
    await flush();

    type(ctrl, "git s");
    ctrl.handleOutputWritten();

    expect(env.suggestions.at(-1)).toBeNull();
  });

  it("returns no suggestion when disabled, even with a matching line", async () => {
    const env = makeEnv({ history: ["git status"], enabled: false, term: makeFakeTerm({ cursorX: 5 }) });
    const ctrl = createGhostTextController(env.deps);
    await flush();

    type(ctrl, "git s");
    ctrl.handleOutputWritten();

    expect(env.suggestions.at(-1)).toBeNull();
  });

  it("returns no suggestion when the terminal's .xterm-rows isn't mounted yet (metrics unmeasurable)", async () => {
    const env = makeEnv({ history: ["git status"], hasRows: false, term: makeFakeTerm({ cursorX: 5 }) });
    const ctrl = createGhostTextController(env.deps);
    await flush();

    type(ctrl, "git s");
    ctrl.handleOutputWritten();

    expect(env.suggestions.at(-1)).toBeNull();
  });

  it("caches measured cell geometry across calls until remeasure() is invoked", async () => {
    const env = makeEnv({ history: ["git status"], term: makeFakeTerm({ cursorX: 5 }) });
    const ctrl = createGhostTextController(env.deps);
    await flush();

    type(ctrl, "git s");
    ctrl.handleOutputWritten();
    expect(env.suggestions.at(-1)?.left).toBe(2 + 5 * 10); // cellWidth 10 (800/80 cols)

    // Simulate a resize: same DOM rect, but the terminal is now narrower —
    // cellWidth should change (rowsRect.width / cols), but only once
    // something actually asks for it to be recomputed.
    (env.term as unknown as { cols: number }).cols = 40; // cellWidth becomes 800/40 = 20

    ctrl.handleOutputWritten();
    // Stale cached metrics, unchanged despite the cols change above.
    expect(env.suggestions.at(-1)?.left).toBe(2 + 5 * 10);

    ctrl.remeasure();
    expect(env.suggestions.at(-1)?.left).toBe(2 + 5 * 20);
  });

  describe("handleAcceptKey", () => {
    async function withSuggestion() {
      const env = makeEnv({ history: ["git status"], term: makeFakeTerm({ cursorX: 5 }) });
      const ctrl = createGhostTextController(env.deps);
      await flush();
      type(ctrl, "git s");
      ctrl.handleOutputWritten();
      return { env, ctrl };
    }

    it("accepts on ArrowRight: sends the suggested tail, clears it, and returns true", async () => {
      const { env, ctrl } = await withSuggestion();
      const accepted = ctrl.handleAcceptKey({ key: "ArrowRight", ctrlKey: false, metaKey: false, altKey: false } as KeyboardEvent);

      expect(accepted).toBe(true);
      expect(env.sendInput).toHaveBeenCalledWith("tatus");
      expect(env.suggestions.at(-1)).toBeNull();
    });

    it("accepts on End the same way ArrowRight does", async () => {
      const { env, ctrl } = await withSuggestion();
      const accepted = ctrl.handleAcceptKey({ key: "End", ctrlKey: false, metaKey: false, altKey: false } as KeyboardEvent);

      expect(accepted).toBe(true);
      expect(env.sendInput).toHaveBeenCalledWith("tatus");
    });

    it("ignores any other key and leaves the suggestion untouched", async () => {
      const { env, ctrl } = await withSuggestion();
      const accepted = ctrl.handleAcceptKey({ key: "a", ctrlKey: false, metaKey: false, altKey: false } as KeyboardEvent);

      expect(accepted).toBe(false);
      expect(env.sendInput).not.toHaveBeenCalled();
      expect(env.suggestions.at(-1)?.text).toBe("tatus");
    });

    it("ignores ArrowRight/End when a modifier is held", async () => {
      const { env, ctrl } = await withSuggestion();
      expect(ctrl.handleAcceptKey({ key: "ArrowRight", ctrlKey: true, metaKey: false, altKey: false } as KeyboardEvent)).toBe(false);
      expect(ctrl.handleAcceptKey({ key: "ArrowRight", ctrlKey: false, metaKey: true, altKey: false } as KeyboardEvent)).toBe(false);
      expect(ctrl.handleAcceptKey({ key: "ArrowRight", ctrlKey: false, metaKey: false, altKey: true } as KeyboardEvent)).toBe(false);
      expect(env.sendInput).not.toHaveBeenCalled();
    });

    it("returns false when there is no suggestion to accept", async () => {
      const env = makeEnv({ history: [] });
      const ctrl = createGhostTextController(env.deps);
      await flush();

      const accepted = ctrl.handleAcceptKey({ key: "ArrowRight", ctrlKey: false, metaKey: false, altKey: false } as KeyboardEvent);
      expect(accepted).toBe(false);
      expect(env.sendInput).not.toHaveBeenCalled();
    });
  });
});
