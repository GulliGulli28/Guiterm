import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { SqlCellValue } from "../lib/types";

/** Below this many rows, everything is rendered at once — windowing costs
 * more (scroll listener, spacer rows, fixed column widths) than it saves. */
const VIRTUALIZE_THRESHOLD = 150;
/** Rows kept mounted above and below the viewport, so a fast scroll doesn't
 * expose blank space before the next render lands. */
const OVERSCAN = 12;
/** Used for the very first render, before a real row has been measured. */
const ESTIMATED_ROW_HEIGHT = 25;
/** How many rows the column widths are derived from. Measuring all 5000 would
 * defeat the point; the first screenfuls are representative enough in practice
 * and a wider value further down just gets ellipsised (with a `title`). */
const WIDTH_SAMPLE_ROWS = 200;
const MIN_COL_CH = 6;
const MAX_COL_CH = 60;

/** The plain-text form of a cell — what column widths are measured against,
 * and what a truncated cell shows in its tooltip. Mirrors [`formatCell`]
 * exactly, minus the styling. */
export function cellText(cell: SqlCellValue): string {
  if (cell === null) return "NULL";
  if (typeof cell === "object") return JSON.stringify(cell);
  return String(cell);
}

/** A cell is a JSON scalar for most columns, but a nested object/array for
 * JSON(B) columns and (best-effort) text arrays — see `SqlCellValue`'s doc
 * comment. Only the scalar `null` gets the "NULL" treatment; an empty
 * object/array is a real (non-null) value and is shown as such. */
function formatCell(cell: SqlCellValue) {
  if (cell === null) return <span className="italic text-[var(--c-text-faint)]">NULL</span>;
  if (typeof cell === "object") return JSON.stringify(cell);
  return String(cell);
}

/** Per-column character widths, derived from the header plus the first
 * [`WIDTH_SAMPLE_ROWS`] rows.
 *
 * Virtualising a `<table>` means only the visible rows are in the DOM, so an
 * auto-layout table would re-measure — and visibly re-jump — its column widths
 * on every scroll. Fixing the widths up front is what makes windowed scrolling
 * stable; the sample is what keeps them proportional to the actual data
 * instead of all-equal. */
function useColumnWidths(columns: string[], rows: SqlCellValue[][], enabled: boolean): number[] | null {
  return useMemo(() => {
    if (!enabled) return null;
    const sample = rows.slice(0, WIDTH_SAMPLE_ROWS);
    return columns.map((column, j) => {
      let longest = column.length;
      for (const row of sample) {
        const length = cellText(row[j]).length;
        if (length > longest) longest = length;
      }
      return Math.min(Math.max(longest, MIN_COL_CH), MAX_COL_CH);
    });
  }, [columns, rows, enabled]);
}

/** The rows/columns table shared by the SQL tab's query results and its
 * full-table data preview — same rendering either way, only the query that
 * produced `rows` differs.
 *
 * Owns its own scroll container (rather than scrolling inside the caller's)
 * because past [`VIRTUALIZE_THRESHOLD`] rows it only mounts the visible
 * window: the server hands back up to `core::sql::MAX_RESULT_ROWS` (5000)
 * rows, which at a dozen columns is ~60 000 cells — enough DOM to stall the
 * webview for seconds on a single query. */
export function ResultTable({ columns, rows }: { columns: string[]; rows: SqlCellValue[][] }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLTableSectionElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [rowHeight, setRowHeight] = useState(ESTIMATED_ROW_HEIGHT);

  const virtualized = rows.length > VIRTUALIZE_THRESHOLD;
  const widths = useColumnWidths(columns, rows, virtualized);

  // Measure a real rendered row once per result set: row height depends on the
  // font size/theme in effect, so a hardcoded constant would drift the
  // scroll-position maths (rows visibly lagging the scrollbar) whenever the
  // user changes appearance settings.
  useLayoutEffect(() => {
    if (!virtualized) return;
    const firstRow = bodyRef.current?.querySelector("tr[data-row]");
    const measured = firstRow?.getBoundingClientRect().height;
    if (measured && measured > 0 && Math.abs(measured - rowHeight) > 0.5) setRowHeight(measured);
  }, [virtualized, rowHeight, columns, rows]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element || !virtualized) return;
    const sync = () => setViewportHeight(element.clientHeight);
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(element);
    return () => observer.disconnect();
  }, [virtualized]);

  // A new result set starts at the top — otherwise a short result inherits the
  // previous one's scroll offset and renders an empty window.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
    setScrollTop(0);
  }, [columns, rows]);

  const visibleCount = Math.ceil((viewportHeight || ESTIMATED_ROW_HEIGHT * 30) / rowHeight) + OVERSCAN * 2;
  const start = virtualized ? Math.max(0, Math.floor(scrollTop / rowHeight) - OVERSCAN) : 0;
  const end = virtualized ? Math.min(rows.length, start + visibleCount) : rows.length;
  const padTop = start * rowHeight;
  const padBottom = Math.max(0, (rows.length - end) * rowHeight);

  return (
    <div
      ref={scrollRef}
      className="min-h-0 flex-1 overflow-auto"
      onScroll={virtualized ? (e) => setScrollTop(e.currentTarget.scrollTop) : undefined}
    >
      <table className={`w-full border-collapse text-left text-[12px] ${virtualized ? "table-fixed" : ""}`}>
        {widths && (
          <colgroup>
            {widths.map((width, j) => (
              <col key={j} style={{ width: `${width}ch` }} />
            ))}
          </colgroup>
        )}
        <thead>
          <tr>
            {columns.map((c) => (
              <th
                key={c}
                title={c}
                className="sticky top-0 z-10 overflow-hidden text-ellipsis whitespace-nowrap border-b border-[var(--c-border)] bg-[var(--c-bg2)] px-2 py-1 font-medium text-[var(--c-text-secondary)]"
              >
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody ref={bodyRef}>
          {/* Spacer rows stand in for the un-mounted rows above/below the
              window, so the scrollbar reflects the full result set. */}
          {padTop > 0 && (
            <tr aria-hidden>
              <td colSpan={columns.length} style={{ height: padTop, padding: 0 }} />
            </tr>
          )}
          {rows.slice(start, end).map((row, i) => (
            <tr key={start + i} data-row className="hover:bg-white/5">
              {row.map((cell, j) => {
                const text = cellText(cell);
                const clipped = widths ? text.length > widths[j] : false;
                return (
                  <td
                    key={j}
                    title={clipped ? text : undefined}
                    className="overflow-hidden text-ellipsis whitespace-nowrap border-b border-[var(--c-border)] px-2 py-1 font-mono text-[var(--c-text)]"
                  >
                    {formatCell(cell)}
                  </td>
                );
              })}
            </tr>
          ))}
          {padBottom > 0 && (
            <tr aria-hidden>
              <td colSpan={columns.length} style={{ height: padBottom, padding: 0 }} />
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
