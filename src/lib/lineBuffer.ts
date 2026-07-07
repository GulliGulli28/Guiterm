// Shadows the keystrokes a local terminal sends to its PTY so we can guess
// the text of the line currently being typed, without any help from the
// shell (which only ever gives us back raw echoed bytes). This is
// necessarily best-effort: any interaction we can't model precisely (shell
// tab-completion, Ctrl+R history search, Up/Down history navigation, or any
// other unrecognized control sequence) marks the buffer as "desynced" for
// the rest of the line — we stop guessing rather than risk tracking garbage,
// and resync cleanly on the next Enter/Ctrl+C.

export interface LineBufferState {
  text: string;
  cursor: number;
  desynced: boolean;
}

export const INITIAL_LINE_BUFFER: LineBufferState = { text: "", cursor: 0, desynced: false };

export interface ApplyInputResult {
  next: LineBufferState;
  submitted: string[];
}

export function applyInput(state: LineBufferState, data: string): ApplyInputResult {
  let text = state.text;
  let cursor = state.cursor;
  let desynced = state.desynced;
  const submitted: string[] = [];

  let i = 0;
  while (i < data.length) {
    const ch = data[i];

    if (ch === "\r" || ch === "\n") {
      if (!desynced) {
        const trimmed = text.trim();
        if (trimmed.length > 0) submitted.push(trimmed);
      }
      text = "";
      cursor = 0;
      desynced = false;
      i += 1;
      continue;
    }

    if (ch === "\x03") {
      // Ctrl+C: the shell aborts the current line without running it.
      text = "";
      cursor = 0;
      desynced = false;
      i += 1;
      continue;
    }

    if (desynced) {
      i += 1;
      continue;
    }

    if (ch === "\x7f" || ch === "\b") {
      if (cursor > 0) {
        text = text.slice(0, cursor - 1) + text.slice(cursor);
        cursor -= 1;
      }
      i += 1;
      continue;
    }

    if (ch === "\x15") {
      // Ctrl+U: kill from the start of the line to the cursor.
      text = text.slice(cursor);
      cursor = 0;
      i += 1;
      continue;
    }

    if (ch === "\x17") {
      // Ctrl+W: delete the word before the cursor.
      let start = cursor;
      while (start > 0 && text[start - 1] === " ") start -= 1;
      while (start > 0 && text[start - 1] !== " ") start -= 1;
      text = text.slice(0, start) + text.slice(cursor);
      cursor = start;
      i += 1;
      continue;
    }

    if (ch === "\x1b") {
      const seq = data.slice(i, i + 3);
      if (seq === "\x1b[C") {
        cursor = Math.min(cursor + 1, text.length);
        i += 3;
        continue;
      }
      if (seq === "\x1b[D") {
        cursor = Math.max(cursor - 1, 0);
        i += 3;
        continue;
      }
      if (seq === "\x1b[H" || seq === "\x1bOH") {
        cursor = 0;
        i += 3;
        continue;
      }
      if (seq === "\x1b[F" || seq === "\x1bOF") {
        cursor = text.length;
        i += 3;
        continue;
      }
      // Up/Down (shell history navigation) or anything else: we can't know
      // what the shell will do to the line, so give up on this one.
      desynced = true;
      i += 1;
      continue;
    }

    if (ch === "\x0c") {
      // Ctrl+L: the shell clears the screen and redraws the prompt, but the
      // line content itself is untouched — no reason to lose track of it.
      i += 1;
      continue;
    }

    if (ch === "\t" || ch.charCodeAt(0) < 0x20) {
      // Tab (shell-side completion), Ctrl+R, Ctrl+D, etc.
      desynced = true;
      i += 1;
      continue;
    }

    let end = i + 1;
    while (end < data.length && data.charCodeAt(end) >= 0x20 && data[end] !== "\x7f") {
      end += 1;
    }
    const run = data.slice(i, end);
    text = text.slice(0, cursor) + run + text.slice(cursor);
    cursor += run.length;
    i = end;
  }

  return { next: { text, cursor, desynced }, submitted };
}

/** Most recent history entry that extends the current line, fish-style. */
export function findSuggestion(history: string[], buffer: LineBufferState): string | null {
  if (buffer.desynced || buffer.text.length === 0 || buffer.cursor !== buffer.text.length) {
    return null;
  }
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const entry = history[i];
    if (entry !== buffer.text && entry.startsWith(buffer.text)) {
      return entry.slice(buffer.text.length);
    }
  }
  return null;
}
