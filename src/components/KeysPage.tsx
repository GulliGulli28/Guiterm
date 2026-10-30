import { useEffect, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { api } from "../lib/api";
import type { HostId, KeyAlgorithm, KeyDescription, KeyId, KnownHostEntry, PrivateKey, SshAgentStatus, Workspace } from "../lib/types";
import type { VaultSection } from "../lib/vaultSections";
import { keyTypeOf, openSshFingerprint } from "../lib/hostKeys";
import { IconCheck, IconCopy, IconDownload, IconEdit, IconEye, IconEyeOff, IconFolder, IconKeychain, IconPlus, IconShield, IconTrash, IconUpload, IconWarning } from "./ui-icons";
import { HostTreePicker } from "./HostTreePicker";
import { ConfirmDialog } from "./ConfirmDialog";
import { SshAgentSettings } from "./SshAgentSettings";

interface KeysPageProps {
  workspace: Workspace;
  /** Les vaults du compte affiché, pour dire où chaque clé est rangée. */
  vaultSections: VaultSection[] | null;
  onAddKey: (name: string, path: string, passphrase: string | null) => void;
  onGenerateKey: (name: string, algorithm: KeyAlgorithm, passphrase: string | null) => void;
  onDeleteKey: (id: KeyId) => void;
  onRenameKey: (id: KeyId, name: string) => void;
  onError: (message: string) => void;
}

type KeysTab = "keys" | "hosts" | "agent";

/**
 * « Clés et empreintes » : le trousseau, les clés d'hôtes approuvées et
 * l'agent SSH, sur une page.
 *
 * Réunit les anciens panneaux Clés et Known Hosts, qui parlaient de la même
 * chose — qui on est, et à qui on fait confiance — dans deux colonnes de
 * 300 px, et l'agent SSH, rangé jusque-là dans les Réglages alors qu'il ne
 * sert qu'à présenter ces clés.
 */
export function KeysPage({ workspace, vaultSections, onAddKey, onGenerateKey, onDeleteKey, onRenameKey, onError }: KeysPageProps) {
  const [tab, setTab] = useState<KeysTab>("keys");
  const [described, setDescribed] = useState<Record<KeyId, KeyDescription>>({});
  const [usage, setUsage] = useState<Record<KeyId, string[]>>({});
  const [knownHosts, setKnownHosts] = useState<KnownHostEntry[] | null>(null);
  const [agent, setAgent] = useState<SshAgentStatus | null>(null);
  const [selected, setSelected] = useState<KeyId | null>(null);
  const [form, setForm] = useState<"import" | "generate" | null>(null);

  // Relu à chaque changement du workspace : modifier l'authentification d'un
  // hôte change « Utilisée par », ajouter une clé change la liste.
  useEffect(() => {
    api.describeKeys().then((list) => setDescribed(Object.fromEntries(list.map((d) => [d.id, d])))).catch(() => setDescribed({}));
    api.listKeyUsage().then(setUsage).catch(() => setUsage({}));
  }, [workspace]);
  const refreshKnownHosts = () => api.listKnownHosts().then(setKnownHosts).catch((e) => onError(String(e)));
  useEffect(() => { void refreshKnownHosts(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { api.sshAgentStatus().then(setAgent).catch(() => setAgent(null)); }, [tab]);

  const keys = workspace.keychain;
  const current = keys.find((k) => k.id === selected) ?? null;
  const sectionOf = (id: KeyId): VaultSection | null =>
    vaultSections?.find((s) => s.id === (workspace.vaultBindings?.[id] ?? null)) ?? null;

  const subtitle = [
    `${keys.length} clé${keys.length > 1 ? "s" : ""}`,
    agent ? (agent.enabled ? "agent SSH actif" : "agent SSH éteint") : null,
    knownHosts ? `${knownHosts.length} empreinte${knownHosts.length > 1 ? "s" : ""} d'hôtes connue${knownHosts.length > 1 ? "s" : ""}` : null,
  ].filter(Boolean).join(" · ");

  return (
    <div data-page="keys" className="flex h-full min-h-0 bg-[var(--c-bg2)]">
      <div className="sidebar-scroll min-w-0 flex-1 overflow-y-auto px-8 py-7">
        <div className="space-y-5">
          <div className="flex items-start gap-2.5">
            <div className="min-w-0 flex-1">
              <h1 className="text-[20px] font-semibold text-[var(--c-text)]">Clés et empreintes</h1>
              <p className="mt-1 text-[12.5px] text-[var(--c-text-muted)]">{subtitle}</p>
            </div>
            <button type="button" onClick={() => { setForm("import"); setTab("keys"); }} className="btn btn-secondary">
              <IconDownload size={13} /> Importer
            </button>
            <button type="button" onClick={() => { setForm("generate"); setTab("keys"); }} className="btn btn-primary">
              <IconPlus size={13} /> Générer une clé
            </button>
          </div>

          <div role="tablist" className="flex gap-1 border-b border-[var(--c-border)]">
            {([
              ["keys", "Mes clés", <span key="n" className="text-[var(--c-text-faint)]">{keys.length}</span>],
              ["hosts", "Empreintes d'hôtes", <span key="n" className="text-[var(--c-text-faint)]">{knownHosts?.length ?? "…"}</span>],
              ["agent", "Agent SSH", agent ? <span key="n" className={`chip h-[18px] ${agent.enabled ? "chip-ok" : ""}`}>{agent.enabled ? "Actif" : "Éteint"}</span> : null],
            ] as [KeysTab, string, React.ReactNode][]).map(([id, label, extra]) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={tab === id}
                data-keys-tab={id}
                onClick={() => setTab(id)}
                className={`-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-[13px] ${
                  tab === id ? "border-[var(--c-accent)] font-medium text-[var(--c-text)]" : "border-transparent text-[var(--c-text-muted)] hover:text-[var(--c-text)]"
                }`}
              >
                {label} {extra}
              </button>
            ))}
          </div>

          {tab === "keys" && (
            <>
              {form && (
                <KeyForm
                  mode={form}
                  onModeChange={setForm}
                  onCancel={() => setForm(null)}
                  onImport={(name, path, passphrase) => { onAddKey(name, path, passphrase); setForm(null); }}
                  onGenerate={(name, algorithm, passphrase) => { onGenerateKey(name, algorithm, passphrase); setForm(null); }}
                />
              )}
              {keys.length === 0 ? (
                <div className="card px-4 py-10 text-center">
                  <p className="text-[13px] font-medium text-[var(--c-text-secondary)]">Aucune clé dans le trousseau</p>
                  <p className="help-text mt-1">Importez une clé existante ou générez-en une, puis installez-la sur vos hôtes.</p>
                </div>
              ) : (
                <div className="card overflow-hidden p-0">
                  <table className="w-full table-fixed border-collapse text-[12.5px]" data-keys-table>
                    <thead>
                      <tr className="border-b border-[var(--c-border)] text-left text-[11.5px] text-[var(--c-text-muted)]">
                        <th className="px-3.5 py-2 font-medium">Nom</th>
                        <th className="w-[110px] px-3.5 py-2 font-medium">Type</th>
                        <th className="w-[210px] px-3.5 py-2 font-medium">Empreinte</th>
                        <th className="w-[170px] px-3.5 py-2 font-medium">Utilisée par</th>
                        <th className="w-[170px] px-3.5 py-2 font-medium">Rangée dans</th>
                      </tr>
                    </thead>
                    <tbody>
                      {keys.map((key) => {
                        const info = described[key.id]?.info ?? null;
                        const hosts = usage[key.id] ?? [];
                        const section = sectionOf(key.id);
                        return (
                          <tr
                            key={key.id}
                            data-key-row={key.name}
                            onClick={() => setSelected(key.id === selected ? null : key.id)}
                            aria-selected={key.id === selected}
                            className={`cursor-pointer border-t border-[var(--c-border)] first:border-t-0 ${key.id === selected ? "bg-[var(--c-active)]" : "hover:bg-[var(--c-hover)]"}`}
                          >
                            <td className="truncate px-3.5 py-2.5">
                              <span className="flex items-center gap-2"><IconKeychain size={13} className="shrink-0 text-[var(--c-text-muted)]" /><span className="truncate font-medium text-[var(--c-text)]">{key.name}</span></span>
                            </td>
                            <td className="px-3.5 py-2.5">{info ? <span className="chip">{info.algorithm}</span> : <span className="text-[var(--c-text-faint)]">—</span>}</td>
                            <td className="truncate px-3.5 py-2.5 font-mono text-[11.5px] text-[var(--c-text-muted)]" title={info?.fingerprint}>{info ? shortFingerprint(info.fingerprint) : "illisible"}</td>
                            <td className="truncate px-3.5 py-2.5 text-[var(--c-text-secondary)]" title={hosts.join(", ")}>
                              {hosts.length ? hosts.join(", ") : <span className="chip chip-warn">Aucun hôte</span>}
                            </td>
                            <td className="truncate px-3.5 py-2.5">
                              {section
                                ? <span className="text-[var(--c-text-secondary)]">{section.name}{section.role === "reader" && <span className="chip ml-1.5 h-[18px]">Lecture</span>}</span>
                                : key.content
                                  ? <span className="text-[var(--c-text-secondary)]">Trousseau</span>
                                  : <span className="font-mono text-[11.5px] text-[var(--c-text-muted)]" title={key.path}>{key.path}</span>}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}

          {tab === "hosts" && (
            <KnownHostsTable entries={knownHosts} onRevoke={(identity) => api.revokeKnownHost(identity).then(refreshKnownHosts).catch((e) => onError(String(e)))} />
          )}

          {tab === "agent" && (
            <div className="max-w-[720px]" data-keys-agent>
              <SshAgentSettings onError={onError} />
            </div>
          )}
        </div>
      </div>

      {tab === "keys" && current && (
        <KeyDetail
          key={current.id}
          workspace={workspace}
          keyEntry={current}
          description={described[current.id] ?? null}
          hosts={usage[current.id] ?? []}
          onRename={(name) => onRenameKey(current.id, name)}
          onDelete={() => { onDeleteKey(current.id); setSelected(null); }}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}

/** « SHA256:q4u3c0mZ…fN0s » : assez pour reconnaître une clé d'un coup d'œil,
 * l'empreinte entière reste dans l'infobulle et le détail. */
function shortFingerprint(fp: string): string {
  const body = fp.replace(/^SHA256:/, "");
  return body.length > 16 ? `SHA256:${body.slice(0, 8)}…${body.slice(-4)}` : fp;
}

function KeyForm({ mode, onModeChange, onCancel, onImport, onGenerate }: {
  mode: "import" | "generate";
  onModeChange: (mode: "import" | "generate") => void;
  onCancel: () => void;
  onImport: (name: string, path: string, passphrase: string | null) => void;
  onGenerate: (name: string, algorithm: KeyAlgorithm, passphrase: string | null) => void;
}) {
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [algorithm, setAlgorithm] = useState<KeyAlgorithm>("ed25519");
  const [passphrase, setPassphrase] = useState("");
  const [reveal, setReveal] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const browse = async () => {
    const chosen = await open({ title: "Sélectionner une clé privée SSH", multiple: false, directory: false });
    if (chosen && typeof chosen === "string") {
      setPath(chosen);
      if (!name) setName(chosen.replace(/\\/g, "/").split("/").pop() ?? "");
    }
  };
  const submit = () => {
    if (!name.trim()) { setError("Le nom est requis"); return; }
    if (mode === "import") {
      if (!path.trim()) { setError("Le chemin est requis"); return; }
      onImport(name.trim(), path.trim(), passphrase || null);
    } else {
      onGenerate(name.trim(), algorithm, passphrase || null);
    }
  };

  return (
    <div className="card space-y-3 p-4" data-key-form={mode}>
      <div className="flex items-center gap-3">
        <div className="segmented">
          <button type="button" data-active={mode === "import"} onClick={() => onModeChange("import")}>Importer un fichier</button>
          <button type="button" data-active={mode === "generate"} onClick={() => onModeChange("generate")}>Générer</button>
        </div>
        <span className="flex-1" />
        <button type="button" onClick={onCancel} className="btn btn-ghost btn-sm">Annuler</button>
      </div>
      {error && <p className="callout callout-danger">{error}</p>}
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-3">
        <label className="block">
          <span className="field-label">Nom</span>
          <input value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder={mode === "generate" ? "deploy-prod" : "id_ed25519"} className="input w-full" />
        </label>
        {mode === "import" ? (
          <label className="block">
            <span className="field-label">Fichier</span>
            <span className="flex gap-1.5">
              <input value={path} onChange={(e) => setPath(e.target.value)} placeholder="~/.ssh/id_ed25519" className="input input-mono min-w-0 flex-1" />
              <button type="button" onClick={browse} aria-label="Parcourir" title="Parcourir" className="btn btn-secondary btn-icon"><IconFolder size={13} /></button>
            </span>
          </label>
        ) : (
          <label className="block">
            <span className="field-label">Type</span>
            <select value={algorithm} onChange={(e) => setAlgorithm(e.target.value as KeyAlgorithm)} className="input w-full">
              <option value="ed25519">ed25519 (recommandé)</option>
              <option value="rsa">RSA</option>
            </select>
          </label>
        )}
      </div>
      <label className="block">
        <span className="field-label">Passphrase (optionnelle)</span>
        <span className="flex gap-1.5">
          <input value={passphrase} onChange={(e) => setPassphrase(e.target.value)} type={reveal ? "text" : "password"} autoComplete="off" className="input min-w-0 flex-1" />
          <button type="button" onClick={() => setReveal((v) => !v)} aria-label={reveal ? "Cacher la passphrase" : "Afficher la passphrase"} title={reveal ? "Cacher la passphrase" : "Afficher la passphrase"} className="btn btn-secondary btn-icon">
            {reveal ? <IconEyeOff size={13} /> : <IconEye size={13} />}
          </button>
        </span>
        <span className="help-text mt-1 block">Gardée au coffre, jamais dans workspace.json.</span>
      </label>
      <div className="flex justify-end">
        <button type="button" onClick={submit} className="btn btn-primary">{mode === "import" ? "Importer la clé" : "Générer la clé"}</button>
      </div>
    </div>
  );
}

function KeyDetail({ workspace, keyEntry, description, hosts, onRename, onDelete, onClose }: {
  workspace: Workspace;
  keyEntry: PrivateKey;
  description: KeyDescription | null;
  hosts: string[];
  onRename: (name: string) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [deployHost, setDeployHost] = useState<HostId | null>(null);
  const [deploying, setDeploying] = useState(false);
  const [deployResult, setDeployResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const info = description?.info ?? null;
  const sshHosts = useMemo(() => workspace.hosts.filter((h) => (h.kind ?? "ssh") === "ssh"), [workspace.hosts]);

  const copy = async () => {
    if (!info) return;
    await writeText(info.publicKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  const deploy = async () => {
    if (!deployHost) return;
    setDeploying(true);
    setDeployResult(null);
    try {
      await api.deployPublicKey(deployHost, keyEntry.id);
      setDeployResult({ ok: true, text: `Installée sur ${workspace.hosts.find((h) => h.id === deployHost)?.label ?? "l'hôte"}.` });
    } catch (e) {
      setDeployResult({ ok: false, text: String(e) });
    } finally {
      setDeploying(false);
    }
  };
  const commitRename = () => {
    const next = renaming?.trim();
    if (next && next !== keyEntry.name) onRename(next);
    setRenaming(null);
  };

  return (
    <aside data-key-detail className="sidebar-scroll flex w-[380px] shrink-0 flex-col gap-4 overflow-y-auto border-l border-[var(--c-border)] bg-[var(--c-bg)] px-5 py-5" aria-label={keyEntry.name}>
      <div className="flex items-center gap-2.5">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-[var(--c-border)] bg-[var(--c-bg3)] text-[var(--c-text-secondary)]"><IconKeychain size={16} /></span>
        <div className="min-w-0 flex-1">
          {renaming !== null ? (
            <input
              value={renaming}
              onChange={(e) => setRenaming(e.target.value)}
              onBlur={commitRename}
              onKeyDown={(e) => { if (e.key === "Enter") commitRename(); if (e.key === "Escape") setRenaming(null); }}
              autoFocus
              aria-label="Nom de la clé"
              className="input h-7 w-full font-medium"
            />
          ) : (
            <h2 className="truncate text-[15px] font-semibold text-[var(--c-text)]">{keyEntry.name}</h2>
          )}
          <p className="text-[11.5px] text-[var(--c-text-muted)]">{info ? info.algorithm : "Clé illisible"}</p>
        </div>
        <button type="button" onClick={() => setRenaming(keyEntry.name)} aria-label="Renommer" title="Renommer" className="btn btn-ghost btn-icon"><IconEdit size={13} /></button>
        <button type="button" onClick={onClose} aria-label="Fermer le détail" title="Fermer le détail" className="btn btn-ghost btn-icon">×</button>
      </div>

      {info ? (
        <div>
          <span className="field-label">Clé publique</span>
          <div className="flex items-center gap-1.5 rounded-lg bg-[var(--c-bg3)] py-1.5 pl-3 pr-1.5">
            <code className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-[var(--c-text-muted)]" title={info.publicKey}>{info.publicKey}</code>
            <button type="button" onClick={copy} aria-label="Copier la clé publique" title="Copier la clé publique" className="btn btn-ghost btn-sm btn-icon">
              {copied ? <IconCheck size={12} /> : <IconCopy size={12} />}
            </button>
          </div>
          <p className="mt-1.5 break-all font-mono text-[11px] text-[var(--c-text-faint)]">{info.fingerprint}</p>
        </div>
      ) : (
        <p className="callout callout-warn flex items-start gap-2"><IconWarning size={13} className="mt-0.5 shrink-0" /> Le fichier de cette clé a disparu, ou sa passphrase n'est pas enregistrée.</p>
      )}

      <div className="card space-y-2 p-3">
        <span className="field-label">Installer sur un hôte</span>
        <HostTreePicker
          hosts={sshHosts}
          groups={workspace.groups}
          customIcons={workspace.customIcons}
          value={deployHost}
          onChange={(v) => { setDeployHost(v as HostId | null); setDeployResult(null); }}
          placeholder="Choisir un hôte…"
        />
        <button type="button" onClick={deploy} disabled={!deployHost || deploying} className="btn btn-secondary w-full">
          <IconUpload size={13} /> {deploying ? "Installation…" : "Ajouter à authorized_keys"}
        </button>
        {deployResult && <p className={`callout ${deployResult.ok ? "callout-ok" : "callout-danger"}`}>{deployResult.text}</p>}
      </div>

      <div className="space-y-1.5 text-[12px]">
        <p className="text-[11.5px] text-[var(--c-text-faint)]">Passphrase</p>
        <p className="flex items-center gap-1.5 text-[var(--c-text-secondary)]">
          {description?.passphraseStored ? <><IconCheck size={12} className="text-[var(--c-ok)]" /> Enregistrée dans le coffre</> : "Aucune enregistrée"}
        </p>
        <p className="pt-1.5 text-[11.5px] text-[var(--c-text-faint)]">Utilisée par</p>
        <p className="text-[var(--c-text-secondary)]">{hosts.length ? hosts.join(", ") : "Aucun hôte"}</p>
        <p className="pt-1.5 text-[11.5px] text-[var(--c-text-faint)]">Contenu</p>
        <p className="text-[var(--c-text-secondary)]">{keyEntry.content ? "Intégré au trousseau" : <span className="font-mono text-[11.5px]">{keyEntry.path}</span>}</p>
      </div>

      <div className="mt-auto border-t border-[var(--c-border)] pt-3">
        <button type="button" onClick={() => setConfirmDelete(true)} className="btn btn-ghost text-[var(--c-danger)] hover:bg-[color-mix(in_srgb,var(--c-danger)_10%,transparent)]">
          <IconTrash size={13} /> Supprimer la clé
        </button>
      </div>

      {confirmDelete && (
        <ConfirmDialog
          title={`Supprimer « ${keyEntry.name} » ?`}
          message={hosts.length
            ? `${hosts.length} hôte${hosts.length > 1 ? "s" : ""} s'authentifie${hosts.length > 1 ? "nt" : ""} avec elle (${hosts.join(", ")}) : ${hosts.length > 1 ? "ils" : "il"} ne pourra${hosts.length > 1 ? "ont" : ""} plus se connecter.`
            : "Aucun hôte ne l'utilise."}
          confirmLabel="Supprimer"
          danger
          onConfirm={() => { setConfirmDelete(false); onDelete(); }}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
    </aside>
  );
}

/** Les clés d'hôtes approuvées (`known_hosts.json`), avec leur empreinte
 * calculée ici : c'est elle qu'on compare à celle d'un administrateur. */
function KnownHostsTable({ entries, onRevoke }: { entries: KnownHostEntry[] | null; onRevoke: (identity: string) => void }) {
  const [fingerprints, setFingerprints] = useState<Record<string, string>>({});
  useEffect(() => {
    let cancelled = false;
    void Promise.all((entries ?? []).map(async (e) => [e.identity, await openSshFingerprint(e.publicKey)] as const))
      .then((pairs) => { if (!cancelled) setFingerprints(Object.fromEntries(pairs.filter((p): p is readonly [string, string] => p[1] !== null))); });
    return () => { cancelled = true; };
  }, [entries]);

  if (entries === null) return <p className="text-[12.5px] text-[var(--c-text-muted)]">Chargement…</p>;
  if (entries.length === 0) {
    return (
      <div className="card px-4 py-10 text-center">
        <p className="text-[13px] font-medium text-[var(--c-text-secondary)]">Aucune empreinte d'hôte</p>
        <p className="help-text mt-1">La clé de chaque serveur est retenue à la première connexion, puis vérifiée aux suivantes.</p>
      </div>
    );
  }
  return (
    <div className="card overflow-hidden p-0">
      <table className="w-full table-fixed border-collapse text-[12.5px]" data-known-hosts-table>
        <thead>
          <tr className="border-b border-[var(--c-border)] text-left text-[11.5px] text-[var(--c-text-muted)]">
            <th className="px-3.5 py-2 font-medium">Hôte</th>
            <th className="w-[110px] px-3.5 py-2 font-medium">Type</th>
            <th className="w-[380px] px-3.5 py-2 font-medium">Empreinte</th>
            <th className="w-[60px] px-3.5 py-2" />
          </tr>
        </thead>
        <tbody>
          {entries.map((e) => (
            <tr key={e.identity} data-known-host={e.label} className="border-t border-[var(--c-border)] first:border-t-0">
              <td className="truncate px-3.5 py-2.5"><span className="flex items-center gap-2"><IconShield size={13} className="shrink-0 text-[var(--c-text-muted)]" /><span className="truncate text-[var(--c-text)]">{e.label}</span></span></td>
              <td className="px-3.5 py-2.5"><span className="chip">{keyTypeOf(e.publicKey)}</span></td>
              <td className="truncate px-3.5 py-2.5 font-mono text-[11.5px] text-[var(--c-text-muted)]" title={e.publicKey}>{fingerprints[e.identity] ?? "…"}</td>
              <td className="px-2 py-1.5 text-right">
                <button type="button" onClick={() => onRevoke(e.identity)} aria-label={`Révoquer ${e.label}`} title="Révoquer la confiance" className="btn btn-ghost btn-sm btn-icon hover:text-[var(--c-danger)]"><IconTrash size={13} /></button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
