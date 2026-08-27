import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type MouseEvent } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { api, onTerminalClosed } from "../lib/api";
import { ConnectionFailed } from "./ConnectionFailed";
import { scrollbackText, type TerminalTabHandle } from "./TerminalTab";
import type { AppPreferences } from "../lib/preferences";
import { DEFAULT_PREFERENCES, TERMINAL_THEMES, auroraLayerBackground } from "../lib/preferences";
import { shouldBubbleToShortcut } from "../lib/shortcuts";
import { TerminalSearchBar, type SearchOptions } from "./TerminalSearchBar";
import { createGhostTextController, type GhostSuggestion, type GhostTextController } from "../lib/ghostText";
import { createLongCommandWatcher } from "../lib/longCommand";
import { attachRenderStats, attachWebglRenderer, type RenderStats } from "../lib/xtermRenderer";
import { useTerminalZoom, zoomActionFromKey, zoomActionFromWheel } from "../lib/terminalZoom";
import { TerminalZoomBadge } from "./TerminalZoomBadge";

export { type TerminalTabHandle };

interface LocalTerminalTabProps {
  isActive: boolean;
  preferences?: AppPreferences;
  initialCommand?: string;
  shell?: string | null;
  onDisconnect?: () => void;
  onInputData?: (data: string) => void;
  onLongCommand?: (command: string, durationMs: number, where: string) => void;
}

export const LocalTerminalTab = forwardRef<TerminalTabHandle, LocalTerminalTabProps>(function LocalTerminalTab({ isActive, preferences, initialCommand, shell, onDisconnect, onInputData, onLongCommand }, ref) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const [status, setStatus] = useState<"connecting" | "open" | "failed">("connecting");
  const [error, setError] = useState("");
  // Incrémenté par « Réessayer » (`ConnectionFailed`) : seule dépendance de
  // l'effet de connexion en dehors du shell, donc l'incrémenter rejoue tout
  // le cycle, nettoyage de la session précédente compris.
  const [attempt, setAttempt] = useState(0);

  const [searchOpen, setSearchOpen] = useState(false);
  const searchOpenRef = useRef(searchOpen);
  useEffect(() => { searchOpenRef.current = searchOpen; }, [searchOpen]);
  const preferencesRef = useRef(preferences);
  useEffect(() => { preferencesRef.current = preferences; }, [preferences]);
  const onLongCommandRef = useRef(onLongCommand);
  useEffect(() => { onLongCommandRef.current = onLongCommand; }, [onLongCommand]);
  const isActiveRef = useRef(isActive);
  useEffect(() => { isActiveRef.current = isActive; }, [isActive]);
  const onInputDataRef = useRef(onInputData);
  useEffect(() => { onInputDataRef.current = onInputData; }, [onInputData]);
  const outerRef = useRef<HTMLDivElement>(null);
  const ghostRef = useRef<GhostTextController | null>(null);
  const [suggestion, setSuggestion] = useState<GhostSuggestion | null>(null);
  const [renderStats, setRenderStats] = useState<RenderStats | null>(null);
  const zoom = useTerminalZoom(preferences?.terminalFontSize ?? DEFAULT_PREFERENCES.terminalFontSize);
  // See `TerminalTab` — read from handlers installed once for the session's
  // whole lifetime.
  const applyZoomRef = useRef(zoom.apply);
  useEffect(() => { applyZoomRef.current = zoom.apply; }, [zoom.apply]);

  useImperativeHandle(
    ref,
    () => ({
      runCommand: (command: string) => {
        const id = sessionIdRef.current;
        if (!id) return;
        api.writeLocalTerminal(id, new TextEncoder().encode(command + "\r"));
      },
      writeRaw: (data: string) => {
        const id = sessionIdRef.current;
        if (id) api.writeLocalTerminal(id, new TextEncoder().encode(data));
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
        if (id) api.closeLocalTerminal(id).catch(() => {});
      },
    }),
    [],
  );

  useEffect(() => {
    let disposed = false;
    let unlistenClosed: UnlistenFn | null = null;
    setStatus("connecting");
    setError("");

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
    // Ctrl+wheel resizes this terminal — see `TerminalTab` for why this is
    // registered in the capture phase and non-passive.
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

    // See `TerminalTab` for why this is fed from the ghost-text controller's
    // line shadowing rather than parsing keystrokes a second time here.
    const longCommand = createLongCommandWatcher({
      thresholdMs: (preferencesRef.current?.longCommandNotifySecs ?? 0) * 1000,
      quietMs: 1_500,
    });
    const longCommandTimer = setInterval(() => {
      if ((preferencesRef.current?.longCommandNotifySecs ?? 0) === 0) return;
      const done = longCommand.poll(Date.now());
      if (done && (!document.hasFocus() || !isActiveRef.current)) {
        onLongCommandRef.current?.(done.command, done.durationMs, "terminal local");
      }
    }, 500);

    const ghost = createGhostTextController({
      term,
      containerRef,
      outerRef,
      isEnabled: () => preferencesRef.current?.localTerminalSuggestions ?? true,
      isDisposed: () => disposed,
      sendInput: (data) => {
        const id = sessionIdRef.current;
        if (id) api.writeLocalTerminal(id, new TextEncoder().encode(data));
      },
      onCommandSubmitted: (command) => longCommand.submit(command, Date.now()),
      getHistory: api.getLocalHistory,
      appendHistory: api.appendLocalHistory,
      setSuggestion,
    });
    ghostRef.current = ghost;

    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      const zoomAction = zoomActionFromKey(e);
      if (zoomAction) {
        // See `TerminalTab` — kept terminal-local, and swallowed so it neither
        // reaches the shell nor gets applied twice.
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
      if (sessionIdRef.current) {
        api.writeLocalTerminal(sessionIdRef.current, new TextEncoder().encode(data));
      }
      onInputDataRef.current?.(data);
      ghost.handleOnData(data);
    });

    (async () => {
      try {
        const onData = (chunk: Uint8Array) => {
          longCommand.output(Date.now());
          term.write(chunk, () => ghost.handleOutputWritten());
        };
        const id = await api.openLocalTerminal(shell ?? null, onData);
        if (disposed) {
          api.closeLocalTerminal(id).catch(() => {});
          return;
        }
        sessionIdRef.current = id;
        setStatus("open");

        unlistenClosed = await onTerminalClosed((eventId) => {
          if (eventId !== id) return;
          term.write("\r\n\x1b[31m[terminal fermé]\x1b[0m\r\n");
          setTimeout(() => { if (!disposed) onDisconnect?.(); }, 1000);
        });

        fit.fit();
        api.resizeLocalTerminal(id, term.cols, term.rows).catch(() => {});
        ghost.remeasure();

        if (initialCommand) {
          setTimeout(() => {
            if (!disposed) {
              api.writeLocalTerminal(id, new TextEncoder().encode(initialCommand + "\r")).catch(() => {});
            }
          }, 400);
        }
      } catch (e) {
        if (!disposed) {
          setStatus("failed");
          setError(String(e));
        }
      }
    })();

    return () => {
      disposed = true;
      clearInterval(longCommandTimer);
      longCommand.reset();
      unlistenClosed?.();
      if (sessionIdRef.current) api.closeLocalTerminal(sessionIdRef.current).catch(() => {});
      wheelTarget?.removeEventListener("wheel", onWheel, { capture: true });
      disposeRenderer?.();
      term.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt]);

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

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(() => {
      if (!isActive || !fitRef.current || !termRef.current) return;
      fitRef.current.fit();
      const id = sessionIdRef.current;
      if (id) api.resizeLocalTerminal(id, termRef.current.cols, termRef.current.rows).catch(() => {});
      ghostRef.current?.remeasure();
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [isActive]);

  useEffect(() => {
    if (isActive && fitRef.current && termRef.current) {
      fitRef.current.fit();
      const id = sessionIdRef.current;
      if (id) api.resizeLocalTerminal(id, termRef.current.cols, termRef.current.rows).catch(() => {});
      termRef.current.focus();
      ghostRef.current?.remeasure();
    }
  }, [isActive]);

  // Apply preferences dynamically whenever they change — and this terminal's
  // own zoom, which needs the same refit + pty resize.
  useEffect(() => {
    const term = termRef.current;
    if (!term || !preferences) return;
    const themeEntry = TERMINAL_THEMES[preferences.terminalThemeName];
    if (themeEntry) term.options.theme = themeEntry.theme;
    term.options.fontFamily = preferences.terminalFontFamily;
    term.options.fontSize = zoom.fontSize;
    fitRef.current?.fit();
    const id = sessionIdRef.current;
    if (id) api.resizeLocalTerminal(id, term.cols, term.rows).catch(() => {});
    ghostRef.current?.remeasure();
  }, [preferences, zoom.fontSize]);

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
        if (text) api.writeLocalTerminal(id, new TextEncoder().encode(text));
      }).catch(() => {});
      term?.focus();
    }
  };

  return (
    <div ref={outerRef} className="relative flex min-h-0 flex-1 flex-col p-2" style={{ background: auroraLayerBackground(bgColor) }} onContextMenu={handleContextMenu}>
      {status === "connecting" && <div className="absolute inset-0 flex items-center justify-center text-[var(--c-text-secondary)]">Démarrage du terminal local…</div>}
      {status === "failed" && (
        <ConnectionFailed
          overlay
          title="Impossible de démarrer le terminal local"
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
            // This terminal's own size — the ghost text must line up with the
            // characters actually on screen.
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
