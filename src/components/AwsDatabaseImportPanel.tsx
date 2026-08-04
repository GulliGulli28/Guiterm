import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import type { AwsDatabase, AwsProfile, HostId, Workspace } from "../lib/types";
import { groupProfilesBySession } from "../lib/awsInstances";
import { IconClose } from "./ui-icons";

interface AwsDatabaseImportPanelProps {
  workspace: Workspace;
  onWorkspaceUpdate: (ws: Workspace) => void;
  onClose: () => void;
  onError: (message: string) => void;
}

/** Same list as the EC2 panel, and for the same reason: `describe-regions`
 * needs working credentials, which is what may not be true yet. */
const COMMON_REGIONS = [
  "eu-west-1", "eu-west-2", "eu-west-3", "eu-central-1", "eu-north-1", "eu-south-1",
  "us-east-1", "us-east-2", "us-west-1", "us-west-2",
  "ca-central-1", "sa-east-1",
  "ap-northeast-1", "ap-southeast-1", "ap-southeast-2", "ap-south-1",
];

const inputClass =
  "w-full rounded-md bg-[var(--c-bg3)] px-2 py-1.5 text-sm text-[var(--c-text)] focus:outline-none focus:ring-1 focus:ring-[var(--c-accent-hover)]";

const ENGINE_LABEL: Record<string, string> = {
  mysql: "MySQL",
  postgres: "PostgreSQL",
  redis: "Redis",
};

/**
 * Turning an AWS account's managed databases into saved connections.
 *
 * The tunnel is the part that makes this worth doing rather than a listing:
 * RDS and ElastiCache normally live in a private subnet with no route from
 * this machine, so every imported connection is pointed at a saved host to
 * reach it through — typically an EC2 instance imported by the other panel.
 * Without that, the imports would be correct and uniformly unusable.
 */
export function AwsDatabaseImportPanel({ workspace, onWorkspaceUpdate, onClose, onError }: AwsDatabaseImportPanelProps) {
  const [profiles, setProfiles] = useState<AwsProfile[] | null>(null);
  const [profile, setProfile] = useState("");
  const [region, setRegion] = useState("eu-west-3");
  const [databases, setDatabases] = useState<AwsDatabase[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<{ message: string; hint: string | null } | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [tunnelHostId, setTunnelHostId] = useState<HostId | "">("");
  const [password, setPassword] = useState("");
  const [importing, setImporting] = useState(false);

  useEffect(() => {
    api.listAwsProfiles()
      .then((found) => {
        setProfiles(found);
        setProfile((current) => current || found[0]?.name || "");
      })
      .catch((e) => {
        setProfiles([]);
        setFailure({ message: e.message ?? String(e), hint: e.reason?.hint ?? null });
      });
  }, []);

  useEffect(() => {
    const found = profiles?.find((p) => p.name === profile);
    if (found?.region) setRegion(found.region);
  }, [profile, profiles]);

  const profileGroups = useMemo(() => groupProfilesBySession(profiles ?? []), [profiles]);

  const discover = () => {
    setLoading(true);
    setFailure(null);
    setDatabases(null);
    setSelected(new Set());
    api.discoverAwsDatabases(profile, region)
      .then((found) => {
        setDatabases(found);
        setSelected(new Set(found.filter(importable).map(key)));
      })
      .catch((e) => setFailure({ message: e.message ?? String(e), hint: e.reason?.hint ?? null }))
      .finally(() => setLoading(false));
  };

  const runImport = () => {
    const chosen = (databases ?? []).filter((d) => selected.has(key(d)));
    if (chosen.length === 0) return;
    setImporting(true);
    api.importAwsDatabases(
      chosen.map((database) => ({
        label: database.identifier,
        // Narrowed by `importable` above, so this is never null here.
        engine: database.supportedEngine!,
        address: database.address,
        port: database.port,
        username: database.username,
        initialDatabase: database.initialDatabase,
        tls: database.tls,
      })),
      tunnelHostId || null,
      password || null,
    )
      .then((ws) => { onWorkspaceUpdate(ws); onClose(); })
      .catch((e) => onError(String(e)))
      .finally(() => setImporting(false));
  };

  const importableCount = (databases ?? []).filter(importable).length;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6" onClick={onClose}>
      <div
        className="flex max-h-full w-[min(48rem,100%)] flex-col overflow-hidden rounded-xl border border-[var(--c-border)] bg-[var(--c-bg2)] shadow-[var(--shadow-lg)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-[var(--c-border)] px-4 py-2.5">
          <div>
            <p className="text-[13px] font-medium text-[var(--c-text)]">Importer des bases depuis AWS</p>
            <p className="text-[11px] text-[var(--c-text-muted)]">
              RDS, Aurora et ElastiCache, via ta CLI `aws` déjà connectée.
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
                {profileGroups.map((group) => (
                  <optgroup key={group.session ?? "__none"} label={group.session ? `Session SSO — ${group.session}` : "Sans session SSO"}>
                    {group.profiles.map((p) => (
                      <option key={p.name} value={p.name}>{p.name}{p.accountId ? ` · ${p.accountId}` : ""}</option>
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
            <input list="aws-db-regions" value={region} onChange={(e) => setRegion(e.target.value)} className={inputClass} />
            <datalist id="aws-db-regions">
              {COMMON_REGIONS.map((r) => <option key={r} value={r} />)}
            </datalist>
          </label>
          <button
            onClick={discover}
            disabled={loading || !profile.trim() || !region.trim()}
            className="accent-surface shrink-0 rounded-md border px-3 py-1.5 text-xs font-medium disabled:opacity-50"
          >
            {loading ? "Recherche…" : "Lister les bases"}
          </button>
        </div>

        {failure && (
          <div className="shrink-0 border-b border-rose-900/60 bg-rose-950/40 px-4 py-2.5">
            <pre className="max-h-24 overflow-auto whitespace-pre-wrap break-words font-mono text-[10px] text-rose-200/90">{failure.message}</pre>
            {failure.hint && <p className="mt-1.5 text-[11px] leading-relaxed text-[var(--c-text-secondary)]">{failure.hint}</p>}
          </div>
        )}

        <div className="sidebar-scroll min-h-0 flex-1 overflow-y-auto p-2">
          {databases === null && !failure && (
            <p className="px-2 py-8 text-center text-[13px] text-[var(--c-text-muted)]">
              Choisis un profil et une région, puis liste les bases.
            </p>
          )}
          {databases?.length === 0 && (
            <p className="px-2 py-8 text-center text-[13px] text-[var(--c-text-muted)]">
              Aucune base managée dans cette région pour ce profil.
            </p>
          )}
          {databases?.map((database) => {
            const usable = importable(database);
            return (
              <label
                key={key(database)}
                className={`flex items-start gap-2 rounded-md px-2 py-1.5 ${usable ? "hover:bg-white/5" : "opacity-70"}`}
              >
                <input
                  type="checkbox"
                  checked={selected.has(key(database))}
                  disabled={!usable}
                  onChange={() => setSelected((previous) => {
                    const next = new Set(previous);
                    if (next.has(key(database))) next.delete(key(database));
                    else next.add(key(database));
                    return next;
                  })}
                  className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--c-accent)]"
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] text-[var(--c-text)]">
                    {database.identifier}
                    <span className="ml-1.5 text-[11px] text-[var(--c-text-muted)]">
                      {database.service} · {database.engine}
                      {database.engineVersion ? ` ${database.engineVersion}` : ""}
                    </span>
                  </p>
                  <p className="truncate font-mono text-[11px] text-[var(--c-text-muted)]">
                    {database.address}:{database.port}
                    {database.username ? ` · ${database.username}` : ""}
                    {database.status !== "available" ? ` · ${database.status}` : ""}
                  </p>
                  {/* Shown rather than hidden: "where is my database" is a dead
                      end, where a listed entry with its reason points straight
                      at what to change. */}
                  {database.unsupportedReason && (
                    <p className="mt-0.5 text-[10px] leading-relaxed text-amber-400/90">{database.unsupportedReason}</p>
                  )}
                </div>
                {database.tls && (
                  <span className="mt-0.5 shrink-0 rounded bg-emerald-950/60 px-1.5 py-0.5 text-[10px] text-emerald-300">TLS</span>
                )}
                {database.supportedEngine && (
                  <span className="mt-0.5 shrink-0 rounded bg-[var(--c-bg3)] px-1.5 py-0.5 text-[10px] text-[var(--c-text-secondary)]">
                    {ENGINE_LABEL[database.supportedEngine] ?? database.supportedEngine}
                  </span>
                )}
              </label>
            );
          })}
        </div>

        {selected.size > 0 && (
          <div className="shrink-0 space-y-1.5 border-t border-[var(--c-border)] px-4 py-2.5">
            <div className="flex items-center gap-2">
              <span className="w-24 shrink-0 text-xs font-medium text-[var(--c-text-muted)]">Tunnel SSH</span>
              <select
                value={tunnelHostId}
                onChange={(e) => setTunnelHostId(e.target.value as HostId | "")}
                className="flex-1 rounded-md bg-[var(--c-bg3)] px-2 py-1 text-xs text-[var(--c-text)] focus:outline-none"
              >
                <option value="">Connexion directe (aucun tunnel)</option>
                {workspace.hosts.filter((h) => (h.kind ?? "ssh") === "ssh").map((host) => (
                  <option key={host.id} value={host.id}>{host.label}</option>
                ))}
              </select>
            </div>
            <p className="pl-26 text-[10px] leading-relaxed text-[var(--c-text-faint)]">
              Une base managée est presque toujours dans un sous-réseau privé, sans route depuis cette
              machine : choisis l'hôte par lequel la joindre — typiquement une instance EC2 importée.
            </p>
            <div className="flex items-center gap-2">
              <span className="w-24 shrink-0 text-xs font-medium text-[var(--c-text-muted)]">Mot de passe</span>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="appliqué aux connexions importées"
                className="flex-1 rounded-md bg-[var(--c-bg3)] px-2 py-1 text-xs text-[var(--c-text)] placeholder:text-[var(--c-text-muted)] focus:outline-none"
              />
            </div>
          </div>
        )}

        <div className="flex shrink-0 items-center gap-2 border-t border-[var(--c-border)] px-4 py-2.5">
          <span className="flex-1 text-[11px] text-[var(--c-text-muted)]">
            {databases !== null && `${databases.length} trouvée${databases.length > 1 ? "s" : ""} · ${importableCount} importable${importableCount > 1 ? "s" : ""}`}
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

/** Endpoint rather than name: two services can hand out the same identifier,
 * and the endpoint is what actually distinguishes one connection from another. */
function key(database: AwsDatabase): string {
  return `${database.address}:${database.port}`;
}

function importable(database: AwsDatabase): boolean {
  return database.supportedEngine !== null && database.status === "available";
}
