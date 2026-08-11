import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import { readCloudFailure, type DescribedFailure } from "../lib/cloudFailure";
import type { CloudInstance, CloudScope, InventoryDiff, Workspace } from "../lib/types";
import {
  batchAuthMethod,
  CloudFailureNotice,
  CloudFilterBar,
  CloudImportFooter,
  CloudImportModal,
  CloudInstanceList,
  CloudScopeBar,
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
    <CloudImportModal
      title="Importer depuis GCP"
      intro={
        <>
          Via votre CLI <span className="font-mono">gcloud</span> déjà connectée — aucun
          identifiant Google n'est demandé ni conservé. Étiquettes et tags réseau deviennent des tags.
        </>
      }
      onClose={onClose}
    >
      {failure && <CloudFailureNotice failure={failure} />}

      <CloudScopeBar
        label="Projet"
        scopes={projects}
        value={project}
        onChange={setProject}
        onLoad={load}
        loading={loading}
        loadLabel="Lister les instances"
        emptyLabel="(aucun projet lisible)"
        defaultSuffix=" — courant"
      />

      {diff && (
        <InventoryDriftNotice
          diff={diff}
          scopeLabel="projet"
          onSelectNew={() => setPicked(new Set(diff.notImported))}
        />
      )}

      {instances && (
        <>
          <CloudFilterBar
            filter={filter}
            onFilterChange={setFilter}
            placeholder="Filtrer (nom, adresse, zone, étiquette, tag réseau…)"
            selectable={selectable}
            onSelectAll={() => setPicked(new Set(selectable.map((vm) => vm.id)))}
            onSelectNone={() => setPicked(new Set())}
          />

          <CloudInstanceList
            shown={shown}
            total={instances.length}
            picked={picked}
            alreadyImported={alreadyImported}
            onToggle={toggle}
            emptyLabel="Aucune instance dans ce projet."
            noMatchLabel="Aucune instance ne correspond."
          />

          <CloudImportFooter
            workspace={workspace}
            auth={auth}
            onAuthChange={setAuth}
            usernameHint="Requis : GCP ne rattache pas de login à l'instance."
            count={picked.size}
            importing={importing}
            onImport={runImport}
          />
        </>
      )}
    </CloudImportModal>
  );
}
