import { useCallback, useEffect, useRef, useState } from "react";

/** One step of the per-terminal font size, as bound to Ctrl+±/Ctrl+0 and Ctrl+wheel. */
export type ZoomAction = "in" | "out" | "reset";

/** Bounds for a single terminal's font size, whatever the configured default
 * is. Under 6px xterm's glyph measurement stops being reliable (it rounds
 * cell metrics to whole pixels); past 40px an 80-column shell no longer fits
 * on a normal screen, which is a terminal you can't read either. */
export const MIN_TERMINAL_FONT_SIZE = 6;
export const MAX_TERMINAL_FONT_SIZE = 40;

/** How long the size readout stays on screen after a zoom step. */
const BADGE_MS = 1200;

export function clampTerminalFontSize(size: number): number {
  return Math.min(MAX_TERMINAL_FONT_SIZE, Math.max(MIN_TERMINAL_FONT_SIZE, size));
}

/**
 * Maps a keydown to a zoom action, or `null` when it isn't one.
 *
 * Matched on the *character* for +/-, and on the *physical key* for 0. That
 * split isn't arbitrary — it's what the layouts force:
 *
 * - "+" and "-" keep producing those characters on AZERTY, QWERTY and QWERTZ
 *   alike, only from different physical keys and with different Shift states
 *   ("+" is Shift+"=" on AZERTY, "=" is Shift+"+" nowhere...). Matching on
 *   `key` therefore works everywhere, and Shift can't take part in the match.
 * - "0" does not. On AZERTY the number row is shifted, so the physical 0 key
 *   reports `key: "à"` and only produces "0" with Shift held — Ctrl+0 would
 *   simply never fire. Browsers match their own zoom-reset on the physical
 *   key for exactly this reason, so `code: "Digit0"` is what's matched here
 *   (with `key: "0"` still accepted, which is the same physical key on a
 *   shifted layout).
 *
 * This is also why zoom isn't expressed as a rebindable combo string in
 * `lib/shortcuts.ts`, where one action maps to exactly one combo.
 *
 * Alt is excluded so AltGr combinations keep reaching the shell: on Windows
 * AltGr reports as ctrlKey+altKey, and AltGr+0 is how "@" is typed on some
 * layouts.
 */
export function zoomActionFromKey(e: KeyboardEvent): ZoomAction | null {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return null;
  if (e.code === "NumpadAdd" || e.key === "+" || e.key === "=") return "in";
  if (e.code === "NumpadSubtract" || e.key === "-" || e.key === "_") return "out";
  if (e.code === "Numpad0" || e.code === "Digit0" || e.key === "0") return "reset";
  return null;
}

/** Same, for Ctrl+wheel. `null` for a plain wheel event, which is a scroll. */
export function zoomActionFromWheel(e: WheelEvent): ZoomAction | null {
  if (!(e.ctrlKey || e.metaKey)) return null;
  if (e.deltaY < 0) return "in";
  if (e.deltaY > 0) return "out";
  return null;
}

/**
 * Applies one action to a terminal's current offset from the configured size.
 *
 * The clamp is applied to the resulting *size* and converted back to an
 * offset, so an offset can never drift past what the bounds allow: otherwise
 * holding Ctrl+- at the minimum would keep pushing the offset down and it
 * would take as many presses to get a visible change back.
 */
export function nextZoomOffset(offset: number, baseFontSize: number, action: ZoomAction): number {
  if (action === "reset") return 0;
  const step = action === "in" ? 1 : -1;
  return clampTerminalFontSize(baseFontSize + offset + step) - baseFontSize;
}

export interface TerminalZoom {
  /** Size to render this terminal at: the configured size plus its own offset. */
  fontSize: number;
  /** `0` while the terminal is at the size configured in Settings. */
  offset: number;
  /** True for a moment after a zoom step, so the new size can be shown. */
  badgeVisible: boolean;
  apply: (action: ZoomAction) => void;
}

/**
 * Per-terminal font size, on top of the `terminalFontSize` preference.
 *
 * Deliberately component-local state rather than anything persisted: it
 * belongs to one open terminal, so it must not touch the other tabs nor the
 * configured default — and it follows `baseFontSize`, so changing the size in
 * Settings still moves a zoomed terminal by the same amount instead of
 * pinning it.
 */
export function useTerminalZoom(baseFontSize: number): TerminalZoom {
  const [offset, setOffset] = useState(0);
  const [badgeVisible, setBadgeVisible] = useState(false);
  const baseRef = useRef(baseFontSize);
  useEffect(() => { baseRef.current = baseFontSize; }, [baseFontSize]);
  const badgeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (badgeTimer.current) clearTimeout(badgeTimer.current); }, []);

  const apply = useCallback((action: ZoomAction) => {
    setOffset((prev) => nextZoomOffset(prev, baseRef.current, action));
    setBadgeVisible(true);
    if (badgeTimer.current) clearTimeout(badgeTimer.current);
    badgeTimer.current = setTimeout(() => setBadgeVisible(false), BADGE_MS);
  }, []);

  return { fontSize: clampTerminalFontSize(baseFontSize + offset), offset, badgeVisible, apply };
}
