import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { api } from "../lib/api";
import { runOnTerminalHandle } from "../lib/runOnTerminalHandle";
import type { Host, HostId, SqlConnection, TabMeta, Workspace } from "../lib/types";
import type { AppPreferences } from "../lib/preferences";
import type { NotificationKind } from "../lib/notifications";
import { loadTabs, saveTabs } from "../lib/tabPersistence";
import type { TerminalTabHandle } from "../components/TerminalTab";

let nextTabId = 0;

interface UseTabsParams {
  workspace: Workspace | null;
  preferences: AppPreferences;
  terminalRefs: RefObject<Map<string, TerminalTabHandle>>;
  pushNotification: (kind: NotificationKind, message: string) => void;
  reportError: (message: string) => void;
  refreshWorkspace: (next: Workspace) => void;
}

/** Tab list + connection lifecycle (open/close/reconnect, running a snippet
 * on one or more tabs, exporting scrollback), extracted from App.tsx. Needs
 * workspace/preferences/notifications passed in — this doesn't reduce
 * coupling, just gives the tab-management logic a name and its own file. */
export function useTabs({ workspace, preferences, terminalRefs, pushNotification, reportError, refreshWorkspace }: UseTabsParams) {
  const [tabs, setTabs] = useState<TabMeta[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);

  const openTab = useCallback((kind: "terminal" | "transfer" | "rdp-view", host: Host, dockerContainerId?: string, k8sPodName?: string, k8sContainerName?: string | null) => {
    const id = `tab-${nextTabId++}`;
    const label = kind === "transfer"
      ? `Transfert : ${host.label}`
      : kind === "rdp-view"
        ? `Aperçu : ${host.label}`
        : dockerContainerId
          ? `${host.label} : ${dockerContainerId}`
          : k8sPodName
            ? `${host.label} : ${k8sPodName}`
            : host.label;
    setTabs((prev) => [...prev, { id, kind, hostId: host.id, label, dockerContainerId, k8sPodName, k8sContainerName }]);
    setActiveTabId(id);
  }, []);

  const openLocalTerminal = useCallback((initialCommand?: string, shell?: string | null) => {
    const id = `tab-${nextTabId++}`;
    const label = initialCommand ? `ssh ${initialCommand.replace(/^ssh\s+/, "")}` : "Terminal local";
    setTabs((prev) => [...prev, { id, kind: "local-terminal", label, initialCommand, shell: shell ?? preferences.defaultLocalShell }]);
    setActiveTabId(id);
  }, [preferences.defaultLocalShell]);

  // Only one Fleet tab makes sense at a time (it isn't host-scoped like a
  // terminal/transfer tab) — focus the existing one instead of piling up
  // duplicates when opened repeatedly from the toolbar button.
  const openFleet = useCallback(() => {
    setTabs((prev) => {
      const existing = prev.find((t) => t.kind === "fleet");
      if (existing) {
        setActiveTabId(existing.id);
        return prev;
      }
      const id = `tab-${nextTabId++}`;
      setActiveTabId(id);
      return [...prev, { id, kind: "fleet", label: "Opérations de flotte" }];
    });
  }, []);

  // One tab per SQL connection — reopening an already-open connection just
  // focuses it, same idea as `openFleet`'s single-tab dedup (there, a global
  // singleton; here, keyed per connection so different connections can each
  // have their own tab).
  const openSql = useCallback((conn: SqlConnection) => {
    setTabs((prev) => {
      const existing = prev.find((t) => t.kind === "sql" && t.sqlConnectionId === conn.id);
      if (existing) {
        setActiveTabId(existing.id);
        return prev;
      }
      const id = `tab-${nextTabId++}`;
      setActiveTabId(id);
      return [...prev, { id, kind: "sql", label: conn.label, sqlConnectionId: conn.id }];
    });
  }, []);

  const reconnectTab = useCallback((id: string) => {
    setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, status: "connected" } : t)));
  }, []);

  // Restore the last session's tab list (as disconnected placeholders) once, right after
  // the workspace loads. Never auto-reconnects — the user clicks a placeholder to do that.
  const restoredTabsRef = useRef(false);
  useEffect(() => {
    if (!workspace || restoredTabsRef.current) return;
    restoredTabsRef.current = true;
    if (!preferences.restoreTabsOnLaunch) return;
    const persisted = loadTabs();
    const restored: TabMeta[] = persisted.flatMap((p): TabMeta[] => {
      const id = `tab-${nextTabId++}`;
      if (p.kind === "local-terminal") {
        return [{ id, kind: "local-terminal", label: p.label, status: "placeholder", shell: p.shell }];
      }
      // "fleet"/"sql" tabs are deliberately never restored (a fleet run and
      // a SQL session are both point-in-time things, not something to
      // silently reopen) — narrowed explicitly rather than just falling
      // through the `!p.hostId` check below, which happened to reject them
      // too but for the wrong (accidental) reason and didn't type-check
      // once a second no-`hostId` kind ("sql") joined "fleet".
      if (p.kind !== "terminal" && p.kind !== "transfer" && p.kind !== "rdp-view") return [];
      if (!p.hostId || !workspace.hosts.some((h) => h.id === p.hostId)) return [];
      return [{
        id, kind: p.kind, hostId: p.hostId, label: p.label, status: "placeholder",
        dockerContainerId: p.dockerContainerId, k8sPodName: p.k8sPodName, k8sContainerName: p.k8sContainerName,
      }];
    });
    if (restored.length > 0) {
      setTabs(restored);
      setActiveTabId(restored[0].id);
    }
  }, [workspace, preferences.restoreTabsOnLaunch]);

  // Persist the (trimmed, session-less) tab list on every change, once the initial
  // restore pass above has already run.
  useEffect(() => {
    if (!restoredTabsRef.current || !preferences.restoreTabsOnLaunch) return;
    saveTabs(tabs);
  }, [tabs, preferences.restoreTabsOnLaunch]);

  const closeTab = useCallback((id: string, reason?: "disconnected") => {
    terminalRefs.current.get(id)?.dispose();
    terminalRefs.current.delete(id);
    setTabs((prev) => {
      const closed = prev.find((t) => t.id === id);
      if (reason === "disconnected" && closed && preferences.notifyOnDisconnect !== false) {
        pushNotification("error", `Connexion perdue : ${closed.label}`);
      }
      const next = prev.filter((t) => t.id !== id);
      setActiveTabId((current) => (current === id ? (next.length > 0 ? next[next.length - 1].id : null) : current));
      return next;
    });
  }, [preferences.notifyOnDisconnect, pushNotification, terminalRefs]);

  // Closing a tab with a live SSH session is easy to trigger by accident (a stray
  // Ctrl+Shift+W, a misclick) and kills the remote session outright, so it goes
  // through a confirmation instead of closing immediately.
  const [pendingCloseTabId, setPendingCloseTabId] = useState<string | null>(null);
  const requestCloseTab = useCallback((id: string) => {
    const tab = tabs.find((t) => t.id === id);
    if (tab && tab.kind === "terminal" && tab.status !== "placeholder") {
      setPendingCloseTabId(id);
    } else {
      closeTab(id);
    }
  }, [tabs, closeTab]);

  // Runs a snippet/script on specific tabs, or the active tab when no target is given
  // (e.g. from the Snippets panel, where an empty selection means "just the active tab").
  const runSnippet = useCallback((command: string, targetTabIds?: string[]) => {
    const ids = targetTabIds && targetTabIds.length > 0 ? targetTabIds : activeTabId ? [activeTabId] : [];
    if (ids.length === 0) { reportError("Aucun terminal actif pour exécuter ce snippet"); return; }
    let ran = false;
    for (const id of ids) {
      const handle = terminalRefs.current.get(id);
      if (handle) { runOnTerminalHandle(handle, command, tabs.find((t) => t.id === id)?.kind !== "rdp-view"); ran = true; }
    }
    if (!ran) reportError("Aucun terminal ouvert pour exécuter ce snippet");
  }, [activeTabId, reportError, tabs, terminalRefs]);

  // Runs an adaptive (DSL) snippet on specific tabs, or the active tab when
  // no target is given — same convention as `runSnippet`. Unlike a classic
  // snippet, `programText` isn't a runnable command by itself: each target's
  // platform determines what actually gets typed (see `core::adaptive`), so
  // this resolves per target before running the *translated* command.
  // Four kinds of target are supported, each with its own way of finding
  // out "what platform is this": an SSH host's last collected facts
  // (batched through `previewAdaptiveProgram`, collecting first if missing —
  // same as `FleetTab`'s "Prévisualiser"), a Docker exec container or K8s
  // exec pod/container (probed fresh via `composeAdaptiveForDocker`/
  // `composeAdaptiveForK8s`, one call per target — no facts to reuse across
  // calls, neither a `dockerExec` nor a `k8sExec` host is tied to one
  // container/pod), or a local terminal's shell (`composeAdaptiveForLocal` —
  // instant for a native Windows shell, probed locally otherwise). RDP and
  // anything else is reported and skipped rather than silently typing the
  // raw DSL text.
  const runAdaptiveSnippet = useCallback(async (programText: string, targetTabIds?: string[]) => {
    if (!workspace) return;
    const ids = targetTabIds && targetTabIds.length > 0 ? targetTabIds : activeTabId ? [activeTabId] : [];
    if (ids.length === 0) { reportError("Aucun terminal actif pour exécuter ce snippet"); return; }

    const runTranslated = (label: string, handle: TerminalTabHandle, result: { command: string | null; note: string | null }) => {
      if (!result.command) { reportError(`« ${label} » : ${result.note ?? "rien à exécuter pour cet hôte"}`); return; }
      runOnTerminalHandle(handle, result.command, true);
    };

    const sshTargets: { label: string; hostId: HostId; handle: TerminalTabHandle }[] = [];
    for (const id of ids) {
      const tab = tabs.find((t) => t.id === id);
      const handle = terminalRefs.current.get(id);
      if (!tab || !handle) continue;

      if (tab.kind === "local-terminal") {
        api.composeAdaptiveForLocal(programText, tab.shell ?? null)
          .then((result) => runTranslated(tab.label, handle, result))
          .catch((e) => reportError(String(e)));
        continue;
      }

      const ineligible = () => reportError(`« ${tab.label} » : un snippet adaptatif ne peut s'exécuter que sur un terminal local, un hôte SSH, Docker exec ou K8s exec`);
      if (tab.kind !== "terminal") { ineligible(); continue; }
      const host = workspace.hosts.find((h) => h.id === tab.hostId);
      if (!host) { ineligible(); continue; }

      if (host.kind === "dockerExec") {
        if (!tab.dockerContainerId) { reportError(`« ${tab.label} » : aucun conteneur associé à cet onglet`); continue; }
        api.composeAdaptiveForDocker(programText, host.id, tab.dockerContainerId)
          .then((result) => runTranslated(tab.label, handle, result))
          .catch((e) => reportError(String(e)));
        continue;
      }
      if (host.kind === "k8sExec") {
        if (!tab.k8sPodName) { reportError(`« ${tab.label} » : aucun pod associé à cet onglet`); continue; }
        api.composeAdaptiveForK8s(programText, host.id, tab.k8sPodName, tab.k8sContainerName ?? null)
          .then((result) => runTranslated(tab.label, handle, result))
          .catch((e) => reportError(String(e)));
        continue;
      }
      if (host.kind !== "ssh") { ineligible(); continue; }
      sshTargets.push({ label: tab.label, hostId: host.id, handle });
    }
    if (sshTargets.length === 0) return;

    const missingFacts = [...new Set(sshTargets.filter((e) => !workspace.hosts.find((h) => h.id === e.hostId)?.lastFacts).map((e) => e.hostId))];
    if (missingFacts.length > 0) {
      try {
        refreshWorkspace((await api.collectFacts(missingFacts)).workspace);
      } catch (e) {
        reportError(String(e));
      }
    }

    try {
      const groups = await api.previewAdaptiveProgram([...new Set(sshTargets.map((e) => e.hostId))], programText);
      const groupByHost = new Map(groups.flatMap((g) => g.hostIds.map((id) => [id, g] as const)));
      for (const target of sshTargets) {
        runTranslated(target.label, target.handle, groupByHost.get(target.hostId) ?? { command: null, note: "rien à exécuter pour cet hôte" });
      }
    } catch (e) {
      reportError(String(e));
    }
  }, [activeTabId, tabs, workspace, reportError, refreshWorkspace, terminalRefs]);

  const exportActiveScrollback = useCallback(async () => {
    if (!activeTabId) { reportError("Aucun terminal actif à exporter"); return; }
    const handle = terminalRefs.current.get(activeTabId);
    if (!handle) { reportError("L'onglet actif n'est pas un terminal"); return; }
    const tabLabel = tabs.find((t) => t.id === activeTabId)?.label ?? "terminal";
    const path = await save({
      defaultPath: `${tabLabel.replace(/[^\w.-]+/g, "_")}.log`,
      filters: [{ name: "Journal", extensions: ["log", "txt"] }],
    }).catch(() => null);
    if (!path) return;
    api.exportText(path, handle.getScrollbackText()).catch((e) => reportError(String(e)));
  }, [activeTabId, tabs, reportError, terminalRefs]);

  return {
    tabs, setTabs, activeTabId, setActiveTabId,
    pendingCloseTabId, setPendingCloseTabId,
    openTab, openLocalTerminal, openFleet, openSql, reconnectTab,
    closeTab, requestCloseTab,
    runSnippet, runAdaptiveSnippet, exportActiveScrollback,
  };
}
