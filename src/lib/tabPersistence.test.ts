import { beforeEach, describe, expect, it } from "vitest";
import { loadTabs, saveTabs, STORAGE_KEY } from "./tabPersistence";
import type { TabMeta } from "./types";

// The project's vitest environment is "node" (vite.config.ts), not jsdom —
// no browser globals. A tiny in-memory stub is enough for tabPersistence's
// getItem/setItem-only usage, without pulling in jsdom as a dependency.
class MemoryStorage implements Storage {
  private store = new Map<string, string>();
  get length() { return this.store.size; }
  clear() { this.store.clear(); }
  getItem(key: string) { return this.store.has(key) ? this.store.get(key)! : null; }
  key(index: number) { return [...this.store.keys()][index] ?? null; }
  removeItem(key: string) { this.store.delete(key); }
  setItem(key: string, value: string) { this.store.set(key, value); }
}
globalThis.localStorage = new MemoryStorage();

describe("tabPersistence", () => {
  beforeEach(() => localStorage.clear());

  it("round-trips a terminal tab, keeping hostId and dockerContainerId", () => {
    const tabs: TabMeta[] = [
      { id: "t1", kind: "terminal", label: "web1", hostId: "h1", dockerContainerId: "c1" },
    ];
    saveTabs(tabs);
    expect(loadTabs()).toEqual([
      { kind: "terminal", label: "web1", hostId: "h1", dockerContainerId: "c1", shell: undefined },
    ]);
  });

  it("drops hostId/dockerContainerId for a local-terminal tab but keeps shell", () => {
    const tabs: TabMeta[] = [
      { id: "t2", kind: "local-terminal", label: "bash", shell: "/bin/zsh" },
    ];
    saveTabs(tabs);
    const [loaded] = loadTabs();
    expect(loaded.hostId).toBeUndefined();
    expect(loaded.dockerContainerId).toBeUndefined();
    expect(loaded.shell).toBe("/bin/zsh");
  });

  it("returns [] when localStorage is empty", () => {
    expect(loadTabs()).toEqual([]);
  });

  it("returns [] when localStorage contains invalid JSON, without throwing", () => {
    localStorage.setItem(STORAGE_KEY, "{not valid json");
    expect(() => loadTabs()).not.toThrow();
    expect(loadTabs()).toEqual([]);
  });

  it("returns [] when localStorage contains valid JSON that isn't an array", () => {
    localStorage.setItem(STORAGE_KEY, "{}");
    expect(loadTabs()).toEqual([]);
  });
});
