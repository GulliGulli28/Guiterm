import { describe, expect, it } from "vitest";
import {
  MAX_TERMINAL_FONT_SIZE,
  MIN_TERMINAL_FONT_SIZE,
  nextZoomOffset,
  zoomActionFromKey,
  zoomActionFromWheel,
} from "./terminalZoom";

/** A keydown as the terminal's own key handler sees it. `code` matters as
 * much as `key` here — that's the whole point of the layout handling. */
function key(init: { key: string; code?: string; ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean }): KeyboardEvent {
  return {
    key: init.key,
    code: init.code ?? "",
    ctrlKey: init.ctrl ?? false,
    shiftKey: init.shift ?? false,
    altKey: init.alt ?? false,
    metaKey: init.meta ?? false,
  } as KeyboardEvent;
}

describe("zoomActionFromKey", () => {
  // The layout cases this exists for. On a US layout Ctrl+"+" arrives with
  // Shift held and key "+"; on a French one the same physical key gives "="
  // unshifted. Both have to zoom in, or the shortcut works on one machine and
  // silently types into the shell on the other.
  it("zooms in on both the shifted and unshifted form of the +/= key", () => {
    expect(zoomActionFromKey(key({ key: "+", ctrl: true, shift: true }))).toBe("in");
    expect(zoomActionFromKey(key({ key: "=", ctrl: true }))).toBe("in");
  });

  it("zooms out on -, and resets on 0", () => {
    expect(zoomActionFromKey(key({ key: "-", ctrl: true }))).toBe("out");
    expect(zoomActionFromKey(key({ key: "_", ctrl: true, shift: true }))).toBe("out");
    expect(zoomActionFromKey(key({ key: "0", code: "Digit0", ctrl: true }))).toBe("reset");
  });

  // Found in the real window (`npm run test:e2e` under a French session): the
  // number row is shifted on AZERTY, so the physical 0 key reports "à" and
  // Ctrl+0 never fired at all. Reset has to match the physical key, the way
  // browsers match their own zoom-reset.
  it("resets on the physical 0 key even when that key types something else", () => {
    expect(zoomActionFromKey(key({ key: "à", code: "Digit0", ctrl: true }))).toBe("reset");
  });

  // The numpad produces the same characters, but not on every layout — match
  // its physical keys too, which are layout-independent.
  it("matches the numpad by code whatever the key character is", () => {
    expect(zoomActionFromKey(key({ key: "Add", code: "NumpadAdd", ctrl: true }))).toBe("in");
    expect(zoomActionFromKey(key({ key: "Subtract", code: "NumpadSubtract", ctrl: true }))).toBe("out");
    expect(zoomActionFromKey(key({ key: "Insert", code: "Numpad0", ctrl: true }))).toBe("reset");
  });

  it("accepts Cmd on macOS", () => {
    expect(zoomActionFromKey(key({ key: "=", meta: true }))).toBe("in");
  });

  it("ignores the same keys without Ctrl — they are just characters to type", () => {
    expect(zoomActionFromKey(key({ key: "+" }))).toBeNull();
    expect(zoomActionFromKey(key({ key: "-" }))).toBeNull();
    expect(zoomActionFromKey(key({ key: "0" }))).toBeNull();
  });

  // On Windows AltGr reports as ctrlKey+altKey. AltGr+0 types "@" on several
  // layouts — swallowing it as a zoom reset would make that character
  // impossible to type in a terminal.
  it("ignores AltGr combinations", () => {
    expect(zoomActionFromKey(key({ key: "@", code: "Digit0", ctrl: true, alt: true }))).toBeNull();
    expect(zoomActionFromKey(key({ key: "0", ctrl: true, alt: true }))).toBeNull();
  });

  it("ignores unrelated Ctrl combinations, which belong to the shell", () => {
    for (const k of ["c", "d", "r", "l", "1", "9"]) {
      expect(zoomActionFromKey(key({ key: k, ctrl: true }))).toBeNull();
    }
  });
});

describe("zoomActionFromWheel", () => {
  it("maps Ctrl+wheel to a zoom step, by direction", () => {
    expect(zoomActionFromWheel({ ctrlKey: true, metaKey: false, deltaY: -120 } as WheelEvent)).toBe("in");
    expect(zoomActionFromWheel({ ctrlKey: true, metaKey: false, deltaY: 120 } as WheelEvent)).toBe("out");
  });

  it("leaves a plain wheel alone — that's scrollback", () => {
    expect(zoomActionFromWheel({ ctrlKey: false, metaKey: false, deltaY: -120 } as WheelEvent)).toBeNull();
  });

  // Trackpads emit 0-delta events; they must not count as a zoom step in
  // either direction.
  it("ignores a wheel event with no movement", () => {
    expect(zoomActionFromWheel({ ctrlKey: true, metaKey: false, deltaY: 0 } as WheelEvent)).toBeNull();
  });
});

describe("nextZoomOffset", () => {
  it("steps one pixel at a time, in both directions", () => {
    expect(nextZoomOffset(0, 14, "in")).toBe(1);
    expect(nextZoomOffset(1, 14, "in")).toBe(2);
    expect(nextZoomOffset(2, 14, "out")).toBe(1);
  });

  it("returns to the configured size on reset", () => {
    expect(nextZoomOffset(7, 14, "reset")).toBe(0);
    expect(nextZoomOffset(-5, 14, "reset")).toBe(0);
  });

  // The offset must saturate rather than keep growing past the bounds:
  // otherwise a few seconds of held Ctrl+"+" builds an offset of +200, and
  // the first dozen Ctrl+"-" afterwards appear to do nothing at all.
  it("saturates instead of drifting past the bounds", () => {
    let offset = 0;
    for (let i = 0; i < 200; i++) offset = nextZoomOffset(offset, 14, "in");
    expect(14 + offset).toBe(MAX_TERMINAL_FONT_SIZE);
    // One step back must be immediately visible.
    expect(14 + nextZoomOffset(offset, 14, "out")).toBe(MAX_TERMINAL_FONT_SIZE - 1);

    offset = 0;
    for (let i = 0; i < 200; i++) offset = nextZoomOffset(offset, 14, "out");
    expect(14 + offset).toBe(MIN_TERMINAL_FONT_SIZE);
    expect(14 + nextZoomOffset(offset, 14, "in")).toBe(MIN_TERMINAL_FONT_SIZE + 1);
  });
});
