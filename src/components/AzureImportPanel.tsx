import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import { readCloudFailure, tenantFromAzureError, type DescribedFailure } from "../lib/cloudFailure";
import type { CloudInstance, CloudScope, InventoryDiff, Workspace } from "../lib/types";
import { AzureSignInPanel } from "./AzureSignInPanel";
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

interface AzureImportPanelProps {
  workspace: Workspace;
  onWorkspaceUpdate: (ws: Workspace) => void;
  onClose: () => void;
  onError: (message: string) => void;
}

/**
 * Turning Azure VMs into hosts, through the user's own `az` CLI.
 *
 * **A panel of its own rather than a shared cloud panel**, on the same
 * reasoning `AnsibleImportPanel` gives: the scope here is a *subscription*,
 * the login comes from `adminUsername`, and the addresses arrive resolved.
 * None of that is true of GCP. What the two genuinely share lives in
 * `CloudImportBits`.
 *
 * Re-importing is the ordinary case — VMs come and go. Hosts already imported
 * are refreshed rather than duplicated, matched on the ARM resource id (see
 * `core::cloud_inventory` for why not the name or the address).
 */
export function AzureImportPanel({ workspace, onWorkspaceUpdate, onClose, onError }: AzureImportPanelProps) {
  const [subscriptions, setSubscriptions] = useState<CloudScope[]>([]);
  const [subscription, setSubscription] = useState("");
  const [vms, setVms] = useState<CloudInstance[] | null>(null);
  const [failure, setFailure] = useState<DescribedFailure | null>(null);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [auth, setAuth] = useState<BatchAuth>(emptyBatchAuth);
  const [importing, setImporting] = useState(false);
  const [signInOpen, setSignInOpen] = useState(false);
  const [diff, setDiff] = useState<InventoryDiff | null>(null);

  const loadSubscriptions = useCallback(() => {
    setLoading(true);
    return api.listAzureSubscriptions()
      .then((found) => {
        setSubscriptions(found);
        setSubscription(found.find((s) => s.isDefault)?.id ?? found[0]?.id ?? "");
        setFailure(null);
      })
      .catch((e) => setFailure(readCloudFailure(e)))
      .finally(() => setLoading(false));
  }, []);

  // The subscription list is the first thing that needs the CLI, so it is also
  // where "not installed" and "not signed in" surface — before the user has
  // filled anything in.
  useEffect(() => { void loadSubscriptions(); }, [loadSubscriptions]);

  /** After signing in, the VM list on screen belongs to the previous session —
   * clearing it is what stops a stale listing from looking like the new
   * account's. */
  const afterSignIn = () => {
    setVms(null);
    setPicked(new Set());
    void loadSubscriptions();
  };

  /** Which resource ids already exist as hosts — shown per row so a re-import
   * reads as a refresh rather than looking like it will duplicate. */
  const alreadyImported = useMemo(
    () => new Set(workspace.hosts.filter((h) => h.source?.kind === "azure").map((h) => h.source!.id)),
    [workspace.hosts],
  );

  const load = () => {
    setLoading(true);
    setFailure(null);
    api.discoverAzureVms(subscription || null)
      .then((found) => {
        setVms(found);
        // Asked once per listing, from the data just fetched: what has
        // disappeared since the last import is the half the panel never had.
        api.diffAzureInventory(subscription, found).then(setDiff).catch(() => setDiff(null));
        // Nothing pre-ticked: a subscription can hold hundreds of machines,
        // and a panel that arrives fully selected invites importing a whole
        // fleet by reflex.
        setPicked(new Set());
      })
      .catch((e) => { setVms(null); setFailure(readCloudFailure(e)); })
      .finally(() => setLoading(false));
  };

  const { shown, selectable } = useCloudSelection(vms, filter);
  const toggle = (id: string) => setPicked((prev) => toggleIn(prev, id));

  const runImport = () => {
    if (!vms || picked.size === 0) return;
    const chosen = vms.filter((vm) => picked.has(vm.id));
    if (!auth.username.trim() && chosen.some((vm) => !vm.username)) {
      onError("Un utilisateur est requis : certaines VM cochées n'en déclarent pas dans Azure");
      return;
    }
    if (auth.kind === "privateKey" && !auth.keyId && !auth.keyPath.trim()) {
      onError("Choisir une clé du trousseau ou saisir un chemin de clé privée");
      return;
    }

    const selections = chosen.map((vm) => ({
      id: vm.id,
      label: vm.name,
      address: (vm.publicIp || vm.privateIp)!,
      // Azure's own `adminUsername` wins: it is more specific than the one
      // typed for the batch, and it is what the VM was actually built with.
      username: vm.username || auth.username.trim(),
      port: 22,
      groupId: auth.groupId,
      tags: vm.tags.map(([k, v]) => (v ? `${k}=${v}` : k)),
    }));

    setImporting(true);
    api.importAzureHosts(subscription, selections, batchAuthMethod(workspace, auth), auth.secret.trim() || null)
      .then((ws) => { onWorkspaceUpdate(ws); onClose(); })
      .catch((e) => onError(readCloudFailure(e).message))
      .finally(() => setImporting(false));
  };

  return (
    <CloudImportModal
      title="Importer depuis Azure"
      intro={
        <>
          Via votre CLI <span className="font-mono">az</span> déjà connectée — aucun identifiant
          Azure n'est demandé ni conservé. Les étiquettes deviennent des tags.
        </>
      }
      onClose={onClose}
      overlayExtra={
        signInOpen && (
          <AzureSignInPanel
            onClose={() => setSignInOpen(false)}
            onSignedIn={afterSignIn}
            // The CLI names the tenant in its own refusal, so the form arrives
            // filled in rather than asking the user to copy a GUID out of it.
            initialTenant={failure ? tenantFromAzureError(failure.message) : null}
          />
        )
      }
    >
      {failure && (
        <CloudFailureNotice
          failure={failure}
          action={
            // Only when signing in is genuinely the fix. A permissions
            // refusal gets no button: the user would authenticate
            // successfully and hit the very same wall.
            failure.needsLogin ? (
              <button
                onClick={() => setSignInOpen(true)}
                className="rounded-md bg-rose-500/20 px-2.5 py-1 text-[11px] font-medium text-rose-100 hover:bg-rose-500/30"
              >
                Se connecter à Azure
              </button>
            ) : undefined
          }
        />
      )}

      <CloudScopeBar
        label="Abonnement"
        scopes={subscriptions}
        value={subscription}
        onChange={setSubscription}
        onLoad={load}
        loading={loading}
        loadLabel="Lister les VM"
        emptyLabel="(aucun abonnement lisible)"
        defaultSuffix=" — par défaut"
        extra={
          // Always available, not only after a failure: reaching a
          // subscription in another directory is a normal thing to want,
          // and it is not an error state.
          <button
            onClick={() => setSignInOpen(true)}
            className="text-[10px] text-[var(--c-accent-text)] hover:underline"
          >
            Ajouter un abonnement / changer de compte…
          </button>
        }
      />

      {diff && (
        <InventoryDriftNotice
          diff={diff}
          scopeLabel="abonnement"
          onSelectNew={() => setPicked(new Set(diff.notImported))}
        />
      )}

      {vms && (
        <>
          <CloudFilterBar
            filter={filter}
            onFilterChange={setFilter}
            placeholder="Filtrer (nom, adresse, région, groupe, étiquette…)"
            selectable={selectable}
            onSelectAll={() => setPicked(new Set(selectable.map((vm) => vm.id)))}
            onSelectNone={() => setPicked(new Set())}
          />

          <CloudInstanceList
            shown={shown}
            total={vms.length}
            picked={picked}
            alreadyImported={alreadyImported}
            onToggle={toggle}
            emptyLabel="Aucune VM dans cet abonnement."
            noMatchLabel="Aucune VM ne correspond."
          />

          <CloudImportFooter
            workspace={workspace}
            auth={auth}
            onAuthChange={setAuth}
            usernameHint="Utilisé seulement là où Azure ne déclare pas d'administrateur."
            count={picked.size}
            importing={importing}
            onImport={runImport}
          />
        </>
      )}
    </CloudImportModal>
  );
}
