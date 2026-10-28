import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type { Host, KnownHostEntry, Workspace } from "../lib/types";
import { IconTrash, IconDownload, IconShield } from "./ui-icons";
import { EntityRow, EntityMono } from "./EntityRow";
import { SshConfigImportDialog } from "./SshConfigImportDialog";

interface KnownHostsPanelProps {
  /** Pour que l'import reconnaisse les hôtes déjà enregistrés. */
  hosts: Host[];
  onWorkspaceUpdate: (ws: Workspace) => void;
  onError: (msg: string) => void;
}

export function KnownHostsPanel({ hosts, onWorkspaceUpdate, onError }: KnownHostsPanelProps) {
  const [entries, setEntries] = useState<KnownHostEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [showImport, setShowImport] = useState(false);

  const refresh = () => {
    setLoading(true);
    api.listKnownHosts().then(setEntries).catch((e) => onError(String(e))).finally(() => setLoading(false));
  };

  useEffect(() => { refresh(); }, []);

  const handleRevoke = (identity: string) => {
    api.revokeKnownHost(identity).then(refresh).catch((e) => onError(String(e)));
  };

  const openImport = () => setShowImport(true);

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
        <SshConfigImportDialog hosts={hosts} onWorkspaceUpdate={onWorkspaceUpdate} onError={onError} onClose={() => setShowImport(false)} />
      )}
    </div>
  );
}
