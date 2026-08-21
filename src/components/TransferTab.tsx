import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api, onTransferDone, onTransferError, onTransferProgress } from "../lib/api";
import type { AppPreferences } from "../lib/preferences";
import type { ArchiveFormat, Entry, Host, PaneFindOutcome, PaneListed, PaneOpened, PaneSource, PaneState, RemoteEditListed, Workspace } from "../lib/types";
import { IconFolder, IconEdit, IconExternal, IconTrash, IconShield, IconClose, IconSearch } from "./ui-icons";
import { QuickEditModal } from "./QuickEditModal";
import { RdpTab } from "./RdpTab";
import { useResizablePane } from "../hooks/useResizablePane";
import { useContainerPicker } from "../hooks/useContainerPicker";
import { baseName, breadcrumbs, containingDir, joinPath, parentPath } from "../lib/panePath";
import { usePaneDrag } from "../hooks/usePaneDrag";
import type { PaneDropTarget, PaneSide } from "../hooks/usePaneDrag";

type Side = PaneSide;
type PanesState = Record<Side, PaneState>;

const otherSide = (side: Side): Side => (side === "left" ? "right" : "left");

// Files above this size don't get a quick-edit button — they'd be unwieldy
// in a plain textarea and this isn't meant to replace a real editor.
const QUICK_EDIT_MAX_SIZE = 512 * 1024;

interface EditingFile {
  side: Side;
  name: string;
  content: string;
  loading: boolean;
  saving: boolean;
  error: string | null;
}
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

function formatSize(bytes: number): string {
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

function sortEntries(entries: Entry[], key: SortKey, dir: SortDir, sizeOf: (entry: Entry) => number): Entry[] {
  const dirs = entries.filter((e) => e.isDir);
  const files = entries.filter((e) => !e.isDir);

  const cmp = (a: Entry, b: Entry): number => {
    let v = 0;
    switch (key) {
      case "name":     v = a.name.toLowerCase().localeCompare(b.name.toLowerCase()); break;
      case "modified": v = (a.modified ?? 0) - (b.modified ?? 0); break;
      case "type":     v = fileTypeLabel(a).localeCompare(fileTypeLabel(b)) || a.name.toLowerCase().localeCompare(b.name.toLowerCase()); break;
      case "size":     v = sizeOf(a) - sizeOf(b); break;
    }
    return dir === "asc" ? v : -v;
  };

  return [...dirs.sort(cmp), ...files.sort(cmp)];
}

interface TransferTabProps {
  host: Host;
  workspace: Workspace;
  preferences?: AppPreferences;
  /** Pour la bascule « fichiers cachés », qui se retient d'une session à
   * l'autre plutôt que d'être à recliquer à chaque onglet ouvert. */
  onPreferencesChange?: (next: AppPreferences) => void;
  onError: (message: string) => void;
  /** Fires after a successful `pushToRdp` — the RDP clipboard push has no
   * other visible effect (nothing lands in either file pane), so without
   * this the action looks like a no-op even when it worked. */
  onPushed?: (message: string) => void;
  /** Set when opened on a Docker exec host (a container already picked —
   * see `SftpPanel.tsx`'s `openDockerPicker`) rather than an SSH one. */
  dockerContainerId?: string;
  /** Set when opened on a K8s exec host (a pod/container already picked —
   * see `SftpPanel.tsx`'s `openK8sPicker`) rather than an SSH one. Mutually
   * exclusive with `dockerContainerId`. */
  k8sPodName?: string;
  k8sContainerName?: string | null;
}

export function TransferTab({ host, workspace, preferences, onPreferencesChange, onError, onPushed, dockerContainerId, k8sPodName, k8sContainerName }: TransferTabProps) {
  // RDP hosts have no file-listing backend at all — the right panel is the
  // live embedded view itself (`RdpTab`) instead of a browsable pane, and
  // dropping entries from the left panel onto it pushes them onto the
  // remote session's clipboard (see `pushToRdp` below) rather than copying
  // them anywhere. See `HostsPanel.tsx`'s "Transférer des fichiers" action
  // for the entry point into this mode.
  const isRdpTarget = (host.kind ?? "ssh") === "rdp";
  const rdpSessionIdRef = useRef<string | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const leftPaneRef = useRef<HTMLDivElement>(null);
  const rightPaneRef = useRef<HTMLDivElement>(null);
  const [transfers, setTransfers] = useState<Record<string, TransferProgressState>>({});

  const divider = useResizablePane({ initial: 50, min: 20, max: 80, axis: "horizontal", mode: "percent", containerRef });

  const initialRightSource: PaneSource = dockerContainerId
    ? { kind: "docker", hostId: host.id, containerId: dockerContainerId }
    : k8sPodName
      ? { kind: "k8s", hostId: host.id, podName: k8sPodName, containerName: k8sContainerName ?? null }
      : { kind: "remote", hostId: host.id };

  const [state, dispatch] = useReducer(reducer, undefined, (): PanesState => ({
    left: { source: { kind: "local" }, status: "connecting", paneId: null, cwd: "", entries: [] },
    right: { source: initialRightSource, status: "connecting", paneId: null, cwd: "", entries: [] },
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
    // The right side is a live `RdpTab`, not a pane, for an RDP host —
    // nothing to open there (see `isRdpTarget`'s doc comment above).
    if (!isRdpTarget) openPaneFor("right", initialRightSource);
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

  /** Copie `entries` du panneau `side` vers `destCwd` sur `destSide`. La
   * destination est explicite (et non « l'autre panneau, dans son dossier
   * courant ») pour le glisser-déposer, qui peut viser un sous-dossier
   * précis du listing d'en face. */
  const copyTo = async (side: Side, entries: Entry[], destSide: Side, destCwd: string) => {
    const sourceId = paneIds.current[side];
    const destId = paneIds.current[destSide];
    if (!sourceId || !destId || entries.length === 0) return;
    try {
      let result: PaneListed | null = null;
      for (const entry of entries) {
        result = await api.copyEntry(sourceId, stateRef.current[side].cwd, entry, destId, destCwd);
      }
      // `copyEntry` rend le listing du dossier de destination : c'est le bon
      // quand on a déposé dans le dossier courant, mais pas quand on a déposé
      // dans un sous-dossier — le panneau ne doit pas y descendre tout seul.
      if (destCwd === stateRef.current[destSide].cwd) {
        if (result) dispatch({ type: "listed", side: destSide, result });
      } else {
        const refreshed = await api.listPane(destId, stateRef.current[destSide].cwd);
        dispatch({ type: "listed", side: destSide, result: refreshed });
      }
    } catch (e) {
      onError(String(e));
    }
  };

  const copy = (side: Side, entries: Entry[]) =>
    copyTo(side, entries, otherSide(side), state[otherSide(side)].cwd);

  // Makes `entries` (files and/or whole folders, from any pane kind — a
  // remote source is downloaded to a temp file server-side first, see
  // `resolve_local_path` in `core::transfer`) available on the RDP
  // session's clipboard — the sidecar then simulates a Ctrl+V itself right
  // after (see `paste_key_sequence` in `rdp-sidecar/src/main.rs`), so this
  // pastes automatically rather than requiring the user to press Ctrl+V —
  // wherever the remote desktop's focus happens to be, same caveat as
  // `RdpTab.tsx`'s `runCommand`. There's no way to drop at a specific
  // remote location the way a normal pane-to-pane copy lands in a chosen
  // folder.
  const pushToRdp = async (sourceSide: Side, entries: Entry[]) => {
    const sessionId = rdpSessionIdRef.current;
    const sourceId = paneIds.current[sourceSide];
    if (!sessionId) { onError("Session RDP non connectée — impossible de pousser des fichiers pour l'instant."); return; }
    if (!sourceId || entries.length === 0) return;
    try {
      await api.pushRdpViewClipboardEntries(sessionId, sourceId, state[sourceSide].cwd, entries);
      onPushed?.(
        entries.length === 1
          ? `« ${entries[0].name} » envoyé et collé dans la session RDP (fenêtre ayant le focus côté distant).`
          : `${entries.length} éléments envoyés et collés dans la session RDP (fenêtre ayant le focus côté distant).`,
      );
    } catch (e) {
      onError(String(e));
    }
  };

  // Left pane's "Copy"/arrow action, redirected to `pushToRdp` for an RDP
  // target: the generic `copy` below needs a destination pane id, but the
  // right side is never opened as a pane in RDP mode (see `isRdpTarget`'s
  // doc comment) — calling it there used to silently no-op (`destId` stays
  // null) instead of doing anything, which read as "it copied fine" with no
  // actual effect.
  const copyOrPushToRdp = (side: Side, entries: Entry[]) => {
    if (isRdpTarget && side === "left") pushToRdp("left", entries);
    else copy(side, entries);
  };

  // ── Glisser-déposer interne, à la souris ─────────────────────────────────
  // Toute la mécanique du geste est dans `usePaneDrag` (voir son commentaire
  // pour pourquoi ce n'est pas l'API HTML5) ; ici, seulement ce qu'un dépôt
  // veut dire dans un onglet de transfert.
  const { drag, begin: beginDrag, justDraggedRef: draggedRef } = usePaneDrag({
    paneRefs: { left: leftPaneRef, right: rightPaneRef },
    onDrop: (source, entries, target) => {
      if (isRdpTarget && target.side === "right") { pushToRdp(source, entries); return; }
      const destCwd = target.dir
        ? joinPath(stateRef.current[target.side].cwd, target.dir)
        : stateRef.current[target.side].cwd;
      copyTo(source, entries, target.side, destCwd);
    },
  });

  const mkdir = async (side: Side, name: string) => {
    const paneId = paneIds.current[side];
    if (!paneId) return;
    try {
      const result = await api.paneMkdir(paneId, state[side].cwd, name);
      dispatch({ type: "listed", side, result });
    } catch (e) { onError(String(e)); }
  };

  const createFile = async (side: Side, name: string) => {
    const paneId = paneIds.current[side];
    if (!paneId) return;
    try {
      await api.writePaneFile(paneId, state[side].cwd, name, "");
      const result = await api.listPane(paneId, state[side].cwd);
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
      const result = await api.paneRemove(paneId, state[side].cwd, entries);
      dispatch({ type: "listed", side, result });
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

  /** Taille récursive d'un dossier, calculée là où il vit. Rejette plutôt que
   * de rendre 0 : le panneau distingue « pas encore calculé » de « n'a pas
   * pu l'être ». */
  const dirSize = (side: Side, path: string): Promise<number> => {
    const paneId = paneIds.current[side];
    if (!paneId) return Promise.reject(new Error("Panneau non ouvert."));
    return api.paneDirSize(paneId, path);
  };

  const findIn = (side: Side, root: string, pattern: string): Promise<PaneFindOutcome> => {
    const paneId = paneIds.current[side];
    if (!paneId) return Promise.reject(new Error("Panneau non ouvert."));
    return api.paneFind(paneId, root, pattern);
  };

  const archive = async (side: Side, names: string[], archiveName: string, format: ArchiveFormat) => {
    const paneId = paneIds.current[side];
    if (!paneId) return;
    try {
      const result = await api.paneArchive(paneId, state[side].cwd, names, archiveName, format);
      dispatch({ type: "listed", side, result });
      onPushed?.(`Archive créée dans ${state[side].cwd}.`);
    } catch (e) { onError(String(e)); }
  };

  const extract = async (side: Side, name: string, destName: string) => {
    const paneId = paneIds.current[side];
    if (!paneId) return;
    try {
      const result = await api.paneExtract(paneId, state[side].cwd, name, destName || undefined);
      dispatch({ type: "listed", side, result });
      onPushed?.(destName ? `« ${name} » extraite dans ${destName}.` : `« ${name} » extraite dans ${state[side].cwd}.`);
    } catch (e) { onError(String(e)); }
  };

  // ── Quick-edit a small text file in place ────────────────────────────────
  const [editing, setEditing] = useState<EditingFile | null>(null);

  const openEdit = async (side: Side, name: string) => {
    const paneId = paneIds.current[side];
    if (!paneId) return;
    setEditing({ side, name, content: "", loading: true, saving: false, error: null });
    try {
      const content = await api.readPaneFile(paneId, state[side].cwd, name);
      setEditing((prev) => (prev && prev.name === name ? { ...prev, content, loading: false } : prev));
    } catch (e) {
      setEditing((prev) => (prev && prev.name === name ? { ...prev, loading: false, error: String(e) } : prev));
    }
  };

  // ── Edit in the user's own editor (any size, unlike quick-edit) ──────────
  // The list is global to the app rather than to this tab (the sessions live
  // in `AppState`), so it's re-read on focus: another transfer tab may have
  // opened or ended one, and `App.tsx` pushes edits back on that same event.
  const [remoteEdits, setRemoteEdits] = useState<RemoteEditListed[]>([]);
  const refreshRemoteEdits = () => { api.listRemoteEdits().then(setRemoteEdits).catch(() => {}); };

  useEffect(() => {
    refreshRemoteEdits();
    const onFocus = () => refreshRemoteEdits();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  const openInEditor = async (side: Side, name: string) => {
    const paneId = paneIds.current[side];
    if (!paneId) return;
    try {
      // `null` means a local pane: the real file was opened directly, there
      // is no copy to track.
      const edit = await api.openRemoteFileInEditor(paneId, state[side].cwd, name);
      if (edit) setRemoteEdits((prev) => [...prev.filter((e) => e.id !== edit.id), edit]);
    } catch (e) { onError(String(e)); }
  };

  const endRemoteEdit = async (id: string) => {
    try {
      const outcome = await api.endRemoteEdit(id);
      setRemoteEdits((prev) => prev.filter((e) => e.id !== id));
      onPushed?.(outcome === "pushed" ? "Modifications renvoyées sur l'hôte." : "Édition terminée — rien n'avait changé.");
    } catch (e) {
      // The edit is deliberately kept on failure, so the local copy — and
      // whatever was typed into it — survives a conflict.
      onError(String(e));
      refreshRemoteEdits();
    }
  };

  const discardRemoteEdit = async (id: string) => {
    try {
      await api.discardRemoteEdit(id);
      setRemoteEdits((prev) => prev.filter((e) => e.id !== id));
    } catch (e) { onError(String(e)); }
  };

  const saveEdit = async (content: string) => {
    if (!editing) return;
    const paneId = paneIds.current[editing.side];
    if (!paneId) return;
    setEditing((prev) => (prev ? { ...prev, saving: true, error: null } : prev));
    try {
      await api.writePaneFile(paneId, state[editing.side].cwd, editing.name, content);
      setEditing(null);
    } catch (e) {
      setEditing((prev) => (prev ? { ...prev, saving: false, error: String(e) } : prev));
    }
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
            // Dropped straight from the OS (Explorer) onto the RDP view —
            // there's no pane to upload into on that side (see `isRdpTarget`'s
            // doc comment), push the raw local paths onto the remote
            // clipboard instead, same as a manual drag from the left pane.
            if (isRdpTarget && side === "right") {
              const sessionId = rdpSessionIdRef.current;
              if (!sessionId) { onError("Session RDP non connectée — impossible de pousser des fichiers pour l'instant."); return; }
              api.pushRdpViewClipboardPaths(sessionId, paths)
                .then(() => {
                  onPushed?.(
                    paths.length === 1
                      ? `« ${paths[0].split(/[\\/]/).pop()} » envoyé et collé dans la session RDP (fenêtre ayant le focus côté distant).`
                      : `${paths.length} éléments envoyés et collés dans la session RDP (fenêtre ayant le focus côté distant).`,
                  );
                })
                .catch((e) => onError(String(e)));
              return;
            }
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

  const paneProps = (side: Side) => ({
    side,
    pane: state[side],
    workspace,
    fontSize,
    onNavigate: navigate,
    onSourceChange: changeSource,
    onMkdir: mkdir,
    onCreateFile: createFile,
    onRename: rename,
    onRemove: remove,
    onChmod: chmod,
    onEdit: openEdit,
    onOpenInEditor: openInEditor,
    onDirSize: dirSize,
    onFind: findIn,
    onArchive: archive,
    onExtract: extract,
    showHidden: preferences?.sftpShowHidden ?? true,
    onToggleHidden: onPreferencesChange && preferences
      ? () => onPreferencesChange({ ...preferences, sftpShowHidden: !(preferences.sftpShowHidden ?? true) })
      : undefined,
    onDragStart: beginDrag,
    justDraggedRef: draggedRef,
    dragging: drag !== null,
    dropTarget: drag && drag.target?.side === side ? drag.target : null,
  });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div ref={containerRef} className="flex min-h-0 flex-1">
        <div ref={leftPaneRef} style={{ width: `${divider.value}%` }} className="flex min-h-0 shrink-0 flex-col overflow-hidden">
          <PaneView {...paneProps("left")} onCopy={copyOrPushToRdp} isRdpPush={isRdpTarget} />
        </div>
        <div
          onMouseDown={divider.onMouseDown}
          className="group relative flex w-1 shrink-0 cursor-col-resize items-center justify-center"
        >
          <div className="h-full w-px bg-[var(--c-border)] transition-colors group-hover:bg-[var(--c-accent)]" />
        </div>
        <div ref={rightPaneRef} className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {isRdpTarget ? (
            <div className={`flex min-h-0 flex-1 flex-col ${drag && drag.target?.side === "right" ? "ring-2 ring-inset ring-[var(--c-accent)]" : ""}`}>
              <RdpTab host={host} isActive={true} preferences={preferences} onSessionId={(id) => { rdpSessionIdRef.current = id; }} />
            </div>
          ) : (
            <PaneView {...paneProps("right")} onCopy={copy} />
          )}
        </div>
      </div>

      {/* Vignette qui suit le curseur pendant un glisser interne. */}
      {drag && (
        <div
          className="pointer-events-none fixed z-50 rounded-md border border-[var(--c-accent)] bg-[var(--c-bg2)] px-2 py-1 text-xs text-[var(--c-text)] shadow-lg"
          style={{ left: drag.x + 14, top: drag.y + 14 }}
        >
          {drag.entries.length === 1 ? drag.entries[0].name : `${drag.entries.length} éléments`}
          {drag.target && (
            <span className="ml-1 text-[var(--c-text-muted)]">
              → {drag.target.dir ?? (drag.target.side === "left" ? "panneau gauche" : isRdpTarget ? "session RDP" : "panneau droit")}
            </span>
          )}
        </div>
      )}

      {remoteEdits.length > 0 && (
        <div className="max-h-32 shrink-0 space-y-1 overflow-y-auto border-t border-[var(--c-border)] bg-[var(--c-bg2)] p-2">
          <p className="px-1 text-[10px] uppercase tracking-wide text-[var(--c-text-faint)]">
            Ouverts dans votre éditeur — renvoyés à chaque retour dans l'app
          </p>
          {remoteEdits.map((edit) => (
            <div key={edit.id} className="flex items-center gap-2 rounded-md px-1 py-0.5 text-xs">
              <IconExternal size={11} className="shrink-0 text-[var(--c-text-faint)]" />
              <span className="min-w-0 flex-1 truncate font-mono text-[var(--c-text-secondary)]" title={edit.remotePath}>
                {edit.remotePath}
              </span>
              <button
                onClick={() => endRemoteEdit(edit.id)}
                title="Renvoyer les modifications puis fermer l'édition"
                className="shrink-0 rounded px-2 py-0.5 text-[11px] text-[var(--c-accent-text)] hover:bg-white/10"
              >
                Terminer
              </button>
              <button
                onClick={() => discardRemoteEdit(edit.id)}
                title="Fermer sans renvoyer — les modifications locales sont perdues"
                className="shrink-0 rounded px-2 py-0.5 text-[11px] text-[var(--c-text-muted)] hover:bg-white/10 hover:text-rose-400"
              >
                Abandonner
              </button>
            </div>
          ))}
        </div>
      )}

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
                  <button aria-label="Retirer de la liste" onClick={() => api.cancelTransfer(t.id)} className="shrink-0 text-[var(--c-text-muted)] hover:text-rose-300" title="Annuler">
                    <IconClose size={11} />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {editing && (
        <QuickEditModal
          fileName={editing.name}
          content={editing.content}
          loading={editing.loading}
          saving={editing.saving}
          error={editing.error}
          onSave={saveEdit}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

interface PaneViewProps {
  side: Side;
  pane: PaneState;
  workspace: Workspace;
  fontSize: number;
  onNavigate: (side: Side, path: string) => void;
  onSourceChange: (side: Side, source: PaneSource) => void;
  onCopy: (side: Side, entries: Entry[]) => void;
  onMkdir: (side: Side, name: string) => void;
  onCreateFile: (side: Side, name: string) => void;
  onRename: (side: Side, oldName: string, newName: string) => void;
  onRemove: (side: Side, entries: Entry[]) => void;
  onChmod: (side: Side, name: string, mode: number) => void;
  onEdit: (side: Side, name: string) => void;
  onOpenInEditor: (side: Side, name: string) => void;
  onDirSize: (side: Side, path: string) => Promise<number>;
  onFind: (side: Side, root: string, pattern: string) => Promise<PaneFindOutcome>;
  onArchive: (side: Side, names: string[], archiveName: string, format: ArchiveFormat) => void;
  onExtract: (side: Side, name: string, destName: string) => void;
  showHidden: boolean;
  /** Absent quand le panneau n'a pas de quoi enregistrer la préférence — la
   * bascule n'est alors pas affichée plutôt que d'être sans effet. */
  onToggleHidden?: () => void;
  onDragStart: (side: Side, entries: Entry[], event: React.MouseEvent) => void;
  justDraggedRef: React.MutableRefObject<boolean>;
  dragging: boolean;
  dropTarget: PaneDropTarget | null;
  /** True for the left pane when the other side is a live RDP view — the
   * "copy" action pushes to the remote clipboard instead of a file pane, so
   * the button labels say so instead of implying a normal file copy. */
  isRdpPush?: boolean;
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
      className={`flex items-center gap-0.5 overflow-hidden whitespace-nowrap text-left text-[11px] font-medium transition-colors hover:text-[var(--c-text)] ${active ? "text-[var(--c-accent-text)]" : "text-[var(--c-text-muted)]"} ${className ?? ""}`}
    >
      {label}
      <span className="text-[9px] opacity-80">{active ? (sortDir === "asc" ? " ▲" : " ▼") : ""}</span>
    </button>
  );
}

/** Taille d'un dossier : inconnue tant qu'on ne l'a pas demandée (voir
 * `pane_dir_size` — c'est un `du` complet, jamais lancé d'office). */
type DirSize = number | "loading" | "error";

type FindState =
  | { pattern: string; status: "running" }
  | { pattern: string; status: "done"; outcome: PaneFindOutcome }
  | { pattern: string; status: "failed"; error: string };

/** Largeurs de colonne sous lesquelles une colonne coûte plus qu'elle
 * n'apporte : le panneau est redimensionnable, et une date de 16 caractères
 * dans 60 pixels débordait sur la colonne d'à côté. Mesuré sur le panneau,
 * pas sur la fenêtre — `sm:` de Tailwind regarde la fenêtre, qui est large
 * même quand le panneau ne l'est pas. */
const SHOW_MODIFIED_ABOVE = 430;
const SHOW_TYPE_ABOVE = 330;

/** Exporté pour `scripts/visual-check-transfer-columns.mjs`, qui le rend dans
 * un vrai navigateur pour mesurer l'alignement des colonnes — la seule chose
 * qui puisse le vérifier, puisque c'est de la mise en page. Pas un point
 * d'entrée : dans l'app, un panneau se rend toujours via `TransferTab`. */
export function PaneView({
  side, pane, workspace, fontSize, onNavigate, onSourceChange, onCopy, onMkdir, onCreateFile, onRename,
  onRemove, onChmod, onEdit, onOpenInEditor, onDirSize, onFind, onArchive, onExtract, showHidden,
  onToggleHidden, onDragStart, justDraggedRef, dragging, dropTarget, isRdpPush,
}: PaneViewProps) {
  const [query, setQuery] = useState("");
  const [find, setFind] = useState<FindState | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [creatingFile, setCreatingFile] = useState(false);
  const [newFileName, setNewFileName] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [chmodTarget, setChmodTarget] = useState<string | null>(null);
  const [chmodValue, setChmodValue] = useState("755");
  const [archiving, setArchiving] = useState(false);
  const [extracting, setExtracting] = useState<string | null>(null);
  const [extractDest, setExtractDest] = useState("");
  const [archiveName, setArchiveName] = useState("");
  const [archiveFormat, setArchiveFormat] = useState<ArchiveFormat>("tarGz");
  const [dirSizes, setDirSizes] = useState<Record<string, DirSize>>({});
  const copyLabel = side === "left" ? "→" : "←";
  // chmod has a real backend for both SFTP and Docker-exec panes (the latter
  // shells out to `chmod` — see `core::docker_pane::DockerPaneClient`), just
  // not for the local filesystem.
  const supportsChmod = pane.source.kind !== "local";

  // Largeur réelle du panneau, pour décider quelles colonnes tiennent.
  const rootRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(el);
    setWidth(el.getBoundingClientRect().width);
    return () => observer.disconnect();
  }, []);

  const showModified = width === 0 || width >= SHOW_MODIFIED_ABOVE;
  const showType = width === 0 || width >= SHOW_TYPE_ABOVE;

  /** Une seule grille pour l'en-tête et pour les lignes : c'est ce qui garantit
   * que les colonnes restent alignées. L'ancienne version empilait des
   * largeurs Tailwind des deux côtés — mêmes chiffres, mais l'en-tête sans
   * `shrink-0` et les lignes avec un nombre variable de boutons d'action, donc
   * un décalage dès qu'une ligne portait un bouton de plus qu'une autre. */
  const columns = useMemo(() => {
    const parts = ["1.1rem", "minmax(0,1fr)"];
    if (showModified) parts.push(`${Math.round(fontSize * 9)}px`);
    if (showType) parts.push(`${Math.round(fontSize * 4.8)}px`);
    parts.push(`${Math.round(fontSize * 5.4)}px`);
    parts.push("70px");
    return parts.join(" ");
  }, [fontSize, showModified, showType]);

  const gridStyle = { display: "grid", gridTemplateColumns: columns, alignItems: "center", columnGap: "4px" } as const;

  // Docker exec repurposes a saved host as a daemon entry point, not a
  // single connectable thing — picking it in the source selector below
  // needs a live-container step first, same as the sidebar's own connect
  // flow (`HostsPanel.tsx`'s `openDockerPicker`) and `SplitPane.tsx`'s
  // second panel. Same idea for K8s exec, one level deeper (a pod, and if it
  // has more than one container, which container).
  const { dockerPickerHost, k8sPickerHost, openDockerPicker, openK8sPicker, pickerModal } = useContainerPicker(
    (host, containerId) => onSourceChange(side, { kind: "docker", hostId: host.id, containerId }),
    (host, podName, containerName) => onSourceChange(side, { kind: "k8s", hostId: host.id, podName, containerName }),
  );

  const handleSort = (key: SortKey) => {
    if (key === sortKey) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(key); setSortDir("asc"); }
  };

  const sizeOf = (entry: Entry): number => {
    const known = dirSizes[joinPath(pane.cwd, entry.name)];
    return typeof known === "number" ? known : entry.size;
  };

  const sorted = useMemo(
    () => sortEntries(pane.entries, sortKey, sortDir, sizeOf),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pane.entries, sortKey, sortDir, dirSizes, pane.cwd],
  );

  const needle = query.trim().toLowerCase();
  const shown = showHidden ? sorted : sorted.filter((e) => !e.name.startsWith("."));
  const visible = needle ? shown.filter((e) => e.name.toLowerCase().includes(needle)) : shown;
  const hiddenCount = sorted.length - shown.length;

  /** Ce qu'on veut voir coché en arrivant dans le dossier — utilisé quand on
   * ouvre un résultat de recherche : le panneau descend dans son dossier et
   * le résultat est déjà sélectionné, sinon il faudrait le retrouver à l'œil
   * dans un listing entier. */
  const pendingSelect = useRef<string | null>(null);
  useEffect(() => {
    setSelected(pendingSelect.current ? new Set([pendingSelect.current]) : new Set());
    pendingSelect.current = null;
    setQuery("");
    setFind(null);
  }, [pane.cwd]);

  // While the Docker container picker is open, keep the dropdown showing
  // the host the user just picked (not the still-unchanged `pane.source`)
  // — otherwise it would visibly snap back to the old selection until a
  // container is actually chosen (`onSourceChange` hasn't fired yet).
  const sourceValue = dockerPickerHost ? dockerPickerHost.id : k8sPickerHost ? k8sPickerHost.id : pane.source.kind === "local" ? "local" : pane.source.hostId;

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

  const submitNewFile = () => {
    const name = newFileName.trim();
    if (name) onCreateFile(side, name);
    setNewFileName("");
    setCreatingFile(false);
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

  const startArchive = () => {
    if (selectedEntries.length === 0) return;
    setArchiveName(selectedEntries.length === 1 ? selectedEntries[0].name : baseName(pane.cwd) || "archive");
    setArchiving(true);
  };

  const submitArchive = () => {
    const name = archiveName.trim();
    if (name && selectedEntries.length > 0) {
      onArchive(side, selectedEntries.map((e) => e.name), name, archiveFormat);
    }
    setArchiving(false);
  };

  /** Le nom du fichier sans son extension d'archive : c'est le dossier que
   * l'on veut neuf fois sur dix, plutôt que déverser cinq cents fichiers dans
   * le dossier courant. Miroir de `pane_ops::archive_base_name`. */
  const archiveBaseName = (name: string) => name.replace(/\.(tar\.gz|tgz|zip)$/i, "");
  const isArchive = (name: string) => /\.(tar\.gz|tgz|zip)$/i.test(name);

  const startExtract = () => {
    const entry = selectedEntries[0];
    if (!entry || entry.isDir || !isArchive(entry.name)) return;
    setExtractDest(archiveBaseName(entry.name));
    setExtracting(entry.name);
  };

  const submitExtract = () => {
    if (extracting) onExtract(side, extracting, extractDest.trim());
    setExtracting(null);
  };

  // ── Taille des dossiers, à la demande ────────────────────────────────────
  const computeDirSize = async (entry: Entry) => {
    const path = joinPath(pane.cwd, entry.name);
    setDirSizes((prev) => (prev[path] === "loading" ? prev : { ...prev, [path]: "loading" }));
    try {
      const size = await onDirSize(side, path);
      setDirSizes((prev) => ({ ...prev, [path]: size }));
    } catch {
      setDirSizes((prev) => ({ ...prev, [path]: "error" }));
    }
  };

  const computeAllDirSizes = async () => {
    // En série : un `du` par dossier, tous lancés d'un coup sur la même
    // connexion SSH n'irait pas plus vite et saturerait l'hôte.
    for (const entry of visible.filter((e) => e.isDir && !e.isSymlink)) {
      await computeDirSize(entry);
    }
  };

  // ── Recherche récursive ──────────────────────────────────────────────────
  const runFind = async () => {
    const pattern = query.trim();
    if (!pattern) return;
    setFind({ pattern, status: "running" });
    try {
      const outcome = await onFind(side, pane.cwd, pattern);
      setFind({ pattern, status: "done", outcome });
    } catch (e) {
      setFind({ pattern, status: "failed", error: String(e) });
    }
  };

  const openHit = (path: string) => {
    pendingSelect.current = baseName(path);
    const parent = containingDir(path);
    if (parent === pane.cwd) {
      // Déjà dans le bon dossier : `pane.cwd` ne change pas, donc l'effet qui
      // applique `pendingSelect` ne partira pas — le faire ici.
      setSelected(new Set([baseName(path)]));
      pendingSelect.current = null;
      setFind(null);
      setQuery("");
      return;
    }
    onNavigate(side, parent);
  };

  const dropHighlight = dropTarget && !dropTarget.dir;

  return (
    // `min-w-0` : sans lui, la grille des lignes impose sa largeur minimale au
    // panneau, qui déborde alors de son conteneur (rogné par l'`overflow-hidden`
    // du parent) au lieu de comprimer la colonne « Nom ».
    <div ref={rootRef} className={`flex min-h-0 w-full min-w-0 flex-1 flex-col ${dropHighlight ? "ring-2 ring-inset ring-[var(--c-accent)]" : ""}`}>
      {/* Source selector */}
      <div className="flex items-center gap-2 border-b border-[var(--c-border)] p-2">
        <select
          value={sourceValue}
          onChange={(e) => {
            const v = e.target.value;
            if (v === "local") { onSourceChange(side, { kind: "local" }); return; }
            const host = workspace.hosts.find((h) => h.id === v);
            if (host && (host.kind ?? "ssh") === "dockerExec") { openDockerPicker(host); return; }
            if (host && (host.kind ?? "ssh") === "k8sExec") { openK8sPicker(host); return; }
            onSourceChange(side, { kind: "remote", hostId: v });
          }}
          className="rounded-md bg-[var(--c-bg3)] px-2 py-1 text-sm text-[var(--c-text)] focus:outline-none focus:ring-1 focus:ring-[var(--c-accent-hover)]"
        >
          <option value="local">Local</option>
          {/* rdp hosts have no file-listing backend — SFTP-shaped browsing
              only applies to ssh/dockerExec/k8sExec. */}
          {workspace.hosts
            .filter((h) => (h.kind ?? "ssh") === "ssh" || (h.kind ?? "ssh") === "dockerExec" || (h.kind ?? "ssh") === "k8sExec")
            .map((h) => (
              <option key={h.id} value={h.id}>
                {h.label}
                {(h.kind ?? "ssh") === "dockerExec" ? " (Docker exec)" : (h.kind ?? "ssh") === "k8sExec" ? " (K8s exec)" : ""}
              </option>
            ))}
        </select>
        {pane.status === "connecting" && <span className="text-xs text-[var(--c-text-muted)]">connexion…</span>}
      </div>

      {pickerModal}

      {pane.status === "failed" && (
        <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-rose-300">
          Erreur : {pane.error}
        </div>
      )}

      {pane.status === "open" && (
        <>
          {/* Navigation bar : fil d'Ariane cliquable — chaque niveau y ramène
              directement, ce que l'ancien champ « Aller à » demandait de
              retaper à la main. */}
          <div className="flex items-center gap-2 border-b border-[var(--c-border)] px-2 py-1.5">
            <button
              onClick={() => onNavigate(side, parentPath(pane.cwd))}
              className="shrink-0 rounded px-2 py-0.5 text-sm text-[var(--c-text-secondary)] hover:bg-white/5 hover:text-[var(--c-text)]"
              title="Dossier parent"
            >
              ↑
            </button>
            <div className="flex min-w-0 flex-1 items-center overflow-x-auto whitespace-nowrap font-mono text-xs text-[var(--c-text-secondary)]" title={pane.cwd}>
              {breadcrumbs(pane.cwd).map((crumb, index, all) => (
                <span key={crumb.path} className="flex items-center">
                  {index > 0 && <span className="px-0.5 text-[var(--c-text-faint)]">/</span>}
                  <button
                    onClick={() => onNavigate(side, crumb.path)}
                    disabled={index === all.length - 1}
                    className={`rounded px-1 py-0.5 ${index === all.length - 1 ? "text-[var(--c-text)]" : "hover:bg-white/5 hover:text-[var(--c-text)]"}`}
                  >
                    {crumb.label}
                  </button>
                </span>
              ))}
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <div className="relative">
                <IconSearch size={11} className="pointer-events-none absolute left-1.5 top-1/2 -translate-y-1/2 text-[var(--c-text-faint)]" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") runFind();
                    if (e.key === "Escape") { setQuery(""); setFind(null); }
                  }}
                  placeholder="Rechercher…"
                  title="Filtre ce dossier au fil de la frappe. Entrée : recherche récursive sous le dossier courant."
                  className="w-32 rounded-md bg-[var(--c-bg3)] py-0.5 pl-6 pr-2 text-xs text-[var(--c-text)] placeholder:text-[var(--c-text-faint)] focus:outline-none focus:ring-1 focus:ring-[var(--c-accent-hover)]"
                />
              </div>
              {(query || find) && (
                <button
                  onClick={() => { setQuery(""); setFind(null); }}
                  title="Effacer la recherche"
                  className="rounded-md bg-[var(--c-bg3)] px-1.5 py-0.5 text-[var(--c-text-secondary)] hover:bg-white/5 hover:text-[var(--c-text)]"
                >
                  <IconClose size={11} />
                </button>
              )}
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
                <button aria-label="Retirer de la liste" onClick={() => setCreatingFolder(false)} className="rounded-md bg-[var(--c-bg3)] px-2 py-1 text-xs text-[var(--c-text-secondary)] hover:bg-white/5">
                  <IconClose size={11} />
                </button>
              </div>
            ) : creatingFile ? (
              <div className="flex flex-1 items-center gap-1">
                <input
                  autoFocus
                  value={newFileName}
                  onChange={(e) => setNewFileName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") submitNewFile(); if (e.key === "Escape") setCreatingFile(false); }}
                  placeholder="Nom du fichier"
                  className="min-w-0 flex-1 rounded-md bg-[var(--c-bg3)] px-2 py-1 text-xs text-[var(--c-text)] placeholder:text-[var(--c-text-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--c-accent-hover)]"
                />
                <button onClick={submitNewFile} className="rounded-md bg-[var(--c-accent)] px-2 py-1 text-xs text-white hover:bg-[var(--c-accent-hover)]">Créer</button>
                <button aria-label="Retirer de la liste" onClick={() => setCreatingFile(false)} className="rounded-md bg-[var(--c-bg3)] px-2 py-1 text-xs text-[var(--c-text-secondary)] hover:bg-white/5">
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
                <button aria-label="Retirer de la liste" onClick={() => setRenaming(null)} className="rounded-md bg-[var(--c-bg3)] px-2 py-1 text-xs text-[var(--c-text-secondary)] hover:bg-white/5">
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
                <button aria-label="Retirer de la liste" onClick={() => setChmodTarget(null)} className="rounded-md bg-[var(--c-bg3)] px-2 py-1 text-xs text-[var(--c-text-secondary)] hover:bg-white/5">
                  <IconClose size={11} />
                </button>
              </div>
            ) : archiving ? (
              <div className="flex flex-1 items-center gap-1">
                <span className="shrink-0 text-xs text-[var(--c-text-secondary)]">Archiver {selectedEntries.length} élément(s) :</span>
                <input
                  autoFocus
                  value={archiveName}
                  onChange={(e) => setArchiveName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") submitArchive(); if (e.key === "Escape") setArchiving(false); }}
                  placeholder="Nom de l'archive"
                  className="min-w-0 flex-1 rounded-md bg-[var(--c-bg3)] px-2 py-1 text-xs text-[var(--c-text)] placeholder:text-[var(--c-text-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--c-accent-hover)]"
                />
                <select
                  value={archiveFormat}
                  onChange={(e) => setArchiveFormat(e.target.value as ArchiveFormat)}
                  title="zip demande la commande `zip` sur l'hôte, souvent absente d'un serveur minimal ou d'un conteneur"
                  className="shrink-0 rounded-md bg-[var(--c-bg3)] px-1 py-1 text-xs text-[var(--c-text)] focus:outline-none focus:ring-1 focus:ring-[var(--c-accent-hover)]"
                >
                  <option value="tarGz">.tar.gz</option>
                  <option value="zip">.zip</option>
                </select>
                <button onClick={submitArchive} className="rounded-md bg-[var(--c-accent)] px-2 py-1 text-xs text-white hover:bg-[var(--c-accent-hover)]">Créer</button>
                <button aria-label="Retirer de la liste" onClick={() => setArchiving(false)} className="rounded-md bg-[var(--c-bg3)] px-2 py-1 text-xs text-[var(--c-text-secondary)] hover:bg-white/5">
                  <IconClose size={11} />
                </button>
              </div>
            ) : extracting ? (
              <div className="flex flex-1 items-center gap-1">
                <span className="shrink-0 truncate text-xs text-[var(--c-text-secondary)]">Extraire {extracting} dans :</span>
                <input
                  autoFocus
                  value={extractDest}
                  onChange={(e) => setExtractDest(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") submitExtract(); if (e.key === "Escape") setExtracting(null); }}
                  placeholder="ce dossier-ci"
                  title="Vide : extraire directement dans le dossier courant"
                  className="min-w-0 flex-1 rounded-md bg-[var(--c-bg3)] px-2 py-1 text-xs text-[var(--c-text)] placeholder:text-[var(--c-text-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--c-accent-hover)]"
                />
                <button onClick={submitExtract} className="rounded-md bg-[var(--c-accent)] px-2 py-1 text-xs text-white hover:bg-[var(--c-accent-hover)]">Extraire</button>
                <button aria-label="Retirer de la liste" onClick={() => setExtracting(null)} className="rounded-md bg-[var(--c-bg3)] px-2 py-1 text-xs text-[var(--c-text-secondary)] hover:bg-white/5">
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
                <button
                  onClick={() => setCreatingFile(true)}
                  title="Nouveau fichier"
                  className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-[var(--c-text-secondary)] hover:bg-white/5 hover:text-[var(--c-text)]"
                >
                  <span className="text-[12px] leading-none">📄</span> Nouveau fichier
                </button>
                <button
                  onClick={computeAllDirSizes}
                  title="Calculer la taille de tous les dossiers affichés (un du par dossier — ça peut prendre du temps sur un gros arbre)"
                  className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-[var(--c-text-secondary)] hover:bg-white/5 hover:text-[var(--c-text)]"
                >
                  Σ Tailles
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
                {selectedEntries.length === 1 && supportsChmod && (
                  <button
                    onClick={() => { setChmodTarget(selectedEntries[0].name); setChmodValue(selectedEntries[0].permissions != null ? (selectedEntries[0].permissions & 0o777).toString(8) : "755"); }}
                    title="Permissions"
                    className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-[var(--c-text-secondary)] hover:bg-white/5 hover:text-[var(--c-text)]"
                  >
                    <IconShield size={12} /> Permissions
                  </button>
                )}
                {onToggleHidden && (
                  <button
                    onClick={onToggleHidden}
                    title={showHidden
                      ? `Masquer les fichiers cachés${hiddenCount > 0 ? "" : " (aucun ici)"}`
                      : `Afficher les fichiers cachés${hiddenCount > 0 ? ` (${hiddenCount} masqué(s) ici)` : ""}`}
                    className={`flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] hover:bg-white/5 hover:text-[var(--c-text)] ${showHidden ? "text-[var(--c-text-secondary)]" : "text-[var(--c-text-faint)]"}`}
                  >
                    {showHidden ? "👁" : "🙈"} Cachés{!showHidden && hiddenCount > 0 ? ` (${hiddenCount})` : ""}
                  </button>
                )}
                {selectedEntries.length === 1 && !selectedEntries[0].isDir && isArchive(selectedEntries[0].name) && (
                  <button
                    onClick={startExtract}
                    title="Extraire cette archive ici — l'extraction a lieu sur place, rien ne transite par le réseau"
                    className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-[var(--c-text-secondary)] hover:bg-white/5 hover:text-[var(--c-text)]"
                  >
                    📦 Extraire
                  </button>
                )}
                {selectedEntries.length > 0 && (
                  <button
                    onClick={startArchive}
                    title="Archiver la sélection dans ce dossier — l'archive est créée sur place, rien ne transite par le réseau"
                    className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-[var(--c-text-secondary)] hover:bg-white/5 hover:text-[var(--c-text)]"
                  >
                    🗜 Archiver ({selectedEntries.length})
                  </button>
                )}
                {selectedEntries.length > 1 && (
                  <button
                    onClick={() => onCopy(side, selectedEntries)}
                    title={isRdpPush ? `Envoyer et coller ${selectedEntries.length} éléments dans la session RDP` : `Copier ${selectedEntries.length} éléments vers l'autre panneau`}
                    className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-[var(--c-text-secondary)] hover:bg-white/5 hover:text-[var(--c-text)]"
                  >
                    {copyLabel} {isRdpPush ? `Envoyer (${selectedEntries.length})` : `Copier (${selectedEntries.length})`}
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

          {find ? (
            <FindResults
              find={find}
              cwd={pane.cwd}
              fontSize={fontSize}
              onOpen={openHit}
              onClose={() => setFind(null)}
            />
          ) : (
            <>
              {/* Column headers */}
              <div
                data-pane-header
                className="border-b border-[var(--c-border)] bg-[var(--c-bg3)]/60 px-2 py-1"
                style={{ ...gridStyle, fontSize: `${Math.max(10, fontSize - 2)}px` }}
              >
                <div />
                <ColHeader label="Nom"     colKey="name"     sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
                {showModified && <ColHeader label="Modifié" colKey="modified" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />}
                {showType && <ColHeader label="Type"        colKey="type"     sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />}
                <ColHeader label="Taille"  colKey="size"     sortKey={sortKey} sortDir={sortDir} onSort={handleSort} className="justify-end" />
                <div />
              </div>

              {/* File list */}
              <div className="min-h-0 flex-1 select-none overflow-y-auto" style={{ fontSize: `${fontSize}px` }}>
                {visible.map((entry) => {
                  const isDropTarget = dropTarget?.dir === entry.name;
                  const size = dirSizes[joinPath(pane.cwd, entry.name)];
                  return (
                    <div
                      key={entry.name}
                      data-pane-row
                      {...(entry.isDir ? { "data-drop-dir": entry.name, "data-drop-side": side } : {})}
                      onMouseDown={(e) => {
                        // Les cases à cocher et les boutons d'action gardent
                        // leur clic ; le reste de la ligne est une poignée.
                        if ((e.target as HTMLElement).closest("[data-no-drag]")) return;
                        const dragged = selected.has(entry.name) && selectedEntries.length > 1 ? selectedEntries : [entry];
                        onDragStart(side, dragged, e);
                      }}
                      className={`group px-2 py-[3px] hover:bg-[var(--c-bg2)] ${selected.has(entry.name) ? "bg-[var(--c-accent-dim)]" : ""} ${isDropTarget ? "outline outline-1 -outline-offset-1 outline-[var(--c-accent)]" : ""}`}
                      style={gridStyle}
                    >
                      <input
                        type="checkbox"
                        data-no-drag
                        checked={selected.has(entry.name)}
                        onClick={(e) => toggleSelect(entry.name, e)}
                        onChange={() => {}}
                        className="h-3.5 w-3.5 accent-[var(--c-accent)]"
                      />
                      {/* Name */}
                      <button
                        onClick={() => {
                          if (justDraggedRef.current) return;
                          if (entry.isDir) onNavigate(side, joinPath(pane.cwd, entry.name));
                        }}
                        className={`flex min-w-0 items-center gap-1.5 overflow-hidden text-left ${
                          entry.isDir ? "font-medium text-[var(--c-accent-text)]" : "text-[var(--c-text)]"
                        } ${entry.isDir ? "cursor-pointer" : "cursor-default"}`}
                        title={entry.name}
                      >
                        <span className="shrink-0 text-[13px]">{entry.isDir ? "📁" : "📄"}</span>
                        <span className="truncate">{entry.name}</span>
                      </button>

                      {/* Modified */}
                      {showModified && (
                        <span className="truncate text-[var(--c-text-muted)] tabular-nums">{formatDate(entry.modified)}</span>
                      )}

                      {/* Type */}
                      {showType && <span className="truncate text-[var(--c-text-muted)]">{fileTypeLabel(entry)}</span>}

                      {/* Size — un dossier n'en a pas tant qu'on ne l'a pas
                          demandée : le « — » est le bouton qui la demande. */}
                      {entry.isDir ? (
                        <button
                          data-no-drag
                          onClick={() => computeDirSize(entry)}
                          disabled={size === "loading"}
                          title={
                            typeof size === "number"
                              ? `${size.toLocaleString("fr-FR")} octets — recalculer`
                              : size === "error"
                                ? "Taille non calculable (dossier illisible ?) — réessayer"
                                : "Calculer la taille de ce dossier"
                          }
                          className={`truncate text-right tabular-nums ${typeof size === "number" ? "text-[var(--c-text-secondary)]" : "text-[var(--c-text-faint)] hover:text-[var(--c-accent-text)]"}`}
                        >
                          {size === "loading" ? "…" : size === "error" ? "?" : typeof size === "number" ? formatSize(size) : "—"}
                        </button>
                      ) : (
                        <span className="truncate text-right tabular-nums text-[var(--c-text-muted)]">{formatSize(entry.size)}</span>
                      )}

                      {/* Actions — trois emplacements de largeur fixe, remplis
                          ou non : sans ça, une ligne sans bouton d'édition
                          décalait toutes ses colonnes par rapport aux autres. */}
                      <div className="flex items-center justify-end gap-0.5">
                        {!entry.isDir && entry.size <= QUICK_EDIT_MAX_SIZE ? (
                          <button
                            data-no-drag
                            onClick={() => onEdit(side, entry.name)}
                            title="Éditer le contenu ici"
                            className="w-[22px] rounded px-0.5 text-center text-[var(--c-text-faint)] opacity-0 hover:bg-[var(--c-accent)] hover:text-white focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"
                          >
                            <IconEdit size={12} className="mx-auto" />
                          </button>
                        ) : (
                          <span className="w-[22px]" />
                        )}

                        {/* Open in the user's own editor — no size limit, unlike
                            quick-edit above: the whole point is the files that are too
                            big, or too worth having a real editor for. */}
                        {!entry.isDir ? (
                          <button
                            data-no-drag
                            onClick={() => onOpenInEditor(side, entry.name)}
                            title="Ouvrir dans mon éditeur (renvoyé au retour dans l'app)"
                            className="w-[22px] rounded px-0.5 text-center text-[var(--c-text-faint)] opacity-0 hover:bg-[var(--c-accent)] hover:text-white focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"
                          >
                            <IconExternal size={12} className="mx-auto" />
                          </button>
                        ) : (
                          <span className="w-[22px]" />
                        )}

                        <button
                          data-no-drag
                          onClick={() => onCopy(side, [entry])}
                          title={
                            isRdpPush
                              ? (entry.isDir ? "Envoyer et coller le dossier dans la session RDP" : "Envoyer et coller dans la session RDP")
                              : (entry.isDir ? "Copier le dossier vers l'autre panneau" : "Copier vers l'autre panneau")
                          }
                          className="w-[22px] rounded px-0.5 text-center text-[var(--c-text-faint)] opacity-0 hover:bg-[var(--c-accent)] hover:text-white focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"
                        >
                          {copyLabel}
                        </button>
                      </div>
                    </div>
                  );
                })}
                {pane.entries.length === 0 && (
                  <p className="px-2 py-6 text-center text-xs text-[var(--c-text-muted)]">Dossier vide</p>
                )}
                {pane.entries.length > 0 && visible.length === 0 && (
                  <p className="px-2 py-6 text-center text-xs text-[var(--c-text-muted)]">
                    Rien qui contienne « {query.trim()} » dans ce dossier.
                    <br />
                    <span className="text-[var(--c-text-faint)]">Entrée : chercher dans les sous-dossiers.</span>
                  </p>
                )}
              </div>
            </>
          )}

          {dragging && !dropTarget && (
            <div className="shrink-0 border-t border-[var(--c-border)] px-2 py-0.5 text-center text-[10px] text-[var(--c-text-faint)]">
              Déposer sur l'autre panneau — ou sur un de ses dossiers pour copier dedans
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** Résultats d'une recherche récursive : une liste de chemins, à la place du
 * listing. Ouvrir un résultat va dans le dossier qui le contient et l'y
 * sélectionne — c'est là qu'on veut être pour en faire quelque chose. */
function FindResults({
  find, cwd, fontSize, onOpen, onClose,
}: {
  find: FindState;
  cwd: string;
  fontSize: number;
  onOpen: (path: string) => void;
  onClose: () => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-[var(--c-border)] bg-[var(--c-bg3)]/60 px-2 py-1 text-[11px] text-[var(--c-text-muted)]">
        <span className="min-w-0 flex-1 truncate">
          {find.status === "running" && `Recherche de « ${find.pattern} » sous ${cwd}…`}
          {find.status === "failed" && <span className="text-rose-300">Échec : {find.error}</span>}
          {find.status === "done" &&
            `${find.outcome.paths.length} résultat(s) pour « ${find.pattern} »${find.outcome.truncated ? " — liste tronquée" : ""}`}
        </span>
        <button onClick={onClose} className="shrink-0 rounded px-2 py-0.5 hover:bg-white/5 hover:text-[var(--c-text)]">
          Revenir au dossier
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto" style={{ fontSize: `${fontSize}px` }}>
        {find.status === "done" &&
          find.outcome.paths.map((path) => (
            <button
              key={path}
              onClick={() => onOpen(path)}
              title={`Aller dans le dossier qui contient ${path}`}
              className="block w-full truncate px-2 py-[3px] text-left font-mono text-[var(--c-text-secondary)] hover:bg-[var(--c-bg2)] hover:text-[var(--c-text)]"
            >
              {path.startsWith(cwd) ? path.slice(cwd.length).replace(/^[\\/]+/, "") : path}
            </button>
          ))}
        {find.status === "done" && find.outcome.paths.length === 0 && (
          <p className="px-2 py-6 text-center text-xs text-[var(--c-text-muted)]">Aucun résultat.</p>
        )}
      </div>
    </div>
  );
}
