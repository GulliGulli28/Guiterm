import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import appIconUrl from "../../src-tauri/icons/32x32.png";
import type { AppNotification } from "../lib/notifications";
import type { TabMeta } from "../lib/types";
import { NotificationBell } from "./NotificationBell";
import { TabBar } from "./TabBar";
import { IconFullscreen, IconFullscreenExit, IconPlus, IconSearch } from "./ui-icons";

const appWindow = getCurrentWindow();

interface TitleBarProps {
  tabs: TabMeta[];
  activeTabId: string | null;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  onReorderTabs: (tabs: TabMeta[]) => void;
  tabColor?: (tab: TabMeta) => string | undefined;
  /** Le « + » au bout des onglets : un terminal local, comme `Ctrl+T`. */
  onNewTab: () => void;
  /** Ouvre l'accueil ; `homeActive` dit qu'il est à l'écran. */
  onHome: () => void;
  homeActive: boolean;
  onOpenPalette: () => void;
  /** Le libellé de la combinaison de la palette, tel que réglé. */
  paletteCombo?: string;
  fullscreen: boolean;
  onToggleFullscreen: () => void;
  notifications: AppNotification[];
  onDismissNotification: (id: string) => void;
  onClearAllNotifications: () => void;
  onMarkAllNotificationsRead: () => void;
}

/**
 * La barre du haut, qui porte aussi les onglets (40 px rendus au contenu,
 * là où barre de titre et barre d'onglets s'empilaient). À gauche le logo,
 * aligné sur le rail ; puis les onglets et leur « + » ; à droite la
 * recherche, le plein écran, les notifications et les boutons de fenêtre.
 *
 * En plein écran, elle reste — c'est là que sont les onglets — mais sans
 * boutons de fenêtre ni déplacement (voir `dragRegion`).
 */
export function TitleBar({
  tabs,
  activeTabId,
  onSelectTab,
  onCloseTab,
  onReorderTabs,
  tabColor,
  onNewTab,
  onHome,
  homeActive,
  onOpenPalette,
  paletteCombo,
  fullscreen,
  onToggleFullscreen,
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

  // Dragging is disabled in fullscreen. Windows treats a drag on a fullscreen
  // window the way it treats one on a maximized window — it restores the
  // window to a smaller size — but tao's own fullscreen flag isn't cleared by
  // that, so the app would keep reporting (and rendering) fullscreen around a
  // window that plainly isn't. Nothing is lost: a fullscreen window has
  // nowhere to be dragged to.
  const dragRegion = fullscreen ? undefined : true;
  const combo = paletteCombo?.replace("Shift", "Maj");

  return (
    <div data-tauri-drag-region={dragRegion} className="flex h-10 shrink-0 select-none items-stretch border-b border-[var(--c-border)] bg-[var(--c-bg)]">
      <div data-tauri-drag-region={dragRegion} className="flex w-[72px] shrink-0 items-center justify-center border-r border-[var(--c-border)]">
        {/* Le logo ramène à l'accueil, par-dessus les onglets ouverts. */}
        <button
          type="button"
          onClick={onHome}
          aria-label="Accueil"
          title="Accueil"
          aria-pressed={homeActive}
          data-home-button=""
          className={`flex h-8 w-8 items-center justify-center rounded-lg transition-colors ${homeActive ? "bg-[var(--c-hover)]" : "hover:bg-[var(--c-hover)]"}`}
        >
          <img src={appIconUrl} alt="" width={20} height={20} className="pointer-events-none" />
        </button>
      </div>

      <TabBar
        tabs={tabs}
        activeTabId={activeTabId}
        onSelect={onSelectTab}
        onClose={onCloseTab}
        onReorder={onReorderTabs}
        tabColor={tabColor}
        dragRegion={dragRegion}
      />
      <button
        type="button"
        onClick={onNewTab}
        aria-label="Nouveau terminal local"
        title="Nouveau terminal local (Ctrl+T)"
        className="flex w-9 shrink-0 items-center justify-center text-[var(--c-text-muted)] hover:bg-[var(--c-hover)] hover:text-[var(--c-text)]"
      >
        <IconPlus size={14} />
      </button>
      <div data-tauri-drag-region={dragRegion} className="min-w-6 flex-1" />

      <div className="flex shrink-0 items-center gap-1 px-2">
        <button
          type="button"
          onClick={onOpenPalette}
          aria-label="Rechercher ou se connecter"
          title={["Rechercher un hôte, une commande ou une action", combo].filter(Boolean).join(" — ")}
          className="flex h-7 w-[280px] items-center gap-2 overflow-hidden whitespace-nowrap rounded-[8px] border border-[var(--c-border)] bg-[var(--c-bg2)] pl-2.5 pr-1.5 text-[12.5px] text-[var(--c-text-muted)] transition-colors hover:border-[var(--c-border-strong)] hover:text-[var(--c-text-secondary)] max-[1180px]:w-auto"
        >
          <IconSearch size={13} />
          <span className="flex-1 truncate text-left max-[1180px]:hidden">Rechercher ou se connecter</span>
          {combo && <span className="kbd max-[1180px]:hidden">{combo}</span>}
        </button>
        {/* Ici plutôt que parmi les boutons de fenêtre : en plein écran ces
            derniers disparaissent, et le chemin du retour doit rester à
            l'écran. */}
        <button
          type="button"
          onClick={onToggleFullscreen}
          title={fullscreen ? "Quitter le plein écran (F11)" : "Plein écran (F11)"}
          aria-label={fullscreen ? "Quitter le plein écran" : "Plein écran"}
          className={`btn btn-sm btn-icon ${fullscreen ? "btn-toggled" : "btn-ghost text-[var(--c-text-muted)]"}`}
        >
          {fullscreen ? <IconFullscreenExit size={14} /> : <IconFullscreen size={14} />}
        </button>
        <NotificationBell
          notifications={notifications}
          onDismiss={onDismissNotification}
          onClearAll={onClearAllNotifications}
          onMarkAllRead={onMarkAllNotificationsRead}
          align="right"
        />
      </div>

      {/* Hidden in fullscreen: maximizing a fullscreen window is the same
          kind of contradictory state as dragging one (see `dragRegion`) —
          the window changes size while the app still believes it's
          fullscreen. Leaving fullscreen first is the way through. */}
      {!fullscreen && (
        <div className="flex h-full shrink-0">
          <button onClick={() => appWindow.minimize()} aria-label="Réduire" className="flex h-full w-11 items-center justify-center text-[var(--c-text-muted)] hover:bg-[var(--c-hover)] hover:text-[var(--c-text)]">
            <svg width="10" height="10" viewBox="0 0 10 10">
              <line x1="0" y1="5" x2="10" y2="5" stroke="currentColor" strokeWidth="1" />
            </svg>
          </button>
          <button onClick={() => appWindow.toggleMaximize()} aria-label="Agrandir" className="flex h-full w-11 items-center justify-center text-[var(--c-text-muted)] hover:bg-[var(--c-hover)] hover:text-[var(--c-text)]">
            {isMaximized ? (
              <svg width="10" height="10" viewBox="0 0 10 10">
                <rect x="2.5" y="0.5" width="7" height="7" fill="none" stroke="currentColor" strokeWidth="1" />
                <path d="M0.5 2.5H7.5V9.5H0.5Z" fill="var(--c-bg)" stroke="currentColor" strokeWidth="1" />
              </svg>
            ) : (
              <svg width="10" height="10" viewBox="0 0 10 10">
                <rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="1" />
              </svg>
            )}
          </button>
          <button onClick={() => appWindow.close()} aria-label="Fermer" className="flex h-full w-11 items-center justify-center text-[var(--c-text-muted)] hover:bg-[#e81123] hover:text-white">
            <svg width="10" height="10" viewBox="0 0 10 10">
              <line x1="0" y1="0" x2="10" y2="10" stroke="currentColor" strokeWidth="1" />
              <line x1="10" y1="0" x2="0" y2="10" stroke="currentColor" strokeWidth="1" />
            </svg>
          </button>
        </div>
      )}
    </div>
  );
}
