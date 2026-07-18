import { useCallback, useState } from "react";
import { type AppNotification, type NotificationKind, createNotification } from "../lib/notifications";

/** Notification bell state + a persistent status banner, extracted from
 * `App.tsx`'s own state — isolated because none of it reads any other
 * App-level state (unlike e.g. tab management, which is coupled to
 * `preferences`/`workspace`). */
export function useNotifications() {
  const [status, setStatus] = useState<string | null>(null);
  const [notifications, setNotifications] = useState<AppNotification[]>([]);

  const pushNotification = useCallback((kind: NotificationKind, message: string) => {
    setNotifications((prev) => [...prev, createNotification(kind, message)]);
  }, []);

  const reportError = useCallback((message: string) => {
    setStatus(message);
    pushNotification("error", message);
  }, [pushNotification]);

  const clearStatus = useCallback(() => setStatus(null), []);

  const dismissNotification = useCallback((id: string) => {
    setNotifications((prev) => prev.filter((n) => n.id !== id));
  }, []);

  const clearAllNotifications = useCallback(() => setNotifications([]), []);

  const markAllNotificationsRead = useCallback(() => {
    setNotifications((prev) => prev.map((n) => (n.read ? n : { ...n, read: true })));
  }, []);

  return {
    status,
    notifications,
    pushNotification,
    reportError,
    clearStatus,
    dismissNotification,
    clearAllNotifications,
    markAllNotificationsRead,
  };
}
