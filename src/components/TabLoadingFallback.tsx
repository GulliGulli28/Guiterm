/** Suspense fallback for lazy-loaded tab content (RdpTab/TransferTab/FleetTab).
 * Chunk load is near-instant here (bundled locally by Tauri, no network) so
 * this is rarely if ever actually seen — it exists so a slow machine/disk
 * doesn't flash blank content instead. */
export function TabLoadingFallback() {
  return (
    <div className="flex flex-1 items-center justify-center text-xs text-[var(--c-text-faint)]">
      Chargement…
    </div>
  );
}
