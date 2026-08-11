import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import { readCloudFailure, type DescribedFailure } from "../lib/cloudFailure";
import type { CloudInstance, CloudScope, InventoryDiff, Workspace } from "../lib/types";
import { IconClose } from "./ui-icons";
import {
  batchAuthMethod,
  cloudInputClass,
  CloudBatchCredentials,
  CloudFailureNotice,
  CloudInstanceRow,
  emptyBatchAuth,
  InventoryDriftNotice,
  toggleIn,
  useCloudSelection,
  type BatchAuth,
} from "./CloudImportBits";

interface GcpImportPanelProps {
  workspace: Workspace;
  onWorkspaceUpdate: (ws: Workspace) => void;
  onClose: () => void;
  onError: (message: string) => void;
}

/**
 * Turning Compute Engine instances into hosts, through the user's own
 * `gcloud` CLI.
 *
 * **A panel of its own**, for the reasons its Azure counterpart gives in
 * reverse: the scope is a *project*, GCP reports no per-instance login (OS
 * Login and project metadata provision accounts, so the batch login always
 * applies), and both labels and network tags become tags.
 *
 * Matching on re-import is the **numeric instance id**, never the name: GCP
 * names are unique only within a zone and only while the instance lives, so a
 * delete/recreate cycle would otherwise let a new machine inherit an old
 * host's credentials.
 */
export function GcpImportPanel({ workspace, onWorkspaceUpdate, onClose, onError }: GcpImportPanelProps) {
  const [projects, setProjects] = useState<CloudScope[]>([]);
  const [project, setProject] = useState("");
  const [instances, setInstances] = useState<CloudInstance[] | null>(null);
  const [failure, setFailure] = useState<DescribedFailure | null>(null);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [auth, setAuth] = useState<BatchAuth>(emptyBatchAuth);
  const [importing, setImporting] = useState(false);
  const [diff, setDiff] = useState<InventoryDiff | null>(null);

  useEffect(() => {
    setLoading(true);
    api.listGcpProjects()
      .then((found) => {
        setProjects(found);
        setProject(found.find((p) => p.isDefault)?.id ?? found[0]?.id ?? "");
        setFailure(null);
      })
      .catch((e) => setFailure(readCloudFailure(e)))
      .finally(() => setLoading(false));
  }, []);

  /** Which instance ids already exist as hosts — shown per row so a re-import
   * reads as a refresh rather than looking like it will duplicate. */
  const alreadyImported = useMemo(
    () => new Set(workspace.hosts.filter((h) => h.source?.kind === "gcp").map((h) => h.source!.id)),
    [workspace.hosts],
  );

  const load = () => {
    setLoading(true);
    setFailure(null);
    api.discoverGcpInstances(project || null)
      .then((found) => {
        setInstances(found);
        setPicked(new Set());
        // Asked from the data just fetched — see the Azure panel.
        api.diffGcpInventory(project, found).then(setDiff).catch(() => setDiff(null));
      })
      .catch((e) => { setInstances(null); setFailure(readCloudFailure(e)); })
      .finally(() => setLoading(false));
  };

  const { shown, selectable } = useCloudSelection(instances, filter);
  const toggle = (id: string) => setPicked((prev) => toggleIn(prev, id));

  const runImport = () => {
    if (!instances || picked.size === 0) return;
    // GCP never reports an instance login, so the batch field is the only
    // source there is — required, unlike on Azure.
    if (!auth.username.trim()) {
      onError("Un utilisateur est requis : GCP ne déclare pas de login par instance");
      return;
    }
    if (auth.kind === "privateKey" && !auth.keyId && !auth.keyPath.trim()) {
      onError("Choisir une clé du trousseau ou saisir un chemin de clé privée");
      return;
    }

    const selections = instances
      .filter((vm) => picked.has(vm.id))
      .map((vm) => ({
        id: vm.id,
        label: vm.name,
        address: (vm.publicIp || vm.privateIp)!,
        username: auth.username.trim(),
        port: 22,
        groupId: auth.groupId,
        tags: vm.tags.map(([k, v]) => (v ? `${k}=${v}` : k)),
      }));

    setImporting(true);
    api.importGcpHosts(project, selections, batchAuthMethod(workspace, auth), auth.secret.trim() || null)
      .then((ws) => { onWorkspaceUpdate(ws); onClose(); })
      .catch((e) => onError(readCloudFailure(e).message))
      .finally(() => setImporting(false));
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6" onClick={onClose}>
      <div
        className="flex max-h-full w-[min(52rem,100%)] flex-col overflow-hidden rounded-xl border border-[var(--c-border)] bg-[var(--c-bg2)] shadow-[var(--shadow-lg)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-[var(--c-border)] px-4 py-2.5">
          <div>
            <p className="text-[13px] font-medium text-[var(--c-text)]">Importer depuis GCP</p>
            <p className="text-[11px] text-[var(--c-text-muted)]">
              Via votre CLI <span className="font-mono">gcloud</span> déjà connectée — aucun
              identifiant Google n'est demandé ni conservé. Étiquettes et tags réseau deviennent des tags.
            </p>
          </div>
          <button onClick={onClose} aria-label="Fermer" className="rounded p-1 text-[var(--c-text-muted)] hover:bg-white/5 hover:text-[var(--c-text)]">
            <IconClose size={13} />
          </button>
        </div>

        {failure && <CloudFailureNotice failure={failure} />}

        <div className="shrink-0 border-b border-[var(--c-border)] px-4 py-2.5">
          <label className="block space-y-1">
            <span className="text-xs font-medium text-[var(--c-text-muted)]">Projet</span>
            <div className="flex gap-1.5">
              <select
                value={project}
                onChange={(e) => setProject(e.target.value)}
                disabled={projects.length === 0}
                className={`${cloudInputClass} flex-1`}
              >
                {projects.length === 0 && <option value="">(aucun projet lisible)</option>}
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}{p.isDefault ? " — courant" : ""}
                  </option>
                ))}
              </select>
              <button
                onClick={load}
                disabled={loading}
                className="accent-surface shrink-0 rounded-md border px-3 text-xs font-medium disabled:opacity-40"
              >
                {loading ? "…" : "Lister les instances"}
              </button>
            </div>
          </label>
        </div>

        {diff && (
          <InventoryDriftNotice
            diff={diff}
            scopeLabel="projet"
            onSelectNew={() => setPicked(new Set(diff.notImported))}
          />
        )}

        {instances && (
          <>
            <div className="shrink-0 border-b border-[var(--c-border)] px-4 py-2">
              <div className="flex items-center gap-2">
                <input
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder="Filtrer (nom, adresse, zone, étiquette, tag réseau…)"
                  className={`${cloudInputClass} flex-1`}
                />
                <button
                  onClick={() => setPicked(new Set(selectable.map((vm) => vm.id)))}
                  className="shrink-0 rounded px-2 py-1 text-[11px] text-[var(--c-accent-text)] hover:bg-[var(--c-bg3)]"
                >
                  Tout ({selectable.length})
                </button>
                <button
                  onClick={() => setPicked(new Set())}
                  className="shrink-0 rounded px-2 py-1 text-[11px] text-[var(--c-text-muted)] hover:bg-[var(--c-bg3)]"
                >
                  Aucun
                </button>
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-2">
              {shown.length === 0 ? (
                <p className="py-6 text-center text-xs text-[var(--c-text-faint)]">
                  {instances.length === 0 ? "Aucune instance dans ce projet." : "Aucune instance ne correspond."}
                </p>
              ) : (
                <ul className="space-y-0.5">
                  {shown.map((vm) => (
                    <CloudInstanceRow
                      key={vm.id}
                      instance={vm}
                      checked={picked.has(vm.id)}
                      known={alreadyImported.has(vm.id)}
                      onToggle={() => toggle(vm.id)}
                    />
                  ))}
                </ul>
              )}
            </div>

            <div className="shrink-0 space-y-2 border-t border-[var(--c-border)] px-4 py-2.5">
              <CloudBatchCredentials
                workspace={workspace}
                auth={auth}
                onChange={setAuth}
                usernameHint="Requis : GCP ne rattache pas de login à l'instance."
              />
              <button
                onClick={runImport}
                disabled={importing || picked.size === 0}
                className="accent-surface w-full rounded-md border py-2 text-sm font-medium disabled:opacity-40"
              >
                {importing ? "Import…" : `Importer ${picked.size} hôte(s)`}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
