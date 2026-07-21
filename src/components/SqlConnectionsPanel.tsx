import { useState } from "react";
import { api } from "../lib/api";
import type { SqlConnection, SqlConnectionId, SqlEngine, Workspace } from "../lib/types";
import { IconDatabase, IconPlus, IconClose, IconTrash, IconEdit, IconChevronDown, IconFlash } from "./ui-icons";

interface SqlConnectionsPanelProps {
  workspace: Workspace;
  onConnect: (conn: SqlConnection) => void;
  onWorkspaceUpdate: (ws: Workspace) => void;
  onError: (message: string) => void;
}

const DEFAULT_PORTS: Record<SqlEngine, string> = { mysql: "3306", postgres: "5432" };

export function SqlConnectionsPanel({ workspace, onConnect, onWorkspaceUpdate, onError }: SqlConnectionsPanelProps) {
  const [editingId, setEditingId] = useState<SqlConnectionId | "new" | null>(null);
  // Id of the connection whose "Modifier ▾" split button has its menu
  // (currently just "Supprimer") open — same single-open-id convention as
  // `HostsPanel`'s `openMenuHostId`.
  const [deleteMenuId, setDeleteMenuId] = useState<SqlConnectionId | null>(null);
  const [label, setLabel] = useState("");
  const [engine, setEngine] = useState<SqlEngine>("mysql");
  const [tunnelHostId, setTunnelHostId] = useState("");
  const [address, setAddress] = useState("");
  const [port, setPort] = useState(DEFAULT_PORTS.mysql);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [database, setDatabase] = useState("");

  const resetForm = () => {
    setLabel(""); setEngine("mysql"); setTunnelHostId(""); setAddress("");
    setPort(DEFAULT_PORTS.mysql); setUsername(""); setPassword(""); setDatabase("");
  };

  const startNew = () => { resetForm(); setEditingId("new"); };
  const startEdit = (conn: SqlConnection) => {
    setLabel(conn.label);
    setEngine(conn.engine);
    setTunnelHostId(conn.tunnelHostId ?? "");
    setAddress(conn.address);
    setPort(String(conn.port));
    setUsername(conn.username);
    setPassword("");
    setDatabase(conn.database ?? "");
    setEditingId(conn.id);
  };

  // Only switches the port if it's still at one engine's default — a custom
  // port the user already typed in is left untouched.
  const onEngineChange = (next: SqlEngine) => {
    setEngine(next);
    if (Object.values(DEFAULT_PORTS).includes(port)) setPort(DEFAULT_PORTS[next]);
  };

  const submit = () => {
    const p = Number(port);
    if (!label.trim() || !address.trim() || !username.trim() || !Number.isInteger(p) || p < 1 || p > 65535) {
      onError("Champs de connexion SQL invalides");
      return;
    }
    api.saveSqlConnection({
      id: editingId === "new" ? null : editingId,
      label: label.trim(),
      engine,
      tunnelHostId: tunnelHostId || null,
      address: address.trim(),
      port: p,
      username: username.trim(),
      database: database.trim() || null,
      groupId: null,
      tags: [],
      secret: password || null,
    }).then((ws) => { onWorkspaceUpdate(ws); setEditingId(null); }).catch((e) => onError(String(e)));
  };

  const remove = (id: SqlConnectionId) => {
    api.deleteSqlConnection(id).then(onWorkspaceUpdate).catch((e) => onError(String(e)));
  };

  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className="sidebar-scroll min-h-0 min-w-0 flex-1 space-y-2 overflow-y-auto pb-2 pl-2 pt-2">
        <div>
          <button
            onClick={() => (editingId ? setEditingId(null) : startNew())}
            className={`accent-surface flex w-full items-center justify-center gap-1.5 rounded-xl border py-2 text-xs font-semibold transition-all ${
              editingId ? "ring-2 ring-white/25" : ""
            }`}
          >
            <IconPlus size={13} /> {editingId ? "Annuler" : "Ajouter une connexion"}
          </button>
          {editingId && (
            <div className="mt-2 space-y-1.5 rounded-xl bg-[var(--c-bg3)] p-2.5">
              <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Nom" className={inputFullClass} />
              <select value={engine} onChange={(e) => onEngineChange(e.target.value as SqlEngine)} className={selectClass}>
                <option value="mysql">MySQL</option>
                <option value="postgres">PostgreSQL</option>
              </select>
              <select value={tunnelHostId} onChange={(e) => setTunnelHostId(e.target.value)} className={selectClass}>
                <option value="">Connexion directe (pas de tunnel)</option>
                {workspace.hosts
                  .filter((h) => (h.kind ?? "ssh") === "ssh")
                  .map((h) => (
                    <option key={h.id} value={h.id}>Tunnel SSH via {h.label}</option>
                  ))}
              </select>
              {tunnelHostId && (
                <p className="px-0.5 text-[11px] leading-relaxed text-[var(--c-text-muted)]">
                  L'adresse ci-dessous doit être joignable <em>depuis</em> cet hôte — souvent
                  127.0.0.1 si la base n'écoute qu'en local sur le serveur.
                </p>
              )}
              <div className="flex gap-1.5">
                <input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="Adresse" className={`${inputClass} min-w-0 flex-1 font-mono`} />
                <input value={port} onChange={(e) => setPort(e.target.value)} placeholder="Port" inputMode="numeric" className={`${inputClass} w-16 shrink-0 font-mono`} />
              </div>
              <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="Utilisateur" className={inputFullClass} />
              <input
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                type="password"
                placeholder={editingId !== "new" ? "Mot de passe (laisser vide pour ne pas changer)" : "Mot de passe"}
                className={inputFullClass}
              />
              <input value={database} onChange={(e) => setDatabase(e.target.value)} placeholder="Base de données (optionnel)" className={inputFullClass} />
              <div className="flex gap-1.5">
                <button onClick={submit} className="accent-surface flex-1 rounded-md border py-1.5 text-xs font-medium">
                  {editingId === "new" ? "Ajouter" : "Enregistrer"}
                </button>
                <button
                  onClick={() => setEditingId(null)}
                  className="flex items-center justify-center rounded-md bg-[var(--c-bg2)] px-2.5 py-1.5 text-xs text-[var(--c-text-secondary)] hover:bg-white/5"
                >
                  <IconClose size={12} />
                </button>
              </div>
            </div>
          )}
        </div>
        {workspace.sqlConnections.map((conn) => {
          const tunnelHost = conn.tunnelHostId ? workspace.hosts.find((h) => h.id === conn.tunnelHostId) : null;
          const menuOpen = deleteMenuId === conn.id;
          return (
            <div key={conn.id} className="rounded-xl border border-transparent bg-[var(--c-bg3)] p-2.5 transition-all hover:border-white/15">
              <div className="flex items-center gap-2">
                <IconDatabase size={14} className="shrink-0 text-[var(--c-text-faint)]" />
                <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-[var(--c-text)]">{conn.label}</span>
              </div>
              <p className="mt-0.5 pl-[22px] text-[10px] text-[var(--c-text-muted)]">
                {conn.engine === "mysql" ? "MySQL" : "PostgreSQL"} · <span className="font-mono">{conn.address}:{conn.port}</span>
                {tunnelHost && <> · via {tunnelHost.label}</>}
              </p>
              <div className="mt-2 flex gap-1">
                <button
                  onClick={() => onConnect(conn)}
                  className="accent-surface flex flex-1 items-center justify-center gap-1.5 rounded-md border py-1.5 text-xs font-medium"
                >
                  <IconFlash size={11} /> Connexion
                </button>
                <div className="relative flex shrink-0">
                  <button
                    onClick={() => startEdit(conn)}
                    className="flex items-center gap-1.5 rounded-l-md bg-[var(--c-bg2)] px-2 py-1.5 text-xs text-[var(--c-text-secondary)] hover:bg-white/5"
                  >
                    <IconEdit size={11} /> Modifier
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); setDeleteMenuId(menuOpen ? null : conn.id); }}
                    title="Options"
                    className={`flex items-center rounded-r-md border-l border-[var(--c-bg)] bg-[var(--c-bg2)] px-1.5 py-1.5 text-xs hover:bg-white/5 ${menuOpen ? "text-[var(--c-text)]" : "text-[var(--c-text-secondary)]"}`}
                  >
                    <IconChevronDown size={11} />
                  </button>
                  {menuOpen && (
                    <>
                      <div className="fixed inset-0 z-10" onClick={() => setDeleteMenuId(null)} />
                      <div className="absolute right-0 top-full z-20 mt-1 w-32 overflow-hidden rounded-md border border-[var(--c-border)] bg-[var(--c-bg2)] py-1 shadow-[var(--shadow-lg)]">
                        <button
                          onClick={() => { setDeleteMenuId(null); remove(conn.id); }}
                          className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-xs text-rose-400 hover:bg-rose-900/40"
                        >
                          <IconTrash size={11} /> Supprimer
                        </button>
                      </div>
                    </>
                  )}
                </div>
              </div>
            </div>
          );
        })}
        {workspace.sqlConnections.length === 0 && !editingId && (
          <p className="px-1 py-4 text-center text-[13px] text-[var(--c-text-muted)]">Aucune connexion SQL configurée</p>
        )}
      </div>
    </div>
  );
}

// No `w-full` here for the same reason as `TunnelsPanel.tsx`'s identical
// constant: every call site pairs this with its own `flex-1`/`w-16` sizing
// in a flex row.
const inputClass = "rounded-md bg-[var(--c-bg2)] px-2 py-1.5 text-[13px] text-[var(--c-text)] placeholder:text-[var(--c-text-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--c-accent)]";
const inputFullClass = `${inputClass} w-full`;
const selectClass = "w-full rounded-md bg-[var(--c-bg2)] px-2 py-1.5 text-[13px] text-[var(--c-text)] focus:outline-none focus:ring-1 focus:ring-[var(--c-accent)]";
