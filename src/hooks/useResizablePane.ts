import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

export interface UseResizablePaneOptions {
  initial: number;
  min: number;
  max: number;
  /** "horizontal" tracks clientX (col-resize), "vertical" tracks clientY (row-resize). */
  axis: "horizontal" | "vertical";
  mode: "px" | "percent";
  /** Flips the drag direction — for a handle on the *leading* edge of a panel
   * that grows toward the start of the axis (e.g. a right-hand panel whose
   * handle sits on its left edge). Default false. */
  invert?: boolean;
  /** Required when `mode === "percent"`: measured (clientWidth/clientHeight)
   * at the start of each drag, not tracked continuously. */
  containerRef?: RefObject<HTMLElement | null>;
  /** Lets a caller combine several panes into one shared drag indicator
   * (see App.tsx's sidebar/right-panel/split-pane, which drive a single
   * cross-fade + mouse-event-stealing overlay from any of the three). */
  onDragChange?: (dragging: boolean) => void;
}

export interface UseResizablePaneResult {
  value: number;
  setValue: (v: number) => void;
  isDragging: boolean;
  onMouseDown: (e: React.MouseEvent) => void;
}

/** Mouse-driven resize handle, shared by every draggable pane divider in the
 * app (sidebar, right panel, split terminal, transfer panes, fleet panels) —
 * previously six near-identical copies of the same ref+listener dance. */
export function useResizablePane(options: UseResizablePaneOptions): UseResizablePaneResult {
  const { initial, min, max, axis, mode, invert = false, containerRef, onDragChange } = options;
  const [value, setValue] = useState(initial);
  const [isDragging, setIsDragging] = useState(false);
  const dragData = useRef<{ start: number; startValue: number; containerSize: number } | null>(null);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const drag = dragData.current;
      if (!drag) return;
      const client = axis === "horizontal" ? e.clientX : e.clientY;
      const delta = invert ? drag.start - client : client - drag.start;
      if (mode === "percent") {
        if (drag.containerSize <= 0) return;
        setValue(Math.max(min, Math.min(max, drag.startValue + (delta / drag.containerSize) * 100)));
      } else {
        setValue(Math.max(min, Math.min(max, drag.startValue + delta)));
      }
    };
    const onUp = () => {
      if (!dragData.current) return;
      dragData.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      setIsDragging(false);
      onDragChange?.(false);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [axis, invert, min, max, mode, onDragChange]);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    const containerSize =
      mode === "percent"
        ? (axis === "horizontal" ? containerRef?.current?.clientWidth : containerRef?.current?.clientHeight) ?? 0
        : 0;
    dragData.current = {
      start: axis === "horizontal" ? e.clientX : e.clientY,
      startValue: value,
      containerSize,
    };
    document.body.style.cursor = axis === "horizontal" ? "col-resize" : "row-resize";
    document.body.style.userSelect = "none";
    setIsDragging(true);
    onDragChange?.(true);
    e.preventDefault();
  }, [axis, mode, containerRef, value, onDragChange]);

  return { value, setValue, isDragging, onMouseDown };
}
