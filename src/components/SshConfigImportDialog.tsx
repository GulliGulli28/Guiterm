import { useEffect, useMemo, useState } from "react";
import { useModalSurface } from "../hooks/useModalSurface";
import { api } from "../lib/api";
import type { Host, SshConfigHost, Workspace } from "../lib/types";

/** Un hôte de `~/.ssh/config` qu'on a déjà : même adresse, même utilisateur,
 * même port. L'alias ne compte pas — on renomme souvent un hôte importé. */
export function alreadyImported(entry: SshConfigHost, hosts: Host[]): boolean {
  const address = (entry.hostname ?? entry.alias).toLowerCase();
  const port = entry.port ?? 22;
  return hosts.some((h) =>
    h.address.toLowerCase() === address && h.port === port && (entry.user == null || h.username === entry.user));
}

/**
 * Importer depuis `~/.ssh/config` : une fenêtre, ouverte depuis l'accueil ou
 * depuis le panneau Known Hosts. Rien n'est écrit avant « Importer ».
 *
 * Les hôtes déjà présents sont décochés d'office : les réimporter créerait des
 * doublons que l'utilisateur devrait ensuite trier à la main.
 */
export function SshConfigImportDialog({ hosts, onWorkspaceUpdate, onError, onClose }: {
  /** Les hôtes connus, pour reconnaître ceux qui sont déjà là. */
  hosts: Host[];
  onWorkspaceUpdate: (ws: Workspace) => void;
  onError: (msg: string) => void;
  onClose: () => void;
}) {
  const [configHosts, setConfigHosts] = useState<SshConfigHost[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [importing, setImporting] = useState(false);
  const { ref, dialogProps } = useModalSurface({ onClose, label: "Importer depuis ~/.ssh/config" });

  useEffect(() => {
    let cancelled = false;
    api.previewSshConfigImport(null)
      .then((found) => {
        if (cancelled) return;
        setConfigHosts(found);
        setSelected(new Set(found.filter((h) => !alreadyImported(h, hosts)).map((h) => h.alias)));
      })
      .catch((e) => { if (!cancelled) { onError(String(e)); setConfigHosts([]); } });
    return () => { cancelled = true; };
    // Lu une fois à l'ouverture : relire à chaque changement de `hosts`
    // décocherait sous les yeux de l'utilisateur ce qu'il vient de cocher.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const present = useMemo(
    () => new Set((configHosts ?? []).filter((h) => alreadyImported(h, hosts)).map((h) => h.alias)),
    [configHosts, hosts],
  );

  const toggleSelected = (alias: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(alias)) next.delete(alias);
      else next.add(alias);
      return next;
    });
  };

  const runImport = () => {
    if (!configHosts) return;
    const selections = configHosts
      .filter((h) => selected.has(h.alias))
      .map((h) => ({
        alias: h.alias,
        hostname: h.hostname ?? h.alias,
        user: h.user ?? "",
        port: h.port ?? 22,
        groupId: null,
        // Without this an SSM/IAP-only entry would import as a plain direct
        // connection and simply time out — the config file already knew how
        // to reach it.
        proxyCommand: h.proxyCommand,
      }));
    if (selections.length === 0) { onClose(); return; }
    setImporting(true);
    api.importSshConfigHosts(selections)
      .then((ws) => { onWorkspaceUpdate(ws); onClose(); })
      .catch((e) => onError(String(e)))
      .finally(() => setImporting(false));
  };

  return (
    <>
      <div className="fixed inset-0 z-30 bg-black/50" onClick={onClose} />
      <div ref={ref} {...dialogProps} data-ssh-config-import="" className="modal fixed left-1/2 top-1/2 z-40 w-[480px] max-w-[90vw] -translate-x-1/2 -translate-y-1/2 overflow-hidden">
        <div className="border-b border-[var(--c-border)] px-4 py-3">
          <p className="text-[14px] font-semibold text-[var(--c-text)]">Importer depuis ~/.ssh/config</p>
          <p className="help-text mt-0.5">
            {configHosts === null
              ? "Lecture du fichier…"
              : `${configHosts.length} hôte${configHosts.length > 1 ? "s" : ""} trouvé${configHosts.length > 1 ? "s" : ""}${present.size > 0 ? ` · ${present.size} déjà présent${present.size > 1 ? "s" : ""}` : ""}. Rien n'est enregistré avant de confirmer.`}
          </p>
        </div>
        <div className="sidebar-scroll max-h-80 overflow-y-auto p-2">
          {configHosts?.length === 0 && <p className="px-2 py-6 text-center text-[13px] text-[var(--c-text-muted)]">Aucun hôte trouvé dans ~/.ssh/config</p>}
          {configHosts?.map((h) => (
            <label key={h.alias} className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-[var(--c-hover)]">
              <input
                type="checkbox"
                checked={selected.has(h.alias)}
                onChange={() => toggleSelected(h.alias)}
                className="h-3.5 w-3.5 shrink-0"
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] text-[var(--c-text)]">{h.alias}</p>
                <p className="truncate font-mono text-[11px] text-[var(--c-text-muted)]">
                  {h.user ?? "?"}@{h.hostname ?? h.alias}{h.port ? `:${h.port}` : ""}
                  {h.proxyCommand && <span title={h.proxyCommand}> · via {h.proxyCommand}</span>}
                </p>
              </div>
              {present.has(h.alias) && <span className="tag shrink-0">Déjà présent</span>}
            </label>
          ))}
        </div>
        <div className="flex justify-end gap-1.5 border-t border-[var(--c-border)] px-4 py-3">
          <button onClick={onClose} className="btn btn-ghost">Annuler</button>
          <button onClick={runImport} disabled={importing || !configHosts || selected.size === 0} className="btn btn-primary">
            {selected.size > 0 ? `Importer ${selected.size} hôte${selected.size > 1 ? "s" : ""}` : "Importer"}
          </button>
        </div>
      </div>
    </>
  );
}
