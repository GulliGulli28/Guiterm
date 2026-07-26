import { Component, type ErrorInfo, type ReactNode } from "react";

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
  componentStack: string | null;
  copied: boolean;
}

/** Catches render-time exceptions anywhere below it and shows a recoverable
 * screen instead of React's default: unmounting the whole tree, which in a
 * desktop app means a blank window with no message, no way back, and nothing
 * to report.
 *
 * A class component because there is still no hook equivalent —
 * `componentDidCatch`/`getDerivedStateFromError` are class-only APIs.
 *
 * Note this does **not** catch errors from event handlers, `setTimeout`
 * callbacks, or rejected promises (React never routes those through an error
 * boundary) — the app's `reportError`/notification path already covers the
 * `invoke(...)` failures that make up most of those. This is the net for the
 * case that path can't reach: a component that throws while rendering. */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null, componentStack: null, copied: false };

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    this.setState({ componentStack: info.componentStack ?? null });
    // Also goes to the webview console, so it's visible in devtools during
    // development and in a `--devtools` session on a user's machine.
    console.error("Erreur non rattrapée dans un composant :", error, info.componentStack);
  }

  private report(): string {
    const { error, componentStack } = this.state;
    return [
      `Erreur : ${error?.message ?? "inconnue"}`,
      "",
      error?.stack ?? "(pas de pile d'appels)",
      "",
      "Composants :",
      componentStack ?? "(indisponible)",
    ].join("\n");
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="flex h-screen w-screen flex-col items-center justify-center gap-4 bg-[var(--c-bg)] p-8 text-[var(--c-text)]">
        <div className="w-full max-w-2xl space-y-4 rounded-xl bg-[var(--c-bg2)] p-6 shadow-[var(--shadow-md)]">
          <h1 className="text-[16px] font-semibold">Une erreur inattendue s'est produite</h1>
          <p className="text-[13px] text-[var(--c-text-secondary)]">
            L'interface a été interrompue. Vos sessions ouvertes ont été fermées, mais aucune donnée
            enregistrée n'est perdue — les hôtes et les connexions sont conservés sur le disque.
          </p>
          <pre className="max-h-64 overflow-auto rounded-md bg-[var(--c-bg3)] p-3 text-[11px] leading-relaxed text-rose-300">
            {this.report()}
          </pre>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => window.location.reload()}
              className="accent-surface rounded-md border px-3 py-1.5 text-xs font-medium"
            >
              Recharger l'application
            </button>
            <button
              onClick={() => {
                // The plain browser clipboard API rather than Tauri's plugin:
                // this screen has to work even when the failure came from
                // something Tauri-related.
                navigator.clipboard
                  .writeText(this.report())
                  .then(() => this.setState({ copied: true }))
                  .catch(() => {});
              }}
              className="rounded-md bg-[var(--c-bg3)] px-3 py-1.5 text-xs text-[var(--c-text-secondary)] hover:bg-white/5"
            >
              {this.state.copied ? "Détails copiés" : "Copier les détails"}
            </button>
          </div>
        </div>
      </div>
    );
  }
}
