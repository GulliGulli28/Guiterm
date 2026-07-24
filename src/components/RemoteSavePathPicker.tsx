import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import type { Entry, Host, HostId } from "../lib/types";
import { ConnectionPickerModal } from "./ConnectionPickerModal";
import { IconFolder, IconChevronRight, IconDatabase } from "./ui-icons";

interface RemoteSavePathPickerProps {
  hosts: Host[];
  /** Skips the host-picker step and browses straight into this host's home
   * directory — used when a host was already chosen via the destination's
   * own dropdown before "Parcourir…" is clicked. */
  initialHostId?: string;
  defaultFileName: string;
  onCancel: () => void;
  onSelect: (hostId: HostId, path: string) => void;
}

function parentPath(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx <= 0 ? "/" : trimmed.slice(0, idx);
}

function joinPath(base: string, segment: string): string {
  return base.endsWith("/") ? `${base}${segment}` : `${base}/${segment}`;
}

/** Directory browser for picking *where to write* a new file on a saved
 * host's filesystem — same host-picker + `open_pane`/`list_pane`/`close_pane`
 * plumbing as `SqliteRemoteFilePicker`, but for a "save" rather than an
 * "open": clicking a directory navigates into it, clicking an existing file
 * fills the filename field (to confirm overwriting it) instead of
 * immediately closing the picker, and a dedicated filename input + "Enregistrer
 * ici" button finalize the choice as `joinPath(cwd, fileName)`. */
export function RemoteSavePathPicker({ hosts, initialHostId, defaultFileName, onCancel, onSelect }: RemoteSavePathPickerProps) {
  const [host, setHost] = useState<Host | null>(() => (initialHostId ? hosts.find((h) => h.id === initialHostId) ?? null : null));
  const [paneId, setPaneId] = useState<string | null>(null);
  const [cwd, setCwd] = useState("");
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fileName, setFileName] = useState(defaultFileName);

  const openHost = (id: string) => {
    const h = hosts.find((x) => x.id === id);
    if (!h) return;
    setHost(h);
    setEntries(null);
    setError(null);
    api.openPane({ kind: "remote", hostId: id })
      .then((res) => { setPaneId(res.paneId); setCwd(res.cwd); setEntries(res.entries); })
      .catch((e) => setError(String(e)));
  };

  // Skips straight to browsing when a host was already chosen — mount-only,
  // `host`'s own initial value already resolved `initialHostId` once.
  const openedInitialHost = useRef(false);
  useEffect(() => {
    if (host && !openedInitialHost.current) {
      openedInitialHost.current = true;
      openHost(host.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const navigate = (path: string) => {
    if (!paneId) return;
    setEntries(null);
    setError(null);
    api.listPane(paneId, path)
      .then((res) => { setCwd(res.cwd); setEntries(res.entries); })
      .catch((e) => setError(String(e)));
  };

  const changeHost = () => {
    if (paneId) api.closePane(paneId).catch(() => {});
    setHost(null);
    setPaneId(null);
    setEntries(null);
    setError(null);
  };

  const cancel = () => {
    if (paneId) api.closePane(paneId).catch(() => {});
    onCancel();
  };

  const confirm = () => {
    if (!host || !fileName.trim()) return;
    const path = joinPath(cwd, fileName.trim());
    if (paneId) api.closePane(paneId).catch(() => {});
    onSelect(host.id, path);
  };

  if (!host) {
    const sshHosts = hosts.filter((h) => (h.kind ?? "ssh") === "ssh");
    return (
      <ConnectionPickerModal
        title="Choisir un hôte enregistré"
        loading={false}
        items={sshHosts.map((h) => ({ id: h.id, name: h.label, meta: `${h.username}@${h.address}`, up: false }))}
        onPick={openHost}
        onClose={onCancel}
      />
    );
  }

  const sorted = (entries ?? []).slice().sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));

  return (
    <>
      <div className="fixed inset-0 z-30 bg-black/50" onClick={cancel} />
      <div className="fixed left-1/2 top-1/2 z-40 flex max-h-[80vh] w-[440px] max-w-[90vw] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-lg bg-[var(--c-bg2)] shadow-[var(--shadow-lg)]">
        <div className="border-b border-[var(--c-border)] px-4 py-3">
          <p className="text-[14px] font-medium text-[var(--c-text)]">Enregistrer sur « {host.label} »</p>
          <p className="mt-0.5 truncate font-mono text-[11px] text-[var(--c-text-muted)]">{cwd}</p>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {!entries && !error && (
            <div className="flex items-center gap-2 px-3 py-6 text-[12.5px] text-[var(--c-text-muted)]">
              <span className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-[var(--c-border)] border-t-[var(--c-accent)]" />
              Chargement…
            </div>
          )}
          {error && <p className="px-3 py-4 text-[12.5px] text-rose-300">{error}</p>}
          {entries && !error && (
            <>
              {cwd !== "/" && (
                <button onClick={() => navigate(parentPath(cwd))} className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left hover:bg-white/5">
                  <IconFolder size={14} className="shrink-0 text-[var(--c-text-faint)]" />
                  <span className="text-[12.5px] text-[var(--c-text-secondary)]">…</span>
                </button>
              )}
              {sorted.length === 0 && (
                <p className="px-3 py-4 text-[12.5px] text-[var(--c-text-muted)]">Dossier vide.</p>
              )}
              {sorted.map((entry) =>
                entry.isDir ? (
                  <button
                    key={entry.name}
                    onClick={() => navigate(joinPath(cwd, entry.name))}
                    className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left hover:bg-white/5"
                  >
                    <IconFolder size={14} className="shrink-0 text-[var(--c-text-faint)]" />
                    <span className="min-w-0 flex-1 truncate text-[12.5px] text-[var(--c-text)]">{entry.name}</span>
                    <IconChevronRight size={12} className="shrink-0 text-[var(--c-text-faint)]" />
                  </button>
                ) : (
                  <button
                    key={entry.name}
                    onClick={() => setFileName(entry.name)}
                    title="Cliquer pour reprendre ce nom de fichier (l'écraser à l'enregistrement)"
                    className={`flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left hover:bg-white/5 ${entry.name === fileName ? "bg-[var(--c-accent-dim)]" : ""}`}
                  >
                    <IconDatabase size={14} className="shrink-0 text-[var(--c-text-faint)]" />
                    <span className="min-w-0 flex-1 truncate text-[12.5px] text-[var(--c-text)]">{entry.name}</span>
                  </button>
                ),
              )}
            </>
          )}
        </div>
        <div className="space-y-2 border-t border-[var(--c-border)] p-2">
          <div className="flex gap-1.5">
            <input
              value={fileName}
              onChange={(e) => setFileName(e.target.value)}
              placeholder="nom_du_fichier.sql"
              className="min-w-0 flex-1 rounded-md bg-[var(--c-bg3)] px-2.5 py-1.5 font-mono text-xs text-[var(--c-text)] placeholder:text-[var(--c-text-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--c-accent-hover)]"
            />
            <button
              onClick={confirm}
              disabled={!fileName.trim()}
              className="accent-surface shrink-0 rounded-md border px-3 py-1.5 text-xs font-medium disabled:opacity-50"
            >
              Enregistrer ici
            </button>
          </div>
          <div className="flex gap-2">
            <button onClick={changeHost} className="flex-1 rounded-md bg-[var(--c-bg3)] py-1.5 text-center text-[12px] text-[var(--c-text-secondary)] hover:bg-white/5">
              Changer d'hôte
            </button>
            <button onClick={cancel} className="flex-1 rounded-md bg-[var(--c-bg3)] py-1.5 text-center text-[12px] text-[var(--c-text-secondary)] hover:bg-white/5">
              Annuler
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
