import { useCallback, useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { useModalSurface } from "../hooks/useModalSurface";
import { IconClose } from "./ui-icons";

/** Une section du formulaire, telle que la navigation du tiroir la montre :
 * son nom, et ce qu'elle contient en quelques mots. */
export interface FormSection<K extends string> {
  id: K;
  label: string;
  icon: ReactNode;
  /** Le résumé sous le nom (« SSH · 203.0.113.10 », « Agent SSH ») — ce qui
   * évite d'ouvrir une section pour savoir ce qu'elle dit. */
  summary: string;
}

interface FormDrawerProps<K extends string> {
  /** Annoncé à l'ouverture, et cherché par l'E2E (`h2`). */
  title: string;
  subtitle?: ReactNode;
  icon: ReactNode;
  /** Sans sections : un seul volet, sans navigation (un dossier n'a que
   * quatre champs). */
  sections?: FormSection<K>[];
  active?: K;
  onSection?: (id: K) => void;
  onCancel: () => void;
  /** Appelé par Ctrl+S, comme par le bouton du pied. */
  onSubmit: () => void;
  /** Grisé (vault en lecture) : Ctrl+S ne fait rien non plus. */
  submitDisabled?: boolean;
  /** Le pied : Supprimer à gauche, puis les actions. */
  footer: ReactNode;
  children: ReactNode;
}

/**
 * Le tiroir des formulaires d'hôte, de dossier et de connexion.
 *
 * Il remplace la colonne de droite, où le formulaire d'hôte empilait trente
 * champs dans 380 px : 720 px par-dessus la zone principale, voilée, avec à
 * gauche la navigation des sections et ce que chacune contient. Une seule
 * section est rendue à la fois — l'erreur d'un champ ouvre la sienne.
 *
 * Modal (`useModalSurface`) : Échap annule, Tab reste dans le tiroir. Le
 * voile ne ferme rien au clic — un clic à côté ne doit pas jeter une saisie.
 */
export function FormDrawer<K extends string>({ title, subtitle, icon, sections, active, onSection, onCancel, onSubmit, submitDisabled, footer, children }: FormDrawerProps<K>) {
  // Un `onClose` stable : `useModalSurface` rejoue son effet quand il change,
  // et le nettoyage rend le focus au bouton d'ouverture. `App` passe une
  // flèche neuve à chaque rendu — le champ en cours de saisie perdait le
  // focus au moindre rendu de l'app.
  const cancelRef = useRef(onCancel);
  useLayoutEffect(() => { cancelRef.current = onCancel; });
  const cancel = useCallback(() => cancelRef.current(), []);
  const { ref, dialogProps } = useModalSurface({ onClose: cancel, label: title });

  // Après `useModalSurface`, qui a retenu le bouton d'ouverture : un
  // `autoFocus` passe avant tout effet, et c'est le champ qu'il aurait retenu
  // — le focus ne revenait plus nulle part à la fermeture.
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus();
  }, [ref]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== "s") return;
      // Une boîte posée par-dessus (choix d'un hôte, d'une icône) a la main.
      const holder = e.target instanceof Element ? e.target.closest('[role="dialog"], .modal') : null;
      if (holder && holder !== ref.current) return;
      e.preventDefault();
      if (!submitDisabled) onSubmit();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onSubmit, submitDisabled, ref]);

  return (
    <>
      <div className="absolute inset-0 z-40 bg-black/50" aria-hidden="true" />
      <section
        ref={ref}
        {...dialogProps}
        data-form
        className="absolute inset-y-0 right-0 z-40 flex w-[720px] max-w-full flex-col border-l border-[var(--c-border)] bg-[var(--c-bg2)] shadow-[var(--shadow-lg)] outline-none"
      >
        <header className="flex h-[60px] shrink-0 items-center gap-3 border-b border-[var(--c-border)] px-5">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-[var(--c-border)] bg-[var(--c-bg3)] text-[var(--c-text-secondary)]">
            {icon}
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-[15px] font-semibold text-[var(--c-text)]">{title}</h2>
            {subtitle && <div className="mt-0.5 flex min-w-0 items-center gap-1.5 truncate text-[11.5px] text-[var(--c-text-muted)]">{subtitle}</div>}
          </div>
          <button type="button" onClick={cancel} aria-label="Fermer le formulaire" title="Fermer (Échap)" className="btn btn-ghost btn-icon">
            <IconClose size={14} />
          </button>
        </header>

        <div className="flex min-h-0 flex-1">
          {sections && sections.length > 0 && (
            <nav aria-label="Sections" className="sidebar-scroll w-[200px] shrink-0 space-y-0.5 overflow-y-auto border-r border-[var(--c-border)] px-2.5 py-3.5">
              {sections.map((section) => (
                <button
                  key={section.id}
                  type="button"
                  data-form-section={section.id}
                  aria-current={section.id === active ? "page" : undefined}
                  onClick={() => onSection?.(section.id)}
                  className={`flex w-full items-start gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors ${
                    section.id === active ? "bg-[var(--c-active)] text-[var(--c-text)]" : "text-[var(--c-text-secondary)] hover:bg-[var(--c-hover)]"
                  }`}
                >
                  <span className="mt-0.5 shrink-0 text-[var(--c-text-muted)]">{section.icon}</span>
                  <span className="min-w-0">
                    <span className="block text-[12.5px] font-medium">{section.label}</span>
                    <span className="block truncate text-[11px] text-[var(--c-text-muted)]" title={section.summary}>{section.summary}</span>
                  </span>
                </button>
              ))}
            </nav>
          )}
          <div className="sidebar-scroll min-h-0 min-w-0 flex-1 overflow-y-auto px-6 py-5">{children}</div>
        </div>

        <footer className="flex shrink-0 flex-wrap items-center gap-2 border-t border-[var(--c-border)] px-5 py-3">{footer}</footer>
      </section>
    </>
  );
}

/** Supprimer, à gauche du pied, avec une confirmation sur place. */
export function DrawerDeleteButton({ what, confirming, onAsk, onConfirm, onCancel }: {
  /** « cet hôte », « ce dossier »… */
  what: string;
  confirming: boolean;
  onAsk: () => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  if (!confirming) {
    return (
      <button type="button" onClick={onAsk} className="btn btn-ghost text-[var(--c-danger)] hover:bg-[color-mix(in_srgb,var(--c-danger)_10%,transparent)]">
        Supprimer
      </button>
    );
  }
  return (
    <span className="flex items-center gap-1.5" role="group" aria-label={`Supprimer ${what}`}>
      <span className="text-[12px] text-[var(--c-text-secondary)]">Supprimer {what} ?</span>
      <button type="button" onClick={onConfirm} className="btn btn-danger btn-sm">Oui, supprimer</button>
      <button type="button" onClick={onCancel} className="btn btn-ghost btn-sm">Non</button>
    </span>
  );
}

/** Le bouton Enregistrer, et le raccourci qui fait la même chose. */
export function DrawerSaveButton({ label = "Enregistrer", disabled, onClick }: { label?: string; disabled?: boolean; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} className="btn btn-primary">
      {label}<span className="kbd border-[color-mix(in_srgb,var(--c-on-accent)_30%,transparent)] text-[color-mix(in_srgb,var(--c-on-accent)_75%,transparent)]">Ctrl S</span>
    </button>
  );
}

/** Un champ : son libellé au-dessus. `<label>` englobant — l'E2E cherche le
 * champ par le texte du `span`. */
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="field-label">{label}</span>
      {children}
    </label>
  );
}

/** Un champ fait de plusieurs contrôles (liste de bastions, étiquettes,
 * boutons de type) : un groupe nommé, pas un `<label>`. Dans un `<label>`, un
 * clic dans le vide activait le premier bouton du groupe (« Monter »), et ce
 * premier bouton prenait tout le texte du libellé pour nom. */
export function FieldGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div role="group" aria-label={label}>
      <span className="field-label">{label}</span>
      {children}
    </div>
  );
}
