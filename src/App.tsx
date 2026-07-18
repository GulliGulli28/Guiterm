import { useCallback, useEffect, useRef, useState } from "react";
import { check as checkForUpdate } from "@tauri-apps/plugin-updater";
import { save } from "@tauri-apps/plugin-dialog";
import { api, bytesToBase64 } from "./lib/api";
import type { GroupId, Host, HostId, TabMeta, VaultStatus, Workspace } from "./lib/types";
import { Sidebar, type SidebarPanelKind } from "./components/Sidebar";
import { HostForm } from "./components/HostForm";
import { TabBar } from "./components/TabBar";
import { BroadcastBar } from "./components/BroadcastBar";
import { TerminalTab, type TerminalTabHandle } from "./components/TerminalTab";
import { LocalTerminalTab } from "./components/LocalTerminalTab";
import { TransferTab } from "./components/TransferTab";
import { RdpTab } from "./components/RdpTab";
import { FleetTab } from "./components/FleetTab";
import { TitleBar } from "./components/TitleBar";
import { type AppPreferences, type UiAccent, ACCENT_COLORS, BG_THEMES, loadPreferences, savePreferences } from "./lib/preferences";
import { SplitPane } from "./components/SplitPane";
import { GroupForm, type GroupFormData } from "./components/GroupForm";
import { IconTerminal, IconClose } from "./components/ui-icons";
import { CommandPalette, type PaletteCommand } from "./components/CommandPalette";
import { SnippetPicker } from "./components/SnippetPicker";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { VaultUnlockModal } from "./components/VaultUnlockModal";
import { SHORTCUT_ACTIONS, useGlobalShortcuts } from "./lib/shortcuts";
import { loadTabs, saveTabs } from "./lib/tabPersistence";
import { useNotifications } from "./hooks/useNotifications";
import { useResizablePane } from "./hooks/useResizablePane";

let nextTabId = 0;
const SPLIT_PANE_ID = "split-pane";

// `shellCapable`: false for an RDP target (see `RdpTab.tsx`'s handle) — it
// has no shell/PTY to pipe a base64-decoded script into, so a multi-line
// command is instead typed as-is (its own `runCommand` turns each embedded
// `\n` into a real Enter keypress line by line, unrelated to this wrapping).
function runOnTerminalHandle(handle: TerminalTabHandle, command: string, shellCapable: boolean) {
  if (shellCapable && command.includes("\n")) {
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
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [snippetPickerOpen, setSnippetPickerOpen] = useState(false);
  const terminalRefs = useRef<Map<string, TerminalTabHandle>>(new Map());

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

  // ── Tab management ───────────────────────────────────────────────────────
  const openTab = useCallback((kind: "terminal" | "transfer" | "rdp-view", host: Host, dockerContainerId?: string) => {
    const id = `tab-${nextTabId++}`;
    const label = kind === "transfer"
      ? `Transfert : ${host.label}`
      : kind === "rdp-view"
        ? `Aperçu : ${host.label}`
        : (dockerContainerId ? `${host.label} : ${dockerContainerId}` : host.label);
    setTabs((prev) => [...prev, { id, kind, hostId: host.id, label, dockerContainerId }]);
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
        return [{ id, kind: "local-terminal", label: p.label, status: "placeholder", shell: p.shell }];
      }
      if (!p.hostId || !workspace.hosts.some((h) => h.id === p.hostId)) return [];
      return [{ id, kind: p.kind, hostId: p.hostId, label: p.label, status: "placeholder", dockerContainerId: p.dockerContainerId }];
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
  }, [activeTabId, reportError, tabs]);

  // Runs an adaptive (DSL) snippet on specific tabs, or the active tab when
  // no target is given — same convention as `runSnippet`. Unlike a classic
  // snippet, `programText` isn't a runnable command by itself: each target's
  // platform determines what actually gets typed (see `core::adaptive`), so
  // this resolves per target before running the *translated* command.
  // Three kinds of target are supported, each with its own way of finding
  // out "what platform is this": an SSH host's last collected facts
  // (batched through `previewAdaptiveProgram`, collecting first if missing —
  // same as `FleetTab`'s "Prévisualiser"), a Docker exec container (probed
  // fresh via `composeAdaptiveForDocker`, one call per target — no facts to
  // reuse across calls, a `dockerExec` host isn't tied to one container),
  // or a local terminal's shell (`composeAdaptiveForLocal` — instant for a
  // native Windows shell, probed locally otherwise). RDP and anything else
  // is reported and skipped rather than silently typing the raw DSL text.
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

      const ineligible = () => reportError(`« ${tab.label} » : un snippet adaptatif ne peut s'exécuter que sur un terminal local, un hôte SSH ou Docker exec`);
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
  }, [activeTabId, tabs, workspace, reportError, refreshWorkspace]);

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
  }, [activeTabId, tabs, reportError]);

  // ── Broadcast: send one command to a chosen set of open terminals ───────
  const [broadcastMode, setBroadcastMode] = useState(false);
  const splitPaneLabel = splitSource === "local"
    ? "Terminal local (panneau 2)"
    : `${workspace?.hosts.find((h) => h.id === splitSource)?.label ?? "Hôte"} (panneau 2)`;
  // The split view's second panel is a standalone terminal outside the tab list, so
  // it has to be added to the broadcast/snippet target list by hand.
  const broadcastTargets: { id: string; label: string }[] = [
    ...tabs
      .filter((t) => (t.kind === "terminal" || t.kind === "local-terminal" || t.kind === "rdp-view") && t.status !== "placeholder")
      .map((t) => ({ id: t.id, label: t.label })),
    ...(splitOpen ? [{ id: SPLIT_PANE_ID, label: splitPaneLabel }] : []),
  ];
  const [broadcastSelected, setBroadcastSelected] = useState<Set<string>>(new Set());

  // Terminals that open *after* broadcast mode was turned on (a new tab, the split
  // view's second panel, …) join the selection automatically, and ones that close
  // (including the split view's panel) drop out of both the selection and the count.
  // A brand-new id is only auto-added the first time it's ever seen — reordering tabs
  // (or any other change that merely re-triggers this effect) must never resurrect a
  // target the user deliberately unchecked earlier.
  const knownTargetIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const currentIds = new Set(broadcastTargets.map((t) => t.id));
    const previouslyKnown = knownTargetIdsRef.current;
    if (broadcastMode) {
      setBroadcastSelected((prev) => {
        const next = new Set(prev);
        let changed = false;
        for (const id of prev) {
          if (!currentIds.has(id)) { next.delete(id); changed = true; }
        }
        for (const id of currentIds) {
          if (!previouslyKnown.has(id) && !next.has(id)) { next.add(id); changed = true; }
        }
        return changed ? next : prev;
      });
    }
    knownTargetIdsRef.current = currentIds;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [broadcastMode, tabs, splitOpen, splitSource]);

  // Not a useCallback: it needs the current render's `broadcastTargets` (which
  // depends on `tabs`, `splitOpen`, `splitSource`, `workspace`), and memoizing on
  // an incomplete dep list previously meant opening the split view (which doesn't
  // touch `tabs`) left this closure holding a stale target list — so turning
  // broadcast on right after would silently miss the split pane.
  const toggleBroadcastMode = () => {
    setBroadcastMode((v) => {
      const next = !v;
      if (next) setBroadcastSelected(new Set(broadcastTargets.map((t) => t.id)));
      else setLiveSyncMode(false);
      return next;
    });
  };

  const broadcastCommand = useCallback((command: string) => {
    for (const id of broadcastSelected) {
      const handle = terminalRefs.current.get(id);
      if (handle) runOnTerminalHandle(handle, command, tabs.find((t) => t.id === id)?.kind !== "rdp-view");
    }
  }, [broadcastSelected, tabs]);

  // Live mode: keystrokes typed into whichever terminal has focus are mirrored, as
  // raw input, to every other selected terminal — unlike broadcastCommand above,
  // which sends one discrete command at a time to all of them.
  const [liveSyncMode, setLiveSyncMode] = useState(false);
  const mirrorInput = useCallback((sourceTabId: string, data: string) => {
    if (!liveSyncMode) return;
    for (const id of broadcastSelected) {
      if (id === sourceTabId) continue;
      terminalRefs.current.get(id)?.writeRaw(data);
    }
  }, [liveSyncMode, broadcastSelected]);

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
    {
      id: "terminal.exportScrollback",
      label: "Exporter le scrollback du terminal actif…",
      run: () => { exportActiveScrollback(); },
    },
    {
      id: "fleet.open",
      label: "Opérations de flotte — exécuter sur plusieurs hôtes…",
      run: () => openFleet(),
    },
  ] : [];

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
  const activeHostId = activeTab && activeTab.kind !== "local-terminal" && activeTab.kind !== "fleet" ? activeTab.hostId : null;

  // Resolves a tab to its host's group color tag (if the host, its group, and a
  // color are all set), so TabBar can show a small dot without knowing about hosts/groups.
  const tabColor = (tab: TabMeta): string | undefined => {
    if (tab.kind === "local-terminal" || tab.kind === "fleet") return undefined;
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
      {paletteOpen && <CommandPalette commands={paletteCommands} onClose={() => setPaletteOpen(false)} />}
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
          onSelect={setActiveTabId}
          onClose={requestCloseTab}
          onToggleSplit={toggleSplit}
          onToggleBroadcast={toggleBroadcastMode}
          onOpenFleet={openFleet}
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
            onConnectRdpView={(host) => openTab("rdp-view", host)}
            onOpenTransfer={(host, containerId) => openTab("transfer", host, containerId)}
            onOpenLocalTerminal={(shell) => openLocalTerminal(undefined, shell)}
            onQuickSSH={(cmd) => openLocalTerminal(cmd)}
            onNewHost={() => { setEditingHost("new"); setNewHostDefaultGroupId(null); setEditingGroup(null); }}
            onEditHost={(host) => { setEditingHost(host); setEditingGroup(null); }}
            onNewGroup={() => { setEditingGroup({ id: null, name: "", parentId: null, icon: null, color: null }); setEditingHost(null); }}
            onNewHostInGroup={(groupId) => { setEditingHost("new"); setNewHostDefaultGroupId(groupId); setEditingGroup(null); }}
            onNewGroupUnder={(parentId) => { setEditingGroup({ id: null, name: "", parentId, icon: null, color: null }); setEditingHost(null); }}
            onEditGroup={(group) => { setEditingGroup({ id: group.id, name: group.name, parentId: group.parentId ?? null, icon: group.icon ?? null, color: group.color ?? null }); setEditingHost(null); }}
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
                        <FleetTab workspace={workspace} onError={reportError} onWorkspaceUpdate={refreshWorkspace} />
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
                          onInputData={(data) => mirrorInput(tab.id, data)}
                          dockerContainerId={tab.kind === "terminal" ? tab.dockerContainerId : undefined}
                          ref={(handle) => {
                            if (handle) terminalRefs.current.set(tab.id, handle);
                            else terminalRefs.current.delete(tab.id);
                          }}
                        />
                      ) : tab.kind === "rdp-view" ? (
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
                      ) : (
                        <TransferTab
                          host={host}
                          workspace={workspace}
                          preferences={preferences}
                          onError={reportError}
                          onPushed={(message) => pushNotification("success", message)}
                          dockerContainerId={tab.kind === "transfer" ? tab.dockerContainerId : undefined}
                        />
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
        </div>
      </div>
    </div>
  );
}
