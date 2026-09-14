import { useEffect, useRef, useState } from "react";
import type { TabMeta } from "../lib/types";
import { IconTerminal, IconTransfer, IconMonitor, IconSplit, IconClose, IconBroadcast, IconDatabase, IconFullscreen, IconFullscreenExit, IconNetDiag, IconBell, IconPin, IconEye } from "./ui-icons";

interface TabBarProps {
  tabs: TabMeta[];
  activeTabId: string | null;
  splitOpen: boolean;
  broadcastActive: boolean;
  fullscreen: boolean;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onToggleSplit: () => void;
  onToggleBroadcast: () => void;
  onToggleFullscreen: () => void;
  onReorder: (tabs: TabMeta[]) => void;
  /** Resolves a tab to its host group's tag color (hex), if any. */
  tabColor?: (tab: TabMeta) => string | undefined;
}

function TabIcon({ kind }: { kind: TabMeta["kind"] }) {
  if (kind === "terminal") return <IconTerminal size={13} />;
  if (kind === "transfer") return <IconTransfer size={13} />;
  if (kind === "fleet") return <IconBroadcast size={13} />;
  if (kind === "sql") return <IconDatabase size={13} />;
  if (kind === "netdiag") return <IconNetDiag size={13} />;
  if (kind === "activity") return <IconBell size={13} />;
  return <IconMonitor size={13} />;
}

export function TabBar({ tabs, activeTabId, splitOpen, broadcastActive, fullscreen, onSelect, onClose, onToggleSplit, onToggleBroadcast, onToggleFullscreen, onReorder, tabColor }: TabBarProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const dragState = useRef<{ draggedId: string; moved: boolean; startX: number } | null>(null);
  const [draggedId, setDraggedId] = useState<string | null>(null);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const drag = dragState.current;
      const container = containerRef.current;
      if (!drag || !container) return;
      if (Math.abs(e.clientX - drag.startX) > 3) drag.moved = true;

      const draggedIdx = tabs.findIndex((t) => t.id === drag.draggedId);
      if (draggedIdx === -1) return;
      const children = Array.from(container.querySelectorAll<HTMLElement>("[data-tab-id]"));
      let overIdx = tabs.length - 1;
      for (let i = 0; i < children.length; i++) {
        const rect = children[i].getBoundingClientRect();
        if (e.clientX < rect.left + rect.width / 2) { overIdx = i; break; }
      }
      if (overIdx !== draggedIdx) {
        const next = tabs.slice();
        const [moved] = next.splice(draggedIdx, 1);
        next.splice(overIdx, 0, moved);
        onReorder(next);
      }
    };
    const onUp = () => {
      dragState.current = null;
      setDraggedId(null);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [tabs, onReorder]);

  return (
    <div className="flex h-9 shrink-0 items-stretch gap-1 border-b border-[var(--c-border)] bg-[var(--c-bg)] pr-1.5">
      {/* The network diagnostics button briefly lived here. It moved to the
          sidebar's nav strip, next to fleet operations: that strip is where
          people look for "what can this app do", and here it went unnoticed. */}
      {/* Les onglets se partagent la largeur comme dans un navigateur : ils
          rétrécissent (jusqu'à 6 rem, le libellé tronqué) avant de déborder,
          et s'ils débordent quand même, la molette fait défiler sans qu'une
          barre à flèches vienne s'incruster dans le bandeau. */}
      <div ref={containerRef} className="scrollbar-none flex min-w-0 flex-1 items-stretch overflow-x-auto">
        {tabs.map((tab) => {
          const isActive = tab.id === activeTabId;
          const color = tabColor?.(tab);
          // Ce que dit la punaise : fermer cet onglet ne perd rien, la session
          // continue de tourner sur le serveur. C'est l'information qui change
          // le geste — sans elle, fermer un onglet reste un pari.
          const pinned = tab.kind === "terminal" && !!tab.sessionKey;
          // L'œil remplace la punaise plutôt que de s'y ajouter : observer une
          // session suppose déjà qu'elle est persistante, et deux pictogrammes
          // sur un onglet étroit se lisent moins bien qu'un seul.
          const observing = tab.kind === "terminal" && !!tab.readOnly;
          return (
            <div
              key={tab.id}
              data-tab-id={tab.id}
              // Which tab is active is otherwise only visible as a styling
              // class, which a test would have to match on. Ctrl+1…9 is
              // exactly the kind of feature that needs a real window to prove,
              // so it gets a handle that says what it means.
              data-tab-active={isActive ? "true" : undefined}
              onMouseDown={(e) => {
                if (e.button !== 0) return;
                dragState.current = { draggedId: tab.id, moved: false, startX: e.clientX };
                setDraggedId(tab.id);
              }}
              onClick={() => { if (!dragState.current?.moved) onSelect(tab.id); }}
              // Un onglet actif se pose sur la surface du contenu (même fond,
              // bordures latérales, pas de trait en dessous) : il en fait
              // partie. Les autres restent dans la barre, en retrait.
              className={`group/tab relative -mb-px flex min-w-[6rem] max-w-[16rem] shrink cursor-pointer select-none items-center gap-1.5 border-r border-[var(--c-border)] px-3 text-[12.5px] transition-colors first:border-l ${
                isActive
                  ? "bg-[var(--c-bg2)] text-[var(--c-text)] after:absolute after:inset-x-0 after:top-0 after:h-0.5 after:bg-[var(--c-accent)]"
                  : tab.status === "placeholder"
                    ? "text-[var(--c-text-faint)] hover:bg-[var(--c-hover)] hover:text-[var(--c-text-muted)]"
                    : "text-[var(--c-text-muted)] hover:bg-[var(--c-hover)] hover:text-[var(--c-text-secondary)]"
              } ${draggedId === tab.id ? "opacity-60" : ""}`}
              title={
                tab.status === "placeholder"
                  ? pinned
                    ? "Session persistante restaurée — cliquez pour la reprendre telle qu'elle était"
                    : "Session restaurée — cliquez pour reconnecter"
                  : observing
                    ? "Observation — vos frappes ne sont pas envoyées, et l'affichage suit la taille de la session"
                    : pinned
                      ? "Session persistante — fermer cet onglet ne perd pas ce qui y tourne"
                      : undefined
              }
            >
              {color && <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: color }} />}
              <span className={isActive ? "text-[var(--c-accent-text)]" : "opacity-70"}><TabIcon kind={tab.kind} /></span>
              {observing ? <IconEye size={11} className="shrink-0 opacity-70" /> : pinned && <IconPin size={10} className="shrink-0 opacity-70" />}
              <span className={`min-w-0 flex-1 truncate ${tab.status === "placeholder" ? "italic" : ""}`}>{tab.label}</span>
              <button
                onClick={(e) => { e.stopPropagation(); onClose(tab.id); }}
                className={`-mr-1 flex h-4 w-4 shrink-0 items-center justify-center rounded-sm transition-opacity hover:bg-[var(--c-active)] ${
                  isActive ? "opacity-60 hover:opacity-100" : "opacity-0 group-hover/tab:opacity-60 hover:!opacity-100"
                }`}
                aria-label="Fermer l'onglet"
              >
                <IconClose size={10} />
              </button>
            </div>
          );
        })}
      </div>
      <div className="flex items-center gap-0.5 pl-1.5">
      <button
        onClick={onToggleBroadcast}
        title={broadcastActive ? "Quitter la diffusion" : "Diffuser une commande à tous les terminaux ouverts"}
        className={`btn btn-sm btn-icon ${
          broadcastActive
            ? "bg-[color-mix(in_srgb,var(--c-warn)_18%,transparent)] text-[var(--c-warn)]"
            : "btn-ghost text-[var(--c-text-muted)]"
        }`}
      >
        <IconBroadcast size={15} />
      </button>
      <button
        onClick={onToggleSplit}
        title={splitOpen ? "Quitter le mode split" : "Mode split — deux terminaux côte à côte"}
        className={`btn btn-sm btn-icon ${splitOpen ? "btn-toggled" : "btn-ghost text-[var(--c-text-muted)]"}`}
      >
        <IconSplit size={15} />
      </button>
      {/* Here rather than among the window controls: in fullscreen the title
          bar is hidden, so this row is the only chrome left on screen — and
          the way back out has to stay visible. */}
      <button
        onClick={onToggleFullscreen}
        title={fullscreen ? "Quitter le plein écran (F11)" : "Plein écran (F11)"}
        aria-label={fullscreen ? "Quitter le plein écran" : "Plein écran"}
        className={`btn btn-sm btn-icon ${fullscreen ? "btn-toggled" : "btn-ghost text-[var(--c-text-muted)]"}`}
      >
        {fullscreen ? <IconFullscreenExit size={15} /> : <IconFullscreen size={15} />}
      </button>
      </div>
    </div>
  );
}
