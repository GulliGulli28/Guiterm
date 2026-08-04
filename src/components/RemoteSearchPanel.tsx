import { useState } from "react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { api } from "../lib/api";
import type { Host, RemoteSearchMode, RemoteSearchOutcome } from "../lib/types";
import { IconClose, IconEdit, IconCopy, IconSearch } from "./ui-icons";

interface RemoteSearchPanelProps {
  host: Host;
  onClose: () => void;
  onError: (message: string) => void;
}

const inputClass =
  "w-full rounded-md bg-[var(--c-bg3)] px-2 py-1.5 text-sm text-[var(--c-text)] focus:outline-none focus:ring-1 focus:ring-[var(--c-accent-hover)]";

/** Directory part of a remote path — mirrors `remote_search::parent_of`, and
 * for the same reason: a hit is opened by its directory plus its name. */
function parentOf(path: string): string {
  const index = path.lastIndexOf("/");
  if (index <= 0) return "/";
  return path.slice(0, index);
}

function nameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/**
 * Finding a file on a host, by name or by what's inside it.
 *
 * What makes this more than a terminal with `find` typed into it is the last
 * step: a hit opens in the editor. The path never has to be read, selected and
 * re-typed — which is the part that actually costs time, and the part that
 * goes wrong on a path with a space in it.
 */
export function RemoteSearchPanel({ host, onClose, onError }: RemoteSearchPanelProps) {
  const [mode, setMode] = useState<RemoteSearchMode>("name");
  const [root, setRoot] = useState("/etc");
  const [pattern, setPattern] = useState("");
  const [outcome, setOutcome] = useState<RemoteSearchOutcome | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const run = () => {
    setRunning(true);
    setError(null);
    setOutcome(null);
    api.searchRemoteFiles(host.id, mode, root.trim(), pattern.trim())
      .then(setOutcome)
      .catch((e) => setError(e.message ?? String(e)))
      .finally(() => setRunning(false));
  };

  /**
   * Opens a hit in whatever the OS uses for that file type.
   *
   * A pane is opened and closed around the call: the edit keeps its own handle
   * on the connection (see `remote_edit::RemoteEdit`), so it stays syncable
   * afterwards — and leaving a pane behind for every file opened would pile up
   * connections nobody asked for.
   */
  const openInEditor = (path: string) => {
    setOpening(path);
    api.openPane({ kind: "remote", hostId: host.id })
      .then(async (pane) => {
        try {
          await api.openRemoteFileInEditor(pane.paneId, parentOf(path), nameOf(path));
        } finally {
          await api.closePane(pane.paneId).catch(() => {});
        }
      })
      .catch((e) => onError(e.message ?? String(e)))
      .finally(() => setOpening((current) => (current === path ? null : current)));
  };

  const copyPath = (path: string) => {
    writeText(path)
      .then(() => {
        setCopied(path);
        setTimeout(() => setCopied((current) => (current === path ? null : current)), 1500);
      })
      .catch((e) => onError(String(e)));
  };

  const canRun = !running && pattern.trim().length > 0 && root.trim().length > 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6" onClick={onClose}>
      <div
        className="flex max-h-full w-[min(46rem,100%)] flex-col overflow-hidden rounded-xl border border-[var(--c-border)] bg-[var(--c-bg2)] shadow-[var(--shadow-lg)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-[var(--c-border)] px-4 py-2.5">
          <div>
            <p className="text-[13px] font-medium text-[var(--c-text)]">Rechercher des fichiers — {host.label}</p>
            <p className="text-[11px] text-[var(--c-text-muted)]">
              Par nom ou par contenu. Chaque recherche est bornée en profondeur, en résultats et en durée.
            </p>
          </div>
          <button onClick={onClose} aria-label="Fermer" className="rounded p-1 text-[var(--c-text-muted)] hover:bg-white/5 hover:text-[var(--c-text)]">
            <IconClose size={13} />
          </button>
        </div>

        <div className="shrink-0 space-y-2 border-b border-[var(--c-border)] px-4 py-2.5">
          <div className="flex gap-1.5 rounded-md bg-[var(--c-bg3)] p-1">
            {([["name", "Par nom"], ["content", "Par contenu"]] as [RemoteSearchMode, string][]).map(([m, label]) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={`flex-1 rounded border py-1 text-xs font-medium transition-all ${
                  mode === m ? "accent-surface" : "border-transparent text-[var(--c-text-secondary)] hover:bg-white/5"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="flex items-end gap-2">
            <label className="block w-44 space-y-1">
              <span className="text-xs font-medium text-[var(--c-text-muted)]">Dossier de départ</span>
              <input
                value={root}
                onChange={(e) => setRoot(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && canRun) run(); }}
                placeholder="/etc"
                className={`${inputClass} font-mono`}
              />
            </label>
            <label className="block flex-1 space-y-1">
              <span className="text-xs font-medium text-[var(--c-text-muted)]">
                {mode === "name" ? "Nom de fichier" : "Texte à trouver"}
              </span>
              <input
                value={pattern}
                onChange={(e) => setPattern(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && canRun) run(); }}
                placeholder={mode === "name" ? "nginx.conf" : "server_name"}
                autoFocus
                className={`${inputClass} font-mono`}
              />
            </label>
            <button
              onClick={run}
              disabled={!canRun}
              className="accent-surface flex shrink-0 items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium disabled:opacity-50"
            >
              <IconSearch size={12} /> {running ? "Recherche…" : "Chercher"}
            </button>
          </div>
          {error && <p className="text-[11px] text-rose-300">{error}</p>}
        </div>

        <div className="sidebar-scroll min-h-0 flex-1 overflow-y-auto p-2">
          {outcome === null && !running && (
            <p className="px-2 py-8 text-center text-[13px] text-[var(--c-text-muted)]">
              {mode === "name"
                ? "Le nom est cherché en tant que fragment : « nginx » trouve « nginx.conf »."
                : "Une seule ligne par fichier est rapportée, les binaires sont ignorés."}
            </p>
          )}
          {outcome?.hits.length === 0 && (
            <p className="px-2 py-8 text-center text-[13px] text-[var(--c-text-muted)]">
              Aucun résultat sous {root}
              {outcome.timedOut && " — mais la recherche a été interrompue avant la fin, donc ce n'est pas une réponse."}
            </p>
          )}
          {outcome?.hits.map((hit) => (
            <div key={`${hit.path}:${hit.line ?? 0}`} className="group flex items-start gap-2 rounded-md px-2 py-1.5 hover:bg-white/5">
              <div className="min-w-0 flex-1">
                <p className="truncate font-mono text-[12px] text-[var(--c-text)]" title={hit.path}>
                  {hit.path}
                  {hit.line !== null && <span className="ml-1.5 text-[var(--c-text-muted)]">:{hit.line}</span>}
                </p>
                {hit.excerpt && (
                  <p className="truncate font-mono text-[10px] text-[var(--c-text-muted)]" title={hit.excerpt}>
                    {hit.excerpt}
                  </p>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                <button
                  onClick={() => copyPath(hit.path)}
                  title="Copier le chemin"
                  className="rounded p-1 text-[var(--c-text-muted)] hover:bg-white/5 hover:text-[var(--c-text-secondary)]"
                >
                  {copied === hit.path ? <span className="px-0.5 text-[11px] text-emerald-400">✓</span> : <IconCopy size={12} />}
                </button>
                <button
                  onClick={() => openInEditor(hit.path)}
                  disabled={opening === hit.path}
                  title="Ouvrir dans l'éditeur — le fichier est rapatrié, et renvoyé quand tu l'enregistres"
                  className="rounded p-1 text-[var(--c-text-muted)] hover:bg-white/5 hover:text-[var(--c-text-secondary)] disabled:opacity-50"
                >
                  <IconEdit size={12} />
                </button>
              </div>
            </div>
          ))}
        </div>

        {outcome && (outcome.truncated || outcome.timedOut) && (
          <div className="shrink-0 border-t border-amber-900/60 bg-amber-950/30 px-4 py-2">
            <p className="text-[11px] leading-relaxed text-amber-200/90">
              {outcome.timedOut
                ? "Recherche interrompue au bout de 20 s : cette liste est partielle. Restreindre le dossier de départ."
                : "Limite de résultats atteinte : il y en a d'autres. Affiner le motif ou le dossier de départ."}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
