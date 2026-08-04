import { useEffect, useRef, useState } from "react";
import { api, onAwsSsoOutput } from "../lib/api";
import type { AwsSsoAccount } from "../lib/types";
import { IconClose } from "./ui-icons";

interface AwsSsoSetupPanelProps {
  onClose: () => void;
  /** Called once profiles have been written, so the caller can reload its
   * profile list without the user having to press anything. */
  onProfilesCreated: () => void;
  /** Pre-filled when reconnecting a session that already exists. */
  initialSession?: { name: string; startUrl: string; region: string };
  /** `"accounts"` skips the browser round trip and lists the accounts with the
   * token already in the CLI's cache — adding a profile to a session that is
   * signed in shouldn't cost a re-authentication. Falls back to the form (with
   * the refusal shown) if that token turns out not to work after all. */
  startAt?: "form" | "accounts";
}

type Stage = "form" | "loggingIn" | "listing" | "accounts" | "done";

const inputClass =
  "w-full rounded-md bg-[var(--c-bg3)] px-2 py-1.5 text-sm text-[var(--c-text)] focus:outline-none focus:ring-1 focus:ring-[var(--c-accent-hover)]";

/** A profile name in the shape `aws configure sso` itself produces, so the
 * result is indistinguishable from a wizard-created one. */
function profileName(roleName: string, accountId: string): string {
  return `${roleName}-${accountId}`;
}

/**
 * Setting up an SSO session and turning it into profiles, without a terminal.
 *
 * The browser step is the one thing that cannot be automated away — AWS
 * requires a human at an identity provider. What this replaces is everything
 * around it: no wizard to answer, no arrow-key menus to pick an account, and
 * the same panel reconnects an expired session later, because the whole
 * procedure *is* that one login command.
 */
export function AwsSsoSetupPanel({ onClose, onProfilesCreated, initialSession, startAt = "form" }: AwsSsoSetupPanelProps) {
  const [name, setName] = useState(initialSession?.name ?? "");
  const [startUrl, setStartUrl] = useState(initialSession?.startUrl ?? "");
  const [region, setRegion] = useState(initialSession?.region ?? "eu-west-3");
  const [stage, setStage] = useState<Stage>("form");
  const [output, setOutput] = useState<string[]>([]);
  const [failure, setFailure] = useState<{ message: string; hint: string | null } | null>(null);
  const [accounts, setAccounts] = useState<AwsSsoAccount[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const outputEndRef = useRef<HTMLDivElement>(null);

  // Subscribed for the whole panel's life rather than only during the login:
  // the first lines (the verification URL and code) arrive within
  // milliseconds of the command starting, and a listener attached after the
  // call would miss exactly the ones worth showing.
  useEffect(() => {
    const pending = onAwsSsoOutput((line) => setOutput((previous) => [...previous, line]));
    return () => { pending.then((unlisten) => unlisten()).catch(() => {}); };
  }, []);

  useEffect(() => { outputEndRef.current?.scrollIntoView({ block: "end" }); }, [output]);

  // Adding profiles to a session already signed in: the accounts are readable
  // with the cached token, so the browser step is skipped entirely. Run once,
  // on mount — a failure here just lands on the form, where "Reconnecter" is.
  useEffect(() => {
    if (startAt !== "accounts" || !initialSession) return;
    setStage("listing");
    api.listAwsSsoAccounts(initialSession.startUrl, initialSession.region, initialSession.name)
      .then((found) => { setAccounts(found); setSelected(new Set()); setStage("accounts"); })
      .catch((e) => {
        setFailure({ message: e.message ?? String(e), hint: e.reason?.hint ?? null });
        setStage("form");
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const start = () => {
    setFailure(null);
    setOutput([]);
    setStage("loggingIn");
    api.saveAwsSsoSession(name.trim(), startUrl.trim(), region.trim())
      .then(() => api.awsSsoLogin(name.trim()))
      .then(() => api.listAwsSsoAccounts(startUrl.trim(), region.trim(), name.trim()))
      .then((found) => {
        setAccounts(found);
        setStage("accounts");
        // Nothing pre-ticked: creating a profile per role across every account
        // would bury the two or three anyone actually uses.
        setSelected(new Set());
      })
      .catch((e) => {
        setFailure({ message: e.message ?? String(e), hint: e.reason?.hint ?? null });
        setStage("form");
      });
  };

  const toggle = (key: string) => {
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const createProfiles = () => {
    const specs = (accounts ?? []).flatMap((account) =>
      account.roles
        .filter((role) => selected.has(`${account.accountId}/${role}`))
        .map((role) => ({
          name: profileName(role, account.accountId),
          session: name.trim(),
          accountId: account.accountId,
          roleName: role,
          region: region.trim(),
        })),
    );
    if (specs.length === 0) return;
    setSaving(true);
    api.saveAwsSsoProfiles(specs)
      .then(() => { onProfilesCreated(); setStage("done"); })
      .catch((e) => setFailure({ message: e.message ?? String(e), hint: e.reason?.hint ?? null }))
      .finally(() => setSaving(false));
  };

  const canStart = name.trim() && startUrl.trim() && region.trim();

  return (
    // Above the import panels, not merely equal to them: this one is always
    // opened *from* one of those, and with the same z-index the winner is
    // whichever React renders later — which put it invisibly behind the
    // database panel while working from the hosts panel, purely by JSX order.
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-6" onClick={onClose}>
      <div
        className="flex max-h-full w-[min(44rem,100%)] flex-col overflow-hidden rounded-xl border border-[var(--c-border)] bg-[var(--c-bg2)] shadow-[var(--shadow-lg)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-[var(--c-border)] px-4 py-2.5">
          <div>
            <p className="text-[13px] font-medium text-[var(--c-text)]">
              {startAt === "accounts"
                ? "Ajouter des profils"
                : initialSession
                  ? "Reconnecter la session SSO"
                  : "Configurer une session SSO"}
            </p>
            <p className="text-[11px] text-[var(--c-text-muted)]">
              Écrit dans `~/.aws/config` : ta CLI et tes autres outils verront la même configuration.
            </p>
          </div>
          <button onClick={onClose} aria-label="Fermer" className="rounded p-1 text-[var(--c-text-muted)] hover:bg-white/5 hover:text-[var(--c-text)]">
            <IconClose size={13} />
          </button>
        </div>

        <div className="sidebar-scroll min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
          {(stage === "form" || stage === "loggingIn") && (
            <>
              <label className="block space-y-1">
                <span className="text-xs font-medium text-[var(--c-text-muted)]">Nom de la session</span>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  disabled={stage === "loggingIn" || !!initialSession}
                  placeholder="ma-boite"
                  className={inputClass}
                />
                <span className="block text-[10px] text-[var(--c-text-faint)]">
                  Le nom sous lequel la connexion est enregistrée — les profils qui la partagent
                  expirent et se renouvellent ensemble.
                </span>
              </label>
              <label className="block space-y-1">
                <span className="text-xs font-medium text-[var(--c-text-muted)]">URL du portail</span>
                <input
                  value={startUrl}
                  onChange={(e) => setStartUrl(e.target.value)}
                  disabled={stage === "loggingIn"}
                  placeholder="https://ma-boite.awsapps.com/start"
                  className={`${inputClass} font-mono`}
                />
              </label>
              <label className="block space-y-1">
                <span className="text-xs font-medium text-[var(--c-text-muted)]">Région du portail SSO</span>
                <input
                  value={region}
                  onChange={(e) => setRegion(e.target.value)}
                  disabled={stage === "loggingIn"}
                  placeholder="eu-west-3"
                  className={`${inputClass} font-mono`}
                />
              </label>
            </>
          )}

          {stage === "loggingIn" && (
            <div className="rounded-md border border-[var(--c-border)] bg-[var(--c-bg3)] px-2.5 py-2">
              <p className="text-xs font-medium text-[var(--c-accent-text)]">
                Authentification en cours — termine la connexion dans ton navigateur.
              </p>
              <p className="mt-0.5 text-[10px] text-[var(--c-text-muted)]">
                S'il ne s'est pas ouvert, l'adresse et le code à saisir sont ci-dessous.
              </p>
              {output.length > 0 && (
                <pre className="mt-1.5 max-h-32 overflow-auto whitespace-pre-wrap break-words font-mono text-[10px] text-[var(--c-text-secondary)]">
                  {output.join("\n")}
                  <div ref={outputEndRef} />
                </pre>
              )}
            </div>
          )}

          {stage === "listing" && (
            <p className="py-6 text-center text-[13px] text-[var(--c-text-muted)]">
              Lecture des comptes accessibles avec la session « {initialSession?.name} »…
            </p>
          )}

          {failure && (
            <div className="rounded-md border border-rose-900/60 bg-rose-950/40 px-2.5 py-2">
              <pre className="max-h-24 overflow-auto whitespace-pre-wrap break-words font-mono text-[10px] text-rose-200/90">{failure.message}</pre>
              {failure.hint && <p className="mt-1.5 text-[11px] leading-relaxed text-[var(--c-text-secondary)]">{failure.hint}</p>}
            </div>
          )}

          {stage === "accounts" && (
            <>
              <p className="text-xs text-[var(--c-text-secondary)]">
                Connecté. Choisis les rôles pour lesquels créer un profil.
              </p>
              {accounts?.length === 0 && (
                <p className="py-6 text-center text-[13px] text-[var(--c-text-muted)]">
                  Cette session ne donne accès à aucun compte.
                </p>
              )}
              {accounts?.map((account) => (
                <div key={account.accountId} className="rounded-md border border-[var(--c-border)] bg-[var(--c-bg3)] p-2">
                  <p className="text-[13px] text-[var(--c-text)]">
                    {account.name || account.accountId}
                    <span className="ml-1.5 font-mono text-[11px] text-[var(--c-text-muted)]">{account.accountId}</span>
                  </p>
                  {account.email && <p className="truncate text-[10px] text-[var(--c-text-faint)]">{account.email}</p>}
                  <div className="mt-1 space-y-0.5">
                    {account.roles.length === 0 && (
                      <p className="text-[11px] text-[var(--c-text-faint)]">Aucun rôle listable sur ce compte.</p>
                    )}
                    {account.roles.map((role) => {
                      const key = `${account.accountId}/${role}`;
                      return (
                        <label key={key} className="flex items-center gap-2 rounded px-1 py-0.5 hover:bg-white/5">
                          <input
                            type="checkbox"
                            checked={selected.has(key)}
                            onChange={() => toggle(key)}
                            className="h-4 w-4 shrink-0 accent-[var(--c-accent)]"
                          />
                          <span className="text-xs text-[var(--c-text-secondary)]">{role}</span>
                          <span className="ml-auto truncate font-mono text-[10px] text-[var(--c-text-faint)]">
                            {profileName(role, account.accountId)}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              ))}
            </>
          )}

          {stage === "done" && (
            <p className="py-6 text-center text-[13px] text-emerald-300">
              Profils créés. Ils sont disponibles ici et dans ta CLI.
            </p>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2 border-t border-[var(--c-border)] px-4 py-2.5">
          <span className="flex-1 text-[11px] text-[var(--c-text-muted)]">
            {stage === "accounts" && `${selected.size} profil${selected.size > 1 ? "s" : ""} à créer`}
          </span>
          {stage === "done" ? (
            <button onClick={onClose} className="accent-surface rounded-md border px-3 py-1.5 text-xs font-medium">Fermer</button>
          ) : stage === "accounts" ? (
            <button
              onClick={createProfiles}
              disabled={saving || selected.size === 0}
              className="accent-surface rounded-md border px-3 py-1.5 text-xs font-medium disabled:opacity-50"
            >
              Créer les profils
            </button>
          ) : (
            <button
              onClick={start}
              disabled={stage === "loggingIn" || stage === "listing" || !canStart}
              className="accent-surface rounded-md border px-3 py-1.5 text-xs font-medium disabled:opacity-50"
            >
              {stage === "loggingIn" ? "Connexion…" : stage === "listing" ? "Lecture…" : initialSession ? "Reconnecter" : "Se connecter"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
