import { useEffect, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { api } from "../lib/api";
import type { AuthMethod, AwsInstance, AwsProfile, AwsSsoSession, GroupId, KeyId, Workspace } from "../lib/types";
import { filterAwsInstances, groupProfilesBySession, profileLabel } from "../lib/awsInstances";
import { useAwsAccountNames } from "../hooks/useAwsAccountNames";
import { IconClose } from "./ui-icons";
import { RegionSelect } from "./RegionSelect";

interface AwsImportPanelProps {
  workspace: Workspace;
  onWorkspaceUpdate: (ws: Workspace) => void;
  onClose: () => void;
  onError: (message: string) => void;
  /** Opens the SSO panel pre-filled to reconnect an expired session. */
  onReconnectSso: (session: AwsSsoSession) => void;
  /** Opens the SSO setup panel — a form and a browser round trip, rather
   * than a terminal running the `aws configure sso` wizard. */
  onConfigureSso: () => void;
}


type AuthKind = "agent" | "password" | "privateKey";

const inputClass =
  "w-full rounded-md bg-[var(--c-bg3)] px-2 py-1.5 text-sm text-[var(--c-text)] focus:outline-none focus:ring-1 focus:ring-[var(--c-accent-hover)]";

/**
 * Turning an AWS account into hosts, without typing an instance id.
 *
 * The panel deliberately shows instances SSM cannot reach rather than hiding
 * them: "my instance isn't in the list" is a dead end, whereas "listed, marked
 * unreachable" points straight at the SSM agent or the VPC endpoints. They
 * simply can't be selected.
 */
export function AwsImportPanel({ workspace, onWorkspaceUpdate, onClose, onError, onConfigureSso, onReconnectSso }: AwsImportPanelProps) {
  const [profiles, setProfiles] = useState<AwsProfile[] | null>(null);
  const [ssoSessions, setSsoSessions] = useState<AwsSsoSession[]>([]);
  // Resolved after the profiles are listed, not before: a twelve-digit account
  // number identifies nothing to a human, but waiting on a network round trip
  // before showing the list at all would be worse. Unresolved ones stay as ids.
  const accountNames = useAwsAccountNames();
  useEffect(() => { api.listAwsSsoSessions().then(setSsoSessions).catch(() => {}); }, []);
  const [profile, setProfile] = useState("");
  const [region, setRegion] = useState("eu-west-3");
  const [instances, setInstances] = useState<AwsInstance[] | null>(null);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<{ message: string; hint: string | null; sessionExpired: boolean } | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [groupTagKey, setGroupTagKey] = useState("");
  const [importing, setImporting] = useState(false);

  // SSH credentials for the batch — the machines arrive from AWS, but getting
  // into them is still ordinary SSH.
  // Empty means "keep each instance's own guess" — which is right far more
  // often than any single value, since an account routinely mixes Amazon
  // Linux, Ubuntu and Rocky. Filling it overrides all of them at once, for the
  // fleets built on one hardened AMI where the guess is simply wrong.
  const [usernameOverride, setUsernameOverride] = useState("");
  const [authKind, setAuthKind] = useState<AuthKind>("privateKey");
  const [keyId, setKeyId] = useState<KeyId | "">("");
  const [keyPath, setKeyPath] = useState("");
  const [secret, setSecret] = useState("");

  const loadProfiles = () => {
    api.listAwsProfiles()
      .then((found) => {
        setProfiles(found);
        setProfile((current) => current || found[0]?.name || "");
      })
      .catch((e) => {
        setProfiles([]);
        setFailure({ message: e.message ?? String(e), hint: e.reason?.hint ?? null, sessionExpired: e.reason?.sessionExpired === true });
      });
  };
  useEffect(loadProfiles, []);

  // A profile usually carries its own default region; using it saves the one
  // field that is easiest to get wrong and hardest to notice.
  useEffect(() => {
    const found = profiles?.find((p) => p.name === profile);
    if (found?.region) setRegion(found.region);
  }, [profile, profiles]);

  const profileGroups = useMemo(() => groupProfilesBySession(profiles ?? []), [profiles]);

  const discover = () => {
    setLoading(true);
    setFailure(null);
    setInstances(null);
    setSelected(new Set());
    api.discoverAwsInstances(profile, region)
      .then((found) => {
        setInstances(found);
        // Pre-tick what can actually be reached — the common case is "import
        // everything usable", and unreachable ones can't be selected anyway.
        setSelected(new Set(found.filter((i) => i.ssmOnline).map((i) => i.instanceId)));
      })
      .catch((e) => setFailure({ message: e.message ?? String(e), hint: e.reason?.hint ?? null, sessionExpired: e.reason?.sessionExpired === true }))
      .finally(() => setLoading(false));
  };

  const visible = useMemo(() => filterAwsInstances(instances ?? [], search), [instances, search]);

  /** Tag keys present on the discovered instances, offered as a grouping key. */
  const tagKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const instance of instances ?? []) {
      for (const [key] of instance.tags) if (key !== "Name") keys.add(key);
    }
    return [...keys].sort();
  }, [instances]);

  const toggle = (id: string) => {
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  /** Ticks or unticks everything the search currently shows — not the whole
   * account, which would quietly undo the filtering the user just did. */
  const toggleVisible = (checked: boolean) => {
    setSelected((previous) => {
      const next = new Set(previous);
      for (const instance of visible) {
        if (!instance.ssmOnline) continue;
        if (checked) next.add(instance.instanceId);
        else next.delete(instance.instanceId);
      }
      return next;
    });
  };

  const authMethod = (): AuthMethod => {
    if (authKind !== "privateKey") return authKind;
    // A keychain key keeps its file path too: `ssh::authenticate` reads the
    // stored content when it has it and falls back to the file otherwise, so
    // dropping the path here would leave keys imported before content was
    // captured with nowhere to load from.
    const fromKeychain = workspace.keychain.find((key) => key.id === keyId);
    return {
      privateKey: {
        path: fromKeychain?.path ?? keyPath.trim(),
        keyId: keyId || null,
        // Not offered for a batch import: a certificate is per-key and
        // short-lived, and one applied to a whole account's instances would be
        // wrong for most of them. Set it per host afterwards if a CA is in play.
        certPath: null,
      },
    };
  };

  const runImport = () => {
    const chosen = (instances ?? []).filter((i) => selected.has(i.instanceId));
    if (chosen.length === 0) return;
    if (authKind === "privateKey" && !keyId && !keyPath.trim()) {
      onError("Choisir une clé du trousseau ou indiquer le chemin d'une clé privée");
      return;
    }
    setImporting(true);
    // Groups are matched by name against what already exists rather than
    // created here: creating them would need a second round trip per tag
    // value, and an unmatched tag simply leaves the host at the root, which is
    // easy to fix and impossible to get wrong.
    const groupIdFor = (instance: AwsInstance): GroupId | null => {
      if (!groupTagKey) return null;
      const value = instance.tags.find(([key]) => key === groupTagKey)?.[1];
      if (!value) return null;
      return workspace.groups.find((g) => g.name.toLowerCase() === value.toLowerCase())?.id ?? null;
    };
    api.importAwsInstances(
      chosen.map((instance) => ({
        instanceId: instance.instanceId,
        label: instance.name ?? instance.instanceId,
        username: usernameOverride.trim() || instance.defaultUsername,
        groupId: groupIdFor(instance),
        tags: instance.tags.filter(([key]) => key !== "Name").map(([key, value]) => `${key}=${value}`),
      })),
      profile,
      region,
      { auth: authMethod(), secret: secret || null },
    )
      .then((ws) => { onWorkspaceUpdate(ws); onClose(); })
      .catch((e) => onError(String(e)))
      .finally(() => setImporting(false));
  };

  const pickKeyFile = () => {
    open({ multiple: false, directory: false })
      .then((picked) => { if (typeof picked === "string") { setKeyPath(picked); setKeyId(""); } })
      .catch(() => {});
  };

  /** What the guess would produce for the current selection, so the field
   * shows what it is overriding rather than an abstract example. */
  const usernamePlaceholder = useMemo(() => {
    const guesses = [...new Set(
      (instances ?? []).filter((i) => selected.has(i.instanceId)).map((i) => i.defaultUsername),
    )];
    return guesses.length > 0 ? guesses.join(", ") : "ec2-user";
  }, [instances, selected]);

  /** Instance ids already in the workspace. An imported host carries the
   * instance id as its address — which is what lets a second import refresh
   * those machines instead of appending a duplicate of each. */
  const imported = useMemo(
    () => new Set(workspace.hosts.map((host) => host.address)),
    [workspace.hosts],
  );
  const toUpdate = [...selected].filter((id) => imported.has(id)).length;

  const selectableVisible = visible.filter((i) => i.ssmOnline).length;
  const allVisibleSelected = selectableVisible > 0 && visible.every((i) => !i.ssmOnline || selected.has(i.instanceId));

  /** The session behind the selected profile, when it has one — what a
   * reconnection needs to replay without asking anything again. */
  const expiredSession = (() => {
    const name = profiles?.find((p) => p.name === profile)?.ssoSession;
    return name ? ssoSessions.find((session) => session.name === name) ?? null : null;
  })();

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6" onClick={onClose}>
      <div
        className="flex max-h-full w-[min(48rem,100%)] flex-col overflow-hidden rounded-xl border border-[var(--c-border)] bg-[var(--c-bg2)] shadow-[var(--shadow-lg)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-[var(--c-border)] px-4 py-2.5">
          <div>
            <p className="text-[13px] font-medium text-[var(--c-text)]">Importer des instances EC2</p>
            <p className="text-[11px] text-[var(--c-text-muted)]">
              Via ta CLI `aws` déjà connectée — aucun identifiant AWS n'est demandé ni conservé par Guiterm.
            </p>
          </div>
          <button onClick={onClose} aria-label="Fermer" className="rounded p-1 text-[var(--c-text-muted)] hover:bg-white/5 hover:text-[var(--c-text)]">
            <IconClose size={13} />
          </button>
        </div>

        <div className="shrink-0 border-b border-[var(--c-border)] px-4 py-2.5">
          <div className="flex items-end gap-2">
            <label className="block flex-1 space-y-1">
              <span className="text-xs font-medium text-[var(--c-text-muted)]">Profil</span>
              {profiles && profiles.length > 0 ? (
                <select value={profile} onChange={(e) => setProfile(e.target.value)} className={inputClass}>
                  {profileGroups.map((group) => (
                    <optgroup key={group.session ?? "__none"} label={group.session ? `Session SSO — ${group.session}` : "Sans session SSO"}>
                      {group.profiles.map((p) => (
                        <option key={p.name} value={p.name}>{profileLabel(p, accountNames)}</option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              ) : (
                <input value={profile} onChange={(e) => setProfile(e.target.value)} placeholder="default" className={inputClass} />
              )}
            </label>
            <label className="block w-40 space-y-1">
              <span className="text-xs font-medium text-[var(--c-text-muted)]">Région</span>
              <RegionSelect value={region} onChange={setRegion} className={inputClass} />
            </label>
            <button
              onClick={discover}
              disabled={loading || !profile.trim() || !region.trim()}
              className="accent-surface shrink-0 rounded-md border px-3 py-1.5 text-xs font-medium disabled:opacity-50"
            >
              {loading ? "Recherche…" : "Lister les instances"}
            </button>
          </div>
          <div className="mt-1.5 flex items-center gap-2">
            <button
              onClick={onConfigureSso}
              className="text-[11px] text-[var(--c-accent-text)] underline-offset-2 hover:underline"
            >
              Configurer une session SSO…
            </button>
            <span className="text-[11px] text-[var(--c-text-faint)]">formulaire, puis navigateur</span>
            <button onClick={loadProfiles} className="ml-auto text-[11px] text-[var(--c-text-secondary)] hover:text-[var(--c-text)]">
              Rafraîchir les profils
            </button>
          </div>
        </div>

        {failure && (
          <div className="shrink-0 border-b border-rose-900/60 bg-rose-950/40 px-4 py-2.5">
            <pre className="max-h-24 overflow-auto whitespace-pre-wrap break-words font-mono text-[10px] text-rose-200/90">{failure.message}</pre>
            {failure.hint && <p className="mt-1.5 text-[11px] leading-relaxed text-[var(--c-text-secondary)]">{failure.hint}</p>}
            {/* Offered only for an expired login — the one failure that
                reconnecting actually fixes. Denied permissions or absent
                credentials would send someone round a loop. */}
            {failure.sessionExpired && expiredSession && (
              <button
                onClick={() => onReconnectSso(expiredSession)}
                className="accent-surface mt-2 rounded-md border px-2.5 py-1 text-xs font-medium"
              >
                Reconnecter la session « {expiredSession.name} »
              </button>
            )}
          </div>
        )}

        {instances !== null && instances.length > 0 && (
          <div className="flex shrink-0 items-center gap-2 border-b border-[var(--c-border)] px-4 py-2">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Rechercher — nom, id, IP, plateforme, tag…"
              className="flex-1 rounded-md bg-[var(--c-bg3)] px-2 py-1 text-xs text-[var(--c-text)] placeholder:text-[var(--c-text-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--c-accent-hover)]"
            />
            <label className="flex shrink-0 items-center gap-1.5 text-[11px] text-[var(--c-text-secondary)]">
              <input
                type="checkbox"
                checked={allVisibleSelected}
                onChange={(e) => toggleVisible(e.target.checked)}
                disabled={selectableVisible === 0}
                className="h-3.5 w-3.5 accent-[var(--c-accent)]"
              />
              Tout cocher{search ? " (résultats)" : ""}
            </label>
          </div>
        )}

        <div className="sidebar-scroll min-h-0 flex-1 overflow-y-auto p-2">
          {instances === null && !failure && (
            <p className="px-2 py-8 text-center text-[13px] text-[var(--c-text-muted)]">
              Choisis un profil et une région, puis liste les instances.
            </p>
          )}
          {instances?.length === 0 && (
            <p className="px-2 py-8 text-center text-[13px] text-[var(--c-text-muted)]">
              Aucune instance dans cette région pour ce profil.
            </p>
          )}
          {instances !== null && instances.length > 0 && visible.length === 0 && (
            <p className="px-2 py-8 text-center text-[13px] text-[var(--c-text-muted)]">
              Aucune instance ne correspond à « {search} ».
            </p>
          )}
          {visible.map((instance) => (
            <label
              key={instance.instanceId}
              className={`flex items-center gap-2 rounded-md px-2 py-1.5 ${instance.ssmOnline ? "hover:bg-white/5" : "opacity-55"}`}
              title={instance.ssmOnline ? undefined : "SSM ne voit pas cette instance : agent arrêté, rôle sans AmazonSSMManagedInstanceCore, ou pas de route vers le service SSM"}
            >
              <input
                type="checkbox"
                checked={selected.has(instance.instanceId)}
                disabled={!instance.ssmOnline}
                onChange={() => toggle(instance.instanceId)}
                className="h-4 w-4 shrink-0 accent-[var(--c-accent)]"
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] text-[var(--c-text)]">
                  {instance.name ?? instance.instanceId}
                  <span className="ml-1.5 text-[11px] text-[var(--c-text-muted)]">{instance.defaultUsername}</span>
                </p>
                <p className="truncate font-mono text-[11px] text-[var(--c-text-muted)]">
                  {instance.instanceId}
                  {instance.privateIp ? ` · ${instance.privateIp}` : ""}
                  {instance.platform ? ` · ${instance.platform}` : ""}
                  {` · ${instance.state}`}
                </p>
              </div>
              {imported.has(instance.instanceId) && (
                <span
                  title="Déjà dans tes hôtes — l'import rafraîchira ses tags et sa commande proxy au lieu d'en créer un second"
                  className="shrink-0 rounded bg-[var(--c-bg3)] px-1.5 py-0.5 text-[10px] text-[var(--c-text-secondary)]"
                >
                  déjà importée
                </span>
              )}
              <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] ${instance.ssmOnline ? "bg-emerald-950/60 text-emerald-300" : "bg-[var(--c-bg3)] text-[var(--c-text-faint)]"}`}>
                {instance.ssmOnline ? "SSM" : "hors SSM"}
              </span>
            </label>
          ))}
        </div>

        {/* SSH credentials for the whole batch. Shown only once there is
            something to import, so the panel stays a listing until it becomes
            a form. */}
        {selected.size > 0 && (
          <div className="shrink-0 space-y-1.5 border-t border-[var(--c-border)] px-4 py-2.5">
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium text-[var(--c-text-muted)]">Utilisateur</span>
              <input
                value={usernameOverride}
                onChange={(e) => setUsernameOverride(e.target.value)}
                placeholder={usernamePlaceholder}
                className="w-44 rounded-md bg-[var(--c-bg3)] px-2 py-1 text-xs text-[var(--c-text)] placeholder:text-[var(--c-text-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--c-accent-hover)]"
              />
              <span className="text-[11px] text-[var(--c-text-faint)]">
                {usernameOverride.trim()
                  ? "appliqué à tous les hôtes importés"
                  : "vide : deviné depuis l'AMI de chaque instance"}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium text-[var(--c-text-muted)]">Connexion SSH</span>
              <select value={authKind} onChange={(e) => setAuthKind(e.target.value as AuthKind)} className="rounded-md bg-[var(--c-bg3)] px-2 py-1 text-xs text-[var(--c-text)]">
                <option value="privateKey">Clé privée</option>
                <option value="agent">Agent SSH</option>
                <option value="password">Mot de passe</option>
              </select>
              <span className="text-[11px] text-[var(--c-text-faint)]">appliqué aux {selected.size} hôte{selected.size > 1 ? "s" : ""} importé{selected.size > 1 ? "s" : ""}</span>
            </div>
            {authKind === "privateKey" && (
              <div className="flex items-center gap-2">
                <select
                  value={keyId}
                  onChange={(e) => { setKeyId(e.target.value as KeyId | ""); if (e.target.value) setKeyPath(""); }}
                  className="flex-1 rounded-md bg-[var(--c-bg3)] px-2 py-1 text-xs text-[var(--c-text)]"
                >
                  <option value="">— clé par chemin de fichier —</option>
                  {workspace.keychain.map((key) => <option key={key.id} value={key.id}>{key.name}</option>)}
                </select>
                {!keyId && (
                  <>
                    <input
                      value={keyPath}
                      onChange={(e) => setKeyPath(e.target.value)}
                      placeholder="C:\\Users\\…\\ma-keypair.pem"
                      className="flex-[2] rounded-md bg-[var(--c-bg3)] px-2 py-1 font-mono text-xs text-[var(--c-text)] placeholder:font-sans placeholder:text-[var(--c-text-muted)]"
                    />
                    <button onClick={pickKeyFile} className="shrink-0 rounded-md border border-[var(--c-border)] px-2 py-1 text-xs text-[var(--c-text-secondary)] hover:border-[var(--c-accent)]">
                      Parcourir…
                    </button>
                  </>
                )}
              </div>
            )}
            {(authKind === "password" || (authKind === "privateKey" && !keyId)) && (
              <input
                type="password"
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                placeholder={authKind === "password" ? "Mot de passe" : "Passphrase de la clé (optionnelle)"}
                className="w-full rounded-md bg-[var(--c-bg3)] px-2 py-1 text-xs text-[var(--c-text)] placeholder:text-[var(--c-text-muted)]"
              />
            )}
          </div>
        )}

        <div className="flex shrink-0 items-center gap-2 border-t border-[var(--c-border)] px-4 py-2.5">
          {tagKeys.length > 0 && (
            <label className="flex items-center gap-1.5">
              <span className="text-[11px] text-[var(--c-text-muted)]">Dossier depuis le tag</span>
              <select value={groupTagKey} onChange={(e) => setGroupTagKey(e.target.value)} className="rounded-md bg-[var(--c-bg3)] px-2 py-1 text-xs text-[var(--c-text)]">
                <option value="">aucun</option>
                {tagKeys.map((key) => <option key={key} value={key}>{key}</option>)}
              </select>
            </label>
          )}
          <span className="flex-1 text-[11px] text-[var(--c-text-muted)]">
            {instances !== null && `${visible.length} affichée${visible.length > 1 ? "s" : ""} · ${selectableVisible} joignable${selectableVisible > 1 ? "s" : ""} via SSM`}
          </span>
          <button
            onClick={runImport}
            disabled={importing || selected.size === 0}
            title={toUpdate > 0 ? "Les machines déjà importées voient leurs tags et leur commande proxy rafraîchis ; leur nom, leur login et leurs identifiants restent tels que tu les as réglés" : undefined}
            className="accent-surface rounded-md border px-3 py-1.5 text-xs font-medium disabled:opacity-50"
          >
            {/* The count that matters is the split: "importer (12)" on a list
                already imported eleven times looked like it was about to make
                twelve more hosts, which is exactly what it used to do. */}
            Importer {selected.size > 0 ? `(${selected.size - toUpdate})` : ""}
            {toUpdate > 0 ? ` · ${toUpdate} à jour` : ""}
          </button>
        </div>
      </div>
    </div>
  );
}
