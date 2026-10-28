import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { api } from "../lib/api";
import type { ExportPreview, Workspace } from "../lib/types";
import { ImportSourceFrame } from "./ImportSourceFrame";
import { IconDownload } from "./ui-icons";

const fileFilters = [{ name: "Export Guiterm", extensions: ["json"] }];

const count = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;

/**
 * La source « Fichier d'export Guiterm » : une configuration entière
 * (Paramètres › Exporter) ou un hôte seul (menu d'un hôte › Exporter).
 *
 * Le fichier est **lu avant d'être importé** (`inspect_import_file`) : on voit
 * ses hôtes, ceux qui remplaceraient un hôte déjà là, et s'il porte des
 * commandes de démarrage. Les deux imports existaient déjà (Paramètres, et
 * « Importer un hôte (fichier) » du panneau Hôtes, qui importait sans rien
 * montrer) ; c'est l'aperçu qui manquait.
 */
export function FileImportSource({ onWorkspaceUpdate, onError, onClose }: {
  onWorkspaceUpdate: (ws: Workspace) => void;
  onError: (msg: string) => void;
  onClose: () => void;
}) {
  const [path, setPath] = useState<string | null>(null);
  const [preview, setPreview] = useState<ExportPreview | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [keepAutomation, setKeepAutomation] = useState(false);
  const [confirmReplace, setConfirmReplace] = useState(false);
  const [importing, setImporting] = useState(false);

  const choose = async () => {
    try {
      const picked = await open({ title: "Importer un fichier d'export Guiterm", multiple: false, filters: fileFilters });
      if (!picked || typeof picked !== "string") return;
      setPath(picked);
      setPreview(null);
      setFailure(null);
      setConfirmReplace(false);
      setKeepAutomation(false);
      setPreview(await api.inspectImportFile(picked));
    } catch (e) {
      setFailure(String(e));
    }
  };

  const run = (replace: boolean) => {
    if (!path || !preview) return;
    setImporting(true);
    const done = preview.kind === "host"
      ? api.importHostFromFile(path, keepAutomation)
      : api.importWorkspace(path, replace, keepAutomation);
    done
      .then((ws) => { onWorkspaceUpdate(ws); onClose(); })
      .catch((e) => onError(String(e)))
      .finally(() => setImporting(false));
  };

  const replaced = preview?.hosts.filter((h) => h.existing).length ?? 0;
  const contents = preview ? [
    count(preview.hosts.length, "hôte", "hôtes"),
    preview.groups > 0 ? count(preview.groups, "dossier", "dossiers") : null,
    preview.snippets > 0 ? count(preview.snippets, "snippet", "snippets") : null,
    preview.keys > 0 ? count(preview.keys, "clé", "clés") : null,
    preview.portForwards > 0 ? count(preview.portForwards, "tunnel", "tunnels") : null,
  ].filter(Boolean).join(", ") : "";

  return (
    <ImportSourceFrame
      source="file"
      intro="Une configuration exportée depuis les Réglages, ou un hôte exporté depuis son menu."
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--c-border)] px-4 py-2.5">
        <p className="min-w-0 flex-1 truncate font-mono text-[12px] text-[var(--c-text-secondary)]" title={path ?? undefined}>
          {path ?? <span className="font-sans text-[var(--c-text-muted)]">Aucun fichier choisi</span>}
        </p>
        <button onClick={choose} className="btn btn-secondary shrink-0">
          <IconDownload size={13} /> {path ? "Choisir un autre fichier…" : "Choisir un fichier…"}
        </button>
      </div>

      {failure && (
        <div className="callout callout-danger mx-4 mt-3 shrink-0">
          <p className="text-[12.5px]">Ce fichier ne peut pas être importé.</p>
          <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-[11px]">{failure}</pre>
        </div>
      )}

      <div className="sidebar-scroll min-h-0 flex-1 overflow-y-auto" data-file-import-preview={preview?.kind ?? ""}>
        {!preview && !failure && (
          <p className="px-4 py-10 text-center text-[12.5px] text-[var(--c-text-muted)]">
            Choisissez un fichier .json : son contenu s'affiche ici avant tout import.
          </p>
        )}
        {preview && (
          <>
            <p className="px-4 pt-3 text-[12.5px] text-[var(--c-text)]">
              <strong className="font-semibold">{preview.kind === "host" ? "Un hôte" : "Une configuration complète"}</strong>
              <span className="text-[var(--c-text-muted)]"> · {contents}{replaced > 0 ? ` · ${replaced} remplacera${replaced > 1 ? "ient" : ""} un hôte existant` : ""}</span>
            </p>
            <table className="mt-2 w-full table-fixed text-[12.5px]">
              <thead>
                <tr className="text-left text-[11px] text-[var(--c-text-muted)]">
                  <th className="px-4 py-2 font-medium">Hôte</th>
                  <th className="px-2 py-2 font-medium">Adresse</th>
                  <th className="w-[20%] px-2 py-2 font-medium">Utilisateur</th>
                  <th className="w-32 px-4 py-2 font-medium" />
                </tr>
              </thead>
              <tbody>
                {preview.hosts.map((h) => (
                  <tr key={h.id} className="border-t border-[var(--c-border)]">
                    <td className="truncate px-4 py-1.5 font-medium text-[var(--c-text)]">{h.label}</td>
                    <td className="truncate px-2 py-1.5 font-mono text-[11.5px] text-[var(--c-text-muted)]">{h.address}{h.port !== 22 ? `:${h.port}` : ""}</td>
                    <td className="truncate px-2 py-1.5 font-mono text-[11.5px] text-[var(--c-text-muted)]">{h.username || "—"}</td>
                    <td className="px-4 py-1.5 text-right">
                      {h.existing ? <span className="chip chip-warn">Remplacera</span> : <span className="chip chip-ok">Nouveau</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>

      {preview && (
        <div className="shrink-0 space-y-2 border-t border-[var(--c-border)] px-4 py-2.5">
          {preview.hasAutomation && (
            <label className="callout callout-warn flex items-start gap-2">
              <input
                type="checkbox"
                checked={keepAutomation}
                onChange={(e) => setKeepAutomation(e.target.checked)}
                className="mt-0.5 h-3.5 w-3.5 shrink-0"
              />
              <span className="text-[12px]">
                Garder les commandes de démarrage du fichier
                <span
                  className="ml-1 text-[var(--c-text-muted)]"
                  title="Snippets et variables lancés à la première connexion, sans validation. Retirés par défaut : un fichier reçu pourrait sinon exécuter des commandes."
                >
                  · retirées sinon
                </span>
              </span>
            </label>
          )}
          <div className="flex items-center justify-end gap-2">
            {preview.kind === "workspace" && (confirmReplace ? (
              <>
                <span className="mr-auto text-[12px] text-[var(--c-danger)]">Toute la configuration actuelle sera remplacée.</span>
                <button onClick={() => setConfirmReplace(false)} className="btn btn-ghost">Annuler</button>
                <button onClick={() => run(true)} disabled={importing} className="btn btn-danger">Remplacer</button>
              </>
            ) : (
              <button onClick={() => setConfirmReplace(true)} className="btn btn-ghost text-[var(--c-danger)]">Tout remplacer…</button>
            ))}
            {!confirmReplace && (
              <button onClick={() => run(false)} disabled={importing} className="btn btn-primary">
                {importing ? "Import…" : preview.kind === "host" ? "Importer l'hôte" : "Fusionner"}
              </button>
            )}
          </div>
        </div>
      )}
    </ImportSourceFrame>
  );
}
