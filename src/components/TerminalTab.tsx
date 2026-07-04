import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { api, base64ToBytes, bytesToBase64, onTerminalClosed, onTerminalData } from "../lib/api";
import type { Host } from "../lib/types";
import type { AppPreferences } from "../lib/preferences";
import { TERMINAL_THEMES } from "../lib/preferences";
import { TerminalSearchBar } from "./TerminalSearchBar";

export interface TerminalTabHandle {
  runCommand: (command: string) => void;
  dispose: () => void;
}

interface TerminalTabProps {
  host: Host;
  isActive: boolean;
  preferences?: AppPreferences;
  onDisconnect?: () => void;
}

export const TerminalTab = forwardRef<TerminalTabHandle, TerminalTabProps>(function TerminalTab({ host, isActive, preferences, onDisconnect }, ref) {
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

  useImperativeHandle(
    ref,
    () => ({
      runCommand: (command: string) => {
        const id = sessionIdRef.current;
        if (!id) return;
        api.writeTerminal(id, bytesToBase64(new TextEncoder().encode(command + "\r")));
      },
      dispose: () => {
        const id = sessionIdRef.current;
        if (id) api.closeTerminal(id).catch(() => {});
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
      return true;
    });

    term.onData((data) => {
      if (sessionIdRef.current) {
        api.writeTerminal(sessionIdRef.current, bytesToBase64(new TextEncoder().encode(data)));
      }
    });

    (async () => {
      try {
        const id = await api.connectTerminal(host.id);
        if (disposed) {
          api.closeTerminal(id).catch(() => {});
          return;
        }
        sessionIdRef.current = id;
        setStatus("open");

        unlistenData = await onTerminalData((eventId, data) => {
          if (eventId !== id) return;
          term.write(base64ToBytes(data));
        });
        unlistenClosed = await onTerminalClosed((eventId) => {
          if (eventId !== id) return;
          term.write("\r\n\x1b[31m[connexion fermée]\x1b[0m\r\n");
          setTimeout(() => { if (!disposed) onDisconnect?.(); }, 1000);
        });

        fit.fit();
        api.resizeTerminal(id, term.cols, term.rows).catch(() => {});
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
      if (sessionIdRef.current) api.closeTerminal(sessionIdRef.current).catch(() => {});
      term.dispose();
    };
  }, [host.id]);

  // Re-fit whenever the container is resized (and is visible).
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(() => {
      if (!isActive || !fitRef.current || !termRef.current) return;
      fitRef.current.fit();
      const id = sessionIdRef.current;
      if (id) api.resizeTerminal(id, termRef.current.cols, termRef.current.rows).catch(() => {});
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [isActive]);

  // Re-fit when this tab becomes active again (it was `display:none` before, so
  // xterm couldn't compute a meaningful size while hidden).
  useEffect(() => {
    if (isActive && fitRef.current && termRef.current) {
      fitRef.current.fit();
      const id = sessionIdRef.current;
      if (id) api.resizeTerminal(id, termRef.current.cols, termRef.current.rows).catch(() => {});
      termRef.current.focus();
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
    if (id) api.resizeTerminal(id, term.cols, term.rows).catch(() => {});
  }, [preferences]);

  const bgColor = preferences ? (TERMINAL_THEMES[preferences.terminalThemeName]?.theme.background ?? "#020617") : "#020617";

  const handleSearch = (value: string, direction: "next" | "prev") => {
    if (!value) return;
    if (direction === "next") searchRef.current?.findNext(value, { incremental: true });
    else searchRef.current?.findPrevious(value, { incremental: true });
  };

  return (
    <div className="relative flex min-h-0 flex-1 flex-col p-2" style={{ backgroundColor: bgColor }}>
      {status === "connecting" && <div className="absolute inset-0 flex items-center justify-center text-[var(--c-text-secondary)]">Connexion à {host.label}…</div>}
      {status === "failed" && <div className="absolute inset-0 flex items-center justify-center px-8 text-center text-rose-300">Échec de connexion : {error}</div>}
      {searchOpen && <TerminalSearchBar onSearch={handleSearch} onClose={() => { setSearchOpen(false); termRef.current?.focus(); }} />}
      <div ref={containerRef} className={`min-h-0 flex-1 ${status === "open" ? "" : "invisible"}`} />
    </div>
  );
});
