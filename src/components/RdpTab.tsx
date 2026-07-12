import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { api, onRdpViewClosed, onRdpViewError } from "../lib/api";
import type { Host } from "../lib/types";
import type { AppPreferences } from "../lib/preferences";
import { shouldBubbleToShortcut } from "../lib/shortcuts";
import type { TerminalTabHandle } from "./TerminalTab";

interface RdpTabProps {
  host: Host;
  isActive: boolean;
  preferences?: AppPreferences;
  onDisconnect?: () => void;
  /** Called with the session id once connected, and again with `null` on
   * disconnect/cleanup — lets `TransferTab.tsx` target this exact session
   * for `api.pushRdpViewClipboardEntries` without needing its own copy of
   * the imperative-handle plumbing. */
  onSessionId?: (id: string | null) => void;
}

/** Maps a DOM mouse position to RDP-space pixel coordinates, accounting for
 * the canvas being displayed scaled (CSS size) relative to its backing
 * buffer (`canvas.width`/`height`, set to the session's fixed resolution). */
function toRdpCoords(clientX: number, clientY: number, canvas: HTMLCanvasElement): { x: number; y: number } | null {
  const rect = canvas.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0 || canvas.width === 0 || canvas.height === 0) return null;
  const x = Math.round(((clientX - rect.left) / rect.width) * canvas.width);
  const y = Math.round(((clientY - rect.top) / rect.height) * canvas.height);
  return { x: Math.max(0, Math.min(canvas.width - 1, x)), y: Math.max(0, Math.min(canvas.height - 1, y)) };
}

/**
 * Embedded RDP session (Phase 2 — see CLAUDE.md's "Pourquoi un processus RDP
 * séparé" section): live view, mouse/keyboard forwarding, and dynamic
 * resize (session resolution follows this tab's container, both at connect
 * time and on every later resize). The primary way to open an RDP host —
 * the system client launcher (`mstsc`/`xfreerdp`) has been removed; this is
 * the only RDP connection mode left.
 *
 * Exposes a `TerminalTabHandle`-shaped ref (same as `TerminalTab`/
 * `LocalTerminalTab`) so `App.tsx` can register it in `terminalRefs` and
 * make it a valid snippet/broadcast target — there's no shell/PTY here, so
 * `runCommand`/`writeRaw` type the text into the remote desktop instead of
 * writing to a byte stream (see their doc comments below).
 */
export const RdpTab = forwardRef<TerminalTabHandle, RdpTabProps>(function RdpTab({ host, isActive, preferences, onDisconnect, onSessionId }, ref) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sessionIdRef = useRef<string | null>(null);
  const [status, setStatus] = useState<"connecting" | "open" | "failed" | "closed">("connecting");
  const [error, setError] = useState("");
  const preferencesRef = useRef(preferences);
  useEffect(() => { preferencesRef.current = preferences; }, [preferences]);

  const sendInput = (message: Parameters<typeof api.sendRdpViewInput>[1]) => {
    const id = sessionIdRef.current;
    if (id) api.sendRdpViewInput(id, message).catch(() => {});
  };
  const sendInputRef = useRef(sendInput);
  sendInputRef.current = sendInput;

  useImperativeHandle(
    ref,
    () => ({
      // `+ "\n"` mirrors SSH/Docker's `command + "\r"` convention (see
      // `TerminalTab.tsx`) — sent as a real Enter keypress by the sidecar,
      // not a literal character (see `rdp_ipc::ClientMessage::TypeText`).
      // Deliberately never wrapped in the `echo '<b64>' | base64 -d | bash`
      // trick `runOnTerminalHandle` (`App.tsx`) uses for multi-line SSH/
      // Docker snippets: there's no guarantee a shell — let alone bash — is
      // even what has focus on the remote desktop, so a multi-line snippet
      // is instead typed line by line, each ending in a real Enter (`\n`
      // embedded in the snippet becomes one, same as the trailing one).
      runCommand: (command: string) => sendInputRef.current({ type: "typeText", text: `${command}\n` }),
      // Used by the live "synced typing" broadcast mode to mirror another
      // terminal's keystrokes here in real time — faithful for regular
      // printable characters, but a source terminal's raw `onData` can also
      // contain ANSI escape sequences for special keys (arrows, function
      // keys, ...), which have no meaning as typed Unicode text and would
      // just get typed literally. Known, accepted limitation: not worth
      // building an ANSI-sequence parser for this secondary mode.
      writeRaw: (data: string) => sendInputRef.current({ type: "typeText", text: data }),
      // No text scrollback here — this is a picture, not a terminal.
      getScrollbackText: () => "",
      dispose: () => {
        const id = sessionIdRef.current;
        if (id) api.closeRdpView(id).catch(() => {});
      },
    }),
    [],
  );

  useEffect(() => {
    let disposed = false;
    let unlistenError: UnlistenFn | null = null;
    let unlistenClosed: UnlistenFn | null = null;

    const connect = async () => {
      try {
        // Measured from the container (always laid out, regardless of the
        // canvas itself being hidden pre-connect) so the session starts at
        // roughly the right resolution instead of an arbitrary default —
        // the sidecar clamps this to MS-RDPEDISP's valid range regardless.
        const rect = containerRef.current?.getBoundingClientRect();
        const width = Math.max(1, Math.round(rect?.width ?? 1280));
        const height = Math.max(1, Math.round(rect?.height ?? 800));
        const id = await api.connectRdpView(host.id, width, height, (frame) => {
          const canvas = canvasRef.current;
          if (!canvas) return;
          // Only touch canvas.width/height (which clears the whole canvas)
          // when the desktop itself actually resized — every other message
          // is just a same-size partial paint (usually far smaller than the
          // full frame; see rdp_ipc::SidecarMessage::Image's doc comment),
          // and resizing here would wipe out everything painted outside
          // this particular rectangle.
          if (canvas.width !== frame.canvasWidth) canvas.width = frame.canvasWidth;
          if (canvas.height !== frame.canvasHeight) canvas.height = frame.canvasHeight;
          const ctx = canvas.getContext("2d");
          if (!ctx) return;
          const rgba = new Uint8ClampedArray(frame.pixels.buffer, frame.pixels.byteOffset, frame.pixels.byteLength);
          ctx.putImageData(new ImageData(rgba, frame.width, frame.height), frame.x, frame.y);
        });
        if (disposed) {
          api.closeRdpView(id).catch(() => {});
          return;
        }
        sessionIdRef.current = id;
        setStatus("open");
        onSessionId?.(id);

        unlistenError = await onRdpViewError((eventId, message) => {
          if (eventId !== id) return;
          setStatus("failed");
          setError(message);
        });
        unlistenClosed = await onRdpViewClosed((eventId) => {
          if (eventId !== id) return;
          sessionIdRef.current = null;
          onSessionId?.(null);
          setStatus((prev) => (prev === "failed" ? prev : "closed"));
        });
      } catch (e) {
        if (disposed) return;
        setStatus("failed");
        setError(String(e));
      }
    };

    connect();

    return () => {
      disposed = true;
      unlistenError?.();
      unlistenClosed?.();
      if (sessionIdRef.current) {
        api.closeRdpView(sessionIdRef.current).catch(() => {});
        onSessionId?.(null);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host.id]);

  // Focus the canvas whenever this tab becomes the active/visible one, so
  // keyboard input starts flowing without an extra click.
  useEffect(() => {
    if (isActive && status === "open") canvasRef.current?.focus();
    // Switching away or losing the connection: nothing should still look
    // "held" server-side once the user can no longer see/control this view.
    if (!isActive) sendInputRef.current({ type: "releaseAll" });
  }, [isActive, status]);

  // Resize requests are debounced well past a single frame (unlike
  // mouse-move's per-animation-frame coalescing below): each one is a full
  // Display Control round-trip plus a Deactivation-Reactivation Sequence on
  // the server side, not a cheap local redraw — sending one per intermediate
  // frame of a window drag would make every drag visibly janky and spam the
  // server with reconnect-shaped churn for no benefit over sending just the
  // final size once the user stops resizing.
  useEffect(() => {
    const container = containerRef.current;
    if (!container || status !== "open") return;
    let debounce: ReturnType<typeof setTimeout> | null = null;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (!rect || rect.width <= 0 || rect.height <= 0) return;
      const width = Math.round(rect.width);
      const height = Math.round(rect.height);
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        debounce = null;
        sendInputRef.current({ type: "resize", width, height });
      }, 400);
    });
    observer.observe(container);
    return () => {
      observer.disconnect();
      if (debounce) clearTimeout(debounce);
    };
  }, [status]);

  // Mouse-move is coalesced to at most one forwarded event per animation
  // frame — the DOM can fire far more of these than the IPC round-trip (and
  // the sidecar's own encode+process step) can usefully keep up with.
  const pendingMoveRef = useRef<{ x: number; y: number } | null>(null);
  const moveRafRef = useRef<number | null>(null);
  useEffect(() => () => { if (moveRafRef.current != null) cancelAnimationFrame(moveRafRef.current); }, []);

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const coords = toRdpCoords(e.clientX, e.clientY, canvas);
    if (!coords) return;
    pendingMoveRef.current = coords;
    if (moveRafRef.current != null) return;
    moveRafRef.current = requestAnimationFrame(() => {
      moveRafRef.current = null;
      const pending = pendingMoveRef.current;
      pendingMoveRef.current = null;
      if (pending) sendInput({ type: "mouseMove", x: pending.x, y: pending.y });
    });
  };

  // Tracks which buttons this view itself pressed, so a `window`-level
  // mouseup (needed to catch a release after the cursor drags off the
  // canvas) never forwards a release for a button it never told the sidecar
  // was pressed.
  const pressedButtonsRef = useRef<Set<number>>(new Set());

  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.focus();
    const coords = toRdpCoords(e.clientX, e.clientY, canvas);
    if (!coords) return;
    pressedButtonsRef.current.add(e.button);
    sendInput({ type: "mouseButton", x: coords.x, y: coords.y, button: e.button, pressed: true });
  };

  useEffect(() => {
    const onWindowMouseUp = (e: MouseEvent) => {
      if (!pressedButtonsRef.current.has(e.button)) return;
      pressedButtonsRef.current.delete(e.button);
      const canvas = canvasRef.current;
      if (!canvas) return;
      const coords = toRdpCoords(e.clientX, e.clientY, canvas) ?? { x: 0, y: 0 };
      sendInputRef.current({ type: "mouseButton", x: coords.x, y: coords.y, button: e.button, pressed: false });
    };
    window.addEventListener("mouseup", onWindowMouseUp);
    return () => window.removeEventListener("mouseup", onWindowMouseUp);
  }, []);

  // Manual (non-JSX) listener: React's synthetic `onWheel` handler is
  // attached passively for scroll-performance reasons, so `preventDefault()`
  // inside it is unreliable — a raw `{ passive: false }` listener is the
  // documented way to actually stop the page from scrolling instead of the
  // remote session.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const coords = toRdpCoords(e.clientX, e.clientY, canvas);
      if (!coords) return;
      sendInputRef.current({ type: "mouseWheel", x: coords.x, y: coords.y, deltaY: e.deltaY });
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, [status]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLCanvasElement>) => {
    const shortcuts = preferencesRef.current?.keyboardShortcuts;
    if (shortcuts && shouldBubbleToShortcut(e.nativeEvent, shortcuts)) return;
    e.preventDefault();
    sendInput({ type: "key", code: e.code, pressed: true });
  };

  const handleKeyUp = (e: React.KeyboardEvent<HTMLCanvasElement>) => {
    const shortcuts = preferencesRef.current?.keyboardShortcuts;
    if (shortcuts && shouldBubbleToShortcut(e.nativeEvent, shortcuts)) return;
    e.preventDefault();
    sendInput({ type: "key", code: e.code, pressed: false });
  };

  return (
    <div ref={containerRef} className="relative flex min-h-0 flex-1 flex-col items-center justify-center overflow-auto bg-black p-2">
      {status === "connecting" && <div className="absolute inset-0 flex items-center justify-center text-[var(--c-text-secondary)]">Connexion à {host.label}…</div>}
      {status === "failed" && <div className="absolute inset-0 flex items-center justify-center px-8 text-center text-rose-300">Échec de connexion : {error}</div>}
      {status === "closed" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-[var(--c-text-secondary)]">
          <p>Session RDP terminée.</p>
          <button
            onClick={() => onDisconnect?.()}
            className="rounded-md bg-[var(--c-accent)] px-3 py-1.5 text-xs font-medium text-white hover:bg-[var(--c-accent-hover)]"
          >
            Fermer l'onglet
          </button>
        </div>
      )}
      <canvas
        ref={canvasRef}
        tabIndex={0}
        className={status === "open" && isActive ? "max-h-full max-w-full cursor-default outline-none" : "hidden"}
        onMouseMove={handleMouseMove}
        onMouseDown={handleMouseDown}
        onContextMenu={(e) => e.preventDefault()}
        onKeyDown={handleKeyDown}
        onKeyUp={handleKeyUp}
        onBlur={() => sendInput({ type: "releaseAll" })}
      />
    </div>
  );
});
