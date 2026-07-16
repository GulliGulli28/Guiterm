/** Colour for a RAM-usage percentage: green under 70, amber under 85, red above. */
export function ramColor(pct: number): string {
  if (pct >= 85) return "#ef4444";
  if (pct >= 70) return "#f59e0b";
  return "#22c55e";
}
