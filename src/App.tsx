import { useCallback, useEffect, useRef, useState } from "react";
import { check as checkForUpdate } from "@tauri-apps/plugin-updater";
import { api, bytesToBase64 } from "./lib/api";
import type { GroupId, Host, TabMeta, Workspace } from "./lib/types";
import { Sidebar, type SidebarPanelKind } from "./components/Sidebar";
import { HostForm } from "./components/HostForm";
import { TabBar } from "./components/TabBar";
import { BroadcastBar } from "./components/BroadcastBar";
import { TerminalTab, type TerminalTabHandle } from "./components/TerminalTab";
import { LocalTerminalTab } from "./components/LocalTerminalTab";
import { TransferTab } from "./components/TransferTab";
import { TitleBar } from "./components/TitleBar";
import { type AppPreferences, ACCENT_COLORS, BG_THEMES, loadPreferences, savePreferences } from "./lib/preferences";
import { SplitPane } from "./components/SplitPane";
import { GroupForm, type GroupFormData } from "./components/GroupForm";
import { IconTerminal, IconClose } from "./components/ui-icons";
import { type AppNotification, type NotificationKind, createNotification } from "./lib/notifications";
import { CommandPalette, type PaletteCommand } from "./components/CommandPalette";
import { SHORTCUT_ACTIONS, useGlobalShortcuts } from "./lib/shortcuts";
import { loadTabs, saveTabs } from "./lib/tabPersistence";

let nextTabId = 0;

function runOnTerminalHandle(handle: TerminalTabHandle, command: string) {
  if (command.includes("\n")) {
    // Encode script as base64 and decode+execute in one line so the terminal
    // only shows a compact command, not the full script content.
    const b64 = bytesToBase64(new TextEncoder().encode(command));
    handle.runCommand(`echo '${b64}' | base64 -d | bash`);
  } else {
    handle.runCommand(command);
  }
}

export default function App() {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [sidebarPanel, setSidebarPanel] = useState<SidebarPanelKind>("hosts");
  const [editingHost, setEditingHost] = useState<Host | "new" | null>(null);
  const [editingGroup, setEditingGroup] = useState<GroupFormData | null>(null);
  const [newHostDefaultGroupId, setNewHostDefaultGroupId] = useState<GroupId | null>(null);
  const [tabs, setTabs] = useState<TabMeta[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [preferences, setPreferences] = useState<AppPreferences>(loadPreferences);
  const [splitOpen, setSplitOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const terminalRefs = useRef<Map<string, TerminalTabHandle>>(new Map());

  // ── Resizable panels ─────────────────────────────────────────────────────
  const [sidebarWidth, setSidebarWidth] = useState(320);
  const [rightPanelWidth, setRightPanelWidth] = useState(420);
  const [splitPercent, setSplitPercent] = useState(50);
  const [isDragging, setIsDragging] = useState(false);
  const sidebarDragData = useRef<{ startX: number; startWidth: number } | null>(null);
  const rightDragData = useRef<{ startX: number; startWidth: number } | null>(null);
  const splitDragData = useRef<{ startX: number; startPercent: number; containerWidth: number } | null>(null);
  const splitContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (sidebarDragData.current) {
        const delta = e.clientX - sidebarDragData.current.startX;
        setSidebarWidth(Math.max(240, Math.min(600, sidebarDragData.current.startWidth + delta)));
      }
      if (rightDragData.current) {
        const delta = rightDragData.current.startX - e.clientX;
        setRightPanelWidth(Math.max(280, Math.min(700, rightDragData.current.startWidth + delta)));
      }
      if (splitDragData.current) {
        const { startX, startPercent, containerWidth } = splitDragData.current;
        const delta = e.clientX - startX;
        const pct = startPercent + (delta / containerWidth) * 100;
        setSplitPercent(Math.max(20, Math.min(80, pct)));
      }
    };
    const onUp = () => {
      if (sidebarDragData.current || rightDragData.current || splitDragData.current) {
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        sidebarDragData.current = null;
        rightDragData.current = null;
        splitDragData.current = null;
        setIsDragging(false);
      }
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  const onSidebarDragStart = useCallback((e: React.MouseEvent) => {
    sidebarDragData.current = { startX: e.clientX, startWidth: sidebarWidth };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    setIsDragging(true);
    e.preventDefault();
  }, [sidebarWidth]);

  const onRightDragStart = useCallback((e: React.MouseEvent) => {
    rightDragData.current = { startX: e.clientX, startWidth: rightPanelWidth };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    setIsDragging(true);
    e.preventDefault();
  }, [rightPanelWidth]);

  const onSplitDragStart = useCallback((e: React.MouseEvent) => {
    const container = splitContainerRef.current;
    if (!container) return;
    splitDragData.current = { startX: e.clientX, startPercent: splitPercent, containerWidth: container.clientWidth };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    setIsDragging(true);
    e.preventDefault();
  }, [splitPercent]);

  // ── Preferences ──────────────────────────────────────────────────────────
  const updatePreferences = useCallback((p: AppPreferences) => {
    savePreferences(p);
    setPreferences(p);
  }, []);

  useEffect(() => {
    const colors = ACCENT_COLORS[preferences.uiAccent ?? "indigo"];
    if (!colors) return;
    const root = document.documentElement;
    root.style.setProperty("--c-accent", colors.c600);
    root.style.setProperty("--c-accent-hover", colors.c500);
    root.style.setProperty("--c-accent-text", colors.c300);
    root.style.setProperty("--c-accent-dim", colors.dim);
  }, [preferences.uiAccent]);

  useEffect(() => {
    const bg = BG_THEMES[preferences.uiBg ?? "slate"];
    if (!bg) return;
    const mode = preferences.colorMode ?? "dark";
    const shade = bg[mode];
    const root = document.documentElement;
    root.style.setProperty("--c-bg", shade.bg);
    root.style.setProperty("--c-bg2", shade.bg2);
    root.style.setProperty("--c-bg3", shade.bg3);
    root.style.setProperty("--c-border", shade.border);
    root.dataset.mode = mode;
  }, [preferences.uiBg, preferences.colorMode]);

  // ── Notifications ────────────────────────────────────────────────────────
  const pushNotification = useCallback((kind: NotificationKind, message: string) => {
    setNotifications((prev) => [...prev, createNotification(kind, message)]);
  }, []);

  const reportError = useCallback((message: string) => {
    setStatus(message);
    pushNotification("error", message);
  }, [pushNotification]);

  const dismissNotification = useCallback((id: string) => {
    setNotifications((prev) => prev.filter((n) => n.id !== id));
  }, []);

  const clearAllNotifications = useCallback(() => setNotifications([]), []);

  const markAllNotificationsRead = useCallback(() => {
    setNotifications((prev) => prev.map((n) => (n.read ? n : { ...n, read: true })));
  }, []);

  useEffect(() => {
    api.getWorkspace().then(setWorkspace).catch((e) => reportError(String(e)));
  }, [reportError]);

  // Silent background check on launch, repeated every few hours for
  // long-running sessions. Only surfaces a notification pointing to
  // Paramètres → Général, never downloads/installs on its own (that always
  // requires an explicit click, since it restarts the app). Re-notifying is
  // skipped while the same version is still pending, so it doesn't nag on
  // every check until the user actually installs it.
  useEffect(() => {
    let notifiedVersion: string | null = null;
    const runCheck = () => {
      checkForUpdate()
        .then((update) => {
          if (update && update.version !== notifiedVersion) {
            notifiedVersion = update.version;
            pushNotification("info", `Mise à jour disponible : v${update.version} — Paramètres → Général pour l'installer.`);
          }
        })
        .catch(() => {});
    };
    runCheck();
    const interval = setInterval(runCheck, 6 * 60 * 60 * 1000);
    return () => clearInterval(interval);
  }, [pushNotification]);

  const refreshWorkspace = useCallback((next: Workspace) => setWorkspace(next), []);

  // ── Tab management ───────────────────────────────────────────────────────
  const openTab = useCallback((kind: "terminal" | "transfer", host: Host) => {
    const id = `tab-${nextTabId++}`;
    const label = kind === "terminal" ? host.label : `Transfert : ${host.label}`;
    setTabs((prev) => [...prev, { id, kind, hostId: host.id, label }]);
    setActiveTabId(id);
  }, []);

  const openLocalTerminal = useCallback((initialCommand?: string) => {
    const id = `tab-${nextTabId++}`;
    const label = initialCommand ? `ssh ${initialCommand.replace(/^ssh\s+/, "")}` : "Terminal local";
    setTabs((prev) => [...prev, { id, kind: "local-terminal", label, initialCommand }]);
    setActiveTabId(id);
  }, []);

  const toggleSplit = useCallback(() => setSplitOpen((v) => !v), []);

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
        return [{ id, kind: "local-terminal", label: p.label, status: "placeholder" }];
      }
      if (!p.hostId || !workspace.hosts.some((h) => h.id === p.hostId)) return [];
      return [{ id, kind: p.kind, hostId: p.hostId, label: p.label, status: "placeholder" }];
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
  }, [preferences.notifyOnDisconnect, pushNotification]);

  const runSnippetOnActiveTerminal = useCallback((command: string) => {
    if (!activeTabId) { reportError("Aucun terminal actif pour exécuter ce snippet"); return; }
    const handle = terminalRefs.current.get(activeTabId);
    if (!handle) { reportError("L'onglet actif n'est pas un terminal"); return; }
    runOnTerminalHandle(handle, command);
  }, [activeTabId, reportError]);

  // ── Broadcast: send one command to every open terminal at once ──────────
  const [broadcastMode, setBroadcastMode] = useState(false);
  const broadcastTargets = tabs.filter((t) => (t.kind === "terminal" || t.kind === "local-terminal") && t.status !== "placeholder");

  const broadcastCommand = useCallback((command: string) => {
    for (const tab of broadcastTargets) {
      const handle = terminalRefs.current.get(tab.id);
      if (handle) runOnTerminalHandle(handle, command);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabs]);

  // ── Global keyboard shortcuts + command palette ─────────────────────────
  const shortcutHandlers: Record<string, () => void> = {
    "palette.open": () => setPaletteOpen(true),
    "sidebar.toggle": () => setSidebarVisible((v) => !v),
    "split.toggle": () => toggleSplit(),
    "tab.close": () => { if (activeTabId) closeTab(activeTabId); },
    "tab.newLocalTerminal": () => openLocalTerminal(),
    "tab.next": () => {
      if (tabs.length === 0) return;
      const idx = tabs.findIndex((t) => t.id === activeTabId);
      setActiveTabId(tabs[(idx + 1) % tabs.length].id);
    },
    "tab.prev": () => {
      if (tabs.length === 0) return;
      const idx = tabs.findIndex((t) => t.id === activeTabId);
      setActiveTabId(tabs[(idx - 1 + tabs.length) % tabs.length].id);
    },
    "settings.open": () => { setSidebarVisible(true); setSidebarPanel("settings"); },
  };
  useGlobalShortcuts(preferences.keyboardShortcuts, shortcutHandlers);

  const paletteCommands: PaletteCommand[] = workspace ? [
    ...SHORTCUT_ACTIONS.map((action) => ({
      id: action.id,
      label: action.label,
      hint: preferences.keyboardShortcuts[action.id] || undefined,
      run: () => shortcutHandlers[action.id]?.(),
    })),
    ...workspace.hosts.map((h) => ({
      id: `host.connect.${h.id}`,
      label: `Se connecter — ${h.label}`,
      hint: "Hôte",
      run: () => openTab("terminal", h),
    })),
  ] : [];

  if (!workspace) {
    return (
      <div className="app-aurora-bg flex h-screen w-screen flex-col overflow-hidden text-[var(--c-text)]">
        <TitleBar
          sidebarVisible={sidebarVisible}
          onToggleSidebar={() => setSidebarVisible((v) => !v)}
          notifications={notifications}
          onDismissNotification={dismissNotification}
          onClearAllNotifications={clearAllNotifications}
          onMarkAllNotificationsRead={markAllNotificationsRead}
        />
        <div className="flex flex-1 items-center justify-center text-[var(--c-text-secondary)]">Chargement…</div>
      </div>
    );
  }

  const showRightPanel = !!(editingHost || editingGroup);
  const activeTab = tabs.find((t) => t.id === activeTabId);
  const activeHostId = activeTab && activeTab.kind !== "local-terminal" ? activeTab.hostId : null;

  return (
    <div className="app-aurora-bg flex h-screen w-screen flex-col overflow-hidden text-[var(--c-text)]">
      {/* Transparent overlay during any drag — prevents xterm canvas from stealing mouse events */}
      {isDragging && <div className="fixed inset-0 z-[9999] cursor-col-resize" />}
      {paletteOpen && <CommandPalette commands={paletteCommands} onClose={() => setPaletteOpen(false)} />}
      <TitleBar
        sidebarVisible={sidebarVisible}
        onToggleSidebar={() => setSidebarVisible((v) => !v)}
        notifications={notifications}
        onDismissNotification={dismissNotification}
        onClearAllNotifications={clearAllNotifications}
        onMarkAllNotificationsRead={markAllNotificationsRead}
      />

      {status && (
        <div className="flex shrink-0 items-center justify-between bg-amber-900/60 px-4 py-2 text-sm text-amber-100">
          <span>{status}</span>
          <button className="flex items-center justify-center rounded p-1 hover:bg-amber-800" onClick={() => setStatus(null)} aria-label="Fermer">
            <IconClose size={12} />
          </button>
        </div>
      )}

      {/* Full-width tab bar — spans above sidebar + content, immune to sidebar resizing */}
      {tabs.length > 0 && (
        <TabBar
          tabs={tabs}
          activeTabId={activeTabId}
          splitOpen={splitOpen}
          broadcastActive={broadcastMode}
          onSelect={setActiveTabId}
          onClose={closeTab}
          onToggleSplit={toggleSplit}
          onToggleBroadcast={() => setBroadcastMode((v) => !v)}
          onReorder={setTabs}
        />
      )}

      {broadcastMode && (
        <BroadcastBar
          targetCount={broadcastTargets.length}
          onSend={broadcastCommand}
          onClose={() => setBroadcastMode(false)}
        />
      )}

      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* Sidebar */}
        <div
          style={{ width: sidebarVisible ? sidebarWidth : 0 }}
          className={`flex shrink-0 overflow-hidden ${isDragging ? "" : "transition-[width] duration-200 ease-in-out"}`}
        >
          <Sidebar
            workspace={workspace}
            panel={sidebarPanel}
            onPanelChange={setSidebarPanel}
            activeHostId={activeHostId}
            onConnect={(host) => openTab("terminal", host)}
            onOpenTransfer={(host) => openTab("transfer", host)}
            onOpenLocalTerminal={() => openLocalTerminal()}
            onQuickSSH={(cmd) => openLocalTerminal(cmd)}
            onNewHost={() => { setEditingHost("new"); setNewHostDefaultGroupId(null); setEditingGroup(null); }}
            onEditHost={(host) => { setEditingHost(host); setEditingGroup(null); }}
            onNewGroup={() => { setEditingGroup({ id: null, name: "", parentId: null, icon: null }); setEditingHost(null); }}
            onNewHostInGroup={(groupId) => { setEditingHost("new"); setNewHostDefaultGroupId(groupId); setEditingGroup(null); }}
            onNewGroupUnder={(parentId) => { setEditingGroup({ id: null, name: "", parentId, icon: null }); setEditingHost(null); }}
            onEditGroup={(group) => { setEditingGroup({ id: group.id, name: group.name, parentId: group.parentId ?? null, icon: group.icon ?? null }); setEditingHost(null); }}
            onWorkspaceUpdate={refreshWorkspace}
            onAddSnippet={(name, command) => api.addSnippet(name, command).then(refreshWorkspace).catch((e) => reportError(String(e)))}
            onUpdateSnippet={(id, name, command) => api.updateSnippet(id, name, command).then(refreshWorkspace).catch((e) => reportError(String(e)))}
            onDeleteSnippet={(id) => api.deleteSnippet(id).then(refreshWorkspace).catch((e) => reportError(String(e)))}
            onRunSnippet={runSnippetOnActiveTerminal}
            onAddForward={(input) => api.addForward(input).then(refreshWorkspace).catch((e) => reportError(String(e)))}
            onDeleteForward={(id) => api.deleteForward(id).then(refreshWorkspace).catch((e) => reportError(String(e)))}
            onAddKey={(name, path, passphrase) => api.addPrivateKey(name, path, passphrase).then(refreshWorkspace).catch((e) => reportError(String(e)))}
            onDeleteKey={(id) => api.deletePrivateKey(id).then(refreshWorkspace).catch((e) => reportError(String(e)))}
            onRenameKey={(id, name) => api.renamePrivateKey(id, name).then(refreshWorkspace).catch((e) => reportError(String(e)))}
            onError={reportError}
            preferences={preferences}
            onPreferencesChange={updatePreferences}
          />
        </div>

        {/* Sidebar resize handle */}
        {sidebarVisible && (
          <div
            onMouseDown={onSidebarDragStart}
            className="group relative flex w-1 shrink-0 cursor-col-resize items-center justify-center"
          >
            <div className="h-full w-px bg-[var(--c-border)] transition-colors group-hover:bg-[var(--c-accent)]" />
          </div>
        )}

        {/* Main content */}
        <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {tabs.length === 0 ? (
            <div className="flex flex-1 select-none flex-col items-center justify-center gap-4">
              <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-[var(--c-bg2)]">
                <IconTerminal size={28} className="text-[var(--c-text-faint)]" />
              </div>
              <div className="text-center">
                <p className="text-[13px] text-[var(--c-text-muted)]">Aucun terminal ouvert</p>
                <p className="mt-0.5 text-xs text-[var(--c-text-faint)]">Choisissez un hôte dans la barre latérale</p>
              </div>
            </div>
          ) : (
            <div ref={splitContainerRef} className="flex min-h-0 flex-1">
              {/* Primary pane */}
              <div
                className="relative min-w-0"
                style={{ width: splitOpen ? `${splitPercent}%` : "100%" }}
              >
                {tabs.map((tab) => {
                  const isActive = tab.id === activeTabId;
                  if (tab.status === "placeholder") {
                    return (
                      <div key={tab.id} className={isActive ? "absolute inset-0 flex select-none flex-col items-center justify-center gap-3" : "hidden"}>
                        <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[var(--c-bg2)] text-[var(--c-text-faint)]">
                          <IconTerminal size={22} />
                        </div>
                        <p className="text-[13px] text-[var(--c-text-secondary)]">{tab.label}</p>
                        <p className="text-xs text-[var(--c-text-faint)]">Session restaurée — non reconnectée</p>
                        <button
                          onClick={() => reconnectTab(tab.id)}
                          className="rounded-md bg-[var(--c-accent)] px-3 py-1.5 text-xs font-medium text-white hover:bg-[var(--c-accent-hover)]"
                        >
                          Cliquer pour reconnecter
                        </button>
                      </div>
                    );
                  }
                  if (tab.kind === "local-terminal") {
                    return (
                      <div key={tab.id} className={isActive ? "absolute inset-0 flex flex-col" : "hidden"}>
                        <LocalTerminalTab
                          isActive={isActive}
                          preferences={preferences}
                          initialCommand={tab.initialCommand}
                          onDisconnect={() => closeTab(tab.id, "disconnected")}
                          ref={(handle) => {
                            if (handle) terminalRefs.current.set(tab.id, handle);
                            else terminalRefs.current.delete(tab.id);
                          }}
                        />
                      </div>
                    );
                  }
                  const host = workspace.hosts.find((h) => h.id === tab.hostId);
                  if (!host) return null;
                  return (
                    <div key={tab.id} className={isActive ? "absolute inset-0 flex flex-col" : "hidden"}>
                      {tab.kind === "terminal" ? (
                        <TerminalTab
                          host={host}
                          isActive={isActive}
                          preferences={preferences}
                          onDisconnect={() => closeTab(tab.id, "disconnected")}
                          ref={(handle) => {
                            if (handle) terminalRefs.current.set(tab.id, handle);
                            else terminalRefs.current.delete(tab.id);
                          }}
                        />
                      ) : (
                        <TransferTab host={host} workspace={workspace} preferences={preferences} onError={reportError} />
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Split pane resize handle + secondary pane */}
              {splitOpen && (
                <>
                  <div
                    onMouseDown={onSplitDragStart}
                    className="group relative flex w-1 shrink-0 cursor-col-resize items-center justify-center"
                  >
                    <div className="h-full w-px bg-[var(--c-border)] transition-colors group-hover:bg-[var(--c-accent)]" />
                  </div>
                  <SplitPane workspace={workspace} preferences={preferences} />
                </>
              )}
            </div>
          )}
        </main>

        {/* Right panel resize handle */}
        {showRightPanel && (
          <div
            onMouseDown={onRightDragStart}
            className="group relative flex w-1 shrink-0 cursor-col-resize items-center justify-center"
          >
            <div className="h-full w-px bg-[var(--c-border)] transition-colors group-hover:bg-[var(--c-accent)]" />
          </div>
        )}

        {/* Right edit panel */}
        <div
          style={{ width: showRightPanel ? rightPanelWidth : 0 }}
          className={`flex shrink-0 flex-col overflow-hidden bg-[var(--c-bg)] ${isDragging ? "" : "transition-[width] duration-200 ease-in-out"}`}
        >
          {editingHost && (
            <HostForm
              workspace={workspace}
              host={editingHost === "new" ? null : editingHost}
              defaultGroupId={editingHost === "new" ? newHostDefaultGroupId : null}
              onCancel={() => setEditingHost(null)}
              onSave={(input) => {
                api.saveHost(input)
                  .then((ws) => { refreshWorkspace(ws); setEditingHost(null); })
                  .catch((e) => reportError(String(e)));
              }}
              onDeleteHost={editingHost !== "new" ? (id) => {
                api.deleteHost(id)
                  .then((ws) => { refreshWorkspace(ws); setEditingHost(null); })
                  .catch((e) => reportError(String(e)));
              } : undefined}
              onWorkspaceUpdate={refreshWorkspace}
            />
          )}
          {editingGroup && (
            <GroupForm
              workspace={workspace}
              group={editingGroup}
              onCancel={() => setEditingGroup(null)}
              onSave={(input) => {
                api.saveGroup(input)
                  .then((ws) => { refreshWorkspace(ws); setEditingGroup(null); })
                  .catch((e) => reportError(String(e)));
              }}
              onDeleteGroup={editingGroup.id ? (id) => {
                api.deleteGroup(id)
                  .then((ws) => { refreshWorkspace(ws); setEditingGroup(null); })
                  .catch((e) => reportError(String(e)));
              } : undefined}
              onWorkspaceUpdate={refreshWorkspace}
            />
          )}
        </div>
      </div>
    </div>
  );
}
