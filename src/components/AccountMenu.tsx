import { useEffect, useRef, useState } from "react";
import { ProfileBar, type ProfileBarProps } from "./ProfileBar";
import { IconMonitor } from "./ui-icons";

/** Les deux lettres d'un compte, tirées de son adresse : « alice@… » → « AL ». */
export function accountInitials(email: string): string {
  const local = email.split("@")[0].replace(/[^\p{L}\p{N}]/gu, "");
  return local.slice(0, 2).toUpperCase() || "?";
}

/**
 * Le compte, en bas du rail : un avatar qui dit d'un coup d'œil quel
 * workspace est affiché (les initiales du compte, ou un écran pour cet
 * appareil) et l'état de la synchro (la pastille), et qui ouvre le
 * sélecteur de profil.
 *
 * C'est la barre de profil d'avant (`ProfileBar`), qui occupait le haut de
 * chaque panneau : un état global de l'app, mais lu à chaque coup d'œil sur la
 * liste d'hôtes, pour une information qui change rarement. Elle est rendue
 * telle quelle dans le menu — même sélecteur, mêmes points d'accroche
 * (`data-profile-bar`, `data-profile-state`).
 */
export function AccountMenu(props: ProfileBarProps) {
  const { status, syncing } = props;
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const email = status.configured ? status.email : null;
  const showingAccount = !!email && !status.viewLocal;
  // La pastille ne parle que du compte : sans compte connecté, rien à
  // synchroniser, donc rien à signaler.
  const dot = !email ? null : !status.unlocked ? "var(--c-warn)" : syncing ? "var(--c-accent)" : "var(--c-ok)";
  const state = !email
    ? "Cet appareil — sans compte connecté"
    : !status.unlocked
      ? `${email} — verrouillé`
      : `${showingAccount ? email : "Cet appareil"}${syncing ? " — synchronisation…" : ""}`;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={`Compte et profil affiché : ${state}`}
        title={state}
        aria-expanded={open}
        data-account-menu=""
        className={`relative flex h-9 w-9 items-center justify-center rounded-full text-[12px] font-semibold transition-colors ${
          showingAccount
            ? "bg-[var(--c-accent-dim)] text-[var(--c-accent-text)] hover:brightness-125"
            : "border border-[var(--c-border)] text-[var(--c-text-muted)] hover:bg-[var(--c-hover)] hover:text-[var(--c-text)]"
        }`}
      >
        {showingAccount ? accountInitials(email) : <IconMonitor size={15} />}
        {dot && (
          <span
            className={`absolute -bottom-px -right-px h-2.5 w-2.5 rounded-full ring-2 ring-[var(--c-bg)] ${syncing ? "animate-pulse" : ""}`}
            style={{ background: dot }}
          />
        )}
      </button>
      {open && (
        <div className="popover absolute bottom-0 left-full z-30 ml-2 w-80 overflow-hidden">
          <div className="px-3 pb-2 pt-3">
            <p className="truncate text-[13px] font-semibold text-[var(--c-text)]">{email ?? "Cet appareil"}</p>
            {status.serverUrl && <p className="truncate font-mono text-[11.5px] text-[var(--c-text-muted)]">{status.serverUrl.replace(/^https?:\/\//, "")}</p>}
          </div>
          <ProfileBar
            {...props}
            onSwitch={(target) => {
              props.onSwitch(target);
              if (typeof target === "object") setOpen(false);
            }}
            onOpenGuiVault={() => {
              setOpen(false);
              props.onOpenGuiVault();
            }}
          />
        </div>
      )}
    </div>
  );
}
