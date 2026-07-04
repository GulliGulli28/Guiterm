import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api, onTransferDone, onTransferError, onTransferProgress } from "../lib/api";
import type { AppPreferences } from "../lib/preferences";
import type { Entry, Host, PaneListed, PaneOpened, PaneSource, PaneState, Workspace } from "../lib/types";
import { IconFolder, IconEdit, IconTrash, IconShield, IconClose } from "./ui-icons";

type Side = "left" | "right";
type PanesState = Record<Side, PaneState>;
type SortKey = "name" | "modified" | "type" | "size";
type SortDir = "asc" | "desc";

interface TransferProgressState {
  id: string;
  fileName: string;
  bytesDone: number;
  bytesTotal: number;
  status: "active" | "done" | "error";
  error?: string;
}

type Action =
  | { type: "opening"; side: Side; source: PaneSource }
  | { type: "opened"; side: Side; result: PaneOpened }
  | { type: "failed"; side: Side; error: string }
  | { type: "listed"; side: Side; result: PaneListed };

function reducer(state: PanesState, action: Action): PanesState {
  const pane = state[action.side];
  switch (action.type) {
    case "opening":
      return { ...state, [action.side]: { source: action.source, status: "connecting", paneId: null, cwd: "", entries: [] } };
    case "opened":
      return { ...state, [action.side]: { ...pane, status: "open", paneId: action.result.paneId, cwd: action.result.cwd, entries: action.result.entries } };
    case "failed":
      return { ...state, [action.side]: { ...pane, status: "failed", error: action.error } };
    case "listed":
      return { ...state, [action.side]: { ...pane, cwd: action.result.cwd, entries: action.result.entries } };
  }
}

function fileExt(entry: Entry): string {
  if (entry.isDir) return "";
  const dot = entry.name.lastIndexOf(".");
  return dot > 0 ? entry.name.slice(dot + 1).toLowerCase() : "";
}

function fileTypeLabel(entry: Entry): string {
  if (entry.isDir) return "Dossier";
  const ext = fileExt(entry);
  return ext ? ext.toUpperCase() : "Fichier";
}

function formatSize(bytes: number, isDir: boolean): string {
  if (isDir) return "—";
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} Ko`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} Mo`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} Go`;
}

function formatDate(ts?: number): string {
  if (!ts) return "—";
  return new Date(ts * 1000).toLocaleString("fr-FR", {
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

function sortEntries(entries: Entry[], key: SortKey, dir: SortDir): Entry[] {
  const dirs = entries.filter((e) => e.isDir);
  const files = entries.filter((e) => !e.isDir);

  const cmp = (a: Entry, b: Entry): number => {
    let v = 0;
    switch (key) {
      case "name":     v = a.name.toLowerCase().localeCompare(b.name.toLowerCase()); break;
      case "modified": v = (a.modified ?? 0) - (b.modified ?? 0); break;
      case "type":     v = fileTypeLabel(a).localeCompare(fileTypeLabel(b)) || a.name.toLowerCase().localeCompare(b.name.toLowerCase()); break;
      case "size":     v = a.size - b.size; break;
    }
    return dir === "asc" ? v : -v;
  };

  return [...dirs.sort(cmp), ...files.sort(cmp)];
}

interface TransferTabProps {
  host: Host;
  workspace: Workspace;
  preferences?: AppPreferences;
  onError: (message: string) => void;
}

export function TransferTab({ host, workspace, preferences, onError }: TransferTabProps) {
  const [leftPercent, setLeftPercent] = useState(50);
  const dividerDragRef = useRef<{ startX: number; startPercent: number; containerWidth: number } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const leftPaneRef = useRef<HTMLDivElement>(null);
  const rightPaneRef = useRef<HTMLDivElement>(null);
  const [transfers, setTransfers] = useState<Record<string, TransferProgressState>>({});

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dividerDragRef.current) return;
      const { startX, startPercent, containerWidth } = dividerDragRef.current;
      const delta = e.clientX - startX;
      const pct = startPercent + (delta / containerWidth) * 100;
      setLeftPercent(Math.max(20, Math.min(80, pct)));
    };
    const onUp = () => {
      if (dividerDragRef.current) {
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        dividerDragRef.current = null;
      }
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  const onDividerDrag = useCallback((e: React.MouseEvent) => {
    const container = containerRef.current;
    if (!container) return;
    dividerDragRef.current = { startX: e.clientX, startPercent: leftPercent, containerWidth: container.clientWidth };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    e.preventDefault();
  }, [leftPercent]);

  const [state, dispatch] = useReducer(reducer, undefined, (): PanesState => ({
    left: { source: { kind: "local" }, status: "connecting", paneId: null, cwd: "", entries: [] },
    right: { source: { kind: "remote", hostId: host.id }, status: "connecting", paneId: null, cwd: "", entries: [] },
  }));
  const paneIds = useRef<Record<Side, string | null>>({ left: null, right: null });
  const stateRef = useRef(state);
  stateRef.current = state;

  const openPaneFor = async (side: Side, source: PaneSource) => {
    dispatch({ type: "opening", side, source });
    try {
      const result = await api.openPane(source);
      paneIds.current[side] = result.paneId;
      dispatch({ type: "opened", side, result });
    } catch (e) {
      dispatch({ type: "failed", side, error: String(e) });
    }
  };

  useEffect(() => {
    openPaneFor("left", { kind: "local" });
    openPaneFor("right", { kind: "remote", hostId: host.id });
    return () => {
      if (paneIds.current.left) api.closePane(paneIds.current.left).catch(() => {});
      if (paneIds.current.right) api.closePane(paneIds.current.right).catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const navigate = async (side: Side, path: string) => {
    const paneId = paneIds.current[side];
    if (!paneId) return;
    try {
      const result = await api.listPane(paneId, path);
      dispatch({ type: "listed", side, result });
    } catch (e) {
      onError(String(e));
    }
  };

  const changeSource = async (side: Side, source: PaneSource) => {
    const oldId = paneIds.current[side];
    if (oldId) api.closePane(oldId).catch(() => {});
    paneIds.current[side] = null;
    await openPaneFor(side, source);
  };

  const copy = async (side: Side, entry: Entry) => {
    const destSide: Side = side === "left" ? "right" : "left";
    const sourceId = paneIds.current[side];
    const destId = paneIds.current[destSide];
    if (!sourceId || !destId) return;
    try {
      const result = await api.copyEntry(sourceId, state[side].cwd, entry, destId, state[destSide].cwd);
      dispatch({ type: "listed", side: destSide, result });
    } catch (e) {
      onError(String(e));
    }
  };

  const mkdir = async (side: Side, name: string) => {
    const paneId = paneIds.current[side];
    if (!paneId) return;
    try {
      const result = await api.paneMkdir(paneId, state[side].cwd, name);
      dispatch({ type: "listed", side, result });
    } catch (e) { onError(String(e)); }
  };

  const rename = async (side: Side, oldName: string, newName: string) => {
    const paneId = paneIds.current[side];
    if (!paneId) return;
    try {
      const result = await api.paneRename(paneId, state[side].cwd, oldName, newName);
      dispatch({ type: "listed", side, result });
    } catch (e) { onError(String(e)); }
  };

  const remove = async (side: Side, entries: Entry[]) => {
    const paneId = paneIds.current[side];
    if (!paneId) return;
    try {
      let result: PaneListed | null = null;
      for (const entry of entries) {
        result = await api.paneRemove(paneId, state[side].cwd, entry);
      }
      if (result) dispatch({ type: "listed", side, result });
    } catch (e) { onError(String(e)); }
  };

  const chmod = async (side: Side, name: string, mode: number) => {
    const paneId = paneIds.current[side];
    if (!paneId) return;
    try {
      const result = await api.paneChmod(paneId, state[side].cwd, name, mode);
      dispatch({ type: "listed", side, result });
    } catch (e) { onError(String(e)); }
  };

  // ── OS drag-and-drop upload ──────────────────────────────────────────────
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    (async () => {
      const webview = getCurrentWebview();
      unlisten = await webview.onDragDropEvent(async (event) => {
        if (event.payload.type !== "drop") return;
        const { paths, position } = event.payload;
        if (!paths || paths.length === 0) return;

        // `position` is in physical pixels; DOM rects are in logical/CSS pixels — convert.
        const scaleFactor = await getCurrentWindow().scaleFactor();
        const logical = position.toLogical(scaleFactor);

        const targets: { side: Side; el: HTMLDivElement | null }[] = [
          { side: "left", el: leftPaneRef.current },
          { side: "right", el: rightPaneRef.current },
        ];
        for (const { side, el } of targets) {
          if (!el) continue;
          const rect = el.getBoundingClientRect();
          if (logical.x >= rect.left && logical.x <= rect.right && logical.y >= rect.top && logical.y <= rect.bottom) {
            const paneId = paneIds.current[side];
            const cwd = stateRef.current[side].cwd;
            if (!paneId) return;
            api.uploadPaths(paneId, cwd, paths)
              .then((ids) => {
                for (const id of ids) {
                  setTransfers((prev) => ({ ...prev, [id]: { id, fileName: "…", bytesDone: 0, bytesTotal: 0, status: "active" } }));
                }
              })
              .catch((e) => onError(String(e)));
            return;
          }
        }
      });
    })();
    return () => { unlisten?.(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Transfer progress events ─────────────────────────────────────────────
  useEffect(() => {
    let unlistenProgress: (() => void) | undefined;
    let unlistenDone: (() => void) | undefined;
    let unlistenError: (() => void) | undefined;
    (async () => {
      unlistenProgress = await onTransferProgress(({ transferId, bytesDone, bytesTotal }) => {
        setTransfers((prev) => (prev[transferId] ? { ...prev, [transferId]: { ...prev[transferId], bytesDone, bytesTotal } } : prev));
      });
      unlistenDone = await onTransferDone((transferId) => {
        setTransfers((prev) => (prev[transferId] ? { ...prev, [transferId]: { ...prev[transferId], status: "done" } } : prev));
        setTimeout(() => setTransfers((prev) => { const next = { ...prev }; delete next[transferId]; return next; }), 2500);
        // Refresh whichever pane the upload landed in (harmless if it wasn't this one).
        if (paneIds.current.left) api.listPane(paneIds.current.left, stateRef.current.left.cwd).then((result) => dispatch({ type: "listed", side: "left", result })).catch(() => {});
        if (paneIds.current.right) api.listPane(paneIds.current.right, stateRef.current.right.cwd).then((result) => dispatch({ type: "listed", side: "right", result })).catch(() => {});
      });
      unlistenError = await onTransferError((transferId, message) => {
        setTransfers((prev) => (prev[transferId] ? { ...prev, [transferId]: { ...prev[transferId], status: "error", error: message } } : prev));
        setTimeout(() => setTransfers((prev) => { const next = { ...prev }; delete next[transferId]; return next; }), 5000);
      });
    })();
    return () => { unlistenProgress?.(); unlistenDone?.(); unlistenError?.(); };
  }, []);

  const fontSize = preferences?.sftpFontSize ?? 13;
  const activeTransfers = Object.values(transfers);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div ref={containerRef} className="flex min-h-0 flex-1">
        <div ref={leftPaneRef} style={{ width: `${leftPercent}%` }} className="flex min-h-0 shrink-0 flex-col overflow-hidden">
          <PaneView side="left" pane={state.left} workspace={workspace} fontSize={fontSize} onNavigate={navigate} onSourceChange={changeSource} onCopy={copy} onMkdir={mkdir} onRename={rename} onRemove={remove} onChmod={chmod} />
        </div>
        <div
          onMouseDown={onDividerDrag}
          className="group relative flex w-1 shrink-0 cursor-col-resize items-center justify-center"
        >
          <div className="h-full w-px bg-[var(--c-border)] transition-colors group-hover:bg-[var(--c-accent)]" />
        </div>
        <div ref={rightPaneRef} className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <PaneView side="right" pane={state.right} workspace={workspace} fontSize={fontSize} onNavigate={navigate} onSourceChange={changeSource} onCopy={copy} onMkdir={mkdir} onRename={rename} onRemove={remove} onChmod={chmod} />
        </div>
      </div>

      {activeTransfers.length > 0 && (
        <div className="max-h-32 shrink-0 space-y-1 overflow-y-auto border-t border-[var(--c-border)] bg-[var(--c-bg2)] p-2">
          {activeTransfers.map((t) => {
            const pct = t.bytesTotal > 0 ? Math.round((t.bytesDone / t.bytesTotal) * 100) : t.status === "done" ? 100 : 0;
            return (
              <div key={t.id} className="flex items-center gap-2 text-xs">
                <span className="w-40 shrink-0 truncate text-[var(--c-text-secondary)]">
                  {t.status === "error" ? `Échec : ${t.error}` : t.status === "done" ? "Terminé" : "Envoi…"}
                </span>
                <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-[var(--c-bg3)]">
                  <div
                    className={`h-full rounded-full transition-all ${t.status === "error" ? "bg-rose-500" : t.status === "done" ? "bg-emerald-500" : "bg-[var(--c-accent)]"}`}
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <span className="w-9 shrink-0 text-right font-mono tabular-nums text-[var(--c-text-muted)]">{pct}%</span>
                {t.status === "active" && (
                  <button onClick={() => api.cancelTransfer(t.id)} className="shrink-0 text-[var(--c-text-muted)] hover:text-rose-300" title="Annuler">
                    <IconClose size={11} />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function parentPath(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  if (idx <= 0) return "/";
  return trimmed.slice(0, idx);
}

function joinPath(base: string, segment: string): string {
  return base.endsWith("/") ? `${base}${segment}` : `${base}/${segment}`;
}

interface PaneViewProps {
  side: Side;
  pane: PaneState;
  workspace: Workspace;
  fontSize: number;
  onNavigate: (side: Side, path: string) => void;
  onSourceChange: (side: Side, source: PaneSource) => void;
  onCopy: (side: Side, entry: Entry) => void;
  onMkdir: (side: Side, name: string) => void;
  onRename: (side: Side, oldName: string, newName: string) => void;
  onRemove: (side: Side, entries: Entry[]) => void;
  onChmod: (side: Side, name: string, mode: number) => void;
}

function ColHeader({
  label, colKey, sortKey, sortDir, onSort, className,
}: {
  label: string; colKey: SortKey; sortKey: SortKey; sortDir: SortDir;
  onSort: (k: SortKey) => void; className?: string;
}) {
  const active = colKey === sortKey;
  return (
    <button
      onClick={() => onSort(colKey)}
      className={`flex items-center gap-0.5 whitespace-nowrap text-left text-[11px] font-medium transition-colors hover:text-[var(--c-text)] ${active ? "text-[var(--c-accent-text)]" : "text-[var(--c-text-muted)]"} ${className ?? ""}`}
    >
      {label}
      <span className="text-[9px] opacity-80">{active ? (sortDir === "asc" ? " ▲" : " ▼") : ""}</span>
    </button>
  );
}

function PaneView({ side, pane, workspace, fontSize, onNavigate, onSourceChange, onCopy, onMkdir, onRename, onRemove, onChmod }: PaneViewProps) {
  const [gotoPath, setGotoPath] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [chmodTarget, setChmodTarget] = useState<string | null>(null);
  const [chmodValue, setChmodValue] = useState("755");
  const copyLabel = side === "left" ? "→" : "←";
  const isRemote = pane.source.kind === "remote";

  const handleSort = (key: SortKey) => {
    if (key === sortKey) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(key); setSortDir("asc"); }
  };

  const sorted = useMemo(() => sortEntries(pane.entries, sortKey, sortDir), [pane.entries, sortKey, sortDir]);

  useEffect(() => { setSelected(new Set()); }, [pane.cwd]);

  const sourceValue = pane.source.kind === "local" ? "local" : pane.source.hostId;

  const toggleSelect = (name: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const selectedEntries = sorted.filter((e) => selected.has(e.name));

  const submitNewFolder = () => {
    const name = newFolderName.trim();
    if (name) onMkdir(side, name);
    setNewFolderName("");
    setCreatingFolder(false);
  };

  const startRename = () => {
    if (selectedEntries.length !== 1) return;
    setRenaming(selectedEntries[0].name);
    setRenameValue(selectedEntries[0].name);
  };

  const submitRename = () => {
    if (!renaming) return;
    const value = renameValue.trim();
    if (value && value !== renaming) onRename(side, renaming, value);
    setRenaming(null);
  };

  const submitChmod = () => {
    if (!chmodTarget) return;
    const mode = parseInt(chmodValue, 8);
    if (Number.isInteger(mode) && mode >= 0 && mode <= 0o7777) onChmod(side, chmodTarget, mode);
    setChmodTarget(null);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Source selector */}
      <div className="flex items-center gap-2 border-b border-[var(--c-border)] p-2">
        <select
          value={sourceValue}
          onChange={(e) => {
            const v = e.target.value;
            onSourceChange(side, v === "local" ? { kind: "local" } : { kind: "remote", hostId: v });
          }}
          className="rounded-md bg-[var(--c-bg3)] px-2 py-1 text-sm text-[var(--c-text)] focus:outline-none focus:ring-1 focus:ring-[var(--c-accent-hover)]"
        >
          <option value="local">Local</option>
          {workspace.hosts.map((h) => (
            <option key={h.id} value={h.id}>{h.label}</option>
          ))}
        </select>
        {pane.status === "connecting" && <span className="text-xs text-[var(--c-text-muted)]">connexion…</span>}
      </div>

      {pane.status === "failed" && (
        <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-rose-300">
          Erreur : {pane.error}
        </div>
      )}

      {pane.status === "open" && (
        <>
          {/* Navigation bar */}
          <div className="flex items-center gap-2 border-b border-[var(--c-border)] px-2 py-1.5">
            <button
              onClick={() => onNavigate(side, parentPath(pane.cwd))}
              className="shrink-0 rounded px-2 py-0.5 text-sm text-[var(--c-text-secondary)] hover:bg-white/5 hover:text-[var(--c-text)]"
              title="Dossier parent"
            >
              ↑
            </button>
            <span className="min-w-0 flex-1 truncate font-mono text-xs text-[var(--c-text-secondary)]" title={pane.cwd}>
              {pane.cwd}
            </span>
            <div className="flex shrink-0 items-center gap-1">
              <input
                value={gotoPath}
                onChange={(e) => setGotoPath(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { onNavigate(side, gotoPath); setGotoPath(""); } }}
                placeholder="Aller à…"
                className="w-28 rounded-md bg-[var(--c-bg3)] px-2 py-0.5 font-mono text-xs text-[var(--c-text)] placeholder:font-sans placeholder:text-[var(--c-text-faint)] focus:outline-none focus:ring-1 focus:ring-[var(--c-accent-hover)]"
              />
              <button
                onClick={() => { onNavigate(side, gotoPath); setGotoPath(""); }}
                className="rounded-md bg-[var(--c-bg3)] px-2 py-0.5 text-xs text-[var(--c-text-secondary)] hover:bg-white/5 hover:text-[var(--c-text)]"
              >
                OK
              </button>
            </div>
          </div>

          {/* Action toolbar */}
          <div className="flex flex-wrap items-center gap-1 border-b border-[var(--c-border)] px-2 py-1">
            {creatingFolder ? (
              <div className="flex flex-1 items-center gap-1">
                <input
                  autoFocus
                  value={newFolderName}
                  onChange={(e) => setNewFolderName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") submitNewFolder(); if (e.key === "Escape") setCreatingFolder(false); }}
                  placeholder="Nom du dossier"
                  className="min-w-0 flex-1 rounded-md bg-[var(--c-bg3)] px-2 py-1 text-xs text-[var(--c-text)] placeholder:text-[var(--c-text-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--c-accent-hover)]"
                />
                <button onClick={submitNewFolder} className="rounded-md bg-[var(--c-accent)] px-2 py-1 text-xs text-white hover:bg-[var(--c-accent-hover)]">Créer</button>
                <button onClick={() => setCreatingFolder(false)} className="rounded-md bg-[var(--c-bg3)] px-2 py-1 text-xs text-[var(--c-text-secondary)] hover:bg-white/5">
                  <IconClose size={11} />
                </button>
              </div>
            ) : renaming ? (
              <div className="flex flex-1 items-center gap-1">
                <input
                  autoFocus
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") submitRename(); if (e.key === "Escape") setRenaming(null); }}
                  className="min-w-0 flex-1 rounded-md bg-[var(--c-bg3)] px-2 py-1 text-xs text-[var(--c-text)] focus:outline-none focus:ring-1 focus:ring-[var(--c-accent-hover)]"
                />
                <button onClick={submitRename} className="rounded-md bg-[var(--c-accent)] px-2 py-1 text-xs text-white hover:bg-[var(--c-accent-hover)]">Renommer</button>
                <button onClick={() => setRenaming(null)} className="rounded-md bg-[var(--c-bg3)] px-2 py-1 text-xs text-[var(--c-text-secondary)] hover:bg-white/5">
                  <IconClose size={11} />
                </button>
              </div>
            ) : chmodTarget ? (
              <div className="flex flex-1 items-center gap-1">
                <span className="shrink-0 truncate text-xs text-[var(--c-text-secondary)]">chmod {chmodTarget}</span>
                <input
                  autoFocus
                  value={chmodValue}
                  onChange={(e) => setChmodValue(e.target.value.replace(/[^0-7]/g, "").slice(0, 4))}
                  onKeyDown={(e) => { if (e.key === "Enter") submitChmod(); if (e.key === "Escape") setChmodTarget(null); }}
                  placeholder="755"
                  className="w-16 rounded-md bg-[var(--c-bg3)] px-2 py-1 font-mono text-xs text-[var(--c-text)] placeholder:text-[var(--c-text-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--c-accent-hover)]"
                />
                <button onClick={submitChmod} className="rounded-md bg-[var(--c-accent)] px-2 py-1 text-xs text-white hover:bg-[var(--c-accent-hover)]">Appliquer</button>
                <button onClick={() => setChmodTarget(null)} className="rounded-md bg-[var(--c-bg3)] px-2 py-1 text-xs text-[var(--c-text-secondary)] hover:bg-white/5">
                  <IconClose size={11} />
                </button>
              </div>
            ) : (
              <>
                <button
                  onClick={() => setCreatingFolder(true)}
                  title="Nouveau dossier"
                  className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-[var(--c-text-secondary)] hover:bg-white/5 hover:text-[var(--c-text)]"
                >
                  <IconFolder size={12} /> Nouveau dossier
                </button>
                {selectedEntries.length === 1 && (
                  <button
                    onClick={startRename}
                    title="Renommer"
                    className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-[var(--c-text-secondary)] hover:bg-white/5 hover:text-[var(--c-text)]"
                  >
                    <IconEdit size={12} /> Renommer
                  </button>
                )}
                {selectedEntries.length === 1 && isRemote && (
                  <button
                    onClick={() => { setChmodTarget(selectedEntries[0].name); setChmodValue(selectedEntries[0].permissions != null ? (selectedEntries[0].permissions & 0o777).toString(8) : "755"); }}
                    title="Permissions"
                    className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-[var(--c-text-secondary)] hover:bg-white/5 hover:text-[var(--c-text)]"
                  >
                    <IconShield size={12} /> Permissions
                  </button>
                )}
                {selectedEntries.length > 0 && (
                  confirmDelete ? (
                    <div className="flex items-center gap-1">
                      <span className="text-[11px] text-rose-300">Supprimer {selectedEntries.length} élément(s) ?</span>
                      <button
                        onClick={() => { onRemove(side, selectedEntries); setConfirmDelete(false); setSelected(new Set()); }}
                        className="rounded-md bg-rose-700 px-2 py-1 text-[11px] text-white hover:bg-rose-600"
                      >
                        Confirmer
                      </button>
                      <button onClick={() => setConfirmDelete(false)} className="rounded-md bg-[var(--c-bg3)] px-2 py-1 text-[11px] text-[var(--c-text-secondary)] hover:bg-white/5">
                        Annuler
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setConfirmDelete(true)}
                      title="Supprimer"
                      className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-rose-400 hover:bg-rose-900/40 hover:text-rose-300"
                    >
                      <IconTrash size={12} /> Supprimer ({selectedEntries.length})
                    </button>
                  )
                )}
              </>
            )}
          </div>

          {/* Column headers */}
          <div className="flex items-center gap-1 border-b border-[var(--c-border)] bg-[var(--c-bg3)]/60 px-2 py-1" style={{ fontSize: `${Math.max(10, fontSize - 2)}px` }}>
            <div className="w-4 shrink-0" />
            <ColHeader label="Nom"          colKey="name"     sortKey={sortKey} sortDir={sortDir} onSort={handleSort} className="flex-1" />
            <ColHeader label="Modifié"      colKey="modified" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} className="w-32 hidden sm:flex" />
            <ColHeader label="Type"         colKey="type"     sortKey={sortKey} sortDir={sortDir} onSort={handleSort} className="w-12" />
            <ColHeader label="Taille"       colKey="size"     sortKey={sortKey} sortDir={sortDir} onSort={handleSort} className="w-14 text-right justify-end" />
            <div className="w-6 shrink-0" />
          </div>

          {/* File list */}
          <div className="min-h-0 flex-1 overflow-y-auto" style={{ fontSize: `${fontSize}px` }}>
            {sorted.map((entry) => (
              <div
                key={entry.name}
                className={`group flex items-center gap-1 px-2 py-[3px] hover:bg-[var(--c-bg2)] ${selected.has(entry.name) ? "bg-[var(--c-accent-dim)]" : ""}`}
              >
                <input
                  type="checkbox"
                  checked={selected.has(entry.name)}
                  onClick={(e) => toggleSelect(entry.name, e)}
                  onChange={() => {}}
                  className="h-3.5 w-3.5 shrink-0 accent-[var(--c-accent)]"
                />
                {/* Name */}
                <button
                  onClick={() => entry.isDir && onNavigate(side, joinPath(pane.cwd, entry.name))}
                  className={`flex min-w-0 flex-1 items-center gap-1.5 truncate text-left ${
                    entry.isDir ? "font-medium text-[var(--c-accent-text)]" : "text-[var(--c-text)]"
                  } ${entry.isDir ? "cursor-pointer" : "cursor-default"}`}
                >
                  <span className="shrink-0 text-[13px]">{entry.isDir ? "📁" : "📄"}</span>
                  <span className="truncate">{entry.name}</span>
                </button>

                {/* Modified */}
                <span className="hidden w-32 shrink-0 text-[var(--c-text-muted)] tabular-nums sm:block">
                  {formatDate(entry.modified)}
                </span>

                {/* Type */}
                <span className="w-12 shrink-0 text-[var(--c-text-muted)]">{fileTypeLabel(entry)}</span>

                {/* Size */}
                <span className="w-14 shrink-0 text-right tabular-nums text-[var(--c-text-muted)]">
                  {formatSize(entry.size, entry.isDir)}
                </span>

                {/* Copy button */}
                <button
                  onClick={() => onCopy(side, entry)}
                  title={entry.isDir ? "Copier le dossier vers l'autre panneau" : "Copier vers l'autre panneau"}
                  className="w-6 shrink-0 rounded px-0.5 text-center text-[var(--c-text-faint)] opacity-0 hover:bg-[var(--c-accent)] hover:text-white focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"
                >
                  {copyLabel}
                </button>
              </div>
            ))}
            {pane.entries.length === 0 && (
              <p className="px-2 py-6 text-center text-xs text-[var(--c-text-muted)]">Dossier vide</p>
            )}
          </div>
        </>
      )}
    </div>
  );
}
