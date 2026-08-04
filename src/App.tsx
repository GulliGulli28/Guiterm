import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { check as checkForUpdate } from "@tauri-apps/plugin-updater";
import { api, onSshAuthPrompt } from "./lib/api";
import type { GroupId, Host, HostId, SqlConnection, SshAuthPrompt, TabMeta, VaultStatus, Workspace } from "./lib/types";
import { Sidebar, type SidebarPanelKind } from "./components/Sidebar";
import { HostForm } from "./components/HostForm";
import { TabBar } from "./components/TabBar";
import { BroadcastBar } from "./components/BroadcastBar";
import { TerminalTab, type TerminalTabHandle } from "./components/TerminalTab";
import { LocalTerminalTab } from "./components/LocalTerminalTab";
import { TitleBar } from "./components/TitleBar";
import { TabLoadingFallback } from "./components/TabLoadingFallback";

// Lazy-loaded: each of these is a large, not-always-used panel (RDP canvas
// rendering, the 950-line file transfer UI, the 1000+-line fleet/adaptive-DSL
// UI). Splitting them out of the main chunk shrinks what has to be
// parsed/compiled before the app is interactive. Chunk load itself is
// near-instant here (bundled locally by Tauri, no network round-trip) — this
// is purely about initial bundle size, not perceived loading latency.
const TransferTab = lazy(() => import("./components/TransferTab").then((m) => ({ default: m.TransferTab })));
const RdpTab = lazy(() => import("./components/RdpTab").then((m) => ({ default: m.RdpTab })));
const FleetTab = lazy(() => import("./components/FleetTab").then((m) => ({ default: m.FleetTab })));
import { type AppPreferences, type UiAccent, ACCENT_COLORS, BG_THEMES, loadPreferences, savePreferences } from "./lib/preferences";
import { SplitPane } from "./components/SplitPane";
import { AwsImportPanel } from "./components/AwsImportPanel";
import { AwsDatabaseImportPanel } from "./components/AwsDatabaseImportPanel";
import { AwsSsoSetupPanel } from "./components/AwsSsoSetupPanel";
import { GroupForm, type GroupFormData } from "./components/GroupForm";
import { SqlConnectionForm } from "./components/SqlConnectionForm";
import { IconTerminal, IconClose } from "./components/ui-icons";
import { CommandPalette, type PaletteCommand } from "./components/CommandPalette";
import { SnippetPicker } from "./components/SnippetPicker";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { VaultUnlockModal } from "./components/VaultUnlockModal";
import { SshAuthPromptModal } from "./components/SshAuthPromptModal";
import { SqlConnectionTab } from "./components/SqlConnectionTab";
import { assertNever } from "./lib/exhaustive";
import { SHORTCUT_ACTIONS, useGlobalShortcuts } from "./lib/shortcuts";
import { formatDuration } from "./lib/longCommand";
import { useNotifications } from "./hooks/useNotifications";
import { useResizablePane } from "./hooks/useResizablePane";
import { useTabs } from "./hooks/useTabs";
import { useBroadcast, SPLIT_PANE_ID } from "./hooks/useBroadcast";
import { useFullscreen } from "./hooks/useFullscreen";
import type { ZoomAction } from "./lib/terminalZoom";

export default function App() {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [sidebarPanel, setSidebarPanel] = useState<SidebarPanelKind>("hosts");
  const [editingHost, setEditingHost] = useState<Host | "new" | null>(null);
  const [editingGroup, setEditingGroup] = useState<GroupFormData | null>(null);
  const [editingSqlConnection, setEditingSqlConnection] = useState<SqlConnection | "new" | null>(null);
  const [newHostDefaultGroupId, setNewHostDefaultGroupId] = useState<GroupId | null>(null);
  const {
    status,
    notifications,
    pushNotification,
    reportError,
    clearStatus,
    dismissNotification,
    clearAllNotifications,
    markAllNotificationsRead,
  } = useNotifications();
  const [preferences, setPreferences] = useState<AppPreferences>(loadPreferences);
  const [splitOpen, setSplitOpen] = useState(false);
  const [splitSource, setSplitSource] = useState<"local" | HostId>("local");
  const toggleSplit = useCallback(() => setSplitOpen((v) => !v), []);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [snippetPickerOpen, setSnippetPickerOpen] = useState(false);
  const [awsImportOpen, setAwsImportOpen] = useState(false);
  const [awsDbImportOpen, setAwsDbImportOpen] = useState(false);
  const [awsSsoOpen, setAwsSsoOpen] = useState<{ name: string; startUrl: string; region: string } | true | null>(null);
  // Bumped after profiles are written, so an open import panel reloads its
  // list instead of the user having to close and reopen it.
  const [awsProfilesEpoch, setAwsProfilesEpoch] = useState(0);
  const terminalRefs = useRef<Map<string, TerminalTabHandle>>(new Map());
  const { fullscreen, toggleFullscreen } = useFullscreen(reportError);
  // In fullscreen the title bar is hidden — this is it being brought back by
  // pushing the pointer against the top edge of the screen.
  //
  // Driven by pointer position rather than an invisible hover strip on top of
  // the tab bar: such a strip would also swallow clicks landing in its few
  // pixels, and the tab bar is exactly what sits there in fullscreen. The two
  // thresholds are deliberately different — the bar appears only at the very
  // edge (which the OS makes easy to hit, the cursor stops there) but doesn't
  // vanish again the moment the pointer moves down onto the bar it just
  // revealed. No listener at all outside fullscreen.
  const [titleBarPeek, setTitleBarPeek] = useState(false);
  useEffect(() => {
    if (!fullscreen) {
      setTitleBarPeek(false);
      return;
    }
    const onMove = (e: MouseEvent) => {
      if (e.clientY <= 2) setTitleBarPeek(true);
      else if (e.clientY > 40) setTitleBarPeek(false);
    };
    window.addEventListener("mousemove", onMove);
    return () => window.removeEventListener("mousemove", onMove);
  }, [fullscreen]);

  // ── Keyboard-interactive authentication (MFA/OTP) ────────────────────────
  // A queue, not a single value: a fleet run or a batch of restored tabs can
  // have several hosts authenticating at once, and each one is a blocked SSH
  // handshake. Dropping any of them would leave that connection hanging until
  // it times out, so they're answered one after another.
  const [authPrompts, setAuthPrompts] = useState<SshAuthPrompt[]>([]);

  useEffect(() => {
    const pending = onSshAuthPrompt((prompt) => setAuthPrompts((prev) => [...prev, prompt]));
    return () => { pending.then((unlisten) => unlisten()); };
  }, []);

  const resolveAuthPrompt = useCallback((id: string, answers: string[] | null) => {
    (answers ? api.submitSshAuthPrompt(id, answers) : api.cancelSshAuthPrompt(id)).catch(() => {});
    setAuthPrompts((prev) => prev.filter((p) => p.id !== id));
  }, []);

  // ── Master-password vault ─────────────────────────────────────────────────
  const [vaultStatus, setVaultStatus] = useState<VaultStatus | null>(null);
  const [unlockModalOpen, setUnlockModalOpen] = useState(false);
  const [unlockError, setUnlockError] = useState<string | null>(null);
  const [unlockSubmitting, setUnlockSubmitting] = useState(false);

  // ── Resizable panels ─────────────────────────────────────────────────────
  // Each pane tracks its own drag state; combined below into a single
  // `isDragging` so the full-screen mouse-event-stealing overlay and the
  // width/percent transitions behave exactly as before the extraction (any
  // one of the three dragging counts as "a drag is in progress").
  const [sidebarDragging, setSidebarDragging] = useState(false);
  const [rightDragging, setRightDragging] = useState(false);
  const [splitDragging, setSplitDragging] = useState(false);
  const isDragging = sidebarDragging || rightDragging || splitDragging;
  const splitContainerRef = useRef<HTMLDivElement>(null);

  const sidebar = useResizablePane({
    initial: 320, min: 240, max: 600, axis: "horizontal", mode: "px", onDragChange: setSidebarDragging,
  });
  const rightPanel = useResizablePane({
    initial: 420, min: 280, max: 700, axis: "horizontal", mode: "px", invert: true, onDragChange: setRightDragging,
  });
  const split = useResizablePane({
    initial: 50, min: 20, max: 80, axis: "horizontal", mode: "percent", containerRef: splitContainerRef, onDragChange: setSplitDragging,
  });

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

  useEffect(() => {
    api.getWorkspace().then(setWorkspace).catch((e) => reportError(String(e)));
  }, [reportError]);

  // Fetch the master-vault status; if a vault exists but is locked, prompt for
  // the master password. Called again after any vault action (enable/lock/…).
  const refreshVaultStatus = useCallback(async () => {
    try {
      const s = await api.masterPasswordStatus();
      setVaultStatus(s);
      if (s.enabled && !s.unlocked) setUnlockModalOpen(true);
    } catch { /* backend unavailable — ignore */ }
  }, []);

  useEffect(() => { refreshVaultStatus(); }, [refreshVaultStatus]);

  const submitUnlock = useCallback(async (password: string) => {
    setUnlockSubmitting(true);
    setUnlockError(null);
    try {
      await api.unlockVault(password);
      setUnlockModalOpen(false);
      setVaultStatus(await api.masterPasswordStatus());
    } catch (e) {
      setUnlockError(String(e));
    } finally {
      setUnlockSubmitting(false);
    }
  }, []);

  // Auto-lock after a configurable idle period. Any mouse/keyboard activity
  // resets the countdown; when it fires we lock and re-prompt for the password.
  useEffect(() => {
    const minutes = preferences.masterVaultAutoLockMinutes ?? 0;
    if (!vaultStatus?.enabled || !vaultStatus?.unlocked || minutes <= 0) return;
    let timer: number | undefined;
    const reset = () => {
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        api.lockVault().catch(() => {}).finally(() => refreshVaultStatus());
      }, minutes * 60_000);
    };
    const events: (keyof WindowEventMap)[] = ["mousemove", "mousedown", "keydown"];
    events.forEach((e) => window.addEventListener(e, reset));
    reset();
    return () => {
      if (timer) window.clearTimeout(timer);
      events.forEach((e) => window.removeEventListener(e, reset));
    };
  }, [vaultStatus?.enabled, vaultStatus?.unlocked, preferences.masterVaultAutoLockMinutes, refreshVaultStatus]);

  // Silent background check on launch, repeated every few hours for
  // long-running sessions. Only surfaces a notification pointing to
  // Paramètres → Général, never downloads/installs on its own (that always
  // requires an explicit click, since it restarts the app). Re-notifying is
  // skipped while the same version is still pending, so it doesn't nag on
  // every check until the user actually installs it.
  useEffect(() => {
    if (!preferences.notifyOnUpdateAvailable) return;
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
  }, [pushNotification, preferences.notifyOnUpdateAvailable]);

  const refreshWorkspace = useCallback((next: Workspace) => setWorkspace(next), []);

  const {
    tabs, setTabs, activeTabId, setActiveTabId,
    pendingCloseTabId, setPendingCloseTabId,
    openTab, openLocalTerminal, openFleet, openSql, reconnectTab,
    closeTab, requestCloseTab,
    runSnippet, runAdaptiveSnippet, exportActiveScrollback,
    activeTabRecording, startActiveRecording, stopActiveRecording,
  } = useTabs({ workspace, preferences, terminalRefs, pushNotification, reportError, refreshWorkspace });

  const {
    broadcastMode, setBroadcastMode,
    broadcastTargets, broadcastSelected, setBroadcastSelected,
    toggleBroadcastMode, broadcastCommand,
    liveSyncMode, setLiveSyncMode, mirrorInput,
  } = useBroadcast({ tabs, splitOpen, splitSource, workspace, terminalRefs });

  // ── Global keyboard shortcuts + command palette ─────────────────────────
  const shortcutHandlers: Record<string, () => void> = {
    "palette.open": () => setPaletteOpen(true),
    "sidebar.toggle": () => setSidebarVisible((v) => !v),
    "split.toggle": () => toggleSplit(),
    "tab.close": () => { if (activeTabId) requestCloseTab(activeTabId); },
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
    "snippets.quickRun": () => setSnippetPickerOpen(true),
    "window.fullscreen": () => toggleFullscreen(),
  };
  useGlobalShortcuts(preferences.keyboardShortcuts, shortcutHandlers);

  // Ctrl+±/Ctrl+0 are handled by the focused terminal itself (see
  // `lib/terminalZoom.ts` for why they aren't rebindable combos) — these are
  // the palette's way in, so the feature is discoverable at all.
  const zoomActiveTerminal = (action: ZoomAction) => {
    if (activeTabId) terminalRefs.current.get(activeTabId)?.zoom(action);
  };

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
    {
      id: "terminal.exportScrollback",
      label: "Exporter le scrollback du terminal actif…",
      run: () => { exportActiveScrollback(); },
    },
    {
      id: "terminal.zoomIn",
      label: "Terminal actif — agrandir la police",
      hint: "Ctrl + +",
      run: () => zoomActiveTerminal("in"),
    },
    {
      id: "terminal.zoomOut",
      label: "Terminal actif — réduire la police",
      hint: "Ctrl + -",
      run: () => zoomActiveTerminal("out"),
    },
    {
      id: "terminal.zoomReset",
      label: "Terminal actif — police par défaut",
      hint: "Ctrl + 0",
      run: () => zoomActiveTerminal("reset"),
    },
    // Two entries rather than one toggle: the palette is a list of actions
    // read at a glance, and "Enregistrer" when it would actually stop is the
    // kind of ambiguity that costs someone a recording.
    activeTabRecording()
      ? {
          id: "terminal.stopRecording",
          label: "Arrêter l'enregistrement de la session",
          run: () => { stopActiveRecording(); },
        }
      : {
          id: "terminal.startRecording",
          label: "Enregistrer la session du terminal actif…",
          run: () => { startActiveRecording(); },
        },
    {
      id: "fleet.open",
      label: "Opérations de flotte — exécuter sur plusieurs hôtes…",
      run: () => openFleet(),
    },
  ] : [];

  const notifyLongCommand = useCallback((command: string, durationMs: number, where: string) => {
    // Truncated: a pasted one-liner can be hundreds of characters, and the
    // point is recognising which command it was, not reading it again.
    const shown = command.length > 60 ? `${command.slice(0, 57)}…` : command;
    pushNotification("success", `« ${shown} » terminée après ${formatDuration(durationMs)} — ${where}`);
  }, [pushNotification]);

  // Pushes back any remote file the user edited in their own editor. Focus is
  // the trigger rather than a watcher or a poll loop: coming back to this
  // window is exactly when a save made elsewhere becomes interesting, and it
  // costs nothing while the user is away. See `termius_core::remote_edit`.
  useEffect(() => {
    const onFocus = () => {
      api.syncRemoteEdits()
        .then((results) => {
          for (const r of results) {
            if (r.error) reportError(`« ${r.name} » : ${r.error}`);
            else if (r.outcome === "pushed") pushNotification("success", `« ${r.name} » renvoyé sur l'hôte.`);
          }
        })
        // A sync failure is reported per edit above; a failure of the call
        // itself (no session at all) is not worth interrupting anyone for.
        .catch(() => {});
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [pushNotification, reportError]);

  // Rendered in both branches below (workspace loaded or not): a restored tab
  // can start authenticating before the workspace has finished loading, and
  // that handshake is already waiting.
  const authPromptModal = authPrompts[0] ? (
    <SshAuthPromptModal
      key={authPrompts[0].id}
      prompt={authPrompts[0]}
      onSubmit={(answers) => resolveAuthPrompt(authPrompts[0].id, answers)}
      onCancel={() => resolveAuthPrompt(authPrompts[0].id, null)}
    />
  ) : null;

  const titleBar = (
    <TitleBar
      sidebarVisible={sidebarVisible}
      onToggleSidebar={() => setSidebarVisible((v) => !v)}
      fullscreen={fullscreen}
      notifications={notifications}
      onDismissNotification={dismissNotification}
      onClearAllNotifications={clearAllNotifications}
      onMarkAllNotificationsRead={markAllNotificationsRead}
    />
  );

  // Fullscreen gives the whole screen to the terminal, so the app's own title
  // bar goes away with the OS decorations. It stays reachable rather than
  // being gone until someone remembers F11 (see `titleBarPeek` above), and it
  // comes back *overlaid* on the content so nothing reflows — a peek must not
  // resize every terminal twice.
  const titleBarArea = !fullscreen ? titleBar : (
    titleBarPeek && <div className="fixed inset-x-0 top-0 z-50 shadow-xl">{titleBar}</div>
  );

  const vaultUnlockModal = unlockModalOpen && vaultStatus?.enabled ? (
    <VaultUnlockModal
      error={unlockError}
      submitting={unlockSubmitting}
      onDismiss={() => { setUnlockModalOpen(false); setUnlockError(null); }}
      onSubmit={submitUnlock}
    />
  ) : null;

  if (!workspace) {
    return (
      <div className="app-aurora-bg flex h-screen w-screen flex-col overflow-hidden text-[var(--c-text)]">
        {vaultUnlockModal}
        {authPromptModal}
        {titleBarArea}
        <div className="flex flex-1 items-center justify-center text-[var(--c-text-secondary)]">Chargement…</div>
      </div>
    );
  }

  const showRightPanel = !!(editingHost || editingGroup || editingSqlConnection);
  const activeTab = tabs.find((t) => t.id === activeTabId);
  const activeHostId = activeTab && activeTab.kind !== "local-terminal" && activeTab.kind !== "fleet" && activeTab.kind !== "sql" ? activeTab.hostId : null;

  // Resolves a tab to its host's group color tag (if the host, its group, and a
  // color are all set), so TabBar can show a small dot without knowing about hosts/groups.
  const tabColor = (tab: TabMeta): string | undefined => {
    if (tab.kind === "local-terminal" || tab.kind === "fleet" || tab.kind === "sql") return undefined;
    const host = workspace.hosts.find((h) => h.id === tab.hostId);
    const group = host?.groupId ? workspace.groups.find((g) => g.id === host.groupId) : null;
    const accent = group?.color as UiAccent | undefined;
    return accent ? ACCENT_COLORS[accent]?.c500 : undefined;
  };

  return (
    <div className="app-aurora-bg flex h-screen w-screen flex-col overflow-hidden text-[var(--c-text)]">
      {/* Transparent overlay during any drag — prevents xterm canvas from stealing mouse events */}
      {isDragging && <div className="fixed inset-0 z-[9999] cursor-col-resize" />}
      {vaultUnlockModal}
      {authPromptModal}
      {paletteOpen && <CommandPalette commands={paletteCommands} onClose={() => setPaletteOpen(false)} />}
      {awsImportOpen && (
        <AwsImportPanel
          workspace={workspace}
          onWorkspaceUpdate={refreshWorkspace}
          onClose={() => setAwsImportOpen(false)}
          onError={reportError}
          onConfigureSso={() => setAwsSsoOpen(true)}
          onReconnectSso={(session) => setAwsSsoOpen(session)}
          key={`aws-import-${awsProfilesEpoch}`}
        />
      )}
      {awsSsoOpen && (
        <AwsSsoSetupPanel
          onClose={() => setAwsSsoOpen(null)}
          onProfilesCreated={() => setAwsProfilesEpoch((n) => n + 1)}
          initialSession={awsSsoOpen === true ? undefined : awsSsoOpen}
        />
      )}
      {awsDbImportOpen && (
        <AwsDatabaseImportPanel
          workspace={workspace}
          onWorkspaceUpdate={refreshWorkspace}
          onClose={() => setAwsDbImportOpen(false)}
          onError={reportError}
          onReconnectSso={(session) => setAwsSsoOpen(session)}
          onConfigureSso={() => setAwsSsoOpen(true)}
          key={`aws-db-import-${awsProfilesEpoch}`}
        />
      )}
      {snippetPickerOpen && workspace && (
        <SnippetPicker
          snippets={workspace.snippets}
          onRun={(command) => runSnippet(command)}
          onSnippetResolved={(snippet, resolvedText) => { if (snippet.adaptive) runAdaptiveSnippet(resolvedText); }}
          onClose={() => setSnippetPickerOpen(false)}
        />
      )}
      {pendingCloseTabId && (
        <ConfirmDialog
          title="Fermer la session ?"
          message={`« ${tabs.find((t) => t.id === pendingCloseTabId)?.label ?? ""} » a une session SSH active. La fermer coupera la connexion.`}
          confirmLabel="Fermer la session"
          danger
          onConfirm={() => { closeTab(pendingCloseTabId); setPendingCloseTabId(null); }}
          onCancel={() => setPendingCloseTabId(null)}
        />
      )}
      {titleBarArea}

      {status && (
        <div className="flex shrink-0 items-center justify-between bg-amber-900/60 px-4 py-2 text-sm text-amber-100">
          <span>{status}</span>
          <button className="flex items-center justify-center rounded p-1 hover:bg-amber-800" onClick={clearStatus} aria-label="Fermer">
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
          fullscreen={fullscreen}
          onSelect={setActiveTabId}
          onClose={requestCloseTab}
          onToggleSplit={toggleSplit}
          onToggleBroadcast={toggleBroadcastMode}
          onToggleFullscreen={toggleFullscreen}
          onReorder={setTabs}
          tabColor={tabColor}
        />
      )}

      {broadcastMode && (
        <BroadcastBar
          targets={broadcastTargets}
          selectedIds={broadcastSelected}
          onChangeSelected={setBroadcastSelected}
          liveSyncMode={liveSyncMode}
          onToggleLiveSync={() => setLiveSyncMode((v) => !v)}
          onSend={broadcastCommand}
          onClose={() => { setBroadcastMode(false); setLiveSyncMode(false); }}
        />
      )}

      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* Sidebar */}
        <div
          style={{ width: sidebarVisible ? sidebar.value : 0 }}
          className={`flex shrink-0 overflow-hidden ${isDragging ? "" : "transition-[width] duration-200 ease-in-out"}`}
        >
          <Sidebar
            workspace={workspace}
            panel={sidebarPanel}
            onPanelChange={setSidebarPanel}
            activeHostId={activeHostId}
            onConnect={(host) => openTab("terminal", host)}
            onConnectDocker={(host, containerId) => openTab("terminal", host, containerId)}
            onConnectK8s={(host, podName, containerName) => openTab("terminal", host, undefined, podName, containerName)}
            onConnectRdpView={(host) => openTab("rdp-view", host)}
            onOpenTransfer={(host, dockerContainerId, k8sPodName, k8sContainerName) => openTab("transfer", host, dockerContainerId, k8sPodName, k8sContainerName)}
            onOpenLocalTerminal={(shell) => openLocalTerminal(undefined, shell)}
            onQuickSSH={(cmd) => openLocalTerminal(cmd)}
            onNewHost={() => { setEditingHost("new"); setNewHostDefaultGroupId(null); setEditingGroup(null); setEditingSqlConnection(null); }}
            onEditHost={(host) => { setEditingHost(host); setEditingGroup(null); setEditingSqlConnection(null); }}
            onNewGroup={() => { setEditingGroup({ id: null, name: "", parentId: null, icon: null, color: null }); setEditingHost(null); setEditingSqlConnection(null); }}
            onImportAws={() => setAwsImportOpen(true)}
            onNewHostInGroup={(groupId) => { setEditingHost("new"); setNewHostDefaultGroupId(groupId); setEditingGroup(null); setEditingSqlConnection(null); }}
            onNewGroupUnder={(parentId) => { setEditingGroup({ id: null, name: "", parentId, icon: null, color: null }); setEditingHost(null); setEditingSqlConnection(null); }}
            onEditGroup={(group) => { setEditingGroup({ id: group.id, name: group.name, parentId: group.parentId ?? null, icon: group.icon ?? null, color: group.color ?? null }); setEditingHost(null); setEditingSqlConnection(null); }}
            onWorkspaceUpdate={refreshWorkspace}
            onAddSnippet={(name, command) => api.addSnippet(name, command).then(refreshWorkspace).catch((e) => reportError(String(e)))}
            onUpdateSnippet={(id, name, command) => api.updateSnippet(id, name, command).then(refreshWorkspace).catch((e) => reportError(String(e)))}
            onDeleteSnippet={(id) => api.deleteSnippet(id).then(refreshWorkspace).catch((e) => reportError(String(e)))}
            onRunSnippet={runSnippet}
            onRunAdaptiveSnippet={runAdaptiveSnippet}
            onSaveAdaptiveSnippet={(id, name, command) =>
              api.saveAdaptiveSnippet(id, name, command).then(refreshWorkspace).catch((e) => reportError(String(e)))
            }
            openTerminals={broadcastTargets}
            onAddForward={(input) => api.addForward(input).then(refreshWorkspace).catch((e) => reportError(String(e)))}
            onDeleteForward={(id) => api.deleteForward(id).then(refreshWorkspace).catch((e) => reportError(String(e)))}
            onAddKey={(name, path, passphrase) => api.addPrivateKey(name, path, passphrase).then(refreshWorkspace).catch((e) => reportError(String(e)))}
            onGenerateKey={(name, algorithm, passphrase) => api.generatePrivateKey(name, algorithm, passphrase).then(refreshWorkspace).catch((e) => reportError(String(e)))}
            onDeleteKey={(id) => api.deletePrivateKey(id).then(refreshWorkspace).catch((e) => reportError(String(e)))}
            onRenameKey={(id, name) => api.renamePrivateKey(id, name).then(refreshWorkspace).catch((e) => reportError(String(e)))}
            onConnectSql={(conn) => openSql(conn)}
            onNewSqlConnection={() => { setEditingSqlConnection("new"); setEditingHost(null); setEditingGroup(null); }}
            onImportAwsDatabases={() => setAwsDbImportOpen(true)}
            onEditSqlConnection={(conn) => { setEditingSqlConnection(conn); setEditingHost(null); setEditingGroup(null); }}
            onOpenFleet={openFleet}
            onError={reportError}
            preferences={preferences}
            onPreferencesChange={updatePreferences}
            vaultStatus={vaultStatus}
            onVaultStatusChange={refreshVaultStatus}
          />
        </div>

        {/* Sidebar resize handle */}
        {sidebarVisible && (
          <div
            onMouseDown={sidebar.onMouseDown}
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
                style={{ width: splitOpen ? `${split.value}%` : "100%" }}
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
                          shell={tab.shell}
                          onLongCommand={notifyLongCommand}
                          onDisconnect={() => closeTab(tab.id, "disconnected")}
                          onInputData={(data) => mirrorInput(tab.id, data)}
                          ref={(handle) => {
                            if (handle) terminalRefs.current.set(tab.id, handle);
                            else terminalRefs.current.delete(tab.id);
                          }}
                        />
                      </div>
                    );
                  }
                  if (tab.kind === "fleet") {
                    return (
                      <div key={tab.id} className={isActive ? "absolute inset-0 flex flex-col" : "hidden"}>
                        <Suspense fallback={<TabLoadingFallback />}>
                          <FleetTab workspace={workspace} onError={reportError} onWorkspaceUpdate={refreshWorkspace} />
                        </Suspense>
                      </div>
                    );
                  }
                  if (tab.kind === "sql") {
                    const connection = workspace.sqlConnections.find((c) => c.id === tab.sqlConnectionId);
                    if (!connection) return null;
                    return (
                      <div key={tab.id} className={isActive ? "absolute inset-0 flex flex-col" : "hidden"}>
                        <Suspense fallback={<TabLoadingFallback />}>
                          <SqlConnectionTab connection={connection} hosts={workspace.hosts} onError={reportError} />
                        </Suspense>
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
                          onLongCommand={notifyLongCommand}
                          onDisconnect={() => closeTab(tab.id, "disconnected")}
                          onInputData={(data) => mirrorInput(tab.id, data)}
                          dockerContainerId={tab.kind === "terminal" ? tab.dockerContainerId : undefined}
                          k8sPodName={tab.kind === "terminal" ? tab.k8sPodName : undefined}
                          k8sContainerName={tab.kind === "terminal" ? tab.k8sContainerName : undefined}
                          ref={(handle) => {
                            if (handle) terminalRefs.current.set(tab.id, handle);
                            else terminalRefs.current.delete(tab.id);
                          }}
                        />
                      ) : tab.kind === "rdp-view" ? (
                        <Suspense fallback={<TabLoadingFallback />}>
                          <RdpTab
                            host={host}
                            isActive={isActive}
                            preferences={preferences}
                            onDisconnect={() => closeTab(tab.id)}
                            ref={(handle) => {
                              if (handle) terminalRefs.current.set(tab.id, handle);
                              else terminalRefs.current.delete(tab.id);
                            }}
                          />
                        </Suspense>
                      ) : tab.kind === "transfer" ? (
                        <Suspense fallback={<TabLoadingFallback />}>
                          <TransferTab
                            host={host}
                            workspace={workspace}
                            preferences={preferences}
                            onError={reportError}
                            onPushed={(message) => pushNotification("success", message)}
                            dockerContainerId={tab.dockerContainerId}
                            k8sPodName={tab.k8sPodName}
                            k8sContainerName={tab.k8sContainerName}
                          />
                        </Suspense>
                      ) : (
                        // Was a bare `else` rendering TransferTab: a new
                        // host-bound tab kind would have silently rendered a
                        // file browser. Now it fails to compile instead.
                        //
                        // Narrows `tab.kind`, not `tab`: these three kinds
                        // share one `TabMeta` member (`kind: "terminal" |
                        // "transfer" | "rdp-view"`) rather than being three
                        // members, so the object type never reduces to
                        // `never` — the discriminant field does.
                        assertNever(tab.kind, "type d'onglet lié à un hôte")
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Split pane resize handle + secondary pane */}
              {splitOpen && (
                <>
                  <div
                    onMouseDown={split.onMouseDown}
                    className="group relative flex w-1 shrink-0 cursor-col-resize items-center justify-center"
                  >
                    <div className="h-full w-px bg-[var(--c-border)] transition-colors group-hover:bg-[var(--c-accent)]" />
                  </div>
                  <SplitPane
                    workspace={workspace}
                    preferences={preferences}
                    source={splitSource}
                    onSourceChange={setSplitSource}
                    onInputData={(data) => mirrorInput(SPLIT_PANE_ID, data)}
                    onRef={(handle) => {
                      if (handle) terminalRefs.current.set(SPLIT_PANE_ID, handle);
                      else terminalRefs.current.delete(SPLIT_PANE_ID);
                    }}
                  />
                </>
              )}
            </div>
          )}
        </main>

        {/* Right panel resize handle */}
        {showRightPanel && (
          <div
            onMouseDown={rightPanel.onMouseDown}
            className="group relative flex w-1 shrink-0 cursor-col-resize items-center justify-center"
          >
            <div className="h-full w-px bg-[var(--c-border)] transition-colors group-hover:bg-[var(--c-accent)]" />
          </div>
        )}

        {/* Right edit panel */}
        <div
          style={{ width: showRightPanel ? rightPanel.value : 0 }}
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
          {editingSqlConnection && (
            <SqlConnectionForm
              workspace={workspace}
              connection={editingSqlConnection === "new" ? null : editingSqlConnection}
              onCancel={() => setEditingSqlConnection(null)}
              onSave={(input) => {
                api.saveSqlConnection(input)
                  .then((ws) => { refreshWorkspace(ws); setEditingSqlConnection(null); })
                  .catch((e) => reportError(String(e)));
              }}
              onDeleteConnection={editingSqlConnection !== "new" ? (id) => {
                api.deleteSqlConnection(id)
                  .then((ws) => { refreshWorkspace(ws); setEditingSqlConnection(null); })
                  .catch((e) => reportError(String(e)));
              } : undefined}
            />
          )}
        </div>
      </div>
    </div>
  );
}
