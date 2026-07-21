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
      {
        kind: "terminal", label: "web1", hostId: "h1", dockerContainerId: "c1",
        k8sPodName: undefined, k8sContainerName: undefined, shell: undefined,
      },
    ]);
  });

  it("round-trips a terminal tab's k8sPodName/k8sContainerName", () => {
    const tabs: TabMeta[] = [
      { id: "t1", kind: "terminal", label: "api", hostId: "h1", k8sPodName: "api-7d9f8b6c-x2kq9", k8sContainerName: "app" },
    ];
    saveTabs(tabs);
    const [loaded] = loadTabs();
    expect(loaded.k8sPodName).toBe("api-7d9f8b6c-x2kq9");
    expect(loaded.k8sContainerName).toBe("app");
  });

  it("round-trips a transfer tab's dockerContainerId and k8sPodName (not just terminal tabs)", () => {
    const tabs: TabMeta[] = [
      { id: "t1", kind: "transfer", label: "web1", hostId: "h1", dockerContainerId: "c1" },
      { id: "t2", kind: "transfer", label: "api", hostId: "h2", k8sPodName: "api-7d9f8b6c-x2kq9", k8sContainerName: null },
    ];
    saveTabs(tabs);
    const [dockerLoaded, k8sLoaded] = loadTabs();
    expect(dockerLoaded.dockerContainerId).toBe("c1");
    expect(k8sLoaded.k8sPodName).toBe("api-7d9f8b6c-x2kq9");
    expect(k8sLoaded.k8sContainerName).toBeNull();
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
