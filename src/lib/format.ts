/** Formats a Unix epoch millisecond timestamp as a short relative time
 * ("à l'instant", "il y a 5 min", "il y a 2 h"), falling back to a locale
 * date once it's more than a day old. */
export function formatRelativeTime(ts: number): string {
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (diffSec < 60) return "à l'instant";
  if (diffSec < 3600) return `il y a ${Math.floor(diffSec / 60)} min`;
  if (diffSec < 86400) return `il y a ${Math.floor(diffSec / 3600)} h`;
  return new Date(ts).toLocaleDateString();
}
