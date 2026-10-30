import { useEffect, useRef, useState } from "react";
import type { TabMeta } from "../lib/types";
import { IconTerminal, IconTransfer, IconMonitor, IconClose, IconBroadcast, IconDatabase, IconNetDiag, IconActivity, IconPin, IconEye, IconRunbook, IconSettings, IconKeychain, IconCloud, IconVault } from "./ui-icons";

interface TabBarProps {
  tabs: TabMeta[];
  activeTabId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onReorder: (tabs: TabMeta[]) => void;
  /** Resolves a tab to its host group's tag color (hex), if any. */
  tabColor?: (tab: TabMeta) => string | undefined;
  /** La bande vit dans la barre de titre : sa partie vide déplace la
   * fenêtre — sauf en plein écran (voir `TitleBar`). */
  dragRegion?: boolean;
}

function TabIcon({ kind }: { kind: TabMeta["kind"] }) {
  if (kind === "terminal" || kind === "local-terminal") return <IconTerminal size={13} />;
  if (kind === "transfer") return <IconTransfer size={13} />;
  if (kind === "fleet") return <IconBroadcast size={13} />;
  if (kind === "sql") return <IconDatabase size={13} />;
  if (kind === "netdiag") return <IconNetDiag size={13} />;
  if (kind === "activity") return <IconActivity size={13} />;
  if (kind === "settings") return <IconSettings size={13} />;
  if (kind === "keys") return <IconKeychain size={13} />;
  if (kind === "cloud") return <IconCloud size={13} />;
  if (kind === "guivault") return <IconVault size={13} />;
  if (kind === "runbook") return <IconRunbook size={13} />;
  return <IconMonitor size={13} />;
}

export function TabBar({ tabs, activeTabId, onSelect, onClose, onReorder, tabColor, dragRegion }: TabBarProps) {
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
    <div className="flex h-full min-w-0 flex-initial items-stretch">
      {/* Les onglets se partagent la largeur comme dans un navigateur : ils
          rétrécissent (jusqu'à 6 rem, le libellé tronqué) avant de déborder,
          et s'ils débordent quand même, la molette fait défiler sans qu'une
          barre à flèches vienne s'incruster dans le bandeau. La place libre
          après le dernier onglet déplace la fenêtre. */}
      <div ref={containerRef} data-tauri-drag-region={dragRegion} className="scrollbar-none flex min-w-0 flex-1 items-stretch overflow-x-auto">
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
              className={`group/tab relative -mb-px flex min-w-[6rem] max-w-[14rem] shrink cursor-pointer select-none items-center gap-2 border-r border-[var(--c-border)] pl-3 pr-2 text-[12.5px] transition-colors ${
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
                className={`flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[5px] transition-opacity hover:bg-[var(--c-active)] ${
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
    </div>
  );
}
