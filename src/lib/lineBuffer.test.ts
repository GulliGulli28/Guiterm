import { describe, expect, it } from "vitest";
import { applyInput, findSuggestion, INITIAL_LINE_BUFFER, type LineBufferState } from "./lineBuffer";

function apply(state: LineBufferState, ...chunks: string[]) {
  let current = state;
  const submitted: string[] = [];
  for (const chunk of chunks) {
    const result = applyInput(current, chunk);
    current = result.next;
    submitted.push(...result.submitted);
  }
  return { next: current, submitted };
}

describe("applyInput", () => {
  it("tracks plain typed characters with the cursor at the end", () => {
    const { next } = apply(INITIAL_LINE_BUFFER, "g", "i", "t");
    expect(next).toEqual({ text: "git", cursor: 3, desynced: false });
  });

  it("handles a whole run of characters delivered in one onData call (paste, fast typing)", () => {
    const { next } = apply(INITIAL_LINE_BUFFER, "git status");
    expect(next).toEqual({ text: "git status", cursor: 10, desynced: false });
  });

  it("submits the trimmed line on Enter and resets the buffer", () => {
    const { next, submitted } = apply(INITIAL_LINE_BUFFER, "git status", "\r");
    expect(submitted).toEqual(["git status"]);
    expect(next).toEqual(INITIAL_LINE_BUFFER);
  });

  it("handles a batch that mixes a printable char with a trailing Enter (fast typing over one onData call)", () => {
    const { next, submitted } = apply(INITIAL_LINE_BUFFER, "gi", "t\r");
    expect(submitted).toEqual(["git"]);
    expect(next).toEqual(INITIAL_LINE_BUFFER);
  });

  it("does not submit an empty or whitespace-only line", () => {
    const { submitted: s1 } = apply(INITIAL_LINE_BUFFER, "\r");
    expect(s1).toEqual([]);
    const { submitted: s2 } = apply(INITIAL_LINE_BUFFER, "   ", "\r");
    expect(s2).toEqual([]);
  });

  it("backspace removes the character before the cursor", () => {
    const { next } = apply(INITIAL_LINE_BUFFER, "gti", "\x7f\x7f", "it");
    expect(next).toEqual({ text: "git", cursor: 3, desynced: false });
  });

  it("Ctrl+C aborts the line without submitting it", () => {
    const { next, submitted } = apply(INITIAL_LINE_BUFFER, "git statu", "\x03");
    expect(submitted).toEqual([]);
    expect(next).toEqual(INITIAL_LINE_BUFFER);
  });

  it("Ctrl+U kills from the start of the line to the cursor", () => {
    const { next } = apply(INITIAL_LINE_BUFFER, "git status", "\x15");
    expect(next).toEqual({ text: "", cursor: 0, desynced: false });
  });

  it("Ctrl+W deletes the word before the cursor", () => {
    const { next } = apply(INITIAL_LINE_BUFFER, "git status", "\x17");
    expect(next).toEqual({ text: "git ", cursor: 4, desynced: false });
  });

  it("Left/Right arrows move the cursor without touching the text", () => {
    const { next } = apply(INITIAL_LINE_BUFFER, "git", "\x1b[D", "\x1b[D");
    expect(next).toEqual({ text: "git", cursor: 1, desynced: false });
  });

  it("Ctrl+L does not desync — clear-screen never touches the line", () => {
    const { next } = apply(INITIAL_LINE_BUFFER, "git status", "\x0c");
    expect(next).toEqual({ text: "git status", cursor: 10, desynced: false });
  });

  it("desyncs on Tab (shell-side completion) and resyncs cleanly on the next Enter", () => {
    const afterTab = apply(INITIAL_LINE_BUFFER, "gi", "\t");
    expect(afterTab.next.desynced).toBe(true);
    // Further typing while desynced is ignored rather than compounding garbage.
    const stillDesynced = apply(afterTab.next, "t status");
    expect(stillDesynced.next).toEqual({ text: "gi", cursor: 2, desynced: true });
    const { next, submitted } = apply(stillDesynced.next, "\r");
    expect(submitted).toEqual([]);
    expect(next).toEqual(INITIAL_LINE_BUFFER);
  });

  it("desyncs on Up/Down (shell history navigation)", () => {
    const { next } = apply(INITIAL_LINE_BUFFER, "gi", "\x1b[A");
    expect(next.desynced).toBe(true);
  });
});

describe("findSuggestion", () => {
  const history = ["ls -la", "git status", "git status --short", "npm run build"];

  it("suggests the tail of the most recent matching history entry", () => {
    const buf: LineBufferState = { text: "git s", cursor: 5, desynced: false };
    expect(findSuggestion(history, buf)).toBe("tatus --short");
  });

  it("returns null when the buffer is empty", () => {
    expect(findSuggestion(history, INITIAL_LINE_BUFFER)).toBeNull();
  });

  it("returns null when the cursor isn't at the end of the line", () => {
    const buf: LineBufferState = { text: "git s", cursor: 2, desynced: false };
    expect(findSuggestion(history, buf)).toBeNull();
  });

  it("returns null while desynced", () => {
    const buf: LineBufferState = { text: "git s", cursor: 5, desynced: true };
    expect(findSuggestion(history, buf)).toBeNull();
  });

  it("returns null when the buffer already equals the only matching entry", () => {
    const buf: LineBufferState = { text: "ls -la", cursor: 6, desynced: false };
    expect(findSuggestion(history, buf)).toBeNull();
  });

  it("returns null when nothing matches", () => {
    const buf: LineBufferState = { text: "docker ", cursor: 7, desynced: false };
    expect(findSuggestion(history, buf)).toBeNull();
  });
});
