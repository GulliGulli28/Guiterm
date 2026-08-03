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

  useEffect(() => {
    const sync = () => { appWindow.isFullscreen().then(setFullscreen).catch(() => {}); };
    sync();
    const pending = appWindow.onResized(sync);
    return () => { pending.then((unlisten) => unlisten()).catch(() => {}); };
  }, []);

  const toggleFullscreen = useCallback(() => {
    const next = !fullscreenRef.current;
    appWindow.setFullscreen(next)
      .then(() => setFullscreen(next))
      .catch((e) => onError(`Plein écran impossible : ${e}`));
  }, [onError]);

  return { fullscreen, toggleFullscreen };
}
