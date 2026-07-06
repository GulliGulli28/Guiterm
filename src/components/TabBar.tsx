import { useEffect, useRef, useState } from "react";
import type { TabMeta } from "../lib/types";
import { IconTerminal, IconTransfer, IconMonitor, IconSplit, IconClose } from "./ui-icons";

interface TabBarProps {
  tabs: TabMeta[];
  activeTabId: string | null;
  splitOpen: boolean;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onToggleSplit: () => void;
  onReorder: (tabs: TabMeta[]) => void;
}

function TabIcon({ kind }: { kind: TabMeta["kind"] }) {
  if (kind === "terminal") return <IconTerminal size={13} />;
  if (kind === "transfer") return <IconTransfer size={13} />;
  return <IconMonitor size={13} />;
}

export function TabBar({ tabs, activeTabId, splitOpen, onSelect, onClose, onToggleSplit, onReorder }: TabBarProps) {
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
      <div ref={containerRef} className="flex min-w-0 flex-1 gap-1 overflow-x-auto">
        {tabs.map((tab) => {
          const isActive = tab.id === activeTabId;
          return (
            <div
              key={tab.id}
              data-tab-id={tab.id}
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
              title={tab.status === "placeholder" ? "Session restaurée — cliquez pour reconnecter" : undefined}
            >
              <TabIcon kind={tab.kind} />
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
    </div>
  );
}
