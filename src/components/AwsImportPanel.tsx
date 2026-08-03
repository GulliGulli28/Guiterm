import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import type { AwsInstance, GroupId, Workspace } from "../lib/types";
import { IconClose } from "./ui-icons";

interface AwsImportPanelProps {
  workspace: Workspace;
  onWorkspaceUpdate: (ws: Workspace) => void;
  onClose: () => void;
  onError: (message: string) => void;
}

/** Regions offered without asking AWS for the list — `describe-regions` needs
 * working credentials, which is exactly what may not be true yet when this
 * panel first opens. The field stays free-text so anything missing here can
 * still be typed. */
const COMMON_REGIONS = [
  "eu-west-1", "eu-west-2", "eu-west-3", "eu-central-1", "eu-north-1", "eu-south-1",
  "us-east-1", "us-east-2", "us-west-1", "us-west-2",
  "ca-central-1", "sa-east-1",
  "ap-northeast-1", "ap-southeast-1", "ap-southeast-2", "ap-south-1",
];

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
export function AwsImportPanel({ workspace, onWorkspaceUpdate, onClose, onError }: AwsImportPanelProps) {
  const [profiles, setProfiles] = useState<string[] | null>(null);
  const [profile, setProfile] = useState("");
  const [region, setRegion] = useState("eu-west-3");
  const [instances, setInstances] = useState<AwsInstance[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<{ message: string; hint: string | null } | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [groupTagKey, setGroupTagKey] = useState("");
  const [importing, setImporting] = useState(false);

  useEffect(() => {
    api.listAwsProfiles()
      .then((found) => {
        setProfiles(found);
        if (found.length > 0) setProfile((current) => current || found[0]);
      })
      .catch((e) => {
        setProfiles([]);
        setFailure({ message: e.message ?? String(e), hint: e.reason?.hint ?? null });
      });
  }, []);

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
      .catch((e) => setFailure({ message: e.message ?? String(e), hint: e.reason?.hint ?? null }))
      .finally(() => setLoading(false));
  };

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

  const runImport = () => {
    const chosen = (instances ?? []).filter((i) => selected.has(i.instanceId));
    if (chosen.length === 0) return;
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
        username: instance.defaultUsername,
        groupId: groupIdFor(instance),
        tags: instance.tags.filter(([key]) => key !== "Name").map(([key, value]) => `${key}=${value}`),
      })),
      profile,
      region,
    )
      .then((ws) => { onWorkspaceUpdate(ws); onClose(); })
      .catch((e) => onError(String(e)))
      .finally(() => setImporting(false));
  };

  const selectable = (instances ?? []).filter((i) => i.ssmOnline).length;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6" onClick={onClose}>
      <div
        className="flex max-h-full w-[min(46rem,100%)] flex-col overflow-hidden rounded-xl border border-[var(--c-border)] bg-[var(--c-bg2)] shadow-[var(--shadow-lg)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-[var(--c-border)] px-4 py-2.5">
          <div>
            <p className="text-[13px] font-medium text-[var(--c-text)]">Importer des instances EC2</p>
            <p className="text-[11px] text-[var(--c-text-muted)]">
              Via ta CLI `aws` déjà connectée — aucun identifiant n'est demandé ni conservé par Guiterm.
            </p>
          </div>
          <button onClick={onClose} aria-label="Fermer" className="rounded p-1 text-[var(--c-text-muted)] hover:bg-white/5 hover:text-[var(--c-text)]">
            <IconClose size={13} />
          </button>
        </div>

        <div className="flex shrink-0 items-end gap-2 border-b border-[var(--c-border)] px-4 py-2.5">
          <label className="block flex-1 space-y-1">
            <span className="text-xs font-medium text-[var(--c-text-muted)]">Profil</span>
            {profiles && profiles.length > 0 ? (
              <select value={profile} onChange={(e) => setProfile(e.target.value)} className={inputClass}>
                {profiles.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            ) : (
              <input value={profile} onChange={(e) => setProfile(e.target.value)} placeholder="default" className={inputClass} />
            )}
          </label>
          <label className="block w-44 space-y-1">
            <span className="text-xs font-medium text-[var(--c-text-muted)]">Région</span>
            <input list="aws-regions" value={region} onChange={(e) => setRegion(e.target.value)} className={inputClass} />
            <datalist id="aws-regions">
              {COMMON_REGIONS.map((r) => <option key={r} value={r} />)}
            </datalist>
          </label>
          <button
            onClick={discover}
            disabled={loading || !profile.trim() || !region.trim()}
            className="accent-surface shrink-0 rounded-md border px-3 py-1.5 text-xs font-medium disabled:opacity-50"
          >
            {loading ? "Recherche…" : "Lister les instances"}
          </button>
        </div>

        {failure && (
          <div className="shrink-0 border-b border-rose-900/60 bg-rose-950/40 px-4 py-2.5">
            <pre className="max-h-24 overflow-auto whitespace-pre-wrap break-words font-mono text-[10px] text-rose-200/90">{failure.message}</pre>
            {failure.hint && <p className="mt-1.5 text-[11px] leading-relaxed text-[var(--c-text-secondary)]">{failure.hint}</p>}
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
          {instances?.map((instance) => (
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
              <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] ${instance.ssmOnline ? "bg-emerald-950/60 text-emerald-300" : "bg-[var(--c-bg3)] text-[var(--c-text-faint)]"}`}>
                {instance.ssmOnline ? "SSM" : "hors SSM"}
              </span>
            </label>
          ))}
        </div>

        <div className="flex shrink-0 items-center gap-2 border-t border-[var(--c-border)] px-4 py-2.5">
          {tagKeys.length > 0 && (
            <label className="flex items-center gap-1.5">
              <span className="text-[11px] text-[var(--c-text-muted)]">Dossier depuis le tag</span>
              <select value={groupTagKey} onChange={(e) => setGroupTagKey(e.target.value)} className="rounded-md bg-[var(--c-bg3)] px-2 py-1 text-xs text-[var(--c-text)] focus:outline-none">
                <option value="">aucun</option>
                {tagKeys.map((key) => <option key={key} value={key}>{key}</option>)}
              </select>
            </label>
          )}
          <span className="flex-1 text-[11px] text-[var(--c-text-muted)]">
            {instances !== null && `${selectable} instance${selectable > 1 ? "s" : ""} joignable${selectable > 1 ? "s" : ""} via SSM`}
          </span>
          <button
            onClick={runImport}
            disabled={importing || selected.size === 0}
            className="accent-surface rounded-md border px-3 py-1.5 text-xs font-medium disabled:opacity-50"
          >
            Importer {selected.size > 0 ? `(${selected.size})` : ""}
          </button>
        </div>
      </div>
    </div>
  );
}
