import { useState } from "react";
import type { AppNotification } from "../lib/notifications";
import { formatRelativeTime } from "../lib/format";
import { IconBell, IconClose } from "./ui-icons";

interface NotificationBellProps {
  notifications: AppNotification[];
  onDismiss: (id: string) => void;
  onClearAll: () => void;
  onMarkAllRead: () => void;
}

const KIND_DOT: Record<AppNotification["kind"], string> = {
  info: "bg-sky-400",
  success: "bg-emerald-400",
  error: "bg-rose-400",
};

export function NotificationBell({ notifications, onDismiss, onClearAll, onMarkAllRead }: NotificationBellProps) {
  const [open, setOpen] = useState(false);
  const unreadCount = notifications.filter((n) => !n.read).length;

  return (
    <div className="relative flex items-center">
      <button
        onClick={() => { setOpen((v) => !v); if (!open) onMarkAllRead(); }}
        title="Notifications"
        className={`btn btn-ghost btn-sm btn-icon relative text-[var(--c-text-muted)] ${open ? "bg-[var(--c-hover)] text-[var(--c-text)]" : ""}`}
      >
        <IconBell size={14} />
        {unreadCount > 0 && (
          <span className="absolute right-0 top-0 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-[var(--c-danger)] px-0.5 text-[9px] font-semibold leading-none text-white">
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        )}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="popover absolute left-0 top-full z-20 mt-1 w-80 overflow-hidden">
            <div className="flex items-center justify-between border-b border-[var(--c-border)] px-3 py-2">
              <span className="eyebrow">Notifications</span>
              {notifications.length > 0 && (
                <button onClick={onClearAll} className="btn btn-ghost btn-sm">Tout effacer</button>
              )}
            </div>
            <div className="sidebar-scroll max-h-80 overflow-y-auto">
              {notifications.length === 0 ? (
                <p className="px-3 py-6 text-center text-[12.5px] text-[var(--c-text-muted)]">Aucune notification</p>
              ) : (
                notifications.slice().reverse().map((n) => (
                  <div key={n.id} className="group flex items-start gap-2 border-b border-[var(--c-border)] px-3 py-2 last:border-b-0 hover:bg-[var(--c-hover)]">
                    <span className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${KIND_DOT[n.kind]}`} />
                    <div className="min-w-0 flex-1">
                      <p className="text-[12px] leading-snug text-[var(--c-text)]">{n.message}</p>
                      <p className="mt-0.5 text-[10.5px] text-[var(--c-text-muted)]">{formatRelativeTime(n.timestamp)}</p>
                    </div>
                    <button
                      onClick={() => onDismiss(n.id)}
                      className="flex shrink-0 items-center rounded p-0.5 text-[var(--c-text-muted)] opacity-0 transition-opacity hover:text-[var(--c-text-secondary)] focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"
                      aria-label="Effacer"
                    >
                      <IconClose size={10} />
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
