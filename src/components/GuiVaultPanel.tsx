import { useCallback, useEffect, useState } from "react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { api } from "../lib/api";
import type {
  FingerprintTrust, GuiVaultAuditEntry, GuiVaultInvitation, GuiVaultMember, GuiVaultReport, GuiVaultSession,
  GuiVaultStatus, GuiVaultUserLookup, GuiVaultVault, VaultId, VaultRole, Workspace,
} from "../lib/types";
import { IconCheck, IconCopy, IconEye, IconEyeOff, IconPlus, IconRefresh, IconTrash, IconVault } from "./ui-icons";
import { ConfirmDialog } from "./ConfirmDialog";

interface GuiVaultPanelProps {
  workspace: Workspace;
  status: GuiVaultStatus | null;
  /** Le statut a changé (connexion, vault créé…) : `App` le recharge — il le
   * passe aussi au formulaire d'hôte pour le sélecteur de vault. */
  onStatusChange: () => void;
  onWorkspaceUpdate: (ws: Workspace) => void;
  onError: (message: string) => void;
  onNotify: (message: string) => void;
}

const inputClass = "input";

const ROLE_LABELS: Record<VaultRole, string> = {
  reader: "lecteur",
  writer: "éditeur",
  admin: "admin",
  owner: "propriétaire",
};

/** Ce qu'un rôle permet, en une ligne : c'est ce qu'on choisit en invitant. */
const ROLE_HINTS: Record<VaultRole, string> = {
  reader: "voit les hôtes et leurs identifiants, ne modifie rien",
  writer: "peut aussi ajouter, modifier et supprimer des entités",
  admin: "peut aussi inviter, retirer des membres et faire tourner la clé",
  owner: "peut aussi supprimer le vault et transférer la propriété",
};

function canManage(role: VaultRole): boolean {
  return role === "admin" || role === "owner";
}

function formatWhen(iso: string | null): string {
  if (!iso) return "jamais";
  const d = new Date(iso);
  return d.toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
}

function describeReport(r: GuiVaultReport): string {
  const parts: string[] = [];
  if (r.pulled) parts.push(`${r.pulled} reçu(s)`);
  if (r.pushed) parts.push(`${r.pushed} envoyé(s)`);
  if (r.removedLocally) parts.push(`${r.removedLocally} retiré(s) ici`);
  if (r.deletedRemotely) parts.push(`${r.deletedRemotely} supprimé(s) en face`);
  return parts.length ? parts.join(", ") : "à jour";
}

/** L'empreinte, en police à chasse fixe, avec un bouton pour la copier —
 * c'est ce qu'on lit à voix haute ou colle dans une messagerie. */
function Fingerprint({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="inline-flex min-w-0 items-center gap-1">
      <code className="truncate font-mono text-[11px] text-[var(--c-text)]">{value}</code>
      <button
        type="button"
        title="Copier l'empreinte"
        aria-label="Copier l'empreinte"
        onClick={() => { writeText(value).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }).catch(() => {}); }}
        className="btn btn-ghost btn-sm btn-icon"
      >
        {copied ? <IconCheck size={11} /> : <IconCopy size={11} />}
      </button>
    </span>
  );
}

/** L'état de confiance d'une empreinte, avec le bouton d'épinglage quand il
 * manque. Une empreinte **changée** est affichée comme une alerte : c'est
 * exactement ce qu'un serveur qui substitue une clé produirait. */
function TrustBadge({ email, fingerprint, trust, onPinned }: { email: string; fingerprint: string; trust: FingerprintTrust; onPinned: () => void }) {
  const [confirm, setConfirm] = useState(false);
  const pin = () => api.guivaultPinFingerprint(email, fingerprint).then(onPinned).catch(() => {});
  if (trust.kind === "pinned") {
    return <span className="tag tag-accent" title="Empreinte vérifiée et épinglée">vérifiée</span>;
  }
  return (
    <>
      {trust.kind === "changed" ? (
        <span className="tag" style={{ background: "color-mix(in srgb, var(--c-danger) 15%, transparent)", color: "var(--c-danger)" }} title={`Empreinte précédemment vérifiée : ${trust.previous}`}>
          clé changée !
        </span>
      ) : (
        <span className="tag" title="Empreinte jamais vérifiée">non vérifiée</span>
      )}
      <button type="button" onClick={() => setConfirm(true)} className="btn btn-secondary btn-sm">Vérifier…</button>
      {confirm && (
        <ConfirmDialog
          title={`Vérifier l'empreinte de ${email}`}
          message={
            (trust.kind === "changed"
              ? `ATTENTION : la clé de ${email} a changé depuis la dernière vérification (${trust.previous}). Si cette personne n'a pas recréé son compte, quelqu'un se fait passer pour elle — ou le serveur ment. `
              : "") +
            `Demandez à ${email} son empreinte par un autre canal (de vive voix, messagerie interne — elle est affichée dans son panneau GuiVault) et comparez-la à : ${fingerprint}. ` +
            "Ne confirmez que si les deux sont identiques : c'est la seule protection contre un serveur qui substituerait sa propre clé pour lire vos vaults partagés."
          }
          confirmLabel="Elles sont identiques, épingler"
          danger={trust.kind === "changed"}
          onConfirm={() => { setConfirm(false); pin(); }}
          onCancel={() => setConfirm(false)}
        />
      )}
    </>
  );
}

// ─── Connexion ───────────────────────────────────────────────────────────────

function ConnectForm({ onDone, onError }: { onDone: () => void; onError: (m: string) => void }) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [serverUrl, setServerUrl] = useState("https://");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [totpCode, setTotpCode] = useState<string | null>(null);

  const submitTotp = async () => {
    if (!totpCode?.trim()) return;
    setBusy(true);
    setError(null);
    try { await api.guivaultLoginTotp(totpCode); onDone(); } catch (e) { setError(String(e)); } finally { setBusy(false); }
  };

  const submit = async () => {
    setError(null);
    if (!/^https?:\/\/.+/.test(serverUrl.trim())) { setError("L'adresse du serveur doit commencer par https:// (ou http:// en local)"); return; }
    if (!email.trim().includes("@")) { setError("Adresse e-mail invalide"); return; }
    if (mode === "register") {
      if (password.length < 12) { setError("Le mot de passe maître doit faire au moins 12 caractères : c'est lui qui protège tout, et il est irrécupérable"); return; }
      if (password !== confirm) { setError("Les deux saisies du mot de passe diffèrent"); return; }
    } else if (!password) { setError("Le mot de passe maître est requis"); return; }
    setBusy(true);
    try {
      const input = { serverUrl: serverUrl.trim(), email: email.trim(), password };
      if (mode === "register") { await api.guivaultRegister(input); onDone(); return; }
      const step = await api.guivaultLogin(input);
      if (step.step === "totpRequired") { setTotpCode(""); return; }
      onDone();
    } catch (e) {
      setError(String(e));
      onError(String(e));
    } finally {
      setBusy(false);
    }
  };

  if (totpCode !== null) {
    return (
      <TotpPrompt code={totpCode} onChange={setTotpCode} busy={busy} error={error} onSubmit={submitTotp} onCancel={() => { setTotpCode(null); setError(null); }} />
    );
  }

  return (
    <div className="card space-y-2 p-3">
      <p className="text-[12px] leading-relaxed text-[var(--c-text-secondary)]">
        GuiVault synchronise vos hôtes, clés et mots de passe entre vos appareils et les partage avec votre équipe —
        chiffrés ici avant d'être envoyés. Le serveur ne peut rien lire, et personne ne peut réinitialiser un mot de passe
        maître oublié. Ce qui est déjà sur cet appareil rejoindra le vault personnel du compte connecté.
      </p>
      <div className="segmented flex w-full">
        {([["login", "Se connecter"], ["register", "Créer un compte"]] as [typeof mode, string][]).map(([m, label]) => (
          <button key={m} type="button" onClick={() => setMode(m)} data-active={mode === m ? "true" : undefined} className="flex-1">{label}</button>
        ))}
      </div>
      {error && <p className="callout callout-danger py-1">{error}</p>}
      <input value={serverUrl} onChange={(e) => setServerUrl(e.target.value)} placeholder="https://vault.example.com" className={`${inputClass} input-mono w-full`} />
      <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="E-mail" type="email" autoComplete="username" className={`${inputClass} w-full`} />
      <div className="flex gap-1.5">
        <input
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          type={show ? "text" : "password"}
          placeholder="Mot de passe maître"
          autoComplete={mode === "register" ? "new-password" : "current-password"}
          onKeyDown={(e) => { if (e.key === "Enter" && mode === "login") submit(); }}
          className={`${inputClass} min-w-0 flex-1`}
        />
        <button type="button" onClick={() => setShow((v) => !v)} aria-label={show ? "Cacher" : "Afficher"} className="btn btn-secondary btn-icon text-[var(--c-text-muted)]">
          {show ? <IconEyeOff size={13} /> : <IconEye size={13} />}
        </button>
      </div>
      {mode === "register" && (
        <input
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          type={show ? "text" : "password"}
          placeholder="Confirmer le mot de passe maître"
          autoComplete="new-password"
          onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
          className={`${inputClass} w-full`}
        />
      )}
      <div className="flex justify-end pt-1">
        <button onClick={submit} disabled={busy} className="btn btn-primary">
          {busy ? "Connexion…" : mode === "register" ? "Créer le compte" : "Se connecter"}
        </button>
      </div>
    </div>
  );
}

/** Deuxième temps d'une connexion : le code de l'application
 * d'authentification, ou un code de récupération. */
function TotpPrompt({ code, onChange, busy, error, onSubmit, onCancel }: { code: string; onChange: (c: string) => void; busy: boolean; error: string | null; onSubmit: () => void; onCancel: () => void }) {
  return (
    <div className="card space-y-2 p-3">
      <p className="text-[12px] text-[var(--c-text-secondary)]">Mot de passe accepté. Saisissez le code de votre application d'authentification — ou un code de récupération.</p>
      {error && <p className="callout callout-danger py-1">{error}</p>}
      <input value={code} onChange={(e) => onChange(e.target.value)} placeholder="123 456" autoFocus inputMode="numeric" autoComplete="one-time-code" onKeyDown={(e) => { if (e.key === "Enter") onSubmit(); }} className={`${inputClass} input-mono w-full`} />
      <div className="flex justify-end gap-1.5">
        <button onClick={onCancel} className="btn btn-ghost">Annuler</button>
        <button onClick={onSubmit} disabled={busy || !code.trim()} className="btn btn-primary">{busy ? "…" : "Valider"}</button>
      </div>
    </div>
  );
}

function UnlockForm({ status, onDone, onError }: { status: GuiVaultStatus; onDone: () => void; onError: (m: string) => void }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [totpCode, setTotpCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    if (!password) return;
    setBusy(true);
    try {
      const step = await api.guivaultUnlock(password);
      if (step.step === "totpRequired") { setTotpCode(""); return; }
      onDone();
    } catch (e) { onError(String(e)); } finally { setBusy(false); }
  };
  const submitTotp = async () => {
    if (!totpCode?.trim()) return;
    setBusy(true);
    setError(null);
    try { await api.guivaultLoginTotp(totpCode); onDone(); } catch (e) { setError(String(e)); } finally { setBusy(false); }
  };
  if (totpCode !== null) {
    return <TotpPrompt code={totpCode} onChange={setTotpCode} busy={busy} error={error} onSubmit={submitTotp} onCancel={() => setTotpCode(null)} />;
  }
  return (
    <div className="card space-y-2 p-3">
      <p className="text-[12px] text-[var(--c-text-secondary)]">
        Compte <span className="font-medium text-[var(--c-text)]">{status.email}</span> sur {status.serverUrl}. Les clés ne
        sont pas conservées sur cet appareil : saisissez le mot de passe maître pour synchroniser.
      </p>
      <input value={password} onChange={(e) => setPassword(e.target.value)} type="password" placeholder="Mot de passe maître" autoFocus onKeyDown={(e) => { if (e.key === "Enter") submit(); }} className={`${inputClass} w-full`} />
      <div className="flex justify-end">
        <button onClick={submit} disabled={busy || !password} className="btn btn-primary">{busy ? "…" : "Déverrouiller"}</button>
      </div>
    </div>
  );
}

// ─── Compte ──────────────────────────────────────────────────────────────────

function AccountCard({ status, onStatusChange, onError, onNotify }: { status: GuiVaultStatus; onStatusChange: () => void; onError: (m: string) => void; onNotify: (m: string) => void }) {
  const [syncing, setSyncing] = useState(false);
  const [showMore, setShowMore] = useState(false);
  const [sessions, setSessions] = useState<GuiVaultSession[] | null>(null);
  const [pwCurrent, setPwCurrent] = useState("");
  const [pwNext, setPwNext] = useState("");
  const [pwBusy, setPwBusy] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [keepShared, setKeepShared] = useState(false);
  const [totpEnabled, setTotpEnabled] = useState<boolean | null>(null);
  const [totpSetup, setTotpSetup] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [totpCode, setTotpCode] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [totpBusy, setTotpBusy] = useState(false);

  const loadTotp = () => api.guivaultTotpStatus().then(setTotpEnabled).catch(() => setTotpEnabled(null));
  const startTotp = async () => {
    setTotpBusy(true);
    try { setTotpSetup(await api.guivaultTotpSetup()); setTotpCode(""); } catch (e) { onError(String(e)); } finally { setTotpBusy(false); }
  };
  const confirmTotp = async () => {
    setTotpBusy(true);
    try {
      const codes = await api.guivaultTotpEnable(totpCode);
      setRecoveryCodes(codes); setTotpSetup(null); setTotpCode(""); setTotpEnabled(true);
      onNotify("Second facteur activé — les autres appareils devront se reconnecter.");
    } catch (e) { onError(String(e)); } finally { setTotpBusy(false); }
  };
  const disableTotp = async () => {
    setTotpBusy(true);
    try { await api.guivaultTotpDisable(totpCode); setTotpCode(""); setTotpEnabled(false); onNotify("Second facteur désactivé."); } catch (e) { onError(String(e)); } finally { setTotpBusy(false); }
  };

  const syncNow = async () => {
    setSyncing(true);
    try {
      const r = await api.guivaultSync();
      onNotify(`Synchronisation : ${describeReport(r)}`);
      onStatusChange();
    } catch (e) { onError(String(e)); } finally { setSyncing(false); }
  };

  const loadSessions = () => api.guivaultSessions().then(setSessions).catch((e) => onError(String(e)));

  const changePassword = async () => {
    setPwBusy(true);
    try {
      await api.guivaultChangePassword(pwCurrent, pwNext);
      setPwCurrent(""); setPwNext("");
      onNotify("Mot de passe maître GuiVault changé — les autres appareils sont déconnectés.");
    } catch (e) { onError(String(e)); } finally { setPwBusy(false); }
  };

  return (
    <div className="card space-y-2 p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-[13px] font-medium text-[var(--c-text)]">{status.email}</p>
          <p className="truncate text-[11.5px] text-[var(--c-text-muted)]">{status.serverUrl}</p>
        </div>
        <button onClick={syncNow} disabled={syncing} className="btn btn-primary btn-sm" title="Synchroniser maintenant">
          <IconRefresh size={12} className={syncing ? "animate-spin" : ""} /> Synchroniser
        </button>
      </div>
      <p className="text-[11.5px] text-[var(--c-text-muted)]">Dernière synchronisation : {formatWhen(status.lastSyncAt)}</p>
      <div className="space-y-0.5">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--c-text-secondary)]">Votre empreinte</p>
        <p className="text-[11.5px] text-[var(--c-text-muted)]">À communiquer à qui veut vous partager un vault, pour qu'il la compare à celle que le serveur lui montre.</p>
        {status.fingerprint && <Fingerprint value={status.fingerprint} />}
      </div>
      <div className="flex items-center justify-between gap-2">
        <label className="text-[12px] text-[var(--c-text-secondary)]">Synchronisation automatique</label>
        <select
          value={status.autoSyncSecs}
          onChange={(e) => api.guivaultSetPreferences(Number(e.target.value), status.persistUnlock).then(onStatusChange).catch((err) => onError(String(err)))}
          className={`${inputClass} w-auto`}
        >
          <option value={0}>manuelle</option>
          <option value={60}>chaque minute</option>
          <option value={300}>toutes les 5 min</option>
          <option value={900}>toutes les 15 min</option>
          <option value={3600}>toutes les heures</option>
        </select>
      </div>
      <label className="flex cursor-pointer items-center justify-between gap-2 text-[12px] text-[var(--c-text-secondary)]" title="Décoché : le mot de passe maître est redemandé à chaque lancement, rien de déchiffrable ne reste sur le disque.">
        <span>Rester déverrouillé sur cet appareil</span>
        <input type="checkbox" checked={status.persistUnlock} onChange={(e) => api.guivaultSetPreferences(status.autoSyncSecs, e.target.checked).then(onStatusChange).catch((err) => onError(String(err)))} className="h-3.5 w-3.5" />
      </label>

      <button type="button" onClick={() => { setShowMore((v) => !v); if (!showMore) { loadSessions(); loadTotp(); } }} className="btn btn-ghost btn-sm w-full">
        {showMore ? "Masquer" : "Appareils, second facteur, mot de passe…"}
      </button>
      {showMore && (
        <div className="space-y-3 border-t border-[var(--c-border)] pt-2">
          <div className="space-y-1">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--c-text-secondary)]">Appareils connectés</p>
            {sessions === null && <p className="text-[11.5px] text-[var(--c-text-muted)]">Chargement…</p>}
            {sessions?.map((s) => (
              <div key={s.id} className="flex items-center gap-2 text-[12px]">
                <span className="min-w-0 flex-1 truncate text-[var(--c-text)]">{s.deviceName ?? "appareil sans nom"}{s.current && <span className="tag tag-accent ml-1.5">celui-ci</span>}</span>
                <span className="text-[11px] text-[var(--c-text-muted)]">{formatWhen(s.lastUsedAt)}</span>
                {!s.current && (
                  <button onClick={() => api.guivaultRevokeSession(s.id).then(loadSessions).catch((e) => onError(String(e)))} className="btn btn-ghost btn-sm btn-icon hover:text-[var(--c-danger)]" title="Déconnecter cet appareil"><IconTrash size={11} /></button>
                )}
              </div>
            ))}
          </div>
          <div className="space-y-1.5">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--c-text-secondary)]">Second facteur (TOTP)</p>
            {totpEnabled === null && <p className="text-[11.5px] text-[var(--c-text-muted)]">Chargement…</p>}
            {totpEnabled === false && !totpSetup && (
              <div className="flex items-center justify-between gap-2">
                <p className="text-[11.5px] text-[var(--c-text-muted)]">Désactivé. Un code d'application d'authentification sera demandé à chaque connexion — il protège la session, pas les données (le mot de passe maître reste seul à les chiffrer).</p>
                <button onClick={startTotp} disabled={totpBusy} className="btn btn-secondary btn-sm shrink-0">Activer</button>
              </div>
            )}
            {totpSetup && (
              <div className="callout space-y-1.5">
                <p>Ajoutez ce secret dans votre application (Aegis, Bitwarden, Google Authenticator…) puis saisissez le code qu'elle affiche :</p>
                <div className="flex flex-wrap items-center gap-1.5">
                  <code className="break-all font-mono text-[11px] text-[var(--c-text)]">{totpSetup.secret.replace(/(.{4})/g, "$1 ").trim()}</code>
                  <button type="button" onClick={() => { writeText(totpSetup.otpauthUrl).catch(() => {}); }} className="btn btn-ghost btn-sm" title="Copier l'URL otpauth:// (importable par la plupart des applications)"><IconCopy size={11} /> URL</button>
                </div>
                <div className="flex gap-1.5">
                  <input value={totpCode} onChange={(e) => setTotpCode(e.target.value)} placeholder="Code à 6 chiffres" inputMode="numeric" onKeyDown={(e) => { if (e.key === "Enter") confirmTotp(); }} className={`${inputClass} input-mono min-w-0 flex-1`} />
                  <button onClick={() => setTotpSetup(null)} className="btn btn-ghost btn-sm">Annuler</button>
                  <button onClick={confirmTotp} disabled={totpBusy || totpCode.trim().length < 6} className="btn btn-primary btn-sm">Confirmer</button>
                </div>
              </div>
            )}
            {recoveryCodes && (
              <div className="callout callout-warn space-y-1">
                <p className="font-medium">Codes de récupération — conservez-les, ils ne seront plus affichés.</p>
                <p>Chacun remplace une fois le code de l'application si vous perdez votre téléphone.</p>
                <code className="block whitespace-pre-wrap font-mono text-[11px] text-[var(--c-text)]">{recoveryCodes.join("\n")}</code>
                <div className="flex justify-end gap-1.5">
                  <button type="button" onClick={() => { writeText(recoveryCodes.join("\n")).catch(() => {}); }} className="btn btn-secondary btn-sm"><IconCopy size={11} /> Copier</button>
                  <button type="button" onClick={() => setRecoveryCodes(null)} className="btn btn-ghost btn-sm">J'ai noté</button>
                </div>
              </div>
            )}
            {totpEnabled === true && !recoveryCodes && (
              <div className="flex gap-1.5">
                <span className="tag tag-accent self-center">actif</span>
                <input value={totpCode} onChange={(e) => setTotpCode(e.target.value)} placeholder="Code pour désactiver" inputMode="numeric" className={`${inputClass} input-mono min-w-0 flex-1`} />
                <button onClick={disableTotp} disabled={totpBusy || !totpCode.trim()} className="btn btn-secondary btn-sm">Désactiver</button>
              </div>
            )}
          </div>
          <div className="space-y-1.5">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--c-text-secondary)]">Changer le mot de passe maître</p>
            <input value={pwCurrent} onChange={(e) => setPwCurrent(e.target.value)} type="password" placeholder="Actuel" autoComplete="current-password" className={`${inputClass} w-full`} />
            <input value={pwNext} onChange={(e) => setPwNext(e.target.value)} type="password" placeholder="Nouveau (12 caractères minimum)" autoComplete="new-password" className={`${inputClass} w-full`} />
            <div className="flex justify-end">
              <button onClick={changePassword} disabled={pwBusy || !pwCurrent || pwNext.length < 12} className="btn btn-secondary btn-sm">Changer</button>
            </div>
          </div>
          <div className="flex flex-wrap justify-end gap-1.5">
            <button onClick={() => api.guivaultLogout().then(onStatusChange).catch((e) => onError(String(e)))} className="btn btn-secondary btn-sm" title="Ferme la session ; les données restent, il faudra se reconnecter">Se déconnecter</button>
            <button onClick={() => setConfirmDisconnect(true)} className="btn btn-danger btn-sm" title="Retire le compte de cet appareil">Retirer le compte</button>
          </div>
        </div>
      )}
      {confirmDisconnect && (
        <>
          <ConfirmDialog
            title="Retirer le compte GuiVault de cet appareil ?"
            message={
              "Vos hôtes, clés et snippets personnels restent ici, sans plus être synchronisés. Rien n'est supprimé sur le serveur. " +
              (keepShared
                ? "Les entités des vaults partagés restent aussi, comme copies locales — attention : un autre compte connecté ensuite sur cet appareil les enverrait dans son vault personnel."
                : "Les entités des vaults partagés sont retirées de cet appareil (elles appartiennent à l'équipe, elles reviendront à la reconnexion).")
            }
            confirmLabel="Retirer"
            danger
            onConfirm={() => { setConfirmDisconnect(false); api.guivaultDisconnect(keepShared).then(onStatusChange).catch((e) => onError(String(e))); }}
            onCancel={() => setConfirmDisconnect(false)}
          />
          <label className="flex cursor-pointer items-center gap-2 text-[12px] text-[var(--c-text-secondary)]">
            <input type="checkbox" checked={keepShared} onChange={(e) => setKeepShared(e.target.checked)} className="h-3.5 w-3.5" />
            Garder une copie locale des entités des vaults partagés
          </label>
        </>
      )}
    </div>
  );
}

// ─── Invitations reçues ──────────────────────────────────────────────────────

function ReceivedInvitations({ invitations, onChange, onError }: { invitations: GuiVaultInvitation[]; onChange: () => void; onError: (m: string) => void }) {
  if (invitations.length === 0) return null;
  return (
    <div className="space-y-1.5">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--c-text-secondary)]">Invitations reçues</p>
      {invitations.map((inv) => (
        <div key={inv.id} className="card space-y-1.5 p-2.5">
          <p className="text-[12.5px] text-[var(--c-text)]">
            <span className="font-medium">{inv.inviterEmail}</span> vous invite dans un vault comme <span className="font-medium">{ROLE_LABELS[inv.role]}</span>.
          </p>
          {inv.status === "awaiting_key" ? (
            <p className="text-[11.5px] text-[var(--c-text-muted)]">Acceptée — en attente que {inv.inviterEmail} vérifie votre empreinte et vous transmette la clé.</p>
          ) : (
            <div className="flex justify-end gap-1.5">
              <button onClick={() => api.guivaultDeclineInvitation(inv.id).then(onChange).catch((e) => onError(String(e)))} className="btn btn-ghost btn-sm">Refuser</button>
              <button onClick={() => api.guivaultAcceptInvitation(inv.id).then(onChange).catch((e) => onError(String(e)))} className="btn btn-primary btn-sm">Accepter</button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ─── Détail d'un vault partagé ───────────────────────────────────────────────

function VaultDetail({ vault, workspace, onBack, onStatusChange, onError, onNotify }: {
  vault: GuiVaultVault; workspace: Workspace; onBack: () => void; onStatusChange: () => void; onError: (m: string) => void; onNotify: (m: string) => void;
}) {
  const manage = canManage(vault.role);
  const [members, setMembers] = useState<GuiVaultMember[]>([]);
  const [invitations, setInvitations] = useState<GuiVaultInvitation[]>([]);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<VaultRole>("reader");
  const [lookup, setLookup] = useState<GuiVaultUserLookup | null | "none">(null);
  const [inviteBusy, setInviteBusy] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<null | { kind: "remove"; m: GuiVaultMember } | { kind: "leave" } | { kind: "delete" } | { kind: "rotate" } | { kind: "transfer"; m: GuiVaultMember }>(null);
  const [keepLocal, setKeepLocal] = useState(true);
  const [audit, setAudit] = useState<GuiVaultAuditEntry[] | null>(null);

  const bound = Object.values(workspace.vaultBindings ?? {}).filter((v) => v === vault.id).length;

  const reload = useCallback(() => {
    api.guivaultMembers(vault.id).then(setMembers).catch((e) => onError(String(e)));
    if (manage) api.guivaultVaultInvitations(vault.id).then(setInvitations).catch((e) => onError(String(e)));
  }, [vault.id, manage, onError]);
  useEffect(() => { reload(); }, [reload]);

  const doLookup = async () => {
    if (!inviteEmail.trim()) return;
    try {
      const u = await api.guivaultLookupUser(inviteEmail);
      setLookup(u ?? "none");
    } catch (e) { onError(String(e)); }
  };

  const invite = async () => {
    setInviteBusy(true);
    try {
      await api.guivaultInvite(vault.id, inviteEmail, inviteRole);
      onNotify(`Invitation envoyée à ${inviteEmail.trim()}`);
      setInviteEmail(""); setLookup(null);
      reload();
    } catch (e) { onError(String(e)); } finally { setInviteBusy(false); }
  };

  const act = (p: Promise<unknown>, after?: () => void) => p.then(() => { reload(); after?.(); }).catch((e) => onError(String(e)));

  const pending = invitations.filter((i) => i.status === "pending" || i.status === "awaiting_key");

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <button onClick={onBack} className="btn btn-ghost btn-sm">← Vaults</button>
        {renaming === null ? (
          <p className="min-w-0 flex-1 truncate text-[13px] font-medium text-[var(--c-text)]" onDoubleClick={() => manage && setRenaming(vault.name)} title={manage ? "Double-clic pour renommer" : undefined}>{vault.name}</p>
        ) : (
          <input
            value={renaming}
            autoFocus
            onChange={(e) => setRenaming(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setRenaming(null);
              if (e.key === "Enter") { const n = renaming.trim(); setRenaming(null); if (n && n !== vault.name) act(api.guivaultRenameVault(vault.id, n), onStatusChange); }
            }}
            className={`${inputClass} min-w-0 flex-1`}
          />
        )}
        <span className="tag" title={ROLE_HINTS[vault.role]}>{ROLE_LABELS[vault.role]}</span>
      </div>
      <p className="text-[11.5px] text-[var(--c-text-muted)]">
        {bound === 0 ? "Aucune entité ici pour l'instant — " : `${bound} entité(s) ici — `}
        choisissez ce vault dans le champ « Vault » d'un hôte pour l'y ranger.
      </p>

      <div className="space-y-1">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--c-text-secondary)]">Membres</p>
        {members.map((m) => (
          <div key={m.userId} className="card space-y-1 p-2">
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-[12.5px] text-[var(--c-text)]">{m.email}{m.isMe && <span className="tag ml-1.5">vous</span>}</span>
              {manage && !m.isMe && m.role !== "owner" ? (
                <select value={m.role} onChange={(e) => act(api.guivaultUpdateMember(vault.id, m.userId, e.target.value as VaultRole))} className={`${inputClass} w-auto`} title="Rôle">
                  {(["reader", "writer", "admin"] as VaultRole[]).filter((r) => r !== "admin" || vault.role === "owner" || vault.role === "admin").map((r) => (
                    <option key={r} value={r}>{ROLE_LABELS[r]}</option>
                  ))}
                </select>
              ) : (
                <span className="tag" title={ROLE_HINTS[m.role]}>{ROLE_LABELS[m.role]}</span>
              )}
              {vault.role === "owner" && !m.isMe && (
                <button onClick={() => setConfirm({ kind: "transfer", m })} className="btn btn-ghost btn-sm" title="Transférer la propriété">Propriétaire</button>
              )}
              {manage && !m.isMe && m.role !== "owner" && (
                <button onClick={() => setConfirm({ kind: "remove", m })} className="btn btn-ghost btn-sm btn-icon hover:text-[var(--c-danger)]" title="Retirer du vault"><IconTrash size={11} /></button>
              )}
            </div>
            {!m.isMe && (
              <div className="flex flex-wrap items-center gap-1.5">
                <Fingerprint value={m.fingerprint} />
                <TrustBadge email={m.email} fingerprint={m.fingerprint} trust={m.trust} onPinned={reload} />
              </div>
            )}
          </div>
        ))}
      </div>

      {manage && (
        <div className="space-y-1.5">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--c-text-secondary)]">Inviter</p>
          <div className="flex gap-1.5">
            <input value={inviteEmail} onChange={(e) => { setInviteEmail(e.target.value); setLookup(null); }} onKeyDown={(e) => { if (e.key === "Enter") doLookup(); }} placeholder="E-mail" type="email" className={`${inputClass} min-w-0 flex-1`} />
            <select value={inviteRole} onChange={(e) => setInviteRole(e.target.value as VaultRole)} className={`${inputClass} w-auto`} title={ROLE_HINTS[inviteRole]}>
              {(["reader", "writer", "admin"] as VaultRole[]).map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
            </select>
            <button onClick={doLookup} disabled={!inviteEmail.trim()} className="btn btn-secondary btn-sm">Chercher</button>
          </div>
          {lookup === "none" && (
            <div className="callout space-y-1.5">
              <p>Pas encore de compte sur ce serveur. L'invitation lui permettra de s'inscrire ; vous compléterez ensuite le partage après avoir vérifié son empreinte.</p>
              <div className="flex justify-end"><button onClick={invite} disabled={inviteBusy} className="btn btn-primary btn-sm">Inviter sans clé</button></div>
            </div>
          )}
          {lookup && lookup !== "none" && (
            <div className="callout space-y-1.5">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-[12px] text-[var(--c-text)]">{lookup.email}</span>
                <Fingerprint value={lookup.fingerprint} />
                <TrustBadge email={lookup.email} fingerprint={lookup.fingerprint} trust={lookup.trust} onPinned={doLookup} />
              </div>
              <div className="flex justify-end">
                <button onClick={invite} disabled={inviteBusy || lookup.trust.kind !== "pinned"} className="btn btn-primary btn-sm" title={lookup.trust.kind !== "pinned" ? "Vérifiez d'abord l'empreinte" : undefined}>
                  Inviter comme {ROLE_LABELS[inviteRole]}
                </button>
              </div>
            </div>
          )}
          {pending.length > 0 && (
            <div className="space-y-1">
              {pending.map((inv) => (
                <div key={inv.id} className="card space-y-1 p-2">
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-[12.5px] text-[var(--c-text)]">{inv.inviteeEmail}</span>
                    <span className="tag">{ROLE_LABELS[inv.role]}</span>
                    <span className="tag">{inv.status === "awaiting_key" ? "a accepté, clé à fournir" : inv.hasKey ? "en attente" : "en attente d'inscription"}</span>
                    <button onClick={() => act(api.guivaultRevokeInvitation(inv.id))} className="btn btn-ghost btn-sm btn-icon hover:text-[var(--c-danger)]" title="Révoquer"><IconTrash size={11} /></button>
                  </div>
                  {inv.inviteeFingerprint && inv.inviteeTrust && !inv.hasKey && (
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Fingerprint value={inv.inviteeFingerprint} />
                      <TrustBadge email={inv.inviteeEmail} fingerprint={inv.inviteeFingerprint} trust={inv.inviteeTrust} onPinned={reload} />
                      <button onClick={() => act(api.guivaultCompleteInvitation(vault.id, inv.id), () => onNotify(`Clé transmise à ${inv.inviteeEmail}`))} disabled={inv.inviteeTrust.kind !== "pinned"} className="btn btn-primary btn-sm">Transmettre la clé</button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="flex flex-wrap justify-end gap-1.5 border-t border-[var(--c-border)] pt-2">
        {manage && (
          <button onClick={() => { if (audit === null) api.guivaultVaultAudit(vault.id).then(setAudit).catch((e) => onError(String(e))); else setAudit(null); }} className="btn btn-ghost btn-sm">{audit === null ? "Journal" : "Masquer le journal"}</button>
        )}
        {manage && <button onClick={() => setConfirm({ kind: "rotate" })} className="btn btn-secondary btn-sm" title="Nouvelle clé de vault, tout re-chiffré">Faire tourner la clé</button>}
        {vault.role !== "owner" && <button onClick={() => setConfirm({ kind: "leave" })} className="btn btn-secondary btn-sm">Quitter</button>}
        {vault.role === "owner" && <button onClick={() => setConfirm({ kind: "delete" })} className="btn btn-danger btn-sm">Supprimer le vault</button>}
      </div>
      {audit && (
        <div className="space-y-0.5">
          {audit.length === 0 && <p className="text-[11.5px] text-[var(--c-text-muted)]">Journal vide.</p>}
          {audit.map((e) => (
            <div key={e.id} className="flex gap-2 font-mono text-[10.5px] text-[var(--c-text-muted)]">
              <span className="shrink-0">{formatWhen(e.at)}</span>
              <span className="shrink-0 text-[var(--c-text-secondary)]">{e.actorEmail ?? "—"}</span>
              <span className="min-w-0 truncate text-[var(--c-text)]">{e.action}{e.target ? ` ${e.target}` : ""}</span>
            </div>
          ))}
        </div>
      )}

      {confirm?.kind === "remove" && (
        <ConfirmDialog
          title={`Retirer ${confirm.m.email} ?`}
          message="Il gardera une copie de ce qu'il a déjà synchronisé, et la clé du vault : celle-ci sera remplacée (tout est re-chiffré) pour que rien de ce qui sera ajouté ensuite ne lui soit lisible. Cela demande que l'empreinte de chaque membre restant soit vérifiée."
          confirmLabel="Retirer et changer la clé"
          danger
          onConfirm={() => { const m = confirm.m; setConfirm(null); act(api.guivaultRemoveMember(vault.id, m.userId, true), () => onNotify(`${m.email} retiré, clé du vault renouvelée`)); }}
          onCancel={() => setConfirm(null)}
        />
      )}
      {confirm?.kind === "transfer" && (
        <ConfirmDialog
          title={`Faire de ${confirm.m.email} le propriétaire ?`}
          message="Vous devenez admin. Seul le propriétaire peut supprimer le vault ou le transférer à nouveau."
          confirmLabel="Transférer"
          onConfirm={() => { const m = confirm.m; setConfirm(null); act(api.guivaultTransferOwnership(vault.id, m.userId), onStatusChange); }}
          onCancel={() => setConfirm(null)}
        />
      )}
      {confirm?.kind === "rotate" && (
        <ConfirmDialog
          title="Faire tourner la clé du vault ?"
          message="Une nouvelle clé est générée, chaque entité est re-chiffrée et une enveloppe est transmise à chaque membre — dont l'empreinte doit avoir été vérifiée. Les invitations en attente sont annulées."
          confirmLabel="Faire tourner"
          onConfirm={() => { setConfirm(null); act(api.guivaultRotateVaultKey(vault.id), () => onNotify("Clé du vault renouvelée")); }}
          onCancel={() => setConfirm(null)}
        />
      )}
      {(confirm?.kind === "leave" || confirm?.kind === "delete") && (
        <ConfirmDialog
          title={confirm.kind === "delete" ? `Supprimer « ${vault.name} » ?` : `Quitter « ${vault.name} » ?`}
          message={
            (confirm.kind === "delete"
              ? "Le vault est supprimé pour tous ses membres. "
              : "Vous n'y aurez plus accès. ") +
            (keepLocal
              ? `Les ${bound} entité(s) qu'il contient restent ici, rapatriées dans votre vault personnel.`
              : `Les ${bound} entité(s) qu'il contient seront retirées de cet appareil.`) +
            " (Rechoisir dans la liste après fermeture pour changer ce comportement : la case ci-dessous.)"
          }
          confirmLabel={confirm.kind === "delete" ? "Supprimer" : "Quitter"}
          danger
          onConfirm={() => {
            const k = confirm.kind; setConfirm(null);
            act(k === "delete" ? api.guivaultDeleteVault(vault.id, keepLocal) : api.guivaultLeaveVault(vault.id, keepLocal), () => { onStatusChange(); onBack(); });
          }}
          onCancel={() => setConfirm(null)}
        />
      )}
      {(confirm?.kind === "leave" || confirm?.kind === "delete") && (
        <label className="flex cursor-pointer items-center gap-2 text-[12px] text-[var(--c-text-secondary)]">
          <input type="checkbox" checked={keepLocal} onChange={(e) => setKeepLocal(e.target.checked)} className="h-3.5 w-3.5" />
          Garder une copie locale des entités
        </label>
      )}
    </div>
  );
}

// ─── Le panneau ──────────────────────────────────────────────────────────────

export function GuiVaultPanel({ workspace, status, onStatusChange, onError, onNotify }: GuiVaultPanelProps) {
  const [received, setReceived] = useState<GuiVaultInvitation[]>([]);
  const [selected, setSelected] = useState<VaultId | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");

  const unlocked = !!status?.configured && status.unlocked;
  const loadReceived = useCallback(() => {
    if (!unlocked) { setReceived([]); return; }
    api.guivaultMyInvitations().then(setReceived).catch(() => setReceived([]));
  }, [unlocked]);
  useEffect(() => { loadReceived(); }, [loadReceived, status?.lastSyncAt]);

  const createVault = async () => {
    const name = newName.trim();
    if (!name) return;
    try {
      const v = await api.guivaultCreateVault(name);
      setNewName(""); setCreating(false);
      onStatusChange();
      setSelected(v.id);
      onNotify(`Vault « ${name} » créé — invitez vos collègues depuis sa fiche.`);
    } catch (e) { onError(String(e)); }
  };

  const selectedVault = status?.vaults.find((v) => v.id === selected) ?? null;

  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className="sidebar-scroll -mx-1 min-h-0 min-w-0 flex-1 overflow-y-auto px-1 pb-2">
        {status === null && <p className="text-[12px] text-[var(--c-text-muted)]">Chargement…</p>}
        {status && !status.configured && <ConnectForm onDone={onStatusChange} onError={onError} />}
        {status && status.configured && !status.unlocked && <UnlockForm status={status} onDone={onStatusChange} onError={onError} />}
        {status && unlocked && selectedVault && (
          <VaultDetail vault={selectedVault} workspace={workspace} onBack={() => setSelected(null)} onStatusChange={onStatusChange} onError={onError} onNotify={onNotify} />
        )}
        {status && unlocked && !selectedVault && (
          <div className="space-y-3">
            <AccountCard status={status} onStatusChange={onStatusChange} onError={onError} onNotify={onNotify} />
            <ReceivedInvitations invitations={received} onChange={() => { loadReceived(); onStatusChange(); }} onError={onError} />
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--c-text-secondary)]">Vaults</p>
                <button onClick={() => setCreating((v) => !v)} className="btn btn-ghost btn-sm"><IconPlus size={12} /> Nouveau</button>
              </div>
              {creating && (
                <div className="flex gap-1.5">
                  <input value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") createVault(); if (e.key === "Escape") setCreating(false); }} placeholder="Nom du vault partagé" autoFocus className={`${inputClass} min-w-0 flex-1`} />
                  <button onClick={createVault} disabled={!newName.trim()} className="btn btn-primary btn-sm">Créer</button>
                </div>
              )}
              {status.vaults.map((v) => {
                const bindings = workspace.vaultBindings ?? {};
                const count = v.kind === "personal"
                  ? workspace.hosts.length + workspace.groups.length + workspace.snippets.length + workspace.keychain.length + workspace.sqlConnections.length - Object.keys(bindings).length
                  : Object.values(bindings).filter((b) => b === v.id).length;
                return (
                  <button
                    key={v.id}
                    type="button"
                    onClick={() => v.kind === "shared" && setSelected(v.id)}
                    disabled={v.kind === "personal"}
                    className={`card flex w-full items-center gap-2 p-2 text-left ${v.kind === "shared" ? "hover:bg-[var(--c-hover)]" : ""}`}
                  >
                    <IconVault size={14} className="shrink-0 text-[var(--c-text-muted)]" />
                    <span className="min-w-0 flex-1 truncate text-[12.5px] text-[var(--c-text)]">{v.name}</span>
                    <span className="text-[11px] text-[var(--c-text-muted)]">{count}</span>
                    <span className="tag" title={ROLE_HINTS[v.role]}>{v.kind === "personal" ? "personnel" : ROLE_LABELS[v.role]}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
