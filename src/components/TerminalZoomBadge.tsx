interface TerminalZoomBadgeProps {
  fontSize: number;
  /** Offset from the size configured in Settings; `0` means "back to default". */
  offset: number;
}

/**
 * The size readout shown for a moment after a Ctrl+±/Ctrl+0 step.
 *
 * Transient rather than permanent: a terminal left at a non-default size is a
 * normal state to be in, not something worth a badge sitting over the output
 * forever. Saying "défaut" on reset is what makes Ctrl+0 confirmable — the
 * font visibly changes on every other step, but resetting an already-default
 * terminal changes nothing at all.
 */
export function TerminalZoomBadge({ fontSize, offset }: TerminalZoomBadgeProps) {
  return (
    <div className="pointer-events-none absolute left-1/2 top-3 -translate-x-1/2 select-none rounded-md border border-[var(--c-border)] bg-black/75 px-2.5 py-1 font-mono text-[11px] text-[var(--c-text-secondary)] shadow-lg">
      {fontSize} px
      {offset === 0 && <span className="text-[var(--c-text-faint)]"> · défaut</span>}
    </div>
  );
}
