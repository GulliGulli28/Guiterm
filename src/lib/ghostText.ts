import type { Terminal } from "@xterm/xterm";
import { applyInput, findSuggestion, INITIAL_LINE_BUFFER, type LineBufferState } from "./lineBuffer";

export interface GhostSuggestion {
  text: string;
  left: number;
  top: number;
  cellHeight: number;
}

interface CellMetrics {
  cellWidth: number;
  cellHeight: number;
  originLeft: number;
  originTop: number;
}

export interface GhostTextController {
  /** Call inside `term.onData`, after the raw data has been sent to the PTY. */
  handleOnData(data: string): void;
  /** Call inside the callback of `term.write(data, cb)`, once real PTY output has been applied. */
  handleOutputWritten(): void;
  /** Call on resize, tab activation, or font/theme changes — recomputes cell geometry too. */
  remeasure(): void;
  /** Call from `attachCustomKeyEventHandler`; returns true if the key was consumed (accepted a suggestion). */
  handleAcceptKey(e: KeyboardEvent): boolean;
}

export interface GhostTextDeps {
  term: Terminal;
  containerRef: { current: HTMLDivElement | null };
  outerRef: { current: HTMLDivElement | null };
  isEnabled: () => boolean;
  isDisposed: () => boolean;
  /** Sends raw bytes to the PTY, as if typed (used to accept a suggestion). */
  sendInput: (data: string) => void;
  getHistory: () => Promise<string[]>;
  appendHistory: (command: string) => Promise<void>;
  setSuggestion: (s: GhostSuggestion | null) => void;
}

/**
 * Shared ghost-text (Fish/Warp-style) command suggestion logic, used by both
 * the local and SSH terminal components: shadows keystrokes to guess the
 * line being typed (lineBuffer.ts), matches it against a command-history
 * list, and positions a suggestion via a DOM overlay measured from xterm's
 * own `.xterm-rows` DOM renderer output. Never written into the real
 * terminal buffer — a shell that redraws its own line (zsh-syntax-
 * highlighting, powerlevel10k, etc.) would otherwise corrupt the screen.
 */
export function createGhostTextController(deps: GhostTextDeps): GhostTextController {
  const { term, containerRef, outerRef, isEnabled, isDisposed, sendInput, getHistory, appendHistory, setSuggestion } = deps;

  let history: string[] = [];
  let buffer: LineBufferState = INITIAL_LINE_BUFFER;
  let metrics: CellMetrics | null = null;

  getHistory().then((h) => { if (!isDisposed()) history = h; }).catch(() => {});

  const measureMetrics = () => {
    const rowsEl = containerRef.current?.querySelector<HTMLElement>(".xterm-rows");
    if (!rowsEl || !outerRef.current) {
      metrics = null;
      return;
    }
    const rowsRect = rowsEl.getBoundingClientRect();
    const outerRect = outerRef.current.getBoundingClientRect();
    const cellWidth = rowsRect.width / term.cols;
    const cellHeight = rowsRect.height / term.rows;
    if (!(cellWidth > 0) || !(cellHeight > 0)) {
      metrics = null;
      return;
    }
    metrics = { cellWidth, cellHeight, originLeft: rowsRect.left - outerRect.left, originTop: rowsRect.top - outerRect.top };
  };

  // Reposition/redraw only once the terminal's real cursor has caught up
  // with the shadowed buffer — i.e. from handleOutputWritten(), never right
  // after handleOnData(): the real echo hasn't been applied to xterm's
  // buffer yet at that point, so cursorX/Y would still be one keystroke
  // behind and the overlay would render in the wrong cell.
  const updateSuggestion = () => {
    if (isDisposed() || !isEnabled()) {
      setSuggestion(null);
      return;
    }
    const tail = findSuggestion(history, buffer);
    if (!tail) {
      setSuggestion(null);
      return;
    }
    const buf = term.buffer.active;
    if (buf.viewportY !== buf.baseY) {
      setSuggestion(null);
      return;
    }
    if (!metrics) measureMetrics();
    if (!metrics) {
      setSuggestion(null);
      return;
    }
    setSuggestion({
      text: tail,
      left: metrics.originLeft + buf.cursorX * metrics.cellWidth,
      top: metrics.originTop + buf.cursorY * metrics.cellHeight,
      cellHeight: metrics.cellHeight,
    });
  };

  return {
    handleOnData(data) {
      if (!isEnabled()) return;
      const { next, submitted } = applyInput(buffer, data);
      buffer = next;
      for (const cmd of submitted) {
        history = [...history.filter((entry) => entry !== cmd), cmd];
        appendHistory(cmd).catch(() => {});
      }
      // Hide immediately on empty/desynced buffers (no real cursor position
      // needed for that); showing a suggestion still waits for the real echo.
      if (next.desynced || next.text.length === 0) setSuggestion(null);
    },
    handleOutputWritten() {
      updateSuggestion();
    },
    remeasure() {
      measureMetrics();
      updateSuggestion();
    },
    handleAcceptKey(e) {
      if (!isEnabled()) return false;
      if (e.ctrlKey || e.metaKey || e.altKey) return false;
      if (e.key !== "ArrowRight" && e.key !== "End") return false;
      const tail = findSuggestion(history, buffer);
      if (!tail) return false;
      buffer = { text: buffer.text + tail, cursor: buffer.text.length + tail.length, desynced: false };
      setSuggestion(null);
      sendInput(tail);
      return true;
    },
  };
}
