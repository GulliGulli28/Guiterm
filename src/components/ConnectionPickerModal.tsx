import { useModalSurface } from "../hooks/useModalSurface";

/** A per-row action that is *not* "pick this one" — showing a container's
 * logs, stopping it. Kept out of `onPick` so a row can offer several verbs
 * without the list stopping being a picker. */
export interface PickerAction {
  label: string;
  title?: string;
  run: () => void;
}

interface PickerItem {
  id: string;
  name: string;
  meta: string;
  up: boolean;
  actions?: PickerAction[];
}

interface ConnectionPickerModalProps {
  title: string;
  /** Shown as an amber notice under the title — e.g. to flag example data. */
  warning?: string;
  loading: boolean;
  error?: string | null;
  items: PickerItem[];
  /** Élargit la boîte. Les lignes du sélecteur de sessions persistantes
   * portent trois actions *et* deux lignes de texte descriptif ; à la largeur
   * d'origine (celle d'une liste de conteneurs, où le nom suffit), les boutons
   * mangeaient la place et « Session ouverte il y a… » se retrouvait tronqué.
   * Les actions occupent leur largeur même invisibles — elles ne sont que
   * transparentes hors survol. */
  wide?: boolean;
  onPick: (id: string) => void;
  onClose: () => void;
}

/** Shared "pick a live target" modal for kinds where a saved host is really a
 * daemon/cluster entry point (Docker containers, Kubernetes pods) rather
 * than a single connectable thing — same chrome for a real, loading list
 * and a stubbed, example one. */
export function ConnectionPickerModal({ title, warning, loading, error, items, wide, onPick, onClose }: ConnectionPickerModalProps) {
  const { ref, dialogProps } = useModalSurface({ onClose, label: "Choisir une connexion" });

  return (
    <>
      <div className="fixed inset-0 z-30 bg-black/50" onClick={onClose} />
      <div ref={ref} {...dialogProps} className={`fixed left-1/2 top-1/2 z-40 ${wide ? "w-[560px]" : "w-[360px]"} max-w-[90vw] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-lg bg-[var(--c-bg2)] shadow-[var(--shadow-lg)]`}>
        <div className="border-b border-[var(--c-border)] px-4 py-3">
          <p className="text-[14px] font-medium text-[var(--c-text)]">{title}</p>
          {warning && <p className="mt-1 text-[11px] leading-relaxed text-amber-300">⚠ {warning}</p>}
        </div>
        <div className="max-h-[320px] overflow-y-auto p-1.5">
          {loading && (
            <div className="flex items-center gap-2 px-3 py-6 text-[12.5px] text-[var(--c-text-muted)]">
              <span className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-[var(--c-border)] border-t-[var(--c-accent)]" />
              Interrogation en cours…
            </div>
          )}
          {!loading && error && <p className="px-3 py-4 text-[12.5px] text-rose-300">{error}</p>}
          {!loading && !error && items.length === 0 && (
            <p className="px-3 py-4 text-[12.5px] text-[var(--c-text-muted)]">Aucun élément trouvé.</p>
          )}
          {!loading && !error && items.map((item) => (
            // A row, not a button, now that it can hold several verbs — the
            // name stays the "pick" affordance, the actions sit beside it.
            <div key={item.id} className="group flex items-center gap-2.5 rounded-md px-2.5 py-2 hover:bg-white/5">
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${item.up ? "bg-emerald-400" : "bg-[var(--c-text-faint)]"}`} />
              <button onClick={() => onPick(item.id)} className="min-w-0 flex-1 text-left">
                <span className="block truncate text-[12.5px] text-[var(--c-text)]">{item.name}</span>
                <span className="block truncate text-[10.5px] text-[var(--c-text-muted)]">{item.meta}</span>
              </button>
              {item.actions?.map((action) => (
                <button
                  key={action.label}
                  onClick={action.run}
                  title={action.title}
                  className="shrink-0 rounded px-1.5 py-0.5 text-[10.5px] text-[var(--c-text-muted)] opacity-0 hover:bg-white/10 hover:text-[var(--c-text)] focus-visible:opacity-100 group-hover:opacity-100"
                >
                  {action.label}
                </button>
              ))}
            </div>
          ))}
        </div>
        <div className="border-t border-[var(--c-border)] p-2">
          <button onClick={onClose} className="w-full rounded-md bg-[var(--c-bg3)] py-1.5 text-center text-[12px] text-[var(--c-text-secondary)] hover:bg-white/5">
            Fermer
          </button>
        </div>
      </div>
    </>
  );
}
