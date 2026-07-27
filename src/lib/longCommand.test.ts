import { describe, expect, it } from "vitest";
import { createLongCommandWatcher, formatDuration } from "./longCommand";

const OPTIONS = { thresholdMs: 10_000, quietMs: 1_500 };

describe("createLongCommandWatcher", () => {
  it("reports a command whose output ran long enough", () => {
    const w = createLongCommandWatcher(OPTIONS);
    w.submit("make -j8", 0);
    w.output(30_000);
    expect(w.poll(31_000)).toBeNull(); // still within the quiet window
    expect(w.poll(31_600)).toEqual({ command: "make -j8", durationMs: 30_000 });
  });

  it("reports only once", () => {
    const w = createLongCommandWatcher(OPTIONS);
    w.submit("make", 0);
    w.output(30_000);
    expect(w.poll(40_000)).not.toBeNull();
    expect(w.poll(50_000)).toBeNull();
  });

  it("stays quiet for a command that finished quickly", () => {
    const w = createLongCommandWatcher(OPTIONS);
    w.submit("ls", 0);
    w.output(40);
    expect(w.poll(5_000)).toBeNull();
  });

  // The case the "measure to the last output" rule exists for: an editor
  // draws its screen and then sits there. Time passes, but the command isn't
  // finished and isn't working either — reporting it would be noise.
  it("stays quiet for an editor left open and idle", () => {
    const w = createLongCommandWatcher(OPTIONS);
    w.submit("vim notes.md", 0);
    w.output(120); // draws its screen
    expect(w.poll(600_000)).toBeNull();
  });

  // ...and the case that rule must not break: something that prints
  // immediately, then works silently for a long time, then returns to a
  // prompt. The prompt is output, so the duration comes out right.
  it("reports a command that printed early then worked silently", () => {
    const w = createLongCommandWatcher(OPTIONS);
    w.submit("./deploy.sh", 0);
    w.output(50); // "Deploying..."
    expect(w.poll(10_000)).toBeNull(); // measured duration is still 50ms
    w.output(90_000); // shell prompt returns
    expect(w.poll(92_000)).toEqual({ command: "./deploy.sh", durationMs: 90_000 });
  });

  it("a command with no output at all is measured by its prompt returning", () => {
    const w = createLongCommandWatcher(OPTIONS);
    w.submit("sleep 60", 0);
    w.output(60_000);
    expect(w.poll(62_000)).toEqual({ command: "sleep 60", durationMs: 60_000 });
  });

  it("a new command replaces the pending one", () => {
    const w = createLongCommandWatcher(OPTIONS);
    w.submit("make", 0);
    w.output(30_000);
    w.submit("ls", 31_000);
    w.output(31_050);
    expect(w.poll(40_000)).toBeNull();
  });

  it("ignores a bare Enter, which runs nothing", () => {
    const w = createLongCommandWatcher(OPTIONS);
    w.submit("make", 0);
    w.output(30_000);
    w.submit("   ", 31_000);
    expect(w.poll(40_000)).toBeNull();
  });

  it("forgets everything on reset", () => {
    const w = createLongCommandWatcher(OPTIONS);
    w.submit("make", 0);
    w.output(30_000);
    w.reset();
    expect(w.poll(40_000)).toBeNull();
  });
});

describe("formatDuration", () => {
  it("formats seconds, minutes and hours", () => {
    expect(formatDuration(8_000)).toBe("8 s");
    expect(formatDuration(59_400)).toBe("59 s");
    expect(formatDuration(60_000)).toBe("1 min");
    expect(formatDuration(95_000)).toBe("1 min 35 s");
    expect(formatDuration(3_600_000)).toBe("1 h 0 min");
    expect(formatDuration(5_400_000)).toBe("1 h 30 min");
  });
});
