import { useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { api } from "../lib/api";
import type { AuthMethod, GroupId, Inventory, InventoryHost, KeyId, Workspace } from "../lib/types";
import { IconClose, IconFolder } from "./ui-icons";
import { GroupTreePicker } from "./GroupTreePicker";

interface AnsibleImportPanelProps {
  workspace: Workspace;
  onWorkspaceUpdate: (ws: Workspace) => void;
  onClose: () => void;
  onError: (message: string) => void;
}

type AuthKind = "agent" | "password" | "privateKey";

const inputClass = "input";

/**
 * Turning an Ansible inventory into hosts.
 *
 * **A panel of its own rather than a generalised `AwsImportPanel`.** That one
 * carries a profile picker, a region, SSM reachability and an account search —
 * none of which mean anything for a file. Merging them would produce one panel
 * with two disjoint halves, which reads worse than two panels sharing an
 * idiom: a source picker, a tick list, one set of credentials for the batch.
 *
 * Re-importing is the ordinary case, not the exception — inventories change.
 * Hosts already imported are refreshed rather than duplicated, matched on the
 * inventory name (see `core::ansible_inventory` for why not the address).
 */
export function AnsibleImportPanel({ workspace, onWorkspaceUpdate, onClose, onError }: AnsibleImportPanelProps) {
  const [path, setPath] = useState("");
  const [inventory, setInventory] = useState<Inventory | null>(null);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [groupId, setGroupId] = useState<GroupId | null>(null);
  const [authKind, setAuthKind] = useState<AuthKind>("agent");
  const [username, setUsername] = useState("");
  const [keyId, setKeyId] = useState<KeyId | null>(null);
  const [keyPath, setKeyPath] = useState("");
  const [secret, setSecret] = useState("");
  const [importing, setImporting] = useState(false);

  /** Which inventory names already exist as hosts — shown per row so a
   * re-import reads as a refresh rather than looking like it will duplicate. */
  const alreadyImported = useMemo(
    () => new Set(workspace.hosts.filter((h) => h.source?.kind === "ansible").map((h) => h.source!.id)),
    [workspace.hosts],
  );

  const browse = async () => {
    const selected = await open({ title: "Sélectionner un inventaire Ansible", multiple: false, directory: false });
    if (!selected || typeof selected !== "string") return;
    setPath(selected);
    void load(selected);
  };

  const load = async (from: string) => {
    setLoading(true);
    try {
      const found = await api.readAnsibleInventory(from);
      setInventory(found);
      // Nothing pre-ticked: an inventory can hold hundreds of machines, and a
      // panel that arrives with everything selected invites importing a whole
      // fleet by reflex.
      setPicked(new Set());
    } catch (e) {
      setInventory(null);
      onError(String(e));
    } finally {
      setLoading(false);
    }
  };

  const shown = useMemo(() => {
    const terms = filter.toLowerCase().split(/\s+/).filter(Boolean);
    if (!inventory) return [];
    if (terms.length === 0) return inventory.hosts;
    return inventory.hosts.filter((host) => {
      const haystack = [host.name, host.address, ...host.groups].join(" ").toLowerCase();
      return terms.every((term) => haystack.includes(term));
    });
  }, [inventory, filter]);

  const toggle = (name: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  const authMethod = (): AuthMethod => {
    if (authKind !== "privateKey") return authKind;
    const fromKeychain = workspace.keychain.find((key) => key.id === keyId);
    return {
      privateKey: {
        path: fromKeychain?.path ?? keyPath.trim(),
        keyId: keyId || null,
        // Not offered for a batch: a certificate is per-key and short-lived,
        // and one applied to a whole inventory would be wrong for most of it.
        certPath: null,
      },
    };
  };

  const runImport = () => {
    if (!inventory || picked.size === 0) return;
    if (!username.trim() && inventory.hosts.some((h) => picked.has(h.name) && !h.username)) {
      onError("Un utilisateur est requis : certains hôtes cochés n'en déclarent pas dans l'inventaire");
      return;
    }
    if (authKind === "privateKey" && !keyId && !keyPath.trim()) {
      onError("Choisir une clé du trousseau ou saisir un chemin de clé privée");
      return;
    }
    const selections = inventory.hosts
      .filter((host) => picked.has(host.name))
      .map((host) => ({
        name: host.name,
        label: host.name,
        address: host.address,
        // The inventory's own value wins: it is more specific than the one
        // typed for the batch, exactly as Ansible resolves it.
        username: host.username ?? username.trim(),
        port: host.port ?? 22,
        groupId,
        tags: host.groups,
      }));

    setImporting(true);
    api.importAnsibleHosts(selections, authMethod(), secret.trim() || null)
      .then((ws) => { onWorkspaceUpdate(ws); onClose(); })
      .catch((e) => onError(String(e)))
      .finally(() => setImporting(false));
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6" onClick={onClose}>
      <div
        className="flex max-h-full w-[min(48rem,100%)] flex-col overflow-hidden modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-[var(--c-border)] px-4 py-2.5">
          <div>
            <p className="text-[13px] font-semibold text-[var(--c-text)]">Importer un inventaire Ansible</p>
            <p className="text-[11.5px] text-[var(--c-text-muted)]">
              Un fichier, aucune API. Les groupes deviennent des tags, donc <span className="font-mono">target tag: …</span> les cible aussitôt.
            </p>
          </div>
          <button onClick={onClose} aria-label="Fermer" className="btn btn-ghost btn-sm btn-icon">
            <IconClose size={13} />
          </button>
        </div>

        <div className="shrink-0 border-b border-[var(--c-border)] px-4 py-2.5">
          <label className="block space-y-1">
            <span className="field-label">Fichier d'inventaire</span>
            <div className="flex gap-1.5">
              <input
                value={path}
                onChange={(e) => setPath(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && path.trim()) void load(path.trim()); }}
                placeholder="~/infra/inventory.yml, /etc/ansible/hosts…"
                className={`${inputClass} input-mono flex-1`}
              />
              <button onClick={browse} title="Parcourir" aria-label="Parcourir" className="btn btn-secondary btn-icon">
                <IconFolder size={13} />
              </button>
              <button
                onClick={() => path.trim() && load(path.trim())}
                disabled={loading || !path.trim()}
                className="btn btn-primary shrink-0 disabled:opacity-40"
              >
                {loading ? "…" : "Lire"}
              </button>
            </div>
          </label>
        </div>

        {inventory && (
          <>
            {inventory.skipped.length > 0 && (
              <div className="shrink-0 border-b border-[var(--c-border)] bg-[color-mix(in_srgb,var(--c-warn)_10%,transparent)] px-4 py-2">
                <p className="text-[11px] font-medium text-[var(--c-warn)]">Entrées non importées :</p>
                <ul className="mt-1 space-y-0.5">
                  {inventory.skipped.map((s, i) => (
                    <li key={i} className="text-[11px] text-[var(--c-warn)]/90">
                      <span className="font-mono">{s.entry}</span> — {s.reason}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="shrink-0 border-b border-[var(--c-border)] px-4 py-2">
              <div className="flex items-center gap-2">
                <input
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder="Filtrer (nom, adresse, groupe…)"
                  className={`${inputClass} flex-1`}
                />
                <button
                  onClick={() => setPicked(new Set(shown.map((h) => h.name)))}
                  className="shrink-0 rounded px-2 py-1 text-[11px] text-[var(--c-accent-text)] hover:bg-[var(--c-bg3)]"
                >
                  Tout ({shown.length})
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
                <p className="py-6 text-center text-xs text-[var(--c-text-faint)]">Aucun hôte ne correspond.</p>
              ) : (
                <ul className="space-y-0.5">
                  {shown.map((host) => (
                    <InventoryRow
                      key={host.name}
                      host={host}
                      checked={picked.has(host.name)}
                      known={alreadyImported.has(host.name)}
                      onToggle={() => toggle(host.name)}
                    />
                  ))}
                </ul>
              )}
            </div>

            <div className="shrink-0 space-y-2 border-t border-[var(--c-border)] px-4 py-2.5">
              <div className="flex gap-2">
                <label className="block flex-1 space-y-1">
                  <span className="field-label">Utilisateur par défaut</span>
                  <input
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder="ubuntu"
                    className={inputClass}
                  />
                  <span className="block text-[10px] text-[var(--c-text-faint)]">
                    Utilisé seulement là où l'inventaire ne dit rien.
                  </span>
                </label>
                <label className="block flex-1 space-y-1">
                  <span className="field-label">Authentification</span>
                  <select value={authKind} onChange={(e) => setAuthKind(e.target.value as AuthKind)} className={inputClass}>
                    <option value="agent">Agent SSH</option>
                    <option value="password">Mot de passe</option>
                    <option value="privateKey">Clé privée</option>
                  </select>
                </label>
              </div>

              {authKind === "privateKey" && (
                <div className="flex gap-2">
                  {workspace.keychain.length > 0 && (
                    <select
                      value={keyId ?? ""}
                      onChange={(e) => { setKeyId(e.target.value || null); setKeyPath(""); }}
                      className={`${inputClass} flex-1`}
                    >
                      <option value="">(saisir un chemin)</option>
                      {workspace.keychain.map((k) => (
                        <option key={k.id} value={k.id}>{k.name}</option>
                      ))}
                    </select>
                  )}
                  {!keyId && (
                    <input
                      value={keyPath}
                      onChange={(e) => setKeyPath(e.target.value)}
                      placeholder="~/.ssh/id_ed25519"
                      className={`${inputClass} input-mono flex-1`}
                    />
                  )}
                </div>
              )}

              {(authKind === "password" || (authKind === "privateKey" && !keyId)) && (
                <input
                  type="password"
                  value={secret}
                  onChange={(e) => setSecret(e.target.value)}
                  placeholder={authKind === "password" ? "Mot de passe" : "Passphrase (optionnelle)"}
                  className={inputClass}
                />
              )}

              <label className="block space-y-1">
                <span className="field-label">Groupe de destination</span>
                <GroupTreePicker
                  groups={workspace.groups}
                  value={groupId}
                  onChange={setGroupId}
                  customIcons={workspace.customIcons ?? []}
                />
              </label>

              <button
                onClick={runImport}
                disabled={importing || picked.size === 0}
                className="btn btn-primary w-full disabled:opacity-40"
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

function InventoryRow({
  host,
  checked,
  known,
  onToggle,
}: {
  host: InventoryHost;
  checked: boolean;
  known: boolean;
  onToggle: () => void;
}) {
  return (
    <li>
      <label className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 hover:bg-[var(--c-bg3)]">
        <input type="checkbox" checked={checked} onChange={onToggle} className="accent-[var(--c-accent)]" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[13px] text-[var(--c-text)]">{host.name}</span>
            {/* Says "this one will be refreshed, not added twice" — the
                question anyone re-importing a changed inventory has. */}
            {known && (
              <span className="shrink-0 rounded bg-[var(--c-bg)] px-1.5 py-0.5 text-[10px] text-[var(--c-text-muted)]">
                déjà importé
              </span>
            )}
          </div>
          <p className="truncate text-[10px] text-[var(--c-text-muted)]">
            {[
              host.address !== host.name ? host.address : null,
              host.username ? `user ${host.username}` : null,
              host.port ? `port ${host.port}` : null,
              host.groups.join(", ") || null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>
      </label>
    </li>
  );
}
