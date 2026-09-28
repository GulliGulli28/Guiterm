import { useCallback, useEffect, useState } from "react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { api } from "../lib/api";
import type { SshAgentStatus } from "../lib/types";

/** Paramètres › Agent SSH : l'agent adossé au trousseau (`core::ssh_agent`).
 * Éteint par défaut ; les clés se cochent une à une ; chaque signature est
 * confirmée (ou pour 10 minutes par clé). */
export function SshAgentSettings({ onError }: { onError: (msg: string) => void }) {
  const [status, setStatus] = useState<SshAgentStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [gitKey, setGitKey] = useState<string>("");

  const reload = useCallback(() => {
    api.sshAgentStatus().then(setStatus).catch((e) => onError(String(e)));
  }, [onError]);
  useEffect(reload, [reload]);

  const act = async (f: () => Promise<SshAgentStatus>) => {
    setBusy(true);
    try {
      setStatus(await f());
    } catch (e) {
      onError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const copy = async (what: string, text: string) => {
    await writeText(text).catch((e) => onError(String(e)));
    setCopied(what);
    setTimeout(() => setCopied((c) => (c === what ? null : c)), 1500);
  };

  if (!status) return <p className="help-text">Chargement…</p>;
  const enabledKeys = status.keys.filter((k) => k.enabled && k.publicKey);
  const signing = enabledKeys.find((k) => k.id === gitKey) ?? enabledKeys[0];
  const envLine = status.windows ? `setx SSH_AUTH_SOCK "${status.endpoint ?? ""}"` : `export SSH_AUTH_SOCK="${status.endpoint ?? ""}"`;
  const gitLines = signing
    ? [`git config --global gpg.format ssh`, `git config --global user.signingkey "key::${signing.publicKey}"`, `git config --global commit.gpgsign true`].join("\n")
    : "";

  return (
    <div className="space-y-3">
      <section className="space-y-2 card p-3">
        <label className="flex items-center justify-between gap-2">
          <span className="text-[12.5px] text-[var(--c-text)]">Activer l'agent SSH de Guiterm</span>
          <input type="checkbox" checked={status.enabled} disabled={busy} onChange={(e) => void act(() => api.sshAgentSetEnabled(e.target.checked))} className="h-3.5 w-3.5" />
        </label>
        <p className="help-text">
          `ssh`, `git`, `scp`… lancés hors de Guiterm lui demandent de signer : les clés restent dans l'application, chaque usage est confirmé, et quand le client annonce son serveur (OpenSSH 8.9 et plus), seule la clé de cet hôte est présentée.
        </p>
        {status.enabled && (
          status.running ? (
            <p className="text-[12px] text-[var(--c-text-secondary)]">
              À l'écoute sur <span className="font-mono">{status.endpoint}</span>
            </p>
          ) : (
            <p className="text-[12px] text-[var(--c-danger,#ef4444)]">Arrêté : {status.error ?? "raison inconnue"}</p>
          )
        )}
      </section>

      <section className="space-y-2">
        <p className="eyebrow">Clés proposées</p>
        <div className="card divide-y divide-[var(--c-border)]">
          {status.keys.length === 0 && <p className="help-text p-3">Le trousseau est vide.</p>}
          {status.keys.map((k) => (
            <label key={k.id} className={`flex items-center gap-2 px-3 py-2 ${k.publicKey ? "cursor-pointer" : "opacity-60"}`} title={k.publicKey ? undefined : "Illisible : fichier introuvable, ou clé chiffrée sans phrase de passe enregistrée"}>
              <input type="checkbox" checked={k.enabled} disabled={busy || !k.publicKey} onChange={(e) => void act(() => api.sshAgentSetKey(k.id, e.target.checked))} className="h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12.5px] text-[var(--c-text)]">{k.name}</span>
                <span className="block truncate font-mono text-[10.5px] text-[var(--c-text-muted)]">{k.fingerprint ?? "illisible"}{k.hosts ? ` · ${k.hosts} hôte${k.hosts > 1 ? "s" : ""}` : ""}</span>
              </span>
            </label>
          ))}
        </div>
      </section>

      <section className="space-y-2">
        <p className="eyebrow">L'utiliser</p>
        <div className="space-y-2 card p-3">
          <p className="help-text">
            {status.windows
              ? "Pour OpenSSH de Windows (ssh.exe) et Git configuré pour l'utiliser (core.sshCommand) : la variable d'environnement, une fois, puis rouvrir le terminal."
              : "Dans le fichier de démarrage de votre shell (~/.bashrc, ~/.zshrc) :"}
          </p>
          <div className="flex items-start gap-2">
            <code className="min-w-0 flex-1 break-all rounded bg-[var(--c-bg3)] px-2 py-1 font-mono text-[11.5px] text-[var(--c-text)]">{envLine}</code>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => void copy("env", envLine)}>{copied === "env" ? "Copié" : "Copier"}</button>
          </div>
        </div>
      </section>

      <section className="space-y-2">
        <p className="eyebrow">Signer ses commits Git</p>
        <div className="space-y-2 card p-3">
          {enabledKeys.length === 0 ? (
            <p className="help-text">Cochez d'abord une clé ci-dessus.</p>
          ) : (
            <>
              {enabledKeys.length > 1 && (
                <select value={signing?.id ?? ""} onChange={(e) => setGitKey(e.target.value)} className="input w-full" aria-label="Clé de signature">
                  {enabledKeys.map((k) => <option key={k.id} value={k.id}>{k.name}</option>)}
                </select>
              )}
              <pre className="whitespace-pre-wrap break-all rounded bg-[var(--c-bg3)] px-2 py-1 font-mono text-[11px] text-[var(--c-text)]">{gitLines}</pre>
              <div className="flex justify-end">
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => void copy("git", gitLines)}>{copied === "git" ? "Copié" : "Copier"}</button>
              </div>
              <p className="help-text">Chaque commit signé passera par la confirmation de l'agent (« Signature d'un commit Git »).</p>
            </>
          )}
        </div>
      </section>
    </div>
  );
}
