import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type { KnownHostEntry, SshConfigHost, Workspace } from "../lib/types";
import { IconTrash, IconDownload, IconShield } from "./ui-icons";
import { EntityRow, EntityMono } from "./EntityRow";

interface KnownHostsPanelProps {
  onWorkspaceUpdate: (ws: Workspace) => void;
  onError: (msg: string) => void;
}

export function KnownHostsPanel({ onWorkspaceUpdate, onError }: KnownHostsPanelProps) {
  const [entries, setEntries] = useState<KnownHostEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [showImport, setShowImport] = useState(false);
  const [configHosts, setConfigHosts] = useState<SshConfigHost[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [importing, setImporting] = useState(false);

  const refresh = () => {
    setLoading(true);
    api.listKnownHosts().then(setEntries).catch((e) => onError(String(e))).finally(() => setLoading(false));
  };

  useEffect(() => { refresh(); }, []);

  const handleRevoke = (identity: string) => {
    api.revokeKnownHost(identity).then(refresh).catch((e) => onError(String(e)));
  };

  const openImport = () => {
    setShowImport(true);
    if (configHosts === null) {
      api.previewSshConfigImport(null)
        .then((hosts) => { setConfigHosts(hosts); setSelected(new Set(hosts.map((h) => h.alias))); })
        .catch((e) => { onError(String(e)); setConfigHosts([]); });
    }
  };

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
    if (selections.length === 0) { setShowImport(false); return; }
    setImporting(true);
    api.importSshConfigHosts(selections)
      .then((ws) => { onWorkspaceUpdate(ws); setShowImport(false); setConfigHosts(null); })
      .catch((e) => onError(String(e)))
      .finally(() => setImporting(false));
  };

  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-2">
        <p className="eyebrow pl-1">Clés d'hôtes de confiance</p>
        <button onClick={openImport} className="btn btn-secondary btn-sm text-[var(--c-text-secondary)]">
          <IconDownload size={12} /> Importer ~/.ssh/config
        </button>
      </div>

      <div className="sidebar-scroll -mx-1 mt-3 min-h-0 min-w-0 flex-1 overflow-y-auto px-1 pb-2">
        {loading && <p className="px-2 py-8 text-center text-[12px] text-[var(--c-text-muted)]">Chargement…</p>}
        {!loading && entries.length === 0 && (
          <div className="px-2 py-8 text-center">
            <p className="text-[12.5px] font-medium text-[var(--c-text-secondary)]">Aucune clé d'hôte</p>
            <p className="help-text mt-1">La clé publique de chaque serveur est retenue à la première connexion, puis vérifiée aux suivantes.</p>
          </div>
        )}
        {entries.map((e) => (
          <EntityRow
            key={e.identity}
            variant="card"
            icon={<IconShield size={13} />}
            title={e.label}
            secondary={<EntityMono title={e.publicKey}>{e.publicKey}</EntityMono>}
            actions={
              <button
                onClick={() => handleRevoke(e.identity)}
                title="Révoquer la confiance"
                aria-label={`Révoquer ${e.label}`}
                className="btn btn-ghost btn-sm btn-icon hover:text-[var(--c-danger)]"
              >
                <IconTrash size={13} />
              </button>
            }
          />
        ))}
      </div>

      {showImport && (
        <>
          <div className="fixed inset-0 z-30 bg-black/50" onClick={() => setShowImport(false)} />
          <div className="modal fixed left-1/2 top-1/2 z-40 w-[420px] max-w-[90vw] -translate-x-1/2 -translate-y-1/2 overflow-hidden">
            <div className="border-b border-[var(--c-border)] px-4 py-3">
              <p className="text-[14px] font-semibold text-[var(--c-text)]">Importer depuis ~/.ssh/config</p>
              <p className="help-text mt-0.5">Seuls l'alias, l'adresse, l'utilisateur et le port sont importés.</p>
            </div>
            <div className="sidebar-scroll max-h-72 overflow-y-auto p-2">
              {configHosts === null && <p className="px-2 py-6 text-center text-[13px] text-[var(--c-text-muted)]">Lecture du fichier…</p>}
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
                    </p>
                    {h.proxyCommand && (
                      <p className="truncate font-mono text-[10px] text-[var(--c-text-faint)]" title={h.proxyCommand}>
                        via {h.proxyCommand}
                      </p>
                    )}
                  </div>
                </label>
              ))}
            </div>
            <div className="flex justify-end gap-1.5 border-t border-[var(--c-border)] px-4 py-3">
              <button onClick={() => setShowImport(false)} className="btn btn-ghost">Annuler</button>
              <button onClick={runImport} disabled={importing || !configHosts || selected.size === 0} className="btn btn-primary">
                Importer {selected.size > 0 ? `(${selected.size})` : ""}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
