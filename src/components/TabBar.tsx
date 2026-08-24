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
    <div className="flex shrink-0 items-center gap-1 border-b border-[var(--c-border)] bg-[var(--c-bg2)] p-1.5">
      {/* The network diagnostics button briefly lived here. It moved to the
          sidebar's nav strip, next to fleet operations: that strip is where
          people look for "what can this app do", and here it went unnoticed. */}
      <div ref={containerRef} className="flex min-w-0 flex-1 gap-1 overflow-x-auto">
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
              className={`flex shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-sm transition-all ${
                isActive
                  ? "accent-surface"
                  : tab.status === "placeholder"
                    ? "border-dashed border-[var(--c-border)] text-[var(--c-text-muted)] hover:bg-white/5"
                    : "border-transparent bg-[var(--c-bg3)] text-[var(--c-text-secondary)] hover:bg-white/5"
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
              {color && <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: color }} />}
              <TabIcon kind={tab.kind} />
              {observing ? <IconEye size={11} className="shrink-0 opacity-70" /> : pinned && <IconPin size={10} className="shrink-0 opacity-70" />}
              <span className="max-w-[12rem] truncate">{tab.label}</span>
              <button
                onClick={(e) => { e.stopPropagation(); onClose(tab.id); }}
                className="flex items-center rounded p-0.5 opacity-60 hover:opacity-100"
                aria-label="Fermer l'onglet"
              >
                <IconClose size={10} />
              </button>
            </div>
          );
        })}
      </div>
      <button
        onClick={onToggleBroadcast}
        title={broadcastActive ? "Quitter la diffusion" : "Diffuser une commande à tous les terminaux ouverts"}
        className={`flex shrink-0 items-center justify-center rounded-lg border p-1.5 transition-all ${
          broadcastActive
            ? "border-transparent bg-amber-800/60 text-amber-100"
            : "border-transparent text-[var(--c-text-secondary)] hover:bg-[var(--c-bg3)] hover:text-[var(--c-text)]"
        }`}
      >
        <IconBroadcast size={15} />
      </button>
      <button
        onClick={onToggleSplit}
        title={splitOpen ? "Quitter le mode split" : "Mode split — deux terminaux côte à côte"}
        className={`flex shrink-0 items-center justify-center rounded-lg border p-1.5 transition-all ${
          splitOpen
            ? "accent-surface"
            : "border-transparent text-[var(--c-text-secondary)] hover:bg-[var(--c-bg3)] hover:text-[var(--c-text)]"
        }`}
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
        className={`flex shrink-0 items-center justify-center rounded-lg border p-1.5 transition-all ${
          fullscreen
            ? "accent-surface"
            : "border-transparent text-[var(--c-text-secondary)] hover:bg-[var(--c-bg3)] hover:text-[var(--c-text)]"
        }`}
      >
        {fullscreen ? <IconFullscreenExit size={15} /> : <IconFullscreen size={15} />}
      </button>
    </div>
  );
}
