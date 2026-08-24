import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { api } from "../lib/api";
import { runOnTerminalHandle } from "../lib/runOnTerminalHandle";
import type { Host, HostId, SqlConnection, TabMeta, Workspace } from "../lib/types";
import { isHostBoundTab } from "../lib/types";
import type { AppPreferences } from "../lib/preferences";
import type { NotificationKind } from "../lib/notifications";
import { loadTabs, restoredTabStatus, saveTabs } from "../lib/tabPersistence";
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

  const openTab = useCallback((kind: "terminal" | "transfer" | "rdp-view", host: Host, dockerContainerId?: string, k8sPodName?: string, k8sContainerName?: string | null, initialCommand?: string) => {
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
    setTabs((prev) => [...prev, { id, kind, hostId: host.id, label, dockerContainerId, k8sPodName, k8sContainerName, initialCommand }]);
    setActiveTabId(id);
  }, []);

  /** Ouvre un terminal rattaché à une session persistante **précise**, au lieu
   * de laisser l'onglet en nommer une nouvelle. C'est la reprise depuis le
   * gestionnaire de sessions, et la seule voie par laquelle un onglet naît
   * avec une clé déjà connue.
   *
   * Si la session est déjà ouverte dans un onglet, on l'active plutôt que d'en
   * ouvrir un second : tmux attacherait les deux clients à la même session et
   * calerait la fenêtre sur le plus petit des deux, ce qui donne un terminal
   * tronqué sans rien pour l'expliquer. */
  const openPersistentSession = useCallback((host: Host, sessionKey: string, readOnly = false) => {
    // La déduplication compare aussi le mode : observer une session qu'on a
    // déjà ouverte en écriture est une demande légitime (regarder sans risquer
    // de taper), et les deux onglets ne montrent pas la même chose.
    const existing = tabs.find((t) =>
      t.kind === "terminal" && t.sessionKey === sessionKey && !!t.readOnly === readOnly);
    if (existing) { setActiveTabId(existing.id); return; }
    const id = `tab-${nextTabId++}`;
    setTabs((prev) => [...prev, {
      id, kind: "terminal", hostId: host.id,
      label: readOnly ? `${host.label} (observation)` : host.label,
      sessionKey, readOnly: readOnly || undefined,
    }]);
    setActiveTabId(id);
  }, [tabs]);

  const openLocalTerminal = useCallback((initialCommand?: string, shell?: string | null) => {
    const id = `tab-${nextTabId++}`;
    // Le libellé ne vaut que pour la voie « quickSSH » : une commande
    // initiale peut aussi être un simple `cd` (onglet ouvert depuis un
    // panneau de transfert), qui n'a rien à faire dans le titre.
    const label = initialCommand?.startsWith("ssh ") ? `ssh ${initialCommand.slice(4)}` : "Terminal local";
    setTabs((prev) => [...prev, { id, kind: "local-terminal", label, initialCommand, shell: shell ?? preferences.defaultLocalShell }]);
    setActiveTabId(id);
  }, [preferences.defaultLocalShell]);

  // Only one Fleet tab makes sense at a time (it isn't host-scoped like a
  // terminal/transfer tab) — focus the existing one instead of piling up
  // duplicates when opened repeatedly from the toolbar button.
  //
  // **The id is minted and the tab activated outside the `setTabs` updater**,
  // like `openTab`/`openLocalTerminal` above. These three used to do both
  // *inside* it, which is a side effect in a function React treats as pure:
  // StrictMode invokes it twice, so `nextTabId++` ran twice and
  // `setActiveTabId` was called with an id that wasn't the one kept in state.
  // The tab appeared in the bar and stayed hidden, because `isActive` was
  // false for every tab. Only visible in dev builds (StrictMode is a
  // development-only behaviour), which is why it survived until an E2E
  // scenario opened one of these tabs from the palette.
  const openFleet = useCallback(() => {
    const existing = tabs.find((t) => t.kind === "fleet");
    if (existing) {
      setActiveTabId(existing.id);
      return;
    }
    const id = `tab-${nextTabId++}`;
    setTabs((prev) => [...prev, { id, kind: "fleet", label: "Opérations de flotte" }]);
    setActiveTabId(id);
  }, [tabs]);

  /** Same single-tab rule as `openFleet`, for the same reason: the journal is
   * global, not scoped to anything, so a second one would show the same thing
   * twice. */
  const openActivity = useCallback(() => {
    const existing = tabs.find((t) => t.kind === "activity");
    if (existing) {
      setActiveTabId(existing.id);
      return;
    }
    const id = `tab-${nextTabId++}`;
    setTabs((prev) => [...prev, { id, kind: "activity", label: "Activité" }]);
    setActiveTabId(id);
  }, [tabs]);

  /** Opens the diagnostics tab, optionally aimed at an address already known.
   *
   * A singleton like the fleet and activity tabs. Reopening it with a new
   * destination re-aims the existing tab rather than stacking a second one:
   * the panel this replaced was a modal, and people open it repeatedly from
   * different hosts during one incident. */
  const openNetdiag = useCallback((sourceHostId?: HostId | null) => {
    const existing = tabs.find((t) => t.kind === "netdiag");
    if (existing) {
      if (sourceHostId) {
        setTabs((prev) => prev.map((t) => (t.id === existing.id ? { ...t, sourceHostId } : t)));
      }
      setActiveTabId(existing.id);
      return;
    }
    const id = `tab-${nextTabId++}`;
    setTabs((prev) => [
      ...prev,
      { id, kind: "netdiag", label: "Diagnostic réseau", sourceHostId: sourceHostId ?? null },
    ]);
    setActiveTabId(id);
  }, [tabs]);

  // One tab per SQL connection — reopening an already-open connection just
  // focuses it, same idea as `openFleet`'s single-tab dedup (there, a global
  // singleton; here, keyed per connection so different connections can each
  // have their own tab).
  const openSql = useCallback((conn: SqlConnection) => {
    const existing = tabs.find((t) => t.kind === "sql" && t.sqlConnectionId === conn.id);
    if (existing) {
      setActiveTabId(existing.id);
      return;
    }
    const id = `tab-${nextTabId++}`;
    setTabs((prev) => [...prev, { id, kind: "sql", label: conn.label, sqlConnectionId: conn.id }]);
    setActiveTabId(id);
  }, [tabs]);

  const reconnectTab = useCallback((id: string) => {
    setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, status: "connected" } : t)));
  }, []);

  /** Retient la session persistante qu'un terminal vient d'ouvrir.
   *
   * Le backend nomme la session, mais c'est ici qu'elle prend de la valeur :
   * portée par l'onglet, elle est persistée avec lui, donc retrouvable au
   * lancement suivant. Volontairement étroit plutôt qu'un `updateTab`
   * générique — c'est le seul champ qu'un onglet apprend de sa propre
   * session. */
  const rememberSessionKey = useCallback((tabId: string, sessionKey: string) => {
    setTabs((prev) => prev.map((t) => (
      t.id === tabId && t.kind === "terminal" && t.sessionKey !== sessionKey
        ? { ...t, sessionKey }
        : t
    )));
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
        id, kind: p.kind, hostId: p.hostId, label: p.label,
        // Un onglet porteur d'une session persistante peut se rouvrir tout
        // seul, si la préférence le dit — voir `restoredTabStatus`.
        status: restoredTabStatus(p, preferences.resumePersistentTabsOnLaunch),
        dockerContainerId: p.dockerContainerId, k8sPodName: p.k8sPodName, k8sContainerName: p.k8sContainerName,
        // Restauré comme le reste : c'est ce qui fait qu'un onglet rouvert
        // après un redémarrage se rattache à sa session au lieu d'en créer une
        // deuxième, laissant la première tourner pour rien sur le serveur.
        sessionKey: p.sessionKey,
        readOnly: p.readOnly,
      }];
    });
    if (restored.length > 0) {
      setTabs(restored);
      setActiveTabId(restored[0].id);
    }
  }, [workspace, preferences.restoreTabsOnLaunch, preferences.resumePersistentTabsOnLaunch]);

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

  /** Rend l'onglet à l'état « vignette » au lieu de le fermer.
   *
   * Ce qu'un onglet persistant doit faire quand sa connexion tombe. Le fermer
   * — ce que fait `closeTab(id, "disconnected")` — emporterait sa clé de
   * session, et la session continuerait de tourner sur le serveur sans plus
   * rien pour la retrouver depuis l'onglet. La vignette, elle, garde la clé et
   * propose de reprendre.
   *
   * C'est le cas courant, pas un cas limite : la reconnexion automatique est
   * désactivée par défaut, donc une coupure de VPN passe par ici. */
  const detachTab = useCallback((id: string) => {
    terminalRefs.current.get(id)?.dispose();
    terminalRefs.current.delete(id);
    setTabs((prev) => {
      const tab = prev.find((t) => t.id === id);
      if (!tab || tab.status === "placeholder") return prev;
      if (preferences.notifyOnDisconnect !== false) {
        pushNotification("error", `Connexion perdue : ${tab.label} — la session est toujours ouverte sur l'hôte`);
      }
      return prev.map((t) => (t.id === id ? { ...t, status: "placeholder" } : t));
    });
  }, [preferences.notifyOnDisconnect, pushNotification, terminalRefs]);

  // Closing a tab with a live SSH session is easy to trigger by accident (a stray
  // Ctrl+Shift+W, a misclick) and kills the remote session outright, so it goes
  // through a confirmation instead of closing immediately.
  //
  // **Sauf en session persistante** : là, fermer ne coupe rien — tmux détache
  // son client et la session continue de tourner. Demander confirmation
  // reviendrait à avertir d'un danger qui n'existe pas, et à réintroduire la
  // friction que la fonctionnalité sert justement à retirer. La punaise dans la
  // barre d'onglets dit en permanence que fermer est sans conséquence, et le
  // gestionnaire de sessions permet de terminer pour de bon.
  const [pendingCloseTabId, setPendingCloseTabId] = useState<string | null>(null);
  const requestCloseTab = useCallback((id: string) => {
    const tab = tabs.find((t) => t.id === id);
    const persistent = tab?.kind === "terminal" && !!tab.sessionKey;
    if (tab && tab.kind === "terminal" && tab.status !== "placeholder" && !persistent) {
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

  // Session ids being recorded, mirrored from the backend (which owns the
  // truth) so the palette can offer start or stop for the active tab.
  const [recordingSessionIds, setRecordingSessionIds] = useState<string[]>([]);
  const refreshRecordings = useCallback(() => {
    api.recordingSessionIds().then(setRecordingSessionIds).catch(() => {});
  }, []);
  useEffect(() => { refreshRecordings(); }, [refreshRecordings]);

  /** Whether the active tab is a terminal currently being recorded — drives
   * which of the two palette entries is offered. */
  const activeTabRecording = useCallback(() => {
    if (!activeTabId) return false;
    const target = terminalRefs.current.get(activeTabId)?.getRecordingTarget?.() ?? null;
    return target !== null && recordingSessionIds.includes(target.sessionId);
  }, [activeTabId, recordingSessionIds, terminalRefs]);

  const startActiveRecording = useCallback(async () => {
    if (!activeTabId) { reportError("Aucun terminal actif à enregistrer"); return; }
    const target = terminalRefs.current.get(activeTabId)?.getRecordingTarget?.() ?? null;
    if (!target) { reportError("L'onglet actif n'est pas un terminal connecté"); return; }
    const tabLabel = tabs.find((t) => t.id === activeTabId)?.label ?? "session";
    const path = await save({
      // `.cast` is what asciinema itself writes and what its player expects.
      defaultPath: `${tabLabel.replace(/[^\w.-]+/g, "_")}.cast`,
      filters: [{ name: "Enregistrement asciicast", extensions: ["cast"] }],
    }).catch(() => null);
    if (!path) return;
    // The host's own label, not the tab's: a second tab on the same host is
    // labelled "web-01 (2)", and the activity journal would then list two
    // hosts that don't exist. `null` for a local terminal, which the journal
    // renders as "cette machine".
    const tab = tabs.find((t) => t.id === activeTabId);
    const host = tab && isHostBoundTab(tab) ? (workspace?.hosts.find((h) => h.id === tab.hostId)?.label ?? null) : null;
    try {
      await api.startSessionRecording(target.sessionId, path, target.cols, target.rows, host);
      refreshRecordings();
      pushNotification("success", `Enregistrement en cours vers ${path}`);
    } catch (e) { reportError(String(e)); }
  }, [activeTabId, tabs, workspace, terminalRefs, pushNotification, reportError, refreshRecordings]);

  const stopActiveRecording = useCallback(async () => {
    if (!activeTabId) return;
    const target = terminalRefs.current.get(activeTabId)?.getRecordingTarget?.() ?? null;
    if (!target) return;
    try {
      await api.stopSessionRecording(target.sessionId);
      pushNotification("success", "Enregistrement arrêté — le fichier est complet.");
    } catch (e) { reportError(String(e)); }
    refreshRecordings();
  }, [activeTabId, terminalRefs, pushNotification, reportError, refreshRecordings]);

  return {
    tabs, setTabs, activeTabId, setActiveTabId,
    pendingCloseTabId, setPendingCloseTabId,
    openTab, openPersistentSession, openLocalTerminal, openFleet, openActivity, openNetdiag, openSql, reconnectTab,
    rememberSessionKey,
    closeTab, detachTab, requestCloseTab,
    activeTabRecording, startActiveRecording, stopActiveRecording,
    runSnippet, runAdaptiveSnippet, exportActiveScrollback,
  };
}
