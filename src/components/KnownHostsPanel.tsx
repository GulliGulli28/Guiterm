import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type { KnownHostEntry, SshConfigHost, Workspace } from "../lib/types";
import { IconTrash, IconDownload, IconShield } from "./ui-icons";

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
      }));
    if (selections.length === 0) { setShowImport(false); return; }
    setImporting(true);
    api.importSshConfigHosts(selections)
      .then((ws) => { onWorkspaceUpdate(ws); setShowImport(false); setConfigHosts(null); })
      .catch((e) => onError(String(e)))
      .finally(() => setImporting(false));
  };

  return (
    <div className="flex h-full min-w-0 flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[13px] font-medium text-[var(--c-text-secondary)]">Clés de confiance</p>
        <button
          onClick={openImport}
          className="flex shrink-0 items-center gap-1.5 rounded-md border border-dashed border-[var(--c-border)] px-2 py-1 text-[11px] text-[var(--c-text-muted)] hover:border-[var(--c-accent)] hover:text-[var(--c-accent-text)]"
        >
          <IconDownload size={12} /> Importer ~/.ssh/config
        </button>
      </div>

      <div className="sidebar-scroll min-h-0 min-w-0 flex-1 space-y-1 overflow-y-auto pb-2 pl-2 pt-2">
        {loading && <p className="px-1 py-4 text-center text-[13px] text-[var(--c-text-muted)]">Chargement…</p>}
        {!loading && entries.length === 0 && (
          <p className="px-1 py-4 text-center text-[13px] text-[var(--c-text-muted)]">Aucune clé d'hôte de confiance pour l'instant</p>
        )}
        {entries.map((e) => (
          <div key={e.identity} className="group flex items-center gap-2 rounded-xl border border-transparent bg-[var(--c-bg3)] p-2.5 transition-all hover:border-white/15">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-[var(--c-accent-dim)]">
              <IconShield size={15} className="text-[var(--c-accent-text)]" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate font-mono text-[13px] font-medium text-[var(--c-text)]">{e.label}</p>
              <p className="truncate font-mono text-[10px] text-[var(--c-text-muted)]" title={e.publicKey}>{e.publicKey}</p>
            </div>
            <button
              onClick={() => handleRevoke(e.identity)}
              title="Révoquer la confiance"
              className="flex shrink-0 items-center rounded p-1.5 text-[var(--c-text-muted)] opacity-0 transition-opacity hover:bg-rose-900/60 hover:text-rose-300 focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"
            >
              <IconTrash size={13} />
            </button>
          </div>
        ))}
      </div>

      {showImport && (
        <>
          <div className="fixed inset-0 z-30 bg-black/50" onClick={() => setShowImport(false)} />
          <div className="fixed left-1/2 top-1/2 z-40 w-[420px] max-w-[90vw] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-lg bg-[var(--c-bg2)] shadow-[var(--shadow-lg)]">
            <div className="border-b border-[var(--c-border)] px-4 py-3">
              <p className="text-[14px] font-medium text-[var(--c-text)]">Importer depuis ~/.ssh/config</p>
              <p className="mt-0.5 text-[11px] text-[var(--c-text-muted)]">Seuls l'alias, l'adresse, l'utilisateur et le port sont importés.</p>
            </div>
            <div className="sidebar-scroll max-h-72 overflow-y-auto p-2">
              {configHosts === null && <p className="px-2 py-6 text-center text-[13px] text-[var(--c-text-muted)]">Lecture du fichier…</p>}
              {configHosts?.length === 0 && <p className="px-2 py-6 text-center text-[13px] text-[var(--c-text-muted)]">Aucun hôte trouvé dans ~/.ssh/config</p>}
              {configHosts?.map((h) => (
                <label key={h.alias} className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-white/5">
                  <input
                    type="checkbox"
                    checked={selected.has(h.alias)}
                    onChange={() => toggleSelected(h.alias)}
                    className="h-4 w-4 shrink-0 accent-[var(--c-accent)]"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] text-[var(--c-text)]">{h.alias}</p>
                    <p className="truncate font-mono text-[11px] text-[var(--c-text-muted)]">
                      {h.user ?? "?"}@{h.hostname ?? h.alias}{h.port ? `:${h.port}` : ""}
                    </p>
                  </div>
                </label>
              ))}
            </div>
            <div className="flex gap-1.5 border-t border-[var(--c-border)] p-2">
              <button
                onClick={runImport}
                disabled={importing || !configHosts || selected.size === 0}
                className="accent-surface flex-1 rounded-md border py-1.5 text-xs font-medium disabled:opacity-50"
              >
                Importer {selected.size > 0 ? `(${selected.size})` : ""}
              </button>
              <button
                onClick={() => setShowImport(false)}
                className="rounded-md bg-[var(--c-bg3)] px-3 py-1.5 text-xs text-[var(--c-text-secondary)] hover:bg-white/5"
              >
                Annuler
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
