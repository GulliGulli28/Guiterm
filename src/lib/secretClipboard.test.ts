import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { copySecret } from "./secretClipboard";

function fakeClipboard() {
  const state = { text: "" };
  return {
    state,
    io: {
      write: async (t: string) => { state.text = t; },
      read: async () => state.text,
      clear: async () => { state.text = ""; },
    },
  };
}

describe("copySecret", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("efface le secret à l'échéance s'il est encore dans le presse-papiers", async () => {
    const { state, io } = fakeClipboard();
    await copySecret("s3cret", io, 1000);
    expect(state.text).toBe("s3cret");
    await vi.advanceTimersByTimeAsync(999);
    expect(state.text).toBe("s3cret");
    await vi.advanceTimersByTimeAsync(1);
    expect(state.text).toBe("");
  });

  it("ne touche pas à ce que l'utilisateur a copié entre-temps", async () => {
    const { state, io } = fakeClipboard();
    await copySecret("s3cret", io, 1000);
    state.text = "autre chose";
    await vi.advanceTimersByTimeAsync(1000);
    expect(state.text).toBe("autre chose");
  });

  it("une seconde copie remplace la minuterie de la première", async () => {
    const { state, io } = fakeClipboard();
    await copySecret("un", io, 1000);
    await vi.advanceTimersByTimeAsync(600);
    await copySecret("deux", io, 1000);
    await vi.advanceTimersByTimeAsync(600);
    // La première échéance ne doit pas effacer la seconde copie.
    expect(state.text).toBe("deux");
    await vi.advanceTimersByTimeAsync(400);
    expect(state.text).toBe("");
  });
});
