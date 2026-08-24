import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { check as checkForUpdate } from "@tauri-apps/plugin-updater";
import { api, onSshAuthPrompt } from "./lib/api";
import type { AwsSsoSession, GroupId, Host, HostId, PaneSource, SqlConnection, SshAuthPrompt, TabMeta, VaultStatus, Workspace } from "./lib/types";
import { isHostBoundTab } from "./lib/types";
import { Sidebar } from "./components/Sidebar";
import { HostForm } from "./components/HostForm";
import { TabBar } from "./components/TabBar";
import { BroadcastBar } from "./components/BroadcastBar";
import type { TerminalTabHandle } from "./components/TerminalTab";
import { TitleBar } from "./components/TitleBar";
import { TabLoadingFallback } from "./components/TabLoadingFallback";

import { type AppPreferences, type UiAccent, ACCENT_COLORS, BG_THEMES, loadPreferences, savePreferences } from "./lib/preferences";
import { resolveVisiblePanel, type SidebarPanelKind } from "./lib/sidebarButtons";
import { cdCommand } from "./lib/panePath";
import { groupPath } from "./lib/hostTree";
import { renderModuleTab } from "./modules/registry";
import type { AppContext, SidebarActions } from "./modules/types";
// Lazy : `SplitPane` monte un terminal, donc importe xterm. Eager, il
// annulerait à lui seul le gain des deux modules ci-dessus — et il n'est rendu
// que si l'utilisateur ouvre le panneau scindé.
const SplitPane = lazy(() => import("./components/SplitPane").then((m) => ({ default: m.SplitPane })));
import { AwsImportPanel } from "./components/AwsImportPanel";
import { AnsibleImportPanel } from "./components/AnsibleImportPanel";
import { AzureImportPanel } from "./components/AzureImportPanel";
import { GcpImportPanel } from "./components/GcpImportPanel";
import { CloudProviderPicker, type CloudProvider } from "./components/CloudProviderPicker";

import { RemoteSearchPanel } from "./components/RemoteSearchPanel";
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
import { SHORTCUT_ACTIONS, useGlobalShortcuts } from "./lib/shortcuts";
import { formatDuration } from "./lib/longCommand";
import { useNotifications } from "./hooks/useNotifications";
import { useResizablePane } from "./hooks/useResizablePane";
import { useTabs } from "./hooks/useTabs";
import { useBroadcast, SPLIT_PANE_ID } from "./hooks/useBroadcast";
import { useFullscreen } from "./hooks/useFullscreen";
import { useAwsSessionAlerts } from "./hooks/useAwsSessionAlerts";
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
  /** Which cloud import is on screen. `"picker"` is the provider choice that
   * the single "Importer depuis le cloud" menu entry opens; the others are the
   * providers' own panels, which stay separate components. */
  const [cloudImport, setCloudImport] = useState<"picker" | CloudProvider | null>(null);
  const [ansibleImportOpen, setAnsibleImportOpen] = useState(false);
  /** Host whose filesystem is being searched. */
  const [searchHost, setSearchHost] = useState<Host | null>(null);
  const [awsDbImportOpen, setAwsDbImportOpen] = useState(false);
  // What the one SSO modal is being opened for: a session that doesn't exist
  // yet, signing a known one in again, or picking new profiles out of a
  // session already signed in (no browser round trip).
  const [awsSsoOpen, setAwsSsoOpen] = useState<
    { mode: "new" } | { mode: "reconnect" | "profiles"; session: AwsSsoSession } | null
  >(null);
  // Bumped after profiles are written, so an open import panel reloads its
  // list instead of the user having to close and reopen it.
  const [awsProfilesEpoch, setAwsProfilesEpoch] = useState(0);
  // Separate from the one above because the identities panel also cares about
  // a *login*, which writes no profile and so only shows up as the modal
  // closing. Bumping the shared one there would remount the import panels —
  // discarding an instance listing every time someone cancelled the modal.
  const [awsIdentitiesEpoch, setAwsIdentitiesEpoch] = useState(0);
  // Watched here rather than in the identities panel: a session dying is worth
  // knowing about while looking at a terminal, and that panel is lazy-loaded.
  const awsAlerts = useAwsSessionAlerts(awsIdentitiesEpoch);
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
    openTab, openLocalTerminal, openFleet, openActivity, openNetdiag, openSql, reconnectTab,
    rememberSessionKey,
    closeTab, requestCloseTab,
    runSnippet, runAdaptiveSnippet, exportActiveScrollback,
    activeTabRecording, startActiveRecording, stopActiveRecording,
  } = useTabs({ workspace, preferences, terminalRefs, pushNotification, reportError, refreshWorkspace });

  /** « Ouvrir un terminal ici », depuis un panneau de transfert : même cible
   * (locale, hôte SSH, conteneur Docker, pod K8s) et un `cd` vers le dossier
   * affiché. La commande est envoyée par l'onglet lui-même une fois la session
   * ouverte — voir `initialCommand` dans `TerminalTab`/`LocalTerminalTab`. */
  const openTerminalIn = useCallback((source: PaneSource, cwd: string) => {
    if (source.kind === "local") {
      openLocalTerminal(cdCommand(cwd, preferences.defaultLocalShell));
      return;
    }
    const host = workspace?.hosts.find((h) => h.id === source.hostId);
    if (!host) { reportError("Hôte introuvable pour ouvrir un terminal."); return; }
    openTab(
      "terminal",
      host,
      source.kind === "docker" ? source.containerId : undefined,
      source.kind === "k8s" ? source.podName : undefined,
      source.kind === "k8s" ? source.containerName : undefined,
      cdCommand(cwd),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace?.hosts, preferences.defaultLocalShell, openLocalTerminal, openTab]);


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

    // Ctrl+1…8 by position, Ctrl+9 to the last tab — the browser convention,
    // which is what makes it useful with more tabs than fingers. Out of range
    // does nothing rather than clamping: jumping to a tab you didn't ask for
    // is worse than the keystroke being ignored.
    ...Object.fromEntries(Array.from({ length: 9 }, (_, i) => [
      `tab.goto${i + 1}`,
      () => {
        const target = i === 8 ? tabs[tabs.length - 1] : tabs[i];
        if (target) setActiveTabId(target.id);
      },
    ])),

    "tab.reconnect": () => { if (activeTabId) reconnectTab(activeTabId); },
    "terminal.toggleRecording": () => {
      if (activeTabRecording()) stopActiveRecording();
      else void startActiveRecording();
    },
    "terminal.exportScrollback": () => { void exportActiveScrollback(); },
    "fleet.open": () => openFleet(),
    "activity.open": () => openActivity(),
    // No source: this machine, which is the "do *I* reach it" half of the
    // question. Opening from a host's menu preselects that host instead.
    "netdiag.open": () => openNetdiag(null),
    "database.open": () => { setSidebarVisible(true); setSidebarPanel("database"); },
    "broadcast.toggle": () => toggleBroadcastMode(),
    "host.new": () => {
      setSidebarVisible(true);
      setSidebarPanel("hosts");
      setEditingHost("new");
      setNewHostDefaultGroupId(null);
      setEditingGroup(null);
      setEditingSqlConnection(null);
    },
  };
  useGlobalShortcuts(preferences.keyboardShortcuts, shortcutHandlers);

  // Ctrl+±/Ctrl+0 are handled by the focused terminal itself (see
  // `lib/terminalZoom.ts` for why they aren't rebindable combos) — these are
  // the palette's way in, so the feature is discoverable at all.
  const zoomActiveTerminal = (action: ZoomAction) => {
    if (activeTabId) terminalRefs.current.get(activeTabId)?.zoom(action);
  };

  const paletteCommands: PaletteCommand[] = workspace ? [
    ...SHORTCUT_ACTIONS.filter((action) => !action.paletteHidden).map((action) => ({
      id: action.id,
      label: action.label,
      hint: preferences.keyboardShortcuts[action.id] || undefined,
      run: () => shortcutHandlers[action.id]?.(),
    })),
    // Le chemin du dossier fait partie du libellé, et les tags de ce qui est
    // cherchable : la palette est le seul endroit où choisir un hôte reste
    // une liste, faute d'arborescence — sans ça, deux machines homonymes
    // rangées dans deux dossiers différents y sont indiscernables.
    ...workspace.hosts.map((h) => ({
      id: `host.connect.${h.id}`,
      label: `Se connecter — ${[...groupPath(workspace.groups, h.groupId), h.label].join(" › ")}`,
      hint: h.tags.length > 0 ? h.tags.join(" · ") : "Hôte",
      keywords: [...h.tags, h.address, h.username].join(" "),
      run: () => openTab("terminal", h),
    })),
    // "Tester la joignabilité" used to be listed here. It is now `netdiag.open`
    // among the shortcut actions above, which renders it with its combo — and
    // the panel it opened has been absorbed by the diagnostics tab.
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
          hint: preferences.keyboardShortcuts["terminal.toggleRecording"] || undefined,
          run: () => { stopActiveRecording(); },
        }
      : {
          id: "terminal.startRecording",
          label: "Enregistrer la session du terminal actif…",
          hint: preferences.keyboardShortcuts["terminal.toggleRecording"] || undefined,
          run: () => { startActiveRecording(); },
        },
    // "Exporter le scrollback", "Opérations de flotte" and "Activité" used to
    // be listed here too. They are shortcut actions now, so the block above
    // renders them — with their combo as a hint, which these hadn't.
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

  // Ce que les modules reçoivent pour rendre leurs onglets. Construit ici, une
  // fois `workspace` narrowed par le retour anticipé ci-dessus, plutôt que
  // dans un `useMemo` en tête de composant où il serait encore `null`. Pas de
  // mémoïsation : cet objet n'est pas une prop d'un composant mémoïsé, il est
  // consommé immédiatement par des fonctions de rendu.
  const moduleContext: AppContext = {
    workspace, preferences, updatePreferences, openTerminalIn, reportError, pushNotification, refreshWorkspace,
    closeTab, notifyLongCommand, mirrorInput,
    // La table des poignées reste ici : la palette, le broadcast, le zoom et
    // la recherche terminal l'interrogent. Les modules n'ont le droit que d'y
    // publier la leur.
    registerTerminalHandle: (tabId, handle) => {
      if (handle) terminalRefs.current.set(tabId, handle);
      else terminalRefs.current.delete(tabId);
    },
    rememberSessionKey,
  };

  const showRightPanel = !!(editingHost || editingGroup || editingSqlConnection);
  const activeTab = tabs.find((t) => t.id === activeTabId);
  const activeHostId = activeTab && isHostBoundTab(activeTab) ? activeTab.hostId : null;

  // Ce que les panneaux de la barre latérale peuvent demander à l'app. Même
  // contenu qu'avant, mais déclaré **une** fois : `SidebarProps` et les 90
  // lignes de passe-plat de `Sidebar.tsx` ont disparu avec.
  const sidebarActions: SidebarActions = {
    connect: (host) => openTab("terminal", host),
    connectDocker: (host, containerId) => openTab("terminal", host, containerId),
    connectK8s: (host, podName, containerName) => openTab("terminal", host, undefined, podName, containerName),
    connectRdpView: (host) => openTab("rdp-view", host),
    openTransfer: (host, dockerContainerId, k8sPodName, k8sContainerName) =>
      openTab("transfer", host, dockerContainerId, k8sPodName, k8sContainerName),
    openLocalTerminal: (shell) => openLocalTerminal(undefined, shell),
    quickSSH: (cmd) => openLocalTerminal(cmd),
    connectSql: (conn) => openSql(conn),
    probeReachability: (host) => openNetdiag(host.id),
    searchFiles: (host) => setSearchHost(host),

    newHost: () => { setEditingHost("new"); setNewHostDefaultGroupId(null); setEditingGroup(null); setEditingSqlConnection(null); },
    editHost: (host) => { setEditingHost(host); setEditingGroup(null); setEditingSqlConnection(null); },
    newHostInGroup: (groupId) => { setEditingHost("new"); setNewHostDefaultGroupId(groupId); setEditingGroup(null); setEditingSqlConnection(null); },
    newGroup: () => { setEditingGroup({ id: null, name: "", parentId: null, icon: null, color: null }); setEditingHost(null); setEditingSqlConnection(null); },
    newGroupUnder: (parentId) => { setEditingGroup({ id: null, name: "", parentId, icon: null, color: null }); setEditingHost(null); setEditingSqlConnection(null); },
    editGroup: (group) => { setEditingGroup({ id: group.id, name: group.name, parentId: group.parentId ?? null, icon: group.icon ?? null, color: group.color ?? null }); setEditingHost(null); setEditingSqlConnection(null); },
    newSqlConnection: () => { setEditingSqlConnection("new"); setEditingHost(null); setEditingGroup(null); },
    editSqlConnection: (conn) => { setEditingSqlConnection(conn); setEditingHost(null); setEditingGroup(null); },
    importCloud: () => setCloudImport("picker"),
    importAnsible: () => setAnsibleImportOpen(true),
    importAwsDatabases: () => setAwsDbImportOpen(true),
    configureSso: () => setAwsSsoOpen({ mode: "new" }),
    reconnectSso: (session) => setAwsSsoOpen({ mode: "reconnect", session }),
    addAwsProfiles: (session) => setAwsSsoOpen({ mode: "profiles", session }),

    addSnippet: (name, command) => api.addSnippet(name, command).then(refreshWorkspace).catch((e) => reportError(String(e))),
    updateSnippet: (id, name, command) => api.updateSnippet(id, name, command).then(refreshWorkspace).catch((e) => reportError(String(e))),
    deleteSnippet: (id) => api.deleteSnippet(id).then(refreshWorkspace).catch((e) => reportError(String(e))),
    runSnippet,
    runAdaptiveSnippet,
    saveAdaptiveSnippet: (id, name, command) =>
      api.saveAdaptiveSnippet(id, name, command).then(refreshWorkspace).catch((e) => reportError(String(e))),
    addForward: (input) => api.addForward(input).then(refreshWorkspace).catch((e) => reportError(String(e))),
    // Pas de `.catch` ici, contrairement aux deux autres : le panneau attend
    // cette promesse pour décider s'il relance le tunnel, et avaler l'échec ici
    // le ferait redémarrer sur une modification qui n'a pas été enregistrée.
    updateForward: (input) => api.updateForward(input).then(refreshWorkspace),
    deleteForward: (id) => api.deleteForward(id).then(refreshWorkspace).catch((e) => reportError(String(e))),
    addKey: (name, path, passphrase) => api.addPrivateKey(name, path, passphrase).then(refreshWorkspace).catch((e) => reportError(String(e))),
    generateKey: (name, algorithm, passphrase) => api.generatePrivateKey(name, algorithm, passphrase).then(refreshWorkspace).catch((e) => reportError(String(e))),
    deleteKey: (id) => api.deletePrivateKey(id).then(refreshWorkspace).catch((e) => reportError(String(e))),
    renameKey: (id, name) => api.renamePrivateKey(id, name).then(refreshWorkspace).catch((e) => reportError(String(e))),

    activeHostId,
    openTerminals: broadcastTargets,
    awsRefreshToken: awsIdentitiesEpoch,
    awsAlerts,
    vaultStatus,
    onVaultStatusChange: refreshVaultStatus,
    updatePreferences,

    openFleet,
    openNetDiag: () => openNetdiag(null),
  };

  // Resolves a tab to its host's group color tag (if the host, its group, and a
  // color are all set), so TabBar can show a small dot without knowing about hosts/groups.
  const tabColor = (tab: TabMeta): string | undefined => {
    if (!isHostBoundTab(tab)) return undefined;
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
      {searchHost && (
        <RemoteSearchPanel host={searchHost} onClose={() => setSearchHost(null)} onError={reportError} />
      )}
      {cloudImport === "picker" && (
        <CloudProviderPicker onPick={setCloudImport} onClose={() => setCloudImport(null)} />
      )}
      {cloudImport === "aws" && (
        <AwsImportPanel
          workspace={workspace}
          onWorkspaceUpdate={refreshWorkspace}
          onClose={() => setCloudImport(null)}
          onError={reportError}
          onConfigureSso={() => setAwsSsoOpen({ mode: "new" })}
          onReconnectSso={(session) => setAwsSsoOpen({ mode: "reconnect", session })}
          key={`aws-import-${awsProfilesEpoch}`}
        />
      )}
      {cloudImport === "azure" && (
        <AzureImportPanel
          workspace={workspace}
          onWorkspaceUpdate={refreshWorkspace}
          onClose={() => setCloudImport(null)}
          onError={reportError}
        />
      )}
      {cloudImport === "gcp" && (
        <GcpImportPanel
          workspace={workspace}
          onWorkspaceUpdate={refreshWorkspace}
          onClose={() => setCloudImport(null)}
          onError={reportError}
        />
      )}
      {ansibleImportOpen && (
        <AnsibleImportPanel
          workspace={workspace}
          onWorkspaceUpdate={refreshWorkspace}
          onClose={() => setAnsibleImportOpen(false)}
          onError={reportError}
        />
      )}
      {awsSsoOpen && (
        <AwsSsoSetupPanel
          onClose={() => { setAwsSsoOpen(null); setAwsIdentitiesEpoch((n) => n + 1); }}
          onProfilesCreated={() => { setAwsProfilesEpoch((n) => n + 1); setAwsIdentitiesEpoch((n) => n + 1); }}
          initialSession={awsSsoOpen.mode === "new" ? undefined : awsSsoOpen.session}
          startAt={awsSsoOpen.mode === "profiles" ? "accounts" : "form"}
        />
      )}
      {awsDbImportOpen && (
        <AwsDatabaseImportPanel
          workspace={workspace}
          onWorkspaceUpdate={refreshWorkspace}
          onClose={() => setAwsDbImportOpen(false)}
          onError={reportError}
          onReconnectSso={(session) => setAwsSsoOpen({ mode: "reconnect", session })}
          onConfigureSso={() => setAwsSsoOpen({ mode: "new" })}
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
            // Résolu au rendu plutôt que dans un effet : masquer le panneau
            // ouvert le fait retomber sur « Hôtes » tout de suite, et un
            // réglage posé dans une session précédente ne peut pas laisser un
            // panneau sans bouton au rechargement.
            panel={resolveVisiblePanel(sidebarPanel, preferences.hiddenSidebarButtons)}
            onPanelChange={setSidebarPanel}
            ctx={moduleContext}
            actions={sidebarActions}
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
                  // Plus aucun dispatch par `kind` ici : chaque onglet est
                  // rendu par son module. `App.tsx` ne garde que la coquille
                  // (montage/masquage, `key`, `Suspense`), qui est le shell
                  // d'onglets — noyau, non extensible.
                  return (
                    <div key={tab.id} className={isActive ? "absolute inset-0 flex flex-col" : "hidden"}>
                      <Suspense fallback={<TabLoadingFallback />}>
                        {renderModuleTab(tab, moduleContext, isActive)}
                      </Suspense>
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
