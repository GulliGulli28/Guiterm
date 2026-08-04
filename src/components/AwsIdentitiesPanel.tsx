import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";
import type { AwsCallerIdentity, AwsProfile, AwsSsoSession, AwsSsoSessionStatus } from "../lib/types";
import { describeState, groupIdentities, roleFromArn } from "../lib/awsIdentities";
import { profileLabel } from "../lib/awsInstances";
import { IconCloud, IconPlus, IconRefresh, IconTrash } from "./ui-icons";

interface AwsIdentitiesPanelProps {
  /** Opens the SSO setup panel for a session that doesn't exist yet. */
  onConfigureSso: () => void;
  /** Opens it prefilled, to sign a known session in again. */
  onReconnectSso: (session: AwsSsoSession) => void;
  /** Opens it prefilled and straight at the account listing — adding profiles
   * to a session whose token is still valid needs no browser round trip. */
  onAddProfiles: (session: AwsSsoSession) => void;
  /** Bumped by the caller whenever the SSO panel has written something, so the
   * listing reflects it without the user pressing anything. */
  refreshToken: number;
}

/** The countdown shown next to a session is only true at the moment it was
 * read. Re-reading two local files every minute keeps it honest — and is what
 * makes "expire dans 3 min" turn into "expirée" while the panel is open. */
const REFRESH_INTERVAL_MS = 60_000;

type Check = { kind: "ok"; identity: AwsCallerIdentity } | { kind: "error"; message: string };

/**
 * The AWS identities the machine can use, and their state.
 *
 * This exists because everything AWS in this app used to be reachable only
 * from *inside* an import panel: configuring a session meant opening "importer
 * des instances EC2" first, and there was nowhere at all to answer "am I still
 * signed in, and as whom".
 *
 * It describes `~/.aws/config` rather than owning it — the same file the CLI,
 * terraform and everything else on the machine read. Nothing here holds a
 * credential: the sign-in state comes from the CLI's own token cache, and the
 * identity check from `sts get-caller-identity`.
 */
export function AwsIdentitiesPanel({ onConfigureSso, onReconnectSso, onAddProfiles, refreshToken }: AwsIdentitiesPanelProps) {
  const [sessions, setSessions] = useState<AwsSsoSessionStatus[]>([]);
  const [profiles, setProfiles] = useState<AwsProfile[]>([]);
  const [accountNames, setAccountNames] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<{ message: string; hint: string | null } | null>(null);
  // Kept apart from the one above, and never swallowed: this call reads two
  // local files and cannot fail for an AWS reason, so a rejection means the
  // command itself didn't answer. Silently showing "no session" for that is
  // indistinguishable from a machine with nothing configured — the exact
  // silence that let an unreachable MongoDB ship.
  const [statusFailure, setStatusFailure] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [checks, setChecks] = useState<Record<string, Check>>({});
  const [checking, setChecking] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  /** Sessions come from a file read and profiles from the CLI, so a missing
   * `aws` binary still lists the sessions — with the reason it can't say more
   * shown once, rather than an empty panel. */
  const loadSessions = useCallback(
    () =>
      api.listAwsSsoStatus()
        .then((found) => { setSessions(found); setStatusFailure(null); })
        .catch((e) => { setSessions([]); setStatusFailure(e.message ?? String(e)); }),
    [],
  );

  const load = useCallback(() => {
    void loadSessions();
    api.listAwsProfiles()
      .then((found) => { setProfiles(found); setFailure(null); })
      .catch((e) => {
        setProfiles([]);
        setFailure({ message: e.message ?? String(e), hint: e.reason?.hint ?? null });
      })
      .finally(() => setLoaded(true));
  }, [loadSessions]);

  useEffect(load, [load, refreshToken]);
  // Names need a valid token, so they arrive late or not at all; profiles show
  // their account id meanwhile rather than waiting on a round trip.
  useEffect(() => { api.listAwsAccountNames().then(setAccountNames).catch(() => {}); }, [refreshToken]);

  useEffect(() => {
    const timer = setInterval(() => { void loadSessions(); }, REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [loadSessions]);

  const check = (name: string) => {
    setChecking(name);
    api.checkAwsIdentity(name)
      .then((identity) => setChecks((previous) => ({ ...previous, [name]: { kind: "ok", identity } })))
      .catch((e) => setChecks((previous) => ({ ...previous, [name]: { kind: "error", message: e.message ?? String(e) } })))
      .finally(() => setChecking((current) => (current === name ? null : current)));
  };

  const removeProfile = (name: string) => {
    setConfirming(null);
    api.deleteAwsProfile(name)
      .then(load)
      .catch((e) => setFailure({ message: e.message ?? String(e), hint: null }));
  };

  const removeSession = (name: string) => {
    setConfirming(null);
    api.deleteAwsSsoSession(name)
      .then(load)
      .catch((e) => setFailure({ message: e.message ?? String(e), hint: null }));
  };

  const groups = groupIdentities(sessions, profiles);
  const empty = loaded && groups.length === 0;

  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className="sidebar-scroll min-h-0 min-w-0 flex-1 space-y-2 overflow-y-auto pb-2 pl-2 pt-2">
        <div className="flex gap-1.5">
          <button
            onClick={onConfigureSso}
            className="accent-surface flex flex-1 items-center justify-center gap-1.5 rounded-xl border py-2 text-xs font-semibold transition-all"
          >
            <IconPlus size={13} /> Nouvelle session SSO
          </button>
          <button
            onClick={load}
            title="Rafraîchir"
            className="flex shrink-0 items-center justify-center rounded-xl bg-[var(--c-bg3)] px-2.5 text-[var(--c-text-muted)] transition-all hover:bg-white/5 hover:text-[var(--c-text-secondary)]"
          >
            <IconRefresh size={13} />
          </button>
        </div>

        {failure && (
          <div className="rounded-xl border border-rose-900/60 bg-rose-950/40 p-2.5">
            <pre className="max-h-24 overflow-auto whitespace-pre-wrap break-words font-mono text-[10px] text-rose-200/90">{failure.message}</pre>
            {failure.hint && <p className="mt-1.5 text-[11px] leading-relaxed text-[var(--c-text-secondary)]">{failure.hint}</p>}
          </div>
        )}

        {statusFailure && (
          <div className="rounded-xl border border-rose-900/60 bg-rose-950/40 p-2.5">
            <p className="text-[11px] font-medium text-rose-200">Les sessions SSO n'ont pas pu être lues.</p>
            <pre className="mt-1 max-h-20 overflow-auto whitespace-pre-wrap break-words font-mono text-[10px] text-rose-200/80">{statusFailure}</pre>
          </div>
        )}

        {empty && !failure && !statusFailure && (
          <div className="rounded-xl bg-[var(--c-bg3)] p-3 text-center">
            <IconCloud size={22} className="mx-auto text-[var(--c-text-faint)]" />
            <p className="mt-1.5 text-[13px] text-[var(--c-text-secondary)]">Aucune identité AWS configurée</p>
            <p className="mt-1 text-[11px] leading-relaxed text-[var(--c-text-muted)]">
              Une session SSO donne accès à tes comptes ; chaque profil y associe un compte et un rôle.
              Écrit dans <span className="font-mono">~/.aws/config</span>, donc partagé avec ta CLI.
            </p>
          </div>
        )}

        {groups.map((group) => {
          const status = group.session;
          const badge = status ? describeState(status.state) : null;
          const session: AwsSsoSession | null = status
            ? { name: status.name, startUrl: status.startUrl, region: status.region }
            : null;
          return (
            <div key={status?.name ?? "__sans-session"} className="rounded-xl bg-[var(--c-bg3)] p-2.5">
              {status && session && badge ? (
                <>
                  <div className="flex items-start gap-2">
                    <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-[var(--c-accent-dim)]">
                      <IconCloud size={13} className="text-[var(--c-accent-text)]" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[14px] font-medium text-[var(--c-text)]">{status.name}</p>
                      <p className="truncate font-mono text-[10px] text-[var(--c-text-muted)]" title={status.startUrl}>
                        {status.startUrl} · {status.region}
                      </p>
                    </div>
                    <button
                      onClick={() => setConfirming(confirming === `session:${status.name}` ? null : `session:${status.name}`)}
                      title="Supprimer la session"
                      className="shrink-0 rounded p-1 text-[var(--c-text-muted)] hover:bg-rose-900/60 hover:text-rose-300"
                    >
                      <IconTrash size={12} />
                    </button>
                  </div>

                  <p className={`mt-1.5 text-[11px] ${badge.tone === "ok" ? "text-emerald-400" : badge.tone === "warn" ? "text-amber-400" : "text-[var(--c-text-muted)]"}`}>
                    {badge.label}
                  </p>

                  {confirming === `session:${status.name}` && (
                    <div className="mt-1.5 rounded-md bg-rose-950/50 p-2">
                      <p className="text-[11px] leading-relaxed text-rose-200/90">
                        Retirer <span className="font-mono">[sso-session {status.name}]</span> de ~/.aws/config ?
                        {group.profiles.length > 0 && ` Les ${group.profiles.length} profil${group.profiles.length > 1 ? "s" : ""} qui l'utilisent resteront, sans pouvoir se connecter.`}
                      </p>
                      <div className="mt-1.5 flex gap-1.5">
                        <button onClick={() => removeSession(status.name)} className="flex-1 rounded-md bg-rose-900/70 py-1 text-[11px] font-medium text-rose-100 hover:bg-rose-900">
                          Supprimer
                        </button>
                        <button onClick={() => setConfirming(null)} className="flex-1 rounded-md bg-[var(--c-bg2)] py-1 text-[11px] text-[var(--c-text-secondary)] hover:bg-white/5">
                          Annuler
                        </button>
                      </div>
                    </div>
                  )}

                  <div className="mt-1.5 flex gap-1.5">
                    {badge.needsLogin ? (
                      <button onClick={() => onReconnectSso(session)} className="accent-surface flex-1 rounded-md border py-1 text-[11px] font-medium">
                        Se connecter
                      </button>
                    ) : (
                      <>
                        <button onClick={() => onAddProfiles(session)} className="accent-surface flex-1 rounded-md border py-1 text-[11px] font-medium">
                          Ajouter des profils
                        </button>
                        <button
                          onClick={() => onReconnectSso(session)}
                          title="Rejouer la connexion navigateur pour repartir sur un jeton neuf"
                          className="rounded-md bg-[var(--c-bg2)] px-2 py-1 text-[11px] text-[var(--c-text-secondary)] hover:bg-white/5"
                        >
                          Reconnecter
                        </button>
                      </>
                    )}
                  </div>
                </>
              ) : (
                <p className="text-[11px] font-medium text-[var(--c-text-muted)]">
                  Sans session SSO
                  <span className="ml-1 font-normal text-[var(--c-text-faint)]">— identifiants statiques, ou session supprimée</span>
                </p>
              )}

              <div className="mt-1.5 space-y-1">
                {group.profiles.length === 0 && status && (
                  <p className="px-1 text-[11px] text-[var(--c-text-faint)]">
                    Aucun profil encore créé pour cette session.
                  </p>
                )}
                {group.profiles.map((profile) => {
                  const result = checks[profile.name];
                  return (
                    <div key={profile.name} className="group rounded-lg bg-[var(--c-bg2)] px-2 py-1.5">
                      <div className="flex items-center gap-1.5">
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-[12px] text-[var(--c-text)]" title={profileLabel(profile, accountNames)}>
                            {profile.name}
                          </p>
                          <p className="truncate text-[10px] text-[var(--c-text-muted)]">
                            {[
                              profile.accountId ? accountNames[profile.accountId] ?? profile.accountId : null,
                              profile.roleName,
                              profile.region,
                            ]
                              .filter(Boolean)
                              .join(" · ") || "aucun détail dans ~/.aws/config"}
                          </p>
                        </div>
                        <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                          <button
                            onClick={() => check(profile.name)}
                            disabled={checking === profile.name}
                            title="Vérifier — qui ce profil est réellement en ce moment"
                            className="rounded px-1.5 py-0.5 text-[10px] text-[var(--c-text-muted)] hover:bg-white/5 hover:text-[var(--c-text-secondary)] disabled:opacity-50"
                          >
                            {checking === profile.name ? "…" : "Vérifier"}
                          </button>
                          <button
                            onClick={() => setConfirming(confirming === `profile:${profile.name}` ? null : `profile:${profile.name}`)}
                            title="Supprimer le profil"
                            className="rounded p-1 text-[var(--c-text-muted)] hover:bg-rose-900/60 hover:text-rose-300"
                          >
                            <IconTrash size={11} />
                          </button>
                        </div>
                      </div>

                      {result?.kind === "ok" && (
                        <p className="mt-1 truncate text-[10px] text-emerald-400" title={result.identity.arn}>
                          ✓ {roleFromArn(result.identity.arn) ?? result.identity.arn} · compte {result.identity.account}
                        </p>
                      )}
                      {result?.kind === "error" && (
                        <p className="mt-1 line-clamp-3 break-words font-mono text-[10px] text-rose-300/90">{result.message}</p>
                      )}

                      {confirming === `profile:${profile.name}` && (
                        <div className="mt-1.5 rounded-md bg-rose-950/50 p-1.5">
                          <p className="text-[10px] leading-relaxed text-rose-200/90">
                            Retirer <span className="font-mono">{profile.name}</span> de ~/.aws/config et ~/.aws/credentials ?
                            Les hôtes déjà importés qui s'en servent perdront leur accès SSM.
                          </p>
                          <div className="mt-1.5 flex gap-1.5">
                            <button onClick={() => removeProfile(profile.name)} className="flex-1 rounded bg-rose-900/70 py-0.5 text-[10px] font-medium text-rose-100 hover:bg-rose-900">
                              Supprimer
                            </button>
                            <button onClick={() => setConfirming(null)} className="flex-1 rounded bg-[var(--c-bg3)] py-0.5 text-[10px] text-[var(--c-text-secondary)] hover:bg-white/5">
                              Annuler
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
