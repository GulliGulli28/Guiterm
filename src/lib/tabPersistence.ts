import type { TabMeta } from "./types";

export const STORAGE_KEY = "gui-termius-tabs";

export interface PersistedTab {
  kind: TabMeta["kind"];
  label: string;
  hostId?: string;
  dockerContainerId?: string;
  k8sPodName?: string;
  k8sContainerName?: string | null;
  shell?: string | null;
}

/** Persists only enough to redraw placeholder tabs — never a live session id. */
export function saveTabs(tabs: TabMeta[]): void {
  const trimmed: PersistedTab[] = tabs.map((t) => {
    const isRemote = t.kind === "terminal" || t.kind === "transfer";
    return {
      kind: t.kind,
      label: t.label,
      hostId: isRemote ? t.hostId : undefined,
      dockerContainerId: isRemote ? t.dockerContainerId : undefined,
      k8sPodName: isRemote ? t.k8sPodName : undefined,
      k8sContainerName: isRemote ? t.k8sContainerName : undefined,
      shell: t.kind === "local-terminal" ? t.shell : undefined,
    };
  });
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
  } catch { /* ignore */ }
}

export function loadTabs(): PersistedTab[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    }
  } catch { /* ignore */ }
  return [];
}
