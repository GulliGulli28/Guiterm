import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import appIconUrl from "../../src-tauri/icons/32x32.png";
import type { AppNotification } from "../lib/notifications";
import { NotificationBell } from "./NotificationBell";

const appWindow = getCurrentWindow();

interface TitleBarProps {
  sidebarVisible: boolean;
  onToggleSidebar: () => void;
  notifications: AppNotification[];
  onDismissNotification: (id: string) => void;
  onClearAllNotifications: () => void;
  onMarkAllNotificationsRead: () => void;
}

export function TitleBar({
  sidebarVisible,
  onToggleSidebar,
  notifications,
  onDismissNotification,
  onClearAllNotifications,
  onMarkAllNotificationsRead,
}: TitleBarProps) {
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    appWindow.isMaximized().then(setIsMaximized);
    const unlistenPromise = appWindow.onResized(() => {
      appWindow.isMaximized().then(setIsMaximized);
    });
    return () => {
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  return (
    <div data-tauri-drag-region className="flex h-9 shrink-0 select-none items-center justify-between border-b border-[var(--c-border)] bg-[var(--c-bg2)] pl-2">
      <div className="flex items-center gap-1">
        <button
          onClick={onToggleSidebar}
          aria-label={sidebarVisible ? "Cacher le panneau" : "Afficher le panneau"}
          className="flex h-6 w-7 items-center justify-center rounded text-[var(--c-text-muted)] hover:bg-white/5 hover:text-[var(--c-text-secondary)]"
        >
          <svg width="14" height="11" viewBox="0 0 14 11" fill="none">
            <line x1="0" y1="1" x2="14" y2="1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            <line x1="0" y1="5.5" x2="14" y2="5.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            <line x1="0" y1="10" x2="14" y2="10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
        <div data-tauri-drag-region className="flex items-center gap-2 pl-1">
          <img
            src={appIconUrl}
            alt=""
            width={20}
            height={20}
            className="rounded-md shadow-[0_0_8px_1px_color-mix(in_srgb,var(--c-accent)_45%,transparent)]"
          />
          <span className="text-[12px] font-semibold tracking-wider text-[var(--c-text-secondary)]">gui-termius</span>
        </div>
        <NotificationBell
          notifications={notifications}
          onDismiss={onDismissNotification}
          onClearAll={onClearAllNotifications}
          onMarkAllRead={onMarkAllNotificationsRead}
        />
      </div>
      <div className="flex h-full">
        <button onClick={() => appWindow.minimize()} aria-label="Réduire" className="flex h-full w-11 items-center justify-center text-[var(--c-text-secondary)] hover:bg-white/5 hover:text-[var(--c-text)]">
          <svg width="10" height="10" viewBox="0 0 10 10">
            <line x1="0" y1="5" x2="10" y2="5" stroke="currentColor" strokeWidth="1" />
          </svg>
        </button>
        <button onClick={() => appWindow.toggleMaximize()} aria-label="Agrandir" className="flex h-full w-11 items-center justify-center text-[var(--c-text-secondary)] hover:bg-white/5 hover:text-[var(--c-text)]">
          {isMaximized ? (
            <svg width="10" height="10" viewBox="0 0 10 10">
              <rect x="2.5" y="0.5" width="7" height="7" fill="none" stroke="currentColor" strokeWidth="1" />
              <path d="M0.5 2.5H7.5V9.5H0.5Z" fill="var(--c-bg2)" stroke="currentColor" strokeWidth="1" />
            </svg>
          ) : (
            <svg width="10" height="10" viewBox="0 0 10 10">
              <rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="1" />
            </svg>
          )}
        </button>
        <button onClick={() => appWindow.close()} aria-label="Fermer" className="flex h-full w-11 items-center justify-center text-[var(--c-text-secondary)] hover:bg-rose-600 hover:text-white">
          <svg width="10" height="10" viewBox="0 0 10 10">
            <line x1="0" y1="0" x2="10" y2="10" stroke="currentColor" strokeWidth="1" />
            <line x1="10" y1="0" x2="0" y2="10" stroke="currentColor" strokeWidth="1" />
          </svg>
        </button>
      </div>
    </div>
  );
}
