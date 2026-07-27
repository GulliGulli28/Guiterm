/** Noticing that a long-running command has finished, so the user can go do
 * something else and be told when to come back.
 *
 * **This is a heuristic, and it has to be.** Knowing precisely when a command
 * starts and ends requires the shell to say so (OSC 133 semantic prompts),
 * which no shell emits unless it has been configured to. What is observable
 * from here is: the user pressed Enter, then output arrived, then it stopped.
 *
 * So a command is considered finished once its output has been quiet for
 * `quietMs`, and its duration is measured up to the *last output*, not up to
 * the moment of noticing — the shell prints its prompt when the command
 * returns, so the last byte is a good proxy for the end.
 *
 * That measure is what keeps the obvious false positives out, without any
 * special-casing:
 * - `vim`/`less` opened and left idle: output stops right after it draws, so
 *   the measured duration is near zero and stays below the threshold.
 * - `sleep 60`: no output until the prompt comes back, so the duration comes
 *   out around 60s, which is right.
 * - a build that prints continuously: last output is at the end, also right.
 *
 * A pending command is deliberately *not* cleared when it turns out too short
 * to report — it stays armed until it either fires or is replaced by the next
 * Enter. Clearing early would miss the case of a command that prints
 * something immediately and then works silently for a long time.
 */
export interface LongCommandOptions {
  /** Below this, finishing isn't worth a notification. */
  thresholdMs: number;
  /** Silence after which output is considered over. */
  quietMs: number;
}

export interface PendingCommand {
  command: string;
  startedAt: number;
  lastOutputAt: number;
  /** Set once reported, so polling again doesn't report it twice. */
  reported: boolean;
}

export interface LongCommandWatcher {
  /** The user pressed Enter on `command`. Replaces any pending one. */
  submit(command: string, now: number): void;
  /** Output arrived from the session. */
  output(now: number): void;
  /** Returns the command to report, or `null`. Call periodically. */
  poll(now: number): { command: string; durationMs: number } | null;
  /** Nothing to watch any more (session closed). */
  reset(): void;
}

export function createLongCommandWatcher({ thresholdMs, quietMs }: LongCommandOptions): LongCommandWatcher {
  let pending: PendingCommand | null = null;

  return {
    submit(command, now) {
      const trimmed = command.trim();
      // An empty Enter just redraws the prompt; nothing ran.
      pending = trimmed ? { command: trimmed, startedAt: now, lastOutputAt: now, reported: false } : null;
    },
    output(now) {
      if (pending && !pending.reported) pending.lastOutputAt = now;
    },
    poll(now) {
      if (!pending || pending.reported) return null;
      if (now - pending.lastOutputAt < quietMs) return null;
      const durationMs = pending.lastOutputAt - pending.startedAt;
      if (durationMs < thresholdMs) return null;
      pending.reported = true;
      return { command: pending.command, durationMs };
    },
    reset() {
      pending = null;
    },
  };
}

/** `95000` → `"1 min 35 s"`, `8000` → `"8 s"` — a notification reads better
 * with a rounded duration than with milliseconds. */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds} s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds ? `${minutes} min ${seconds} s` : `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h ${minutes % 60} min`;
}
