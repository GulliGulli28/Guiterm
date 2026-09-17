import type { GuiVaultStatus } from "../lib/types";
import { formatRelativeTime } from "../lib/format";
import { IconMonitor, IconRefresh, IconVault } from "./ui-icons";

/**
 * Quel workspace on regarde — cet appareil, ou un compte GuiVault — en tête
 * de la barre latérale, sur **tous** les panneaux.
 *
 * Le sélecteur vivait dans le panneau Hôtes seul ; or Clés, Snippets, Bases,
 * la flotte ou un transfert montrent le même workspace, et rien n'y disait
 * lequel. Un compte affiché est un état global de l'app, il se lit et se
 * change au même endroit partout. La ligne dit aussi ce que le compte fait :
 * synchronisation en cours, dernière synchro — le compte se synchronise
 * même quand c'est le profil local qui est affiché, le sélecteur suffit à
 * le dire.
 *
 * Un `<select>` natif, pas un `HostTreePicker` : ce sont des profils, pas
 * des hôtes.
 */
export interface ProfileBarProps {
  status: GuiVaultStatus;
  syncing: boolean;
  /** `"local"` / `"account"` basculent l'affichage ; un autre compte ouvre
   * le panneau GuiVault pour s'y connecter. */
  onSwitch: (target: "local" | "account" | { userId: string }) => void;
  onSyncNow: () => void;
  onOpenGuiVault: () => void;
}

/** Rien à montrer sans compte connecté ni compte connu sur cet appareil. */
export function profileBarNeeded(status: GuiVaultStatus | null): status is GuiVaultStatus {
  return !!status && (status.configured || status.accounts.length > 0);
}

export function ProfileBar({ status, syncing, onSwitch, onSyncNow, onOpenGuiVault }: ProfileBarProps) {
  const connected = status.configured ? status.email : null;
  const value = connected && !status.viewLocal ? "account" : "local";
  const others = status.accounts.filter((a) => a.userId !== status.userId);
  const lastSync = status.lastSyncAt ? new Date(status.lastSyncAt).getTime() : null;

  let state: string;
  let tone = "text-[var(--c-text-muted)]";
  if (!connected) {
    state = "Sans compte — les entités restent sur cet appareil";
  } else if (!status.unlocked) {
    state = "Compte verrouillé — mot de passe maître requis";
    tone = "text-[var(--c-warn)]";
  } else if (syncing) {
    state = "Synchronisation…";
  } else if (lastSync != null) {
    state = `Synchronisé ${formatRelativeTime(lastSync)}`;
  } else {
    state = "Pas encore synchronisé";
  }

  return (
    <div
      data-profile-bar=""
      className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-[var(--c-border)] px-3 py-1.5"
    >
      <span className="flex shrink-0 items-center text-[var(--c-text-muted)]">
        {value === "account" ? <IconVault size={13} /> : <IconMonitor size={13} />}
      </span>
      <select
        value={value}
        onChange={(e) => {
          const v = e.target.value;
          if (v === "local" || v === "account") onSwitch(v);
          else onSwitch({ userId: v });
        }}
        aria-label="Profil affiché"
        title="Quel workspace est affiché dans toute l'app"
        className="input h-6 min-w-0 flex-1 basis-32 py-0 text-[12px]"
      >
        <option value="local">Cet appareil (local)</option>
        {connected && <option value="account">{connected}</option>}
        {others.map((a) => (
          <option key={a.userId} value={a.userId}>{a.email} — se connecter…</option>
        ))}
      </select>
      {connected && status.unlocked && (
        <button
          type="button"
          onClick={onSyncNow}
          disabled={syncing}
          title="Synchroniser maintenant"
          aria-label="Synchroniser maintenant"
          className="btn btn-ghost btn-sm btn-icon"
        >
          <IconRefresh size={12} className={syncing ? "animate-spin" : ""} />
        </button>
      )}
      <button
        type="button"
        onClick={onOpenGuiVault}
        className={`basis-full truncate text-left text-[11px] hover:underline ${tone}`}
        title="Ouvrir le panneau GuiVault"
        data-profile-state=""
      >
        {state}
      </button>
    </div>
  );
}
