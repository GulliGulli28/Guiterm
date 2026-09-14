import { useState } from "react";
import { api } from "../lib/api";
import type { VaultStatus } from "../lib/types";
import type { AppPreferences } from "../lib/preferences";

interface VaultSettingsProps {
  status: VaultStatus | null;
  /** Ask App to re-fetch the vault status (updates the unlock modal + auto-lock). */
  onChange: () => void;
  preferences: AppPreferences;
  onPreferencesChange: (p: AppPreferences) => void;
}

type Notice = { kind: "ok" | "err"; text: string } | null;

const inputClass = "input";

export function VaultSettings({ status, onChange, preferences, onPreferencesChange }: VaultSettingsProps) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  // Set / activate
  const [newPw, setNewPw] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  // Unlock (locked state)
  const [unlockPw, setUnlockPw] = useState("");
  // Change password
  const [curPw, setCurPw] = useState("");
  const [changeNewPw, setChangeNewPw] = useState("");
  const [changeConfirm, setChangeConfirm] = useState("");
  // Disable
  const [disablePw, setDisablePw] = useState("");
  // Auto-lock delay — local draft so the field can be cleared while typing
  // instead of snapping back to "0" on every keystroke (controlled input).
  const [autoLockDraft, setAutoLockDraft] = useState<string | null>(null);

  const run = async (fn: () => Promise<void>, okMsg: string) => {
    setBusy(true);
    setNotice(null);
    try {
      await fn();
      setNotice({ kind: "ok", text: okMsg });
      onChange();
    } catch (e) {
      setNotice({ kind: "err", text: String(e) });
    } finally {
      setBusy(false);
    }
  };

  if (!status) {
    return <p className="text-[13px] text-[var(--c-text-muted)]">Chargement…</p>;
  }

  const noticeBanner = notice && (
    <p
      className={`rounded-md px-2.5 py-2 text-[12px] ${
        notice.kind === "ok"
          ? "border border-[color-mix(in_srgb,var(--c-ok)_35%,transparent)] bg-[color-mix(in_srgb,var(--c-ok)_10%,transparent)] text-[var(--c-ok)]"
          : "border border-[color-mix(in_srgb,var(--c-danger)_35%,transparent)] bg-[color-mix(in_srgb,var(--c-danger)_10%,transparent)] text-[var(--c-danger)]"
      }`}
    >
      {notice.text}
    </p>
  );

  // ── Not enabled: offer to set a master password ──────────────────────────
  if (!status.enabled) {
    return (
      <div className="space-y-3">
        <div className="space-y-2 rounded-lg bg-[var(--c-bg3)] p-3">
          <p className="text-[13px] font-semibold text-[var(--c-text)]">Mot de passe maître</p>
          <p className="help-text">
            Chiffre les mots de passe et passphrases dans un fichier local protégé par un mot de passe
            (Argon2id + XChaCha20-Poly1305), à la place du trousseau du système. Portable entre machines et
            fonctionne même sans trousseau OS. La liste des hôtes reste visible ; le mot de passe n'est demandé
            qu'au lancement.
          </p>
          <p className="callout callout-warn">
            Il n'y a aucun moyen de récupérer les secrets si vous oubliez ce mot de passe.
          </p>
          <input type="password" value={newPw} onChange={(e) => setNewPw(e.target.value)} placeholder="Nouveau mot de passe maître" className={inputClass} />
          <input type="password" value={confirmPw} onChange={(e) => setConfirmPw(e.target.value)} placeholder="Confirmer" className={inputClass} />
          {noticeBanner}
          <button
            disabled={busy || !newPw}
            onClick={() => {
              if (newPw !== confirmPw) { setNotice({ kind: "err", text: "Les mots de passe ne correspondent pas." }); return; }
              run(() => api.setMasterPassword(newPw), "Coffre activé — secrets migrés et chiffrés ✓").then(() => { setNewPw(""); setConfirmPw(""); });
            }}
            className="w-full rounded-md bg-[var(--c-accent)] px-3 py-2 text-[13px] font-medium text-white hover:bg-[var(--c-accent-hover)] disabled:opacity-50"
          >
            {busy ? "Activation…" : "Activer le coffre chiffré"}
          </button>
        </div>
      </div>
    );
  }

  // ── Enabled but locked: offer to unlock ──────────────────────────────────
  if (!status.unlocked) {
    return (
      <div className="space-y-3">
        <div className="space-y-2 rounded-lg bg-[var(--c-bg3)] p-3">
          <p className="flex items-center gap-2 text-[13px] font-medium text-[var(--c-text)]">
            <span className="h-2 w-2 rounded-full bg-[var(--c-warn)]" /> Coffre verrouillé
          </p>
          <p className="help-text">
            Déverrouillez-le pour vous connecter aux hôtes qui utilisent un secret enregistré, et pour gérer ses paramètres.
          </p>
          <input
            type="password"
            value={unlockPw}
            onChange={(e) => setUnlockPw(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && unlockPw) run(() => api.unlockVault(unlockPw), "Coffre déverrouillé ✓").then(() => setUnlockPw("")); }}
            placeholder="Mot de passe maître"
            className={inputClass}
          />
          {noticeBanner}
          <button
            disabled={busy || !unlockPw}
            onClick={() => run(() => api.unlockVault(unlockPw), "Coffre déverrouillé ✓").then(() => setUnlockPw(""))}
            className="w-full rounded-md bg-[var(--c-accent)] px-3 py-2 text-[13px] font-medium text-white hover:bg-[var(--c-accent-hover)] disabled:opacity-50"
          >
            {busy ? "Déverrouillage…" : "Déverrouiller"}
          </button>
        </div>
      </div>
    );
  }

  // ── Enabled and unlocked: manage ─────────────────────────────────────────
  const autoLock = preferences.masterVaultAutoLockMinutes ?? 0;
  return (
    <div className="space-y-3">
      <div className="space-y-2 rounded-lg bg-[var(--c-bg3)] p-3">
        <p className="flex items-center gap-2 text-[13px] font-medium text-[var(--c-text)]">
          <span className="h-2 w-2 shrink-0 rounded-full bg-[var(--c-ok)]" /> Coffre chiffré actif — déverrouillé
        </p>
        <button
          disabled={busy}
          onClick={() => run(() => api.lockVault(), "Coffre verrouillé.")}
          className="w-full rounded-md bg-[var(--c-bg2)] px-3 py-1.5 text-[12px] font-medium text-[var(--c-text-secondary)] hover:bg-[var(--c-hover)] disabled:opacity-50"
        >
          Verrouiller maintenant
        </button>
      </div>

      {noticeBanner}

      <div className="space-y-2 rounded-lg bg-[var(--c-bg3)] p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-[13px] text-[var(--c-text-secondary)]">Verrouillage auto après inactivité</span>
          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            <input
              type="number"
              min={0}
              max={240}
              value={autoLockDraft ?? String(autoLock)}
              onChange={(e) => {
                const raw = e.target.value;
                setAutoLockDraft(raw);
                if (raw === "") return;
                onPreferencesChange({ ...preferences, masterVaultAutoLockMinutes: Math.max(0, Math.min(240, Number(raw) || 0)) });
              }}
              onBlur={() => {
                if (autoLockDraft === "") onPreferencesChange({ ...preferences, masterVaultAutoLockMinutes: 0 });
                setAutoLockDraft(null);
              }}
              className="input w-16 shrink-0 text-right [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
            />
            <span className="shrink-0 text-[12px] text-[var(--c-text-muted)]">min</span>
          </div>
        </div>
        <p className="help-text">{autoLock === 0 ? "Désactivé — le coffre reste déverrouillé jusqu'à la fermeture de l'application." : `Le coffre se verrouille après ${autoLock} min sans activité.`}</p>
      </div>

      <div className="space-y-2 rounded-lg bg-[var(--c-bg3)] p-3">
        <p className="text-[13px] font-semibold text-[var(--c-text)]">Changer le mot de passe maître</p>
        <input type="password" value={curPw} onChange={(e) => setCurPw(e.target.value)} placeholder="Mot de passe actuel" className={inputClass} />
        <input type="password" value={changeNewPw} onChange={(e) => setChangeNewPw(e.target.value)} placeholder="Nouveau mot de passe" className={inputClass} />
        <input type="password" value={changeConfirm} onChange={(e) => setChangeConfirm(e.target.value)} placeholder="Confirmer le nouveau" className={inputClass} />
        <button
          disabled={busy || !curPw || !changeNewPw}
          onClick={() => {
            if (changeNewPw !== changeConfirm) { setNotice({ kind: "err", text: "Les nouveaux mots de passe ne correspondent pas." }); return; }
            run(() => api.changeMasterPassword(curPw, changeNewPw), "Mot de passe maître changé ✓").then(() => { setCurPw(""); setChangeNewPw(""); setChangeConfirm(""); });
          }}
          className="w-full rounded-md bg-[var(--c-bg2)] px-3 py-2 text-[13px] font-medium text-[var(--c-text)] hover:bg-[var(--c-hover)] disabled:opacity-50"
        >
          {busy ? "…" : "Changer le mot de passe"}
        </button>
      </div>

      <div className="space-y-2 rounded-lg bg-[var(--c-bg3)] p-3">
        <p className="text-[13px] font-semibold text-[var(--c-text)]">Désactiver le coffre</p>
        <p className="help-text">
          Restaure les secrets dans le trousseau du système et supprime le fichier chiffré.
        </p>
        <input type="password" value={disablePw} onChange={(e) => setDisablePw(e.target.value)} placeholder="Mot de passe maître" className={inputClass} />
        <button
          disabled={busy || !disablePw}
          onClick={() => run(() => api.disableMasterPassword(disablePw), "Coffre désactivé — secrets rendus au trousseau du système.").then(() => setDisablePw(""))}
          className="btn btn-danger w-full"
        >
          {busy ? "…" : "Désactiver le coffre"}
        </button>
      </div>
    </div>
  );
}
