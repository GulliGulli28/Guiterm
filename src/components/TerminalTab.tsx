import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState, type MouseEvent } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { api, onTerminalClosed } from "../lib/api";
import { ConnectionFailed } from "./ConnectionFailed";
import type { Host, PersistenceOutcome, TerminalOpened } from "../lib/types";
import { assertNever } from "../lib/exhaustive";
import { nextClosureAction } from "../lib/terminalClosure";
import { observedFontSize } from "../lib/observedFont";
import type { AppPreferences } from "../lib/preferences";
import { DEFAULT_PREFERENCES, TERMINAL_THEMES, auroraLayerBackground } from "../lib/preferences";
import { shouldBubbleToShortcut } from "../lib/shortcuts";
import { TerminalSearchBar, type SearchOptions } from "./TerminalSearchBar";
import { createGhostTextController, type GhostSuggestion, type GhostTextController } from "../lib/ghostText";
import { createLongCommandWatcher } from "../lib/longCommand";
import { attachRenderStats, attachWebglRenderer, type RenderStats } from "../lib/xtermRenderer";
import { useTerminalZoom, zoomActionFromKey, zoomActionFromWheel, type ZoomAction } from "../lib/terminalZoom";
import { TerminalZoomBadge } from "./TerminalZoomBadge";

export interface TerminalTabHandle {
  runCommand: (command: string) => void;
  writeRaw: (data: string) => void;
  getScrollbackText: () => string;
  /** Backend session id and current geometry, for session recording — the
   * recorder lives in Rust but only xterm knows the real size. `null` before
   * the session is open (or after it closed), which is also the answer to
   * "can this tab be recorded right now". */
  getRecordingTarget: () => { sessionId: string; cols: number; rows: number } | null;
  /** Changes this terminal's own font size, leaving every other terminal and
   * the configured default alone. Normally driven by Ctrl+±/Ctrl+0 inside the
   * terminal itself; exposed so the command palette can reach the active tab
   * too. No-op for tabs that don't render text (RDP). */
  zoom: (action: ZoomAction) => void;
  dispose: () => void;
}

export function scrollbackText(term: Terminal): string {
  const buf = term.buffer.active;
  const lines: string[] = [];
  for (let i = 0; i < buf.length; i++) {
    lines.push(buf.getLine(i)?.translateToString(true) ?? "");
  }
  return lines.join("\n");
}

/** La ligne d'état écrite dans le terminal après une (re)connexion.
 *
 * `null` quand il n'y a rien à dire : une première ouverture qui n'était pas
 * censée être persistante n'a pas à commenter. Le seul message qui compte est
 * « tu retrouves ton travail » ou « non, tu repars de zéro », et c'est
 * précisément ce qu'une reconnexion silencieuse laissait deviner.
 */
function persistenceNotice(outcome: PersistenceOutcome, isRetry: boolean): string | null {
  switch (outcome) {
    case "resumed":
      return "\x1b[32m[session reprise — vous retrouvez le terminal tel que vous l'aviez laissé]\x1b[0m";
    case "unavailable":
      return "\x1b[33m[tmux introuvable sur cet hôte : session non persistante]\x1b[0m";
    case "created":
      // À la création il n'y a rien à reprendre — la promesse ne vaut que pour
      // la fois d'après, et l'annoncer à chaque ouverture serait du bruit.
      return isRetry ? "\x1b[33m[session persistante recréée — la précédente n'existait plus]\x1b[0m" : null;
    case "off":
      return isRetry ? "\x1b[32m[reconnecté]\x1b[0m" : null;
    default:
      return assertNever(outcome, "état de session persistante");
  }
}

interface TerminalTabProps {
  host: Host;
  isActive: boolean;
  preferences?: AppPreferences;
  onDisconnect?: () => void;
  /** Appelé à la place d'`onDisconnect` quand la session perdue est
   * persistante : elle tourne toujours sur l'hôte, donc l'onglet doit revenir
   * à l'état « vignette » et garder sa clé, pas disparaître avec. */
  onDetach?: () => void;
  // Called with each raw keystroke this terminal sends to its own session — used by
  // the live broadcast "synced typing" mode to mirror input to other terminals.
  onInputData?: (data: string) => void;
  /** Called when a command that ran a while finishes and this terminal isn't
   * what the user is looking at — see `lib/longCommand.ts`. */
  onLongCommand?: (command: string, durationMs: number, where: string) => void;
  /** Envoyée une fois la session ouverte — un `cd` quand l'onglet vient d'un
   * panneau de transfert. Jamais rejouée sur une reconnexion : elle
   * appartient à l'ouverture de l'onglet, pas à la session. */
  initialCommand?: string;
  /** When set, execs into this Docker container on `host` instead of opening an SSH shell. */
  dockerContainerId?: string;
  /** When set, execs into this pod (and, if given, container) on `host`
   * instead of opening an SSH shell — mutually exclusive with
   * `dockerContainerId`, both come from `host.kind`. */
  k8sPodName?: string;
  k8sContainerName?: string | null;
  /** La session persistante que cet onglet utilisait déjà, quand il en a une.
   * `undefined` à la première ouverture : le backend en nomme alors une, qui
   * remonte par `onSessionKey`. */
  sessionKey?: string;
  /** Observer la session sans pouvoir y taper : les frappes ne sont pas
   * envoyées, et le terminal adopte la taille de la session au lieu de la
   * sienne — s'attacher à une autre taille la redimensionnerait pour tous ceux
   * qui y sont attachés, `-r` ou pas (mesuré sur tmux 3.4). */
  readOnly?: boolean;
  /** Publie la clé pour que l'onglet la retienne — et donc la persiste. Sans
   * ça, la session survivrait côté serveur sans que rien ici sache la
   * retrouver, ce qui est exactement le contraire du but. */
  onSessionKey?: (key: string) => void;
}

export const TerminalTab = forwardRef<TerminalTabHandle, TerminalTabProps>(function TerminalTab({ host, isActive, preferences, onDisconnect, onDetach, onInputData, onLongCommand, initialCommand, dockerContainerId, k8sPodName, k8sContainerName, sessionKey, readOnly, onSessionKey }, ref) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const [status, setStatus] = useState<"connecting" | "open" | "failed">("connecting");
  const [error, setError] = useState("");
  // Incrémenté par « Réessayer » (`ConnectionFailed`) : seule dépendance de
  // l'effet de connexion en dehors de la cible, donc l'incrémenter rejoue tout
  // le cycle, nettoyage de la session précédente compris.
  const [attempt, setAttempt] = useState(0);

  const [searchOpen, setSearchOpen] = useState(false);
  const searchOpenRef = useRef(searchOpen);
  useEffect(() => { searchOpenRef.current = searchOpen; }, [searchOpen]);
  const preferencesRef = useRef(preferences);
  useEffect(() => { preferencesRef.current = preferences; }, [preferences]);
  const onInputDataRef = useRef(onInputData);
  useEffect(() => { onInputDataRef.current = onInputData; }, [onInputData]);
  const onLongCommandRef = useRef(onLongCommand);
  useEffect(() => { onLongCommandRef.current = onLongCommand; }, [onLongCommand]);
  const isActiveRef = useRef(isActive);
  useEffect(() => { isActiveRef.current = isActive; }, [isActive]);
  const readOnlyRef = useRef(readOnly ?? false);
  useEffect(() => { readOnlyRef.current = readOnly ?? false; }, [readOnly]);
  /** La taille imposée par la session observée, ou `null` quand ce terminal
   * suit sa propre fenêtre comme d'habitude. */
  const observedSizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const onDetachRef = useRef(onDetach);
  useEffect(() => { onDetachRef.current = onDetach; }, [onDetach]);
  const onSessionKeyRef = useRef(onSessionKey);
  useEffect(() => { onSessionKeyRef.current = onSessionKey; }, [onSessionKey]);
  // La clé vit dans une ref, pas dans les dépendances de l'effet : elle est
  // *semée* par la prop et *réécrite* par la première connexion, et la
  // reconnexion automatique doit reprendre celle-là — pas relancer l'effet, ce
  // qui détruirait le terminal qu'on est justement en train de rattraper.
  const sessionKeyRef = useRef<string | null>(sessionKey ?? null);
  /** Accorde la grille du terminal et le pty distant.
   *
   * Un seul endroit pour les quatre déclencheurs (connexion, conteneur
   * redimensionné, onglet réactivé, police changée) parce qu'ils n'ont plus la
   * même réponse : **en observation, la grille suit la session, pas la
   * fenêtre**. Redimensionner ici redimensionnerait la session pour tous ceux
   * qui y sont attachés — `tmux attach -r` n'y change rien (mesuré sur tmux
   * 3.4 : un client 80×24 fait passer une session 200×50 à 80×23).
   *
   * Ne lit que des refs, donc stable : les effets peuvent la capturer sans
   * craindre une fermeture périmée. */
  const syncGeometry = useCallback(() => {
    const term = termRef.current;
    if (!term) return;
    const observed = observedSizeRef.current;
    if (observed) {
      // La grille est celle de la session ; la seule variable qui reste est la
      // police. Sans elle, une session plus large que la fenêtre serait rognée
      // — on ne verrait qu'une partie de l'écran de quelqu'un d'autre, sans
      // rien pour le signaler. Voir `lib/observedFont.ts`.
      const proposed = fitRef.current?.proposeDimensions();
      if (proposed) {
        const next = observedFontSize({
          baseFontSize: preferencesRef.current?.terminalFontSize ?? DEFAULT_PREFERENCES.terminalFontSize,
          currentFontSize: term.options.fontSize ?? DEFAULT_PREFERENCES.terminalFontSize,
          proposedCols: proposed.cols,
          proposedRows: proposed.rows,
          targetCols: observed.cols,
          targetRows: observed.rows,
        });
        if (next !== null) term.options.fontSize = next;
      }
      if (term.cols !== observed.cols || term.rows !== observed.rows) {
        term.resize(observed.cols, observed.rows);
      }
    } else {
      fitRef.current?.fit();
      const id = sessionIdRef.current;
      if (id) api.resizeTerminal(id, term.cols, term.rows).catch(() => {});
    }
    ghostRef.current?.remeasure();
  }, []);

  const outerRef = useRef<HTMLDivElement>(null);
  const ghostRef = useRef<GhostTextController | null>(null);
  const [suggestion, setSuggestion] = useState<GhostSuggestion | null>(null);
  const [renderStats, setRenderStats] = useState<RenderStats | null>(null);
  const zoom = useTerminalZoom(preferences?.terminalFontSize ?? DEFAULT_PREFERENCES.terminalFontSize);
  // Read from the key/wheel handlers, which are installed once for the
  // session's whole lifetime — re-running that effect would tear down the SSH
  // connection.
  const applyZoomRef = useRef(zoom.apply);
  useEffect(() => { applyZoomRef.current = zoom.apply; }, [zoom.apply]);

  useImperativeHandle(
    ref,
    () => ({
      runCommand: (command: string) => {
        const id = sessionIdRef.current;
        if (!id) return;
        api.writeTerminal(id, new TextEncoder().encode(command + "\r"));
      },
      writeRaw: (data: string) => {
        const id = sessionIdRef.current;
        if (id) api.writeTerminal(id, new TextEncoder().encode(data));
      },
      getScrollbackText: () => (termRef.current ? scrollbackText(termRef.current) : ""),
      getRecordingTarget: () => {
        const id = sessionIdRef.current;
        const term = termRef.current;
        return id && term ? { sessionId: id, cols: term.cols, rows: term.rows } : null;
      },
      zoom: (action) => applyZoomRef.current(action),
      dispose: () => {
        const id = sessionIdRef.current;
        if (id) api.closeTerminal(id).catch(() => {});
      },
    }),
    [],
  );

  useEffect(() => {
    let disposed = false;
    let unlistenClosed: UnlistenFn | null = null;

    const term = new Terminal({
      cursorBlink: true,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      fontSize: 14,
      theme: { background: "#020617", foreground: "#e2e8f0" },
    });
    const fit = new FitAddon();
    const search = new SearchAddon();
    term.loadAddon(fit);
    term.loadAddon(search);
    // The WebGL renderer needs a terminal that's already attached to the DOM,
    // so it loads after `open()` — unlike fit/search, which don't care.
    let disposeRenderer: (() => void) | null = null;
    if (containerRef.current) {
      term.open(containerRef.current);
      disposeRenderer = attachWebglRenderer(term, {
        enabled: preferencesRef.current?.terminalWebglRenderer ?? true,
        onRenderer: (renderer) => setRenderStats((prev) => ({ renderer, msPerFrame: prev?.msPerFrame ?? 0 })),
      });
    }
    // Ctrl+wheel resizes this terminal. Registered in the capture phase, and
    // non-passive so it can be cancelled: xterm listens on its own inner
    // elements, and would otherwise scroll the scrollback at the same time.
    const wheelTarget = containerRef.current;
    const onWheel = (e: WheelEvent) => {
      const action = zoomActionFromWheel(e);
      if (!action) return;
      e.preventDefault();
      e.stopPropagation();
      applyZoomRef.current(action);
    };
    wheelTarget?.addEventListener("wheel", onWheel, { capture: true, passive: false });
    termRef.current = term;
    fitRef.current = fit;
    searchRef.current = search;

    // Watches for a long command finishing so the user can go and do
    // something else. Deliberately fed from the ghost-text controller's line
    // shadowing rather than a second parser of its own — see
    // `GhostTextDeps.onCommandSubmitted`.
    const longCommand = createLongCommandWatcher({
      // Read once per session: changing the preference applies to terminals
      // opened afterwards, like the other terminal settings here.
      thresholdMs: (preferencesRef.current?.longCommandNotifySecs ?? 0) * 1000,
      quietMs: 1_500,
    });
    const longCommandTimer = setInterval(() => {
      if ((preferencesRef.current?.longCommandNotifySecs ?? 0) === 0) return;
      const done = longCommand.poll(Date.now());
      // Only worth saying when the user isn't already looking at it — the
      // whole point is to be told while attention is elsewhere.
      if (done && (!document.hasFocus() || !isActiveRef.current)) {
        onLongCommandRef.current?.(done.command, done.durationMs, host.label);
      }
    }, 500);

    const ghost = createGhostTextController({
      term,
      containerRef,
      outerRef,
      isEnabled: () => preferencesRef.current?.sshTerminalSuggestions ?? false,
      isDisposed: () => disposed,
      sendInput: (data) => {
        const id = sessionIdRef.current;
        if (id) api.writeTerminal(id, new TextEncoder().encode(data));
      },
      getHistory: api.getSshHistory,
      // The host travels with the command purely for the activity journal —
      // ghost-text still reads back a plain list of strings, which is what
      // kept its own code and tests untouched by that feature.
      appendHistory: (command) => api.appendSshHistory(command, host.label),
      setSuggestion,
      onCommandSubmitted: (command) => longCommand.submit(command, Date.now()),
    });
    ghostRef.current = ghost;

    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      const zoomAction = zoomActionFromKey(e);
      if (zoomAction) {
        // Handled right here rather than as a global shortcut so the terminal
        // that has focus is the one that resizes — and swallowed outright
        // (`stopPropagation`) so the combo neither reaches the shell nor
        // bubbles up to a second handler that would apply it twice.
        e.preventDefault();
        e.stopPropagation();
        applyZoomRef.current(zoomAction);
        return false;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
        setSearchOpen(true);
        return false;
      }
      if (e.key === "Escape" && searchOpenRef.current) {
        setSearchOpen(false);
        return false;
      }
      if (ghost.handleAcceptKey(e)) {
        return false;
      }
      // Let a handful of app shortcuts (tab switching/closing, snippet quick-run) bubble
      // up to the window-level handler instead of being sent to the shell — otherwise
      // xterm consumes them (and stops their propagation), so they'd only ever fire
      // once before focus lands back in a terminal and swallows every further press.
      const shortcuts = preferencesRef.current?.keyboardShortcuts;
      if (shortcuts && shouldBubbleToShortcut(e, shortcuts)) {
        return false;
      }
      return true;
    });

    term.onData((data) => {
      // En observation, les frappes ne partent pas. tmux les ignorerait de
      // toute façon (`-r`), mais s'en remettre à lui donnerait un terminal qui
      // a l'air gelé ; les arrêter ici rend la promesse franche.
      if (readOnlyRef.current) return;
      if (sessionIdRef.current) {
        api.writeTerminal(sessionIdRef.current, new TextEncoder().encode(data));
      }
      onInputDataRef.current?.(data);
      ghost.handleOnData(data);
    });

    setStatus("connecting");
    setError("");

    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectAttempt = 0;

    // Called after the pty closes. Retries with a growing backoff when auto-reconnect
    // is on, otherwise falls back to the previous behavior (notify + let the tab close).
    const handleClosed = () => {
      sessionIdRef.current = null;
      setSuggestion(null);
      if (disposed) return;
      const maxAttempts = preferencesRef.current?.autoReconnectMaxAttempts ?? 5;
      // La décision est sortie du composant : elle croise trois règles (repli
      // exponentiel, épuisement des tentatives, session persistante ou non) et
      // se testait mal ici. Voir `lib/terminalClosure.ts`.
      const action = nextClosureAction({
        autoReconnect: preferencesRef.current?.autoReconnect ?? false,
        attempt: reconnectAttempt,
        maxAttempts,
        hasPersistentSession: sessionKeyRef.current !== null,
      });
      if (action.kind === "retry") {
        reconnectAttempt = action.attempt;
        term.write(`\r\n\x1b[33m[connexion perdue — reconnexion dans ${action.delaySec}s (tentative ${action.attempt}/${maxAttempts})]\x1b[0m\r\n`);
        setStatus("connecting");
        reconnectTimer = setTimeout(() => connect(true), action.delaySec * 1000);
      } else if (action.kind === "detach") {
        term.write("\r\n\x1b[33m[connexion perdue — la session est toujours ouverte sur l'hôte]\x1b[0m\r\n");
        setTimeout(() => { if (!disposed) onDetachRef.current?.(); }, 1000);
      } else {
        term.write("\r\n\x1b[31m[connexion fermée]\x1b[0m\r\n");
        setTimeout(() => { if (!disposed) onDisconnect?.(); }, 1000);
      }
    };

    const connect = async (isRetry: boolean) => {
      if (disposed) return;
      setStatus("connecting");
      try {
        const onData = (chunk: Uint8Array) => {
          longCommand.output(Date.now());
          term.write(chunk, () => ghost.handleOutputWritten());
        };
        let opened: TerminalOpened;
        // Docker/K8s exec n'ont ni session persistante ni observation : la
        // forme est complétée ici pour que la suite n'ait qu'un seul cas à
        // traiter.
        const plain = { sessionKey: null, persistence: "off" as const, readOnly: false, cols: 80, rows: 24 };
        if (k8sPodName) {
          const id = await api.connectK8sExec(host.id, k8sPodName, k8sContainerName ?? null, onData);
          opened = { sessionId: id, ...plain };
        } else if (dockerContainerId) {
          const id = await api.connectDockerExec(host.id, dockerContainerId, onData);
          opened = { sessionId: id, ...plain };
        } else {
          opened = await api.connectTerminal(host.id, {
            key: sessionKeyRef.current,
            readOnly: readOnly ?? false,
            // Jamais en observation : masquer ou montrer la barre changerait
            // l'apparence de la session pour ceux qui y travaillent.
            hideStatusBar: !readOnly && (preferencesRef.current?.tmuxHideStatusBar ?? true),
            // La molette : sans elle, remonter dans l'historique ne marche pas
            // en session persistante — tmux repeint l'écran entier, donc le
            // tampon de xterm est vide et l'historique vit dans tmux.
            mouse: !readOnly && (preferencesRef.current?.tmuxMouseMode ?? true),
          }, onData);
        }
        const id = opened.sessionId;
        if (disposed) {
          api.closeTerminal(id).catch(() => {});
          return;
        }
        if (opened.sessionKey && opened.sessionKey !== sessionKeyRef.current) {
          sessionKeyRef.current = opened.sessionKey;
          onSessionKeyRef.current?.(opened.sessionKey);
        }
        sessionIdRef.current = id;
        setStatus("open");
        reconnectAttempt = 0;

        unlistenClosed = await onTerminalClosed((eventId) => {
          if (eventId !== id) return;
          unlistenClosed?.();
          unlistenClosed = null;
          handleClosed();
        });

        // Ce que l'utilisateur doit savoir en une ligne : est-ce qu'il retrouve
        // son travail, ou est-ce qu'il repart de zéro ? Les quatre cas sont
        // fermés par `assertNever` — ajouter un état côté Rust sans décider de
        // ce qui s'affiche ici devient une erreur de compilation.
        const notice = persistenceNotice(opened.persistence, isRetry);
        if (notice) term.write(`\r\n${notice}\r\n`);
        observedSizeRef.current = opened.readOnly ? { cols: opened.cols, rows: opened.rows } : null;
        if (opened.readOnly) {
          term.write(`\r\n\x1b[36m[lecture seule — vos frappes ne sont pas envoyées ; affiché à la taille de la session (${opened.cols}×${opened.rows})]\x1b[0m\r\n`);
        }
        syncGeometry();

        // Le délai, comme dans `LocalTerminalTab` : le shell distant n'a pas
        // encore écrit son invite au moment où la session s'ouvre, et une
        // commande envoyée avant se perd dans l'initialisation.
        if (initialCommand && !isRetry) {
          setTimeout(() => {
            if (!disposed && sessionIdRef.current === id) {
              api.writeTerminal(id, new TextEncoder().encode(initialCommand + "\r")).catch(() => {});
            }
          }, 400);
        }
      } catch (e) {
        if (disposed) return;
        if (isRetry) {
          handleClosed();
        } else {
          setStatus("failed");
          setError(String(e));
        }
      }
    };

    connect(false);

    return () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      clearInterval(longCommandTimer);
      longCommand.reset();
      unlistenClosed?.();
      if (sessionIdRef.current) api.closeTerminal(sessionIdRef.current).catch(() => {});
      wheelTarget?.removeEventListener("wheel", onWheel, { capture: true });
      disposeRenderer?.();
      term.dispose();
    };
  }, [host.id, dockerContainerId, k8sPodName, k8sContainerName, attempt]);

  // Attached separately from the terminal's own lifecycle so toggling the
  // setting takes effect on already-open tabs — the whole point of the readout
  // is comparing the two renderers, which means seeing it appear on the
  // terminal you're already looking at rather than only on the next one.
  useEffect(() => {
    const term = termRef.current;
    if (!term || !preferences?.terminalRenderStats) return;
    return attachRenderStats(term, (msPerFrame) =>
      setRenderStats((prev) => ({ renderer: prev?.renderer ?? "dom", msPerFrame })),
    );
  }, [preferences?.terminalRenderStats]);

  // Re-fit whenever the container is resized (and is visible).
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(() => {
      if (!isActive) return;
      syncGeometry();
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [isActive, syncGeometry]);

  // Re-fit when this tab becomes active again (it was `display:none` before, so
  // xterm couldn't compute a meaningful size while hidden).
  useEffect(() => {
    if (isActive && termRef.current) {
      syncGeometry();
      termRef.current.focus();
    }
  }, [isActive, syncGeometry]);

  // Apply preferences dynamically whenever they change — and this terminal's
  // own zoom, which lands in the same place: changing the size means refitting
  // and telling the remote pty about the new geometry, whichever of the two
  // moved.
  useEffect(() => {
    const term = termRef.current;
    if (!term || !preferences) return;
    const themeEntry = TERMINAL_THEMES[preferences.terminalThemeName];
    if (themeEntry) term.options.theme = themeEntry.theme;
    term.options.fontFamily = preferences.terminalFontFamily;
    // En observation la police est calculée, pas choisie : `syncGeometry` la
    // recalcule juste après, et la fixer ici ferait clignoter l'affichage.
    if (!observedSizeRef.current) term.options.fontSize = zoom.fontSize;
    syncGeometry();
  }, [preferences, zoom.fontSize, syncGeometry]);

  const bgColor = preferences ? (TERMINAL_THEMES[preferences.terminalThemeName]?.theme.background ?? "#020617") : "#020617";

  const handleSearch = (value: string, direction: "next" | "prev", options: SearchOptions) => {
    if (!value) return;
    if (direction === "next") searchRef.current?.findNext(value, { incremental: true, ...options });
    else searchRef.current?.findPrevious(value, { ...options });
  };

  const handleContextMenu = (e: MouseEvent) => {
    if (!preferences?.terminalRightClickMenu) return;
    e.preventDefault();
    const term = termRef.current;
    const id = sessionIdRef.current;
    if (term?.hasSelection()) {
      const selection = term.getSelection();
      writeText(selection).catch(() => {});
      term.clearSelection();
      term.focus();
    } else if (id) {
      readText().then((text) => {
        if (text) api.writeTerminal(id, new TextEncoder().encode(text));
      }).catch(() => {});
      term?.focus();
    }
  };

  return (
    <div ref={outerRef} className="relative flex min-h-0 flex-1 flex-col p-2" style={{ background: auroraLayerBackground(bgColor) }} onContextMenu={handleContextMenu}>
      {status === "connecting" && <div className="absolute inset-0 flex items-center justify-center text-[var(--c-text-secondary)]">Connexion à {host.label}…</div>}
      {status === "failed" && (
        <ConnectionFailed
          overlay
          title={`Impossible de se connecter à « ${host.label} »`}
          error={error}
          onRetry={() => setAttempt((n) => n + 1)}
          onClose={() => onDisconnect?.()}
        />
      )}
      {searchOpen && <TerminalSearchBar onSearch={handleSearch} onClose={() => { setSearchOpen(false); termRef.current?.focus(); }} />}
      <div ref={containerRef} className={`min-h-0 flex-1 ${status === "open" ? "" : "invisible"}`} />
      {zoom.badgeVisible && <TerminalZoomBadge fontSize={zoom.fontSize} offset={zoom.offset} />}
      {preferences?.terminalRenderStats && renderStats && (
        <div
          className="pointer-events-none absolute right-3 top-3 select-none rounded bg-black/60 px-2 py-1 font-mono text-[11px] text-[var(--c-text-secondary)]"
          // 60 Hz leaves ~16.7 ms per frame; past that the terminal is behind
          // the output rather than keeping up with it.
          title="Moyenne du temps entre deux images rendues, pendant que la sortie défile"
        >
          {renderStats.renderer === "webgl" ? "GPU" : "DOM"}
          {renderStats.msPerFrame > 0 && (
            <span className={renderStats.msPerFrame > 16.7 ? " text-amber-400" : ""}>
              {" "}{renderStats.msPerFrame.toFixed(1)} ms/img
            </span>
          )}
        </div>
      )}
      {suggestion && (
        <span
          className="pointer-events-none absolute select-none whitespace-pre"
          style={{
            left: suggestion.left,
            top: suggestion.top,
            lineHeight: `${suggestion.cellHeight}px`,
            fontFamily: preferences?.terminalFontFamily,
            // The terminal's own size, not the configured one — the ghost text
            // has to line up with the characters actually on screen.
            fontSize: zoom.fontSize,
            color: "rgba(148, 163, 184, 0.55)",
          }}
        >
          {suggestion.text}
        </span>
      )}
    </div>
  );
});
