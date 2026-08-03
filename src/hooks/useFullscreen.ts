import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

const appWindow = getCurrentWindow();

/**
 * Real OS fullscreen for the app window, mirrored into React state.
 *
 * Mirrored rather than read on demand because the layout keys off it: the
 * window is undecorated, so the title bar is ours to hide, and hiding it is
 * most of what "fullscreen" means here. And it's re-read on every resize
 * because fullscreen can be left without going through the app at all (a
 * window-manager shortcut, macOS's own green button) — `onResized` is the
 * only signal Tauri gives for that, and it's the same one `TitleBar` already
 * uses to track maximized.
 *
 * The state is only moved *after* the window agrees: a refused
 * `set_fullscreen` (a missing capability, say) has to show up as an error
 * rather than as a title bar that vanishes with nothing behind it.
 */
export function useFullscreen(onError: (message: string) => void): {
  fullscreen: boolean;
  toggleFullscreen: () => void;
} {
  const [fullscreen, setFullscreen] = useState(false);
  const fullscreenRef = useRef(false);
  useEffect(() => { fullscreenRef.current = fullscreen; }, [fullscreen]);
  // Whether the window was maximized when fullscreen was entered, so leaving
  // it puts the window back the way it was found rather than restoring to
  // some earlier, smaller size.
  const wasMaximizedRef = useRef(false);

  useEffect(() => {
    const sync = () => { appWindow.isFullscreen().then(setFullscreen).catch(() => {}); };
    sync();
    const pending = appWindow.onResized(sync);
    return () => { pending.then((unlisten) => unlisten()).catch(() => {}); };
  }, []);

  const toggleFullscreen = useCallback(() => {
    const next = !fullscreenRef.current;
    (async () => {
      if (next) {
        // Un-maximize first. On Windows, asking an already-maximized
        // undecorated window to go fullscreen leaves it at the *work area*
        // size — the screen minus the taskbar — while still reporting itself
        // as fullscreen: a strip of desktop stays visible along the bottom
        // and nothing ever corrects it. Measured through WebView2: 1032px on
        // a 1080px screen. From a normal window the same call is fine, so the
        // fix is to never make that call from the maximized state.
        wasMaximizedRef.current = await appWindow.isMaximized();
        if (wasMaximizedRef.current) await appWindow.unmaximize();
        await appWindow.setFullscreen(true);
      } else {
        await appWindow.setFullscreen(false);
        if (wasMaximizedRef.current) await appWindow.maximize();
      }
      setFullscreen(next);
    })().catch((e) => onError(`Plein écran impossible : ${e}`));
  }, [onError]);

  return { fullscreen, toggleFullscreen };
}
