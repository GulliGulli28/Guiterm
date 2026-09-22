import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { api } from "../lib/api";
import type {
  FingerprintTrust, GuiVaultAuditEntry, GuiVaultEntity, GuiVaultInvitation, GuiVaultKnownAccount, GuiVaultMember,
  GuiVaultFollower, GuiVaultReport, GuiVaultSession, GuiVaultStatus, GuiVaultUserLookup, GuiVaultVault, VaultId, VaultPlace, VaultRole, Workspace,
} from "../lib/types";
import { buildVaultTree, buildVaultTreeSections } from "../lib/vaultTree";
import { useModalSurface } from "../hooks/useModalSurface";
import { IconCheck, IconChevronDown, IconCopy, IconEye, IconEyeOff, IconMonitor, IconPlus, IconRefresh, IconSearch, IconTransfer, IconTrash, IconVault } from "./ui-icons";
import { ConfirmDialog } from "./ConfirmDialog";
import { VaultEntityTree } from "./VaultEntityTree";
import { TransferConfirmDialog } from "./TransferConfirmDialog";

interface GuiVaultPanelProps {
  workspace: Workspace;
  status: GuiVaultStatus | null;
  /** Le statut a changé (connexion, vault créé…) : `App` le recharge — il le
   * passe aussi au formulaire d'hôte pour le sélecteur de vault. */
  onStatusChange: () => void;
  /** « Ouvrir le vault » depuis le panneau Hôtes : le détail de ce vault
   * s'affiche (`null` = personnel). */
  focus?: { vaultId: VaultId | null; epoch: number } | null;
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
    <span className="flex min-w-0 max-w-full items-start gap-1">
      <code className="min-w-0 break-all font-mono text-[11px] leading-snug text-[var(--c-text)]">{value}</code>
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

function ConnectForm({ accounts, localCount, onDone, onError, onNotify }: { accounts: GuiVaultKnownAccount[]; localCount: number; onDone: () => void; onError: (m: string) => void; onNotify: (m: string) => void }) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [serverUrl, setServerUrl] = useState(accounts[0]?.serverUrl ?? "https://");
  const [email, setEmail] = useState("");
  /** Compte connu choisi dans la liste : serveur et e-mail figés. */
  const [known, setKnown] = useState<GuiVaultKnownAccount | null>(null);
  // Décoché par défaut : local et compte ne se mélangent pas, sauf demande.
  const [adoptLocal, setAdoptLocal] = useState(false);
  const [forgetting, setForgetting] = useState<GuiVaultKnownAccount | null>(null);
  const isKnownEmail = accounts.some((a) => a.email === email.trim().toLowerCase() && a.serverUrl === serverUrl.trim().replace(/\/$/, ""));
  const offerAdopt = localCount > 0 && !known && !isKnownEmail;
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
      const input = { serverUrl: serverUrl.trim(), email: email.trim(), password, adoptLocal: offerAdopt && adoptLocal };
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

  const pickKnown = (a: GuiVaultKnownAccount) => { setKnown(a); setServerUrl(a.serverUrl); setEmail(a.email); setMode("login"); setError(null); };

  return (
    <div className="space-y-3">
      {accounts.length > 0 && !known && (
        <div className="space-y-1.5">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--c-text-secondary)]">Comptes sur cet appareil</p>
          {accounts.map((a) => (
            <div key={a.userId} className="card flex min-w-0 items-center gap-2 p-2">
              <button type="button" onClick={() => pickKnown(a)} className="min-w-0 flex-1 text-left">
                <span className="block truncate text-[12.5px] text-[var(--c-text)]">{a.email}</span>
                <span className="block truncate text-[11px] text-[var(--c-text-muted)]">{a.serverUrl} — {formatWhen(a.lastUsedAt)}</span>
              </button>
              <button type="button" onClick={() => setForgetting(a)} className="btn btn-ghost btn-sm btn-icon hover:text-[var(--c-danger)]" title="Oublier ce compte sur cet appareil"><IconTrash size={11} /></button>
            </div>
          ))}
          <p className="text-[11.5px] text-[var(--c-text-muted)]">Chaque compte a ses propres hôtes ici ; déconnecté, vous voyez le profil local de cet appareil.</p>
        </div>
      )}
      {forgetting && (
        <ConfirmDialog
          title={`Oublier ${forgetting.email} sur cet appareil ?`}
          message="Ses hôtes, clés et snippets sont retirés de cet appareil (ils restent sur le serveur et reviendront à une prochaine connexion). Les empreintes vérifiées pour ce compte sont oubliées aussi."
          confirmLabel="Oublier"
          danger
          onConfirm={() => { const a = forgetting; setForgetting(null); api.guivaultForget(a.userId).then(() => { onNotify(`Compte ${a.email} oublié sur cet appareil.`); onDone(); }).catch((e) => onError(String(e))); }}
          onCancel={() => setForgetting(null)}
        />
      )}
    <div className="card space-y-2 p-3">
      {known ? (
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <p className="min-w-0 flex-1 basis-32 truncate text-[12.5px] text-[var(--c-text)]">{known.email} <span className="text-[var(--c-text-muted)]">sur {known.serverUrl}</span></p>
          <button type="button" onClick={() => { setKnown(null); setEmail(""); }} className="btn btn-ghost btn-sm">Autre compte</button>
        </div>
      ) : (
        <>
          <p className="text-[12px] leading-relaxed text-[var(--c-text-secondary)]">
            GuiVault synchronise vos hôtes, clés et mots de passe entre vos appareils et les partage avec votre équipe —
            chiffrés ici avant d'être envoyés. Le serveur ne peut rien lire, et personne ne peut réinitialiser un mot de passe
            maître oublié.
          </p>
          <div className="segmented flex w-full">
            {([["login", "Se connecter"], ["register", "Créer un compte"]] as [typeof mode, string][]).map(([m, label]) => (
              <button key={m} type="button" onClick={() => setMode(m)} data-active={mode === m ? "true" : undefined} className="flex-1">{label}</button>
            ))}
          </div>
        </>
      )}
      {error && <p className="callout callout-danger py-1">{error}</p>}
      {!known && <input value={serverUrl} onChange={(e) => setServerUrl(e.target.value)} placeholder="https://vault.example.com" className={`${inputClass} input-mono w-full`} />}
      {!known && <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="E-mail" type="email" autoComplete="username" className={`${inputClass} w-full`} />}
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
      {offerAdopt && (
        <label className="flex cursor-pointer items-start gap-2 text-[12px] text-[var(--c-text-secondary)]" title="Décoché : le compte démarre vide ici, le profil local garde ses données.">
          <input type="checkbox" checked={adoptLocal} onChange={(e) => setAdoptLocal(e.target.checked)} className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>Transférer les {localCount} entité(s) de cet appareil (hôtes, groupes, clés, snippets, connexions) dans le vault personnel de ce compte. Le profil local sera vide ensuite.</span>
        </label>
      )}
      <div className="flex justify-end pt-1">
        <button onClick={submit} disabled={busy} className="btn btn-primary">
          {busy ? "Connexion…" : mode === "register" ? "Créer le compte" : "Se connecter"}
        </button>
      </div>
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
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1 basis-32">
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
        {status.fingerprint && <div className="min-w-0"><Fingerprint value={status.fingerprint} /></div>}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
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
        {showMore ? "Masquer" : "Plus d'options…"}
      </button>
      {showMore && (
        <div className="space-y-3 border-t border-[var(--c-border)] pt-2">
          <div className="space-y-1">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--c-text-secondary)]">Appareils connectés</p>
            {sessions === null && <p className="text-[11.5px] text-[var(--c-text-muted)]">Chargement…</p>}
            {sessions?.map((s) => (
              <div key={s.id} className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[12px]">
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
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="min-w-0 flex-1 basis-40 text-[11.5px] text-[var(--c-text-muted)]">Désactivé. Un code d'application d'authentification sera demandé à chaque connexion — il protège la session, pas les données (le mot de passe maître reste seul à les chiffrer).</p>
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
            <button onClick={() => api.guivaultLogout().then(onStatusChange).catch((e) => onError(String(e)))} className="btn btn-secondary btn-sm" title="Ferme la session et revient au profil local de cet appareil ; le compte reste proposé pour se reconnecter">Se déconnecter</button>
            <button onClick={() => setConfirmDisconnect(true)} className="btn btn-danger btn-sm" title="Retire le compte et ses données de cet appareil">Oublier le compte</button>
          </div>
        </div>
      )}
      {confirmDisconnect && (
        <ConfirmDialog
          title="Oublier ce compte sur cet appareil ?"
          message="Ses hôtes, clés et snippets sont retirés de cet appareil — ils restent sur le serveur et reviendront à une prochaine connexion. Pour simplement changer de compte, « Se déconnecter » suffit."
          confirmLabel="Oublier"
          danger
          onConfirm={() => { setConfirmDisconnect(false); if (status.userId) api.guivaultForget(status.userId).then(onStatusChange).catch((e) => onError(String(e))); }}
          onCancel={() => setConfirmDisconnect(false)}
        />
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

// ─── Contenu d'un vault : arborescence à cocher, déplacer/copier/supprimer ──

/** Un emplacement où envoyer une sélection, tel que le menu le propose. */
interface Destination {
  key: string;
  label: string;
  place: VaultPlace;
}

/** Les emplacements autres que `current` : les vaults où le compte écrit,
 * le personnel, puis cet appareil. */
function destinationsFrom(current: VaultPlace, vaults: GuiVaultVault[]): Destination[] {
  const out: Destination[] = [];
  for (const v of vaults) {
    const place: VaultPlace = { kind: "account", vaultId: v.kind === "personal" ? null : v.id };
    if (samePlace(place, current) || (v.kind === "shared" && v.role === "reader")) continue;
    out.push({ key: v.kind === "personal" ? "personal" : v.id, label: v.kind === "personal" ? "Vault personnel" : v.name, place });
  }
  if (current.kind !== "local") out.push({ key: "local", label: "Cet appareil (local)", place: { kind: "local" } });
  return out;
}

function samePlace(a: VaultPlace, b: VaultPlace): boolean {
  return a.kind === b.kind && (a.kind === "local" || b.kind === "local" || a.vaultId === b.vaultId);
}

/** « Déplacer vers ▾ » / « Copier vers ▾ » : un bouton et son menu
 * d'emplacements, ancré dessous. */
function DestinationMenu({ label, icon, destinations, disabled, onPick }: {
  label: string; icon: ReactNode; destinations: Destination[]; disabled: boolean; onPick: (d: Destination) => void;
}) {
  // Ancré en `fixed` sur le bouton, comme le menu « … » d'un hôte : le
  // conteneur défile (`overflow-y-auto`) et couperait un menu `absolute`.
  const [anchor, setAnchor] = useState<{ top: number; right: number } | null>(null);
  const open = anchor !== null;
  const setOpen = (v: boolean) => { if (!v) setAnchor(null); };
  return (
    <div className="relative">
      <button
        type="button"
        onClick={(e) => {
          if (open) { setAnchor(null); return; }
          const rect = e.currentTarget.getBoundingClientRect();
          setAnchor({ top: rect.bottom + 4, right: window.innerWidth - rect.right });
        }}
        disabled={disabled || destinations.length === 0}
        aria-haspopup="menu"
        aria-expanded={open}
        className="btn btn-secondary btn-sm"
        title={destinations.length === 0 ? "Aucun autre emplacement où écrire" : undefined}
      >
        {icon} {label} <IconChevronDown size={10} className="text-[var(--c-text-muted)]" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onMouseDown={() => setOpen(false)} />
          <div className="popover fixed z-40 min-w-[12rem] py-1" style={{ top: anchor.top, right: anchor.right }} role="menu">
            <p className="eyebrow px-2.5 pb-1 pt-1.5">{label}</p>
            {destinations.map((d) => (
              <button key={d.key} type="button" onClick={() => { setOpen(false); onPick(d); }} className="menu-item" role="menuitem">
                {d.place.kind === "local" ? <IconMonitor size={13} /> : <IconVault size={13} />}
                <span className="truncate">{d.label}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/** Une sélection dans un ensemble de clés — ce que les cases manipulent. */
function useSelection() {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const toggle = (id: string) => setSelected((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const toggleKeys = (keys: string[], checked: boolean) => setSelected((prev) => { const n = new Set(prev); for (const k of keys) { if (checked) n.add(k); else n.delete(k); } return n; });
  const clear = () => setSelected(new Set());
  const setAll = (keys: string[]) => setSelected(new Set(keys));
  return { selected, toggle, toggleKeys, clear, setAll };
}

/** Ce qu'un vault contient, en arborescence à cocher — dossiers, hôtes et
 * connexions dedans, clés et snippets regroupés — puis les actions sur la
 * sélection : déplacer ou copier vers un autre emplacement, supprimer.
 * Passe par le backend plutôt que par `workspace` : ce qui est affiché peut
 * être le profil local.
 *
 * Les déplacements emmènent ce qui doit suivre (dossiers, clé, sous-arbre) :
 * le backend ferme la sélection, la case ne dit que l'entité choisie. */
function VaultContents({ vault, vaults, onChanged, onError, onNotify }: {
  vault: GuiVaultVault; vaults: GuiVaultVault[]; onChanged: () => void; onError: (m: string) => void; onNotify: (m: string) => void;
}) {
  const [entities, setEntities] = useState<GuiVaultEntity[] | null>(null);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const { selected, toggle, toggleKeys, clear, setAll } = useSelection();
  const isPersonal = vault.kind === "personal";
  const place: VaultPlace = { kind: "account", vaultId: isPersonal ? null : vault.id };
  const canWrite = vault.role !== "reader";
  const here = useMemo(() => (entities ?? []).filter((e) => e.vaultId === place.vaultId), [entities, place.vaultId]);
  const tree = useMemo(() => buildVaultTree(here, query), [here, query]);
  const destinations = useMemo(() => destinationsFrom(place, vaults), [place.vaultId, vaults]); // eslint-disable-line react-hooks/exhaustive-deps
  const count = selected.size;

  const load = useCallback(() => {
    api.guivaultListEntities("account").then(setEntities).catch((e) => onError(String(e)));
  }, [onError]);
  useEffect(() => { load(); }, [load, vault.id]);
  // Une entité disparue (synchro, suppression) ne reste pas cochée en silence.
  useEffect(() => {
    if (entities === null) return;
    const ids = new Set(here.map((e) => e.id));
    if ([...selected].some((id) => !ids.has(id))) setAll([...selected].filter((id) => ids.has(id)));
  }, [here]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Un transfert en attente de confirmation : ce qui suivrait. */
  const [pending, setPending] = useState<{ to: Destination; copy: boolean; followers: GuiVaultFollower[] } | null>(null);

  const doSend = async (dropped: string[], to: Destination, copy: boolean) => {
    setBusy(true);
    try {
      const n = await api.guivaultTransferEntities([...selected], place, to.place, copy, dropped);
      onNotify(`${n} entité(s) ${copy ? "copiée(s)" : "déplacée(s)"} vers ${to.label}.`);
      setPending(null); clear(); load(); onChanged();
    } catch (err) { onError(String(err)); } finally { setBusy(false); }
  };

  // D'abord ce qui suivrait : rien ⇒ on agit ; sinon la liste à confirmer.
  const send = async (to: Destination, copy: boolean) => {
    const ids = [...selected];
    try {
      const plan = await api.guivaultTransferPlan(ids, place);
      if (plan.followers.length === 0) await doSend([], to, copy);
      else setPending({ to, copy, followers: plan.followers });
    } catch (err) { onError(String(err)); }
  };

  const remove = async () => {
    setConfirmDelete(false);
    setBusy(true);
    try {
      const ids = [...selected];
      await api.guivaultDeleteEntities(ids);
      onNotify(`${ids.length} entité(s) supprimée(s) de « ${vault.name} ».`);
      clear(); load(); onChanged();
    } catch (err) { onError(String(err)); } finally { setBusy(false); }
  };

  const selectedNames = here.filter((e) => selected.has(e.id)).map((e) => e.name);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-1.5">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--c-text-secondary)]">Contenu{entities && ` (${here.length})`}</p>
        {canWrite && (
          <button onClick={() => setAdding(true)} className="btn btn-ghost btn-sm" title="Ajouter des entités depuis cet appareil ou depuis un autre vault">
            <IconPlus size={12} /> Ajouter…
          </button>
        )}
      </div>
      {here.length > 6 && (
        <div className="relative">
          <div className="pointer-events-none absolute inset-y-0 left-2.5 flex items-center"><IconSearch size={12} className="text-[var(--c-text-muted)]" /></div>
          <input value={query} onChange={(e) => setQuery(e.target.value)} data-panel-search="" placeholder="Filtrer le contenu" aria-label="Filtrer le contenu" className="input h-7 w-full pl-7 text-[12px]" />
        </div>
      )}
      {canWrite && here.length > 0 && (
        // La barre d'actions de la sélection — même dessin que le mode
        // sélection du panneau Hôtes : compteur, Tout/Aucun, actions à droite.
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 rounded-md border border-[var(--c-border)] bg-[var(--c-bg3)] px-2 py-1 text-[11.5px]" data-vault-selection-bar="">
          <span className="text-[var(--c-text-secondary)]">{count} sélectionné{count > 1 ? "s" : ""}</span>
          <button type="button" onClick={() => setAll(tree.visibleKeys)} className="text-[var(--c-accent-text)] hover:underline">Tout</button>
          <button type="button" onClick={clear} className="text-[var(--c-text-muted)] hover:underline">Aucun</button>
          <span className="ml-auto flex items-center gap-1">
            <DestinationMenu label="Déplacer" icon={<IconTransfer size={12} />} destinations={destinations} disabled={busy || count === 0} onPick={(d) => send(d, false)} />
            <DestinationMenu label="Copier" icon={<IconCopy size={12} />} destinations={destinations} disabled={busy || count === 0} onPick={(d) => send(d, true)} />
            <button type="button" onClick={() => setConfirmDelete(true)} disabled={busy || count === 0} className="btn btn-ghost btn-sm btn-icon hover:text-[var(--c-danger)]" title="Supprimer la sélection" aria-label="Supprimer la sélection"><IconTrash size={12} /></button>
          </span>
        </div>
      )}
      {entities === null ? (
        <p className="text-[11.5px] text-[var(--c-text-muted)]">Chargement…</p>
      ) : (
        <VaultEntityTree
          rows={tree.rows}
          selected={selected}
          onToggle={toggle}
          onToggleKeys={toggleKeys}
          selectable={canWrite}
          emptyMessage={query ? `Rien ne correspond à « ${query.trim()} ».` : canWrite ? "Vide — « Ajouter… » y range des entités de cet appareil ou d'un autre vault." : "Vide."}
        />
      )}
      {confirmDelete && (
        <ConfirmDialog
          title={count === 1 ? `Supprimer « ${selectedNames[0]} » ?` : `Supprimer ${count} entités ?`}
          message={
            "Un dossier supprimé rend ses hôtes à la racine ; une clé supprimée laisse ses hôtes sans moyen de s'authentifier. " +
            (isPersonal ? "Supprimé de votre compte et de tous vos appareils à la prochaine synchronisation." : "Supprimé du vault pour tous ses membres à la prochaine synchronisation.")
          }
          confirmLabel="Supprimer"
          danger
          onConfirm={remove}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
      {pending && (
        <TransferConfirmDialog
          title={`${pending.copy ? "Copier" : "Déplacer"} ${count} entité${count > 1 ? "s" : ""} vers ${pending.to.label}`}
          confirmLabel={pending.copy ? "Copier" : "Déplacer"}
          followers={pending.followers}
          busy={busy}
          onConfirm={(dropped) => doSend(dropped, pending.to, pending.copy)}
          onCancel={() => setPending(null)}
        />
      )}
      {adding && (
        <AddToVaultDialog
          vault={vault}
          vaults={vaults}
          onClose={() => setAdding(false)}
          onDone={(message) => { setAdding(false); onNotify(message); load(); onChanged(); }}
          onError={onError}
        />
      )}
    </div>
  );
}

/** « Ajouter dans ce vault » : le même arbre à cocher, avec un dossier par
 * emplacement d'origine — cet appareil, le vault personnel, chaque autre
 * vault du compte — puis « Copier ici » ou « Déplacer ici ». Une sélection
 * peut mélanger les origines : un appel par origine. */
function AddToVaultDialog({ vault, vaults, onClose, onDone, onError }: {
  vault: GuiVaultVault; vaults: GuiVaultVault[]; onClose: () => void; onDone: (message: string) => void; onError: (m: string) => void;
}) {
  const { ref, dialogProps } = useModalSurface({ onClose, label: `Ajouter dans ${vault.name}` });
  const [local, setLocal] = useState<GuiVaultEntity[] | null>(null);
  const [account, setAccount] = useState<GuiVaultEntity[] | null>(null);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const { selected, toggle, toggleKeys, clear } = useSelection();
  const isPersonal = vault.kind === "personal";
  const target: VaultPlace = { kind: "account", vaultId: isPersonal ? null : vault.id };

  useEffect(() => {
    api.guivaultListEntities("local").then(setLocal).catch((e) => { onError(String(e)); setLocal([]); });
    api.guivaultListEntities("account").then(setAccount).catch((e) => { onError(String(e)); setAccount([]); });
  }, [onError]);

  // Les origines, dans l'ordre où le panneau Hôtes les montre : cet appareil,
  // Personnel, puis chaque vault partagé — sauf le vault de destination.
  const sources = useMemo(() => {
    if (local === null || account === null) return null;
    const out: { key: string; name: string; place: VaultPlace; readOnly: boolean; entities: GuiVaultEntity[] }[] = [
      { key: "local", name: "Cet appareil (local)", place: { kind: "local" }, readOnly: false, entities: local },
    ];
    for (const v of vaults) {
      const vaultId = v.kind === "personal" ? null : v.id;
      if (vaultId === target.vaultId) continue;
      out.push({
        key: v.kind === "personal" ? "personal" : v.id,
        name: v.kind === "personal" ? "Vault personnel" : v.name,
        place: { kind: "account", vaultId },
        readOnly: v.kind === "shared" && v.role === "reader",
        entities: account.filter((e) => e.vaultId === vaultId),
      });
    }
    return out;
  }, [local, account, vaults, target.vaultId]);
  const tree = useMemo(() => (sources ? buildVaultTreeSections(sources, query) : null), [sources, query]);

  // Une entité d'un vault en lecture seule se copie mais ne se déplace pas
  // (la retirer la ferait juste revenir à la synchro suivante).
  const readOnlyIds = useMemo(() => new Set((sources ?? []).filter((s) => s.readOnly).flatMap((s) => s.entities.map((e) => e.id))), [sources]);
  const moveBlocked = [...selected].some((id) => readOnlyIds.has(id));
  const count = selected.size;

  /** Ce qui suivrait, par origine, en attente de confirmation. */
  const [pending, setPending] = useState<{ copy: boolean; followers: GuiVaultFollower[]; bySource: Map<string, string[]> } | null>(null);

  const selectedIn = (source: NonNullable<typeof sources>[number]) => source.entities.filter((e) => selected.has(e.id)).map((e) => e.id);

  const doSubmit = async (copy: boolean, dropped: Set<string>) => {
    if (!sources) return;
    setBusy(true);
    try {
      let n = 0;
      for (const source of sources) {
        const own = selectedIn(source);
        if (own.length === 0) continue;
        // Un suiveur vit dans le même workspace que ce qu'il suit : les
        // décochés de cette origine sont parmi ceux que son plan a listés.
        const droppedHere = (pending?.bySource.get(source.key) ?? []).filter((id) => dropped.has(id));
        n += await api.guivaultTransferEntities(own, source.place, target, copy, droppedHere);
      }
      setPending(null); clear();
      onDone(`${n} entité(s) ${copy ? "copiée(s)" : "déplacée(s)"} dans « ${vault.name} ».`);
    } catch (err) { onError(String(err)); } finally { setBusy(false); }
  };

  const submit = async (copy: boolean) => {
    if (!sources) return;
    try {
      const followers: GuiVaultFollower[] = [];
      const bySource = new Map<string, string[]>();
      for (const source of sources) {
        const own = selectedIn(source);
        if (own.length === 0) continue;
        const plan = await api.guivaultTransferPlan(own, source.place);
        followers.push(...plan.followers);
        bySource.set(source.key, plan.followers.map((f) => f.entity.id));
      }
      if (followers.length === 0) { await doSubmit(copy, new Set()); return; }
      setPending({ copy, followers, bySource });
    } catch (err) { onError(String(err)); }
  };

  const sectionMeta = (key: string) => {
    const source = sources?.find((s) => s.key === key);
    if (!source) return undefined;
    return {
      icon: source.place.kind === "local" ? <IconMonitor size={14} /> : <IconVault size={14} />,
      badge: source.readOnly ? <span className="tag" title="Vous ne faites que lire ce vault : copier, oui ; déplacer, non.">copie seulement</span> : undefined,
    };
  };

  return (
    <>
      {pending && (
        <TransferConfirmDialog
          title={`${pending.copy ? "Copier" : "Déplacer"} ${count} entité${count > 1 ? "s" : ""} dans « ${vault.name} »`}
          confirmLabel={pending.copy ? "Copier ici" : "Déplacer ici"}
          followers={pending.followers}
          busy={busy}
          onConfirm={(dropped) => doSubmit(pending.copy, new Set(dropped))}
          onCancel={() => setPending(null)}
        />
      )}
      <div className="fixed inset-0 z-40 bg-black/50" onClick={onClose} />
      <div ref={ref} {...dialogProps} className="modal fixed left-1/2 top-1/2 z-50 flex max-h-[80vh] w-[520px] max-w-[92vw] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden" data-vault-add-dialog="">
        <div className="px-4 pt-4">
          <h2 className="text-[14px] font-semibold text-[var(--c-text)]">Ajouter dans « {vault.name} »</h2>
          <p className="mt-1 text-[12px] leading-relaxed text-[var(--c-text-secondary)]">
            Cochez ce qui doit rejoindre ce vault, depuis cet appareil ou depuis un autre vault. <strong>Déplacer</strong> retire l'entité de son origine ; <strong>copier</strong> en met un exemplaire indépendant ici. Un hôte emmène sa clé et ses dossiers, un dossier son contenu.
          </p>
          <div className="relative mt-3">
            <div className="pointer-events-none absolute inset-y-0 left-2.5 flex items-center"><IconSearch size={13} className="text-[var(--c-text-muted)]" /></div>
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Rechercher un hôte, un dossier, une clé…" aria-label="Rechercher" autoFocus className="input w-full pl-8" />
          </div>
        </div>
        <div className="sidebar-scroll min-h-0 flex-1 overflow-y-auto px-3 py-2">
          {tree === null ? (
            <p className="px-2 py-6 text-center text-[12px] text-[var(--c-text-muted)]">Chargement…</p>
          ) : (
            <VaultEntityTree
              rows={tree.rows}
              selected={selected}
              onToggle={toggle}
              onToggleKeys={toggleKeys}
              sectionMeta={sectionMeta}
              emptyMessage={query ? `Rien ne correspond à « ${query.trim()} ».` : "Rien à ajouter : les autres emplacements sont vides."}
            />
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2 border-t border-[var(--c-border)] px-4 py-3">
          <span className="text-[11.5px] text-[var(--c-text-secondary)]">{count} sélectionné{count > 1 ? "s" : ""}</span>
          <span className="ml-auto flex flex-wrap gap-1.5">
            <button onClick={onClose} className="btn btn-ghost">Annuler</button>
            <button onClick={() => submit(true)} disabled={busy || count === 0} className="btn btn-secondary"><IconCopy size={12} /> Copier ici{count > 0 && ` (${count})`}</button>
            <button
              onClick={() => submit(false)}
              disabled={busy || count === 0 || moveBlocked}
              className="btn btn-primary"
              title={moveBlocked ? "La sélection contient des entités d'un vault en lecture seule : elles ne peuvent qu'être copiées" : undefined}
            >
              <IconTransfer size={12} /> Déplacer ici{count > 0 && ` (${count})`}
            </button>
          </span>
        </div>
      </div>
    </>
  );
}

// ─── Détail d'un vault ───────────────────────────────────────────────────────

function VaultDetail({ vault, vaults, workspace, onBack, onStatusChange, onError, onNotify }: {
  vault: GuiVaultVault; vaults: GuiVaultVault[]; workspace: Workspace; onBack: () => void; onStatusChange: () => void; onError: (m: string) => void; onNotify: (m: string) => void;
}) {
  const isPersonal = vault.kind === "personal";
  const manage = !isPersonal && canManage(vault.role);
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

  const [bound, setBound] = useState(0);
  useEffect(() => {
    api.guivaultListEntities("account").then((l) => setBound(l.filter((e) => e.vaultId === vault.id).length)).catch(() => {});
  }, [vault.id, workspace]);

  const reload = useCallback(() => {
    if (isPersonal) return;
    api.guivaultMembers(vault.id).then(setMembers).catch((e) => onError(String(e)));
    if (manage) api.guivaultVaultInvitations(vault.id).then(setInvitations).catch((e) => onError(String(e)));
  }, [vault.id, manage, isPersonal, onError]);
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
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <button onClick={onBack} className="btn btn-ghost btn-sm">← Vaults</button>
        {renaming === null ? (
          <p className="min-w-[6rem] flex-1 truncate text-[13px] font-medium text-[var(--c-text)]" onDoubleClick={() => manage && setRenaming(vault.name)} title={manage ? "Double-clic pour renommer" : vault.name}>{vault.name}</p>
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
      <VaultContents vault={vault} vaults={vaults} onChanged={onStatusChange} onError={onError} onNotify={onNotify} />

      {!isPersonal && (
      <div className="space-y-1">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--c-text-secondary)]">Membres</p>
        {members.map((m) => (
          <div key={m.userId} className="card min-w-0 space-y-1 p-2">
            <div className="flex min-w-0 items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-[12.5px] text-[var(--c-text)]" title={m.email}>{m.email}{m.isMe && <span className="tag ml-1.5">vous</span>}</span>
              {manage && !m.isMe && m.role !== "owner" && (
                <button onClick={() => setConfirm({ kind: "remove", m })} className="btn btn-ghost btn-sm btn-icon shrink-0 hover:text-[var(--c-danger)]" title="Retirer du vault"><IconTrash size={11} /></button>
              )}
            </div>
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
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
                <button onClick={() => setConfirm({ kind: "transfer", m })} className="btn btn-ghost btn-sm" title="Transférer la propriété">Rendre propriétaire</button>
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

      )}

      {manage && (
        <div className="space-y-1.5">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--c-text-secondary)]">Inviter</p>
          <div className="flex flex-wrap gap-1.5">
            <input value={inviteEmail} onChange={(e) => { setInviteEmail(e.target.value); setLookup(null); }} onKeyDown={(e) => { if (e.key === "Enter") doLookup(); }} placeholder="E-mail" type="email" className={`${inputClass} min-w-[9rem] flex-1`} />
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
                <div key={inv.id} className="card min-w-0 space-y-1 p-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-[12.5px] text-[var(--c-text)]" title={inv.inviteeEmail}>{inv.inviteeEmail}</span>
                    <button onClick={() => act(api.guivaultRevokeInvitation(inv.id))} className="btn btn-ghost btn-sm btn-icon shrink-0 hover:text-[var(--c-danger)]" title="Révoquer"><IconTrash size={11} /></button>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="tag">{ROLE_LABELS[inv.role]}</span>
                    <span className="tag">{inv.status === "awaiting_key" ? "a accepté, clé à fournir" : inv.hasKey ? "en attente" : "en attente d'inscription"}</span>
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

      {!isPersonal && (
      <div className="flex flex-wrap justify-end gap-1.5 border-t border-[var(--c-border)] pt-2">
        {manage && (
          <button onClick={() => { if (audit === null) api.guivaultVaultAudit(vault.id).then(setAudit).catch((e) => onError(String(e))); else setAudit(null); }} className="btn btn-ghost btn-sm">{audit === null ? "Journal" : "Masquer le journal"}</button>
        )}
        {manage && <button onClick={() => setConfirm({ kind: "rotate" })} className="btn btn-secondary btn-sm" title="Nouvelle clé de vault, tout re-chiffré">Faire tourner la clé</button>}
        {vault.role !== "owner" && <button onClick={() => setConfirm({ kind: "leave" })} className="btn btn-secondary btn-sm">Quitter</button>}
        {vault.role === "owner" && <button onClick={() => setConfirm({ kind: "delete" })} className="btn btn-danger btn-sm">Supprimer le vault</button>}
      </div>
      )}
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
              : `Les ${bound} entité(s) qu'il contient seront retirées de cet appareil.`)
          }
          confirmLabel={confirm.kind === "delete" ? "Supprimer" : "Quitter"}
          danger
          onConfirm={() => {
            const k = confirm.kind; setConfirm(null);
            act(k === "delete" ? api.guivaultDeleteVault(vault.id, keepLocal) : api.guivaultLeaveVault(vault.id, keepLocal), () => { onStatusChange(); onBack(); });
          }}
          onCancel={() => setConfirm(null)}
        >
          <label className="flex cursor-pointer items-center gap-2 text-[12px] text-[var(--c-text-secondary)]">
            <input type="checkbox" checked={keepLocal} onChange={(e) => setKeepLocal(e.target.checked)} className="h-3.5 w-3.5" />
            Garder une copie dans mon vault personnel
          </label>
        </ConfirmDialog>
      )}
    </div>
  );
}

// ─── Le panneau ──────────────────────────────────────────────────────────────

export function GuiVaultPanel({ workspace, status, onStatusChange, focus, onError, onNotify }: GuiVaultPanelProps) {
  const [received, setReceived] = useState<GuiVaultInvitation[]>([]);
  // Les entités du **compte** — pas celles affichées : quand le profil local
  // est à l'écran, `workspace` est le local, et le compter au vault personnel
  // serait faux.
  const [accountEntities, setAccountEntities] = useState<GuiVaultEntity[]>([]);
  const [selected, setSelected] = useState<VaultId | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");

  const unlocked = !!status?.configured && status.unlocked;
  useEffect(() => {
    if (!focus || !status) return;
    const target = status.vaults.find((v) => (focus.vaultId === null ? v.kind === "personal" : v.id === focus.vaultId));
    if (target) setSelected(target.id);
  }, [focus?.epoch]); // eslint-disable-line react-hooks/exhaustive-deps
  const loadReceived = useCallback(() => {
    if (!unlocked) { setReceived([]); return; }
    api.guivaultMyInvitations().then(setReceived).catch(() => setReceived([]));
  }, [unlocked]);
  useEffect(() => { loadReceived(); }, [loadReceived, status?.lastSyncAt]);
  useEffect(() => {
    if (!unlocked) { setAccountEntities([]); return; }
    api.guivaultListEntities("account").then(setAccountEntities).catch(() => setAccountEntities([]));
  }, [unlocked, status?.lastSyncAt, workspace]);

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
        {status && !status.configured && (
          <ConnectForm
            accounts={status.accounts}
            localCount={workspace.hosts.length + workspace.groups.length + workspace.snippets.length + workspace.keychain.length + workspace.sqlConnections.length}
            onDone={onStatusChange}
            onError={onError}
            onNotify={onNotify}
          />
        )}
        {status && status.configured && !status.unlocked && <UnlockForm status={status} onDone={onStatusChange} onError={onError} />}
        {status && unlocked && selectedVault && (
          <VaultDetail vault={selectedVault} vaults={status.vaults} workspace={workspace} onBack={() => setSelected(null)} onStatusChange={onStatusChange} onError={onError} onNotify={onNotify} />
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
              <p className="text-[11.5px] text-[var(--c-text-muted)]">Ouvrir un vault pour voir son contenu, en déplacer ou copier une partie ailleurs, ou y ajouter des entités de cet appareil ou d'un autre vault.</p>
              {status.vaults.map((v) => {
                const count = accountEntities.filter((e) => (v.kind === "personal" ? e.vaultId === null : e.vaultId === v.id)).length;
                return (
                  <button
                    key={v.id}
                    type="button"
                    onClick={() => setSelected(v.id)}
                    className="card flex w-full min-w-0 flex-wrap items-center gap-x-2 gap-y-1 p-2 text-left hover:bg-[var(--c-hover)]"
                  >
                    <IconVault size={14} className="shrink-0 text-[var(--c-text-muted)]" />
                    <span className="min-w-[6rem] flex-1 truncate text-[12.5px] text-[var(--c-text)]" title={v.name}>{v.name}</span>
                    <span className="text-[11px] tabular-nums text-[var(--c-text-muted)]" title="Entités dans ce vault">{count}</span>
                    {v.kind === "shared" && <span className="tag" title={ROLE_HINTS[v.role]}>{ROLE_LABELS[v.role]}</span>}
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
