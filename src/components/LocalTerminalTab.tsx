import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type MouseEvent } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { api, base64ToBytes, bytesToBase64, onTerminalClosed, onTerminalData } from "../lib/api";
import { scrollbackText, type TerminalTabHandle } from "./TerminalTab";
import type { AppPreferences } from "../lib/preferences";
import { TERMINAL_THEMES, auroraLayerBackground } from "../lib/preferences";
import { shouldBubbleToShortcut } from "../lib/shortcuts";
import { TerminalSearchBar, type SearchOptions } from "./TerminalSearchBar";
import { createGhostTextController, type GhostSuggestion, type GhostTextController } from "../lib/ghostText";

export { type TerminalTabHandle };

interface LocalTerminalTabProps {
  isActive: boolean;
  preferences?: AppPreferences;
  initialCommand?: string;
  shell?: string | null;
  onDisconnect?: () => void;
  onInputData?: (data: string) => void;
}

export const LocalTerminalTab = forwardRef<TerminalTabHandle, LocalTerminalTabProps>(function LocalTerminalTab({ isActive, preferences, initialCommand, shell, onDisconnect, onInputData }, ref) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const [status, setStatus] = useState<"connecting" | "open" | "failed">("connecting");
  const [error, setError] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const searchOpenRef = useRef(searchOpen);
  useEffect(() => { searchOpenRef.current = searchOpen; }, [searchOpen]);
  const preferencesRef = useRef(preferences);
  useEffect(() => { preferencesRef.current = preferences; }, [preferences]);
  const onInputDataRef = useRef(onInputData);
  useEffect(() => { onInputDataRef.current = onInputData; }, [onInputData]);
  const outerRef = useRef<HTMLDivElement>(null);
  const ghostRef = useRef<GhostTextController | null>(null);
  const [suggestion, setSuggestion] = useState<GhostSuggestion | null>(null);

  useImperativeHandle(
    ref,
    () => ({
      runCommand: (command: string) => {
        const id = sessionIdRef.current;
        if (!id) return;
        api.writeLocalTerminal(id, bytesToBase64(new TextEncoder().encode(command + "\r")));
      },
      writeRaw: (data: string) => {
        const id = sessionIdRef.current;
        if (id) api.writeLocalTerminal(id, bytesToBase64(new TextEncoder().encode(data)));
      },
      getScrollbackText: () => (termRef.current ? scrollbackText(termRef.current) : ""),
      dispose: () => {
        const id = sessionIdRef.current;
        if (id) api.closeLocalTerminal(id).catch(() => {});
      },
    }),
    [],
  );

  useEffect(() => {
    let disposed = false;
    let unlistenData: UnlistenFn | null = null;
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
    if (containerRef.current) term.open(containerRef.current);
    termRef.current = term;
    fitRef.current = fit;
    searchRef.current = search;

    const ghost = createGhostTextController({
      term,
      containerRef,
      outerRef,
      isEnabled: () => preferencesRef.current?.localTerminalSuggestions ?? true,
      isDisposed: () => disposed,
      sendInput: (data) => {
        const id = sessionIdRef.current;
        if (id) api.writeLocalTerminal(id, bytesToBase64(new TextEncoder().encode(data)));
      },
      getHistory: api.getLocalHistory,
      appendHistory: api.appendLocalHistory,
      setSuggestion,
    });
    ghostRef.current = ghost;

    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
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
        api.writeLocalTerminal(sessionIdRef.current, bytesToBase64(new TextEncoder().encode(data)));
      }
      onInputDataRef.current?.(data);
      ghost.handleOnData(data);
    });

    (async () => {
      try {
        const id = await api.openLocalTerminal(shell ?? null);
        if (disposed) {
          api.closeLocalTerminal(id).catch(() => {});
          return;
        }
        sessionIdRef.current = id;
        setStatus("open");

        unlistenData = await onTerminalData((eventId, data) => {
          if (eventId !== id) return;
          term.write(base64ToBytes(data), () => ghost.handleOutputWritten());
        });
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
              api.writeLocalTerminal(id, bytesToBase64(new TextEncoder().encode(initialCommand + "\r"))).catch(() => {});
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
      unlistenData?.();
      unlistenClosed?.();
      if (sessionIdRef.current) api.closeLocalTerminal(sessionIdRef.current).catch(() => {});
      term.dispose();
    };
  }, []);

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

  // Apply preferences dynamically whenever they change.
  useEffect(() => {
    const term = termRef.current;
    if (!term || !preferences) return;
    const themeEntry = TERMINAL_THEMES[preferences.terminalThemeName];
    if (themeEntry) term.options.theme = themeEntry.theme;
    term.options.fontFamily = preferences.terminalFontFamily;
    term.options.fontSize = preferences.terminalFontSize;
    fitRef.current?.fit();
    const id = sessionIdRef.current;
    if (id) api.resizeLocalTerminal(id, term.cols, term.rows).catch(() => {});
    ghostRef.current?.remeasure();
  }, [preferences]);

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
        if (text) api.writeLocalTerminal(id, bytesToBase64(new TextEncoder().encode(text)));
      }).catch(() => {});
      term?.focus();
    }
  };

  return (
    <div ref={outerRef} className="relative flex min-h-0 flex-1 flex-col p-2" style={{ background: auroraLayerBackground(bgColor) }} onContextMenu={handleContextMenu}>
      {status === "connecting" && <div className="absolute inset-0 flex items-center justify-center text-[var(--c-text-secondary)]">Démarrage du terminal local…</div>}
      {status === "failed" && <div className="absolute inset-0 flex items-center justify-center px-8 text-center text-rose-300">Échec : {error}</div>}
      {searchOpen && <TerminalSearchBar onSearch={handleSearch} onClose={() => { setSearchOpen(false); termRef.current?.focus(); }} />}
      <div ref={containerRef} className={`min-h-0 flex-1 ${status === "open" ? "" : "invisible"}`} />
      {suggestion && (
        <span
          className="pointer-events-none absolute select-none whitespace-pre"
          style={{
            left: suggestion.left,
            top: suggestion.top,
            lineHeight: `${suggestion.cellHeight}px`,
            fontFamily: preferences?.terminalFontFamily,
            fontSize: preferences?.terminalFontSize,
            color: "rgba(148, 163, 184, 0.55)",
          }}
        >
          {suggestion.text}
        </span>
      )}
    </div>
  );
});
