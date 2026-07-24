import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import type { HostId, SqlConnection, SqlConnectionId, SqlEngine, Workspace } from "../lib/types";
import { IconTrash } from "./ui-icons";
import { SqliteRemoteFilePicker } from "./SqliteRemoteFilePicker";

export interface SqlConnectionFormData {
  id: SqlConnectionId | null;
  label: string;
  engine: SqlEngine;
  tunnelHostId: string | null;
  address: string;
  port: number;
  username: string;
  database: string | null;
  path: string | null;
  sqliteHostId: string | null;
  groupId: null;
  tags: string[];
  secret: string | null;
}

interface SqlConnectionFormProps {
  workspace: Workspace;
  /** `null` — a new connection. */
  connection: SqlConnection | null;
  onCancel: () => void;
  onSave: (input: SqlConnectionFormData) => void;
  onDeleteConnection?: (id: SqlConnectionId) => void;
}

const DEFAULT_PORTS: Record<Exclude<SqlEngine, "sqlite">, string> = { mysql: "3306", postgres: "5432", redis: "6379" };

const SQLITE_FILTERS = [{ name: "SQLite", extensions: ["sqlite", "sqlite3", "db"] }, { name: "Tous les fichiers", extensions: ["*"] }];

/** Right-panel form for creating/editing a SQL connection — same slot and
 * layout as `HostForm`/`GroupForm` (see `App.tsx`'s `showRightPanel`), rather
 * than an inline expansion in `SqlConnectionsPanel`'s list. */
export function SqlConnectionForm({ workspace, connection, onCancel, onSave, onDeleteConnection }: SqlConnectionFormProps) {
  const [label, setLabel] = useState(connection?.label ?? "");
  const [engine, setEngine] = useState<SqlEngine>(connection?.engine ?? "mysql");
  const [tunnelHostId, setTunnelHostId] = useState(connection?.tunnelHostId ?? "");
  const [address, setAddress] = useState(connection?.address ?? "");
  const [port, setPort] = useState(String(connection?.port ?? DEFAULT_PORTS.mysql));
  const [username, setUsername] = useState(connection?.username ?? "");
  const [password, setPassword] = useState("");
  const [database, setDatabase] = useState(connection?.database ?? "");
  const [path, setPath] = useState(connection?.path ?? "");
  const [sqliteHostId, setSqliteHostId] = useState<HostId | "">(connection?.sqliteHostId ?? "");
  const [showRemotePicker, setShowRemotePicker] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Only switches the port if it's still at one engine's default — a custom
  // port the user already typed in is left untouched. No port to switch for
  // `sqlite` (it has none — see `DEFAULT_PORTS`).
  const onEngineChange = (next: SqlEngine) => {
    setEngine(next);
    if (next !== "sqlite" && Object.values(DEFAULT_PORTS).includes(port)) setPort(DEFAULT_PORTS[next]);
  };

  const browseLocalFile = async () => {
    const selected = await open({ title: "Sélectionner un fichier SQLite", multiple: false, directory: false, filters: SQLITE_FILTERS });
    if (selected && typeof selected === "string") {
      setPath(selected);
      setSqliteHostId("");
    }
  };

  const onRemoteFilePicked = (hostId: HostId, remotePath: string) => {
    setPath(remotePath);
    setSqliteHostId(hostId);
    setShowRemotePicker(false);
  };

  const submit = () => {
    if (!label.trim()) {
      setError("Champs de connexion SQL invalides");
      return;
    }
    if (engine === "sqlite") {
      if (!path.trim()) {
        setError("Chemin du fichier SQLite manquant");
        return;
      }
      onSave({
        id: connection?.id ?? null,
        label: label.trim(),
        engine,
        tunnelHostId: null,
        address: "",
        port: 0,
        username: "",
        database: null,
        path: path.trim(),
        sqliteHostId: sqliteHostId || null,
        groupId: null,
        tags: [],
        secret: null,
      });
      return;
    }
    const p = Number(port);
    // `username` is optional for Redis (empty means legacy `requirepass`-only
    // auth, still the common case) — required for MySQL/PostgreSQL.
    if (!address.trim() || (engine !== "redis" && !username.trim()) || !Number.isInteger(p) || p < 1 || p > 65535) {
      setError("Champs de connexion SQL invalides");
      return;
    }
    onSave({
      id: connection?.id ?? null,
      label: label.trim(),
      engine,
      tunnelHostId: tunnelHostId || null,
      address: address.trim(),
      port: p,
      username: username.trim(),
      database: database.trim() || null,
      path: null,
      sqliteHostId: null,
      groupId: null,
      tags: [],
      secret: password || null,
    });
  };

  return (
    <div className="flex flex-1 flex-col overflow-y-auto p-4">
      <div className="w-full space-y-4 rounded-xl bg-[var(--c-bg2)] p-5 shadow-[var(--shadow-md)]">
        <h2 className="text-[16px] font-semibold text-[var(--c-text)]">
          {connection ? "Modifier la connexion SQL" : "Nouvelle connexion SQL"}
        </h2>

        {error && <p className="rounded-md bg-rose-950 px-3 py-2 text-sm text-rose-300">{error}</p>}

        <div className="space-y-1">
          <span className="text-xs font-medium text-[var(--c-text-secondary)]">Nom</span>
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Nom" autoFocus className={inputFullClass} />
        </div>

        <div className="space-y-1">
          <span className="text-xs font-medium text-[var(--c-text-secondary)]">Moteur</span>
          <select value={engine} onChange={(e) => onEngineChange(e.target.value as SqlEngine)} className={selectClass}>
            <option value="mysql">MySQL</option>
            <option value="postgres">PostgreSQL</option>
            <option value="sqlite">SQLite</option>
            <option value="redis">Redis</option>
          </select>
        </div>

        {engine === "sqlite" ? (
          <div className="space-y-1">
            <span className="text-xs font-medium text-[var(--c-text-secondary)]">Fichier SQLite</span>
            <div className="flex gap-1.5">
              <input
                value={path}
                onChange={(e) => { setPath(e.target.value); setSqliteHostId(""); }}
                placeholder="Chemin du fichier .sqlite / .db"
                className={`${inputClass} w-full font-mono`}
              />
              <button type="button" onClick={browseLocalFile} className="shrink-0 rounded-md bg-[var(--c-bg3)] px-3 py-2 text-xs font-medium text-[var(--c-text-secondary)] hover:bg-white/5">
                Parcourir…
              </button>
            </div>
            <button type="button" onClick={() => setShowRemotePicker(true)} className="px-0.5 text-[11px] text-[var(--c-accent-text)] hover:underline">
              …ou choisir un fichier sur un hôte enregistré
            </button>
            {sqliteHostId ? (
              <p className="px-0.5 text-[11px] leading-relaxed text-[var(--c-text-muted)]">
                Sur l'hôte « {workspace.hosts.find((h) => h.id === sqliteHostId)?.label ?? "?"} » — copié
                localement à la connexion, renvoyé automatiquement à la fermeture propre de l'onglet.
              </p>
            ) : (
              <p className="px-0.5 text-[11px] leading-relaxed text-[var(--c-text-muted)]">
                Fichier local à cette machine.
              </p>
            )}
          </div>
        ) : (
          <>
            <div className="space-y-1">
              <span className="text-xs font-medium text-[var(--c-text-secondary)]">Tunnel</span>
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
            </div>

            <div className="flex gap-1.5">
              <div className="min-w-0 flex-1 space-y-1">
                <span className="text-xs font-medium text-[var(--c-text-secondary)]">Adresse</span>
                <input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="Adresse" className={`${inputClass} w-full font-mono`} />
              </div>
              <div className="w-20 shrink-0 space-y-1">
                <span className="text-xs font-medium text-[var(--c-text-secondary)]">Port</span>
                <input value={port} onChange={(e) => setPort(e.target.value)} placeholder="Port" inputMode="numeric" className={`${inputClass} w-full font-mono`} />
              </div>
            </div>

            <div className="space-y-1">
              <span className="text-xs font-medium text-[var(--c-text-secondary)]">
                Utilisateur{engine === "redis" ? " (optionnel)" : ""}
              </span>
              <input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder={engine === "redis" ? "Utilisateur ACL (optionnel)" : "Utilisateur"}
                className={inputFullClass}
              />
              {engine === "redis" && !username.trim() && (
                <p className="px-0.5 text-[11px] leading-relaxed text-[var(--c-text-muted)]">
                  Laissé vide : authentification par mot de passe seul (`requirepass`), le cas le plus courant.
                </p>
              )}
            </div>

            <div className="space-y-1">
              <span className="text-xs font-medium text-[var(--c-text-secondary)]">Mot de passe</span>
              <input
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                type="password"
                placeholder={connection ? "Laisser vide pour ne pas changer" : "Mot de passe"}
                className={inputFullClass}
              />
            </div>

            {engine === "redis" ? (
              <div className="space-y-1">
                <span className="text-xs font-medium text-[var(--c-text-secondary)]">Base (0-15)</span>
                <select value={database || "0"} onChange={(e) => setDatabase(e.target.value)} className={selectClass}>
                  {Array.from({ length: 16 }, (_, i) => (
                    <option key={i} value={i}>{i}</option>
                  ))}
                </select>
              </div>
            ) : (
              <div className="space-y-1">
                <span className="text-xs font-medium text-[var(--c-text-secondary)]">Base de données (optionnel)</span>
                <input value={database} onChange={(e) => setDatabase(e.target.value)} placeholder="Base de données (optionnel)" className={inputFullClass} />
                {engine === "postgres" && !database.trim() && (
                  <p className="px-0.5 text-[11px] leading-relaxed text-[var(--c-text-muted)]">
                    Laissé vide : la connexion listera toutes les bases du serveur au lieu d'une seule.
                  </p>
                )}
              </div>
            )}
          </>
        )}

        <div className="flex gap-2 pt-2">
          <button onClick={submit} className="flex-1 rounded-md bg-[var(--c-accent)] px-3 py-2 text-sm font-medium text-white hover:bg-[var(--c-accent-hover)]">
            {connection ? "Enregistrer" : "Ajouter"}
          </button>
          <button onClick={onCancel} className="flex-1 rounded-md bg-[var(--c-bg3)] px-3 py-2 text-sm font-medium text-[var(--c-text)] hover:bg-white/5">
            Annuler
          </button>
        </div>

        {connection && onDeleteConnection && (
          <div className="border-t border-[var(--c-border)] pt-3">
            {confirmDelete ? (
              <div className="space-y-2 rounded-lg bg-rose-950/30 p-3">
                <p className="text-sm text-rose-300">Supprimer cette connexion définitivement ?</p>
                <div className="flex gap-2">
                  <button
                    onClick={() => onDeleteConnection(connection.id)}
                    className="flex-1 rounded-md bg-rose-700 px-3 py-2 text-sm font-medium text-white hover:bg-rose-600"
                  >
                    Oui, supprimer
                  </button>
                  <button onClick={() => setConfirmDelete(false)} className="flex-1 rounded-md bg-[var(--c-bg3)] px-3 py-2 text-sm font-medium text-[var(--c-text)] hover:bg-white/5">
                    Annuler
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => setConfirmDelete(true)}
                className="flex w-full items-center justify-center gap-2 rounded-md py-2 text-sm text-rose-400 hover:bg-rose-950/40 hover:text-rose-300"
              >
                <IconTrash size={13} /> Supprimer cette connexion
              </button>
            )}
          </div>
        )}
      </div>

      {showRemotePicker && (
        <SqliteRemoteFilePicker workspace={workspace} onCancel={() => setShowRemotePicker(false)} onSelect={onRemoteFilePicked} />
      )}
    </div>
  );
}

const inputClass = "rounded-md bg-[var(--c-bg3)] px-3 py-2 text-sm text-[var(--c-text)] placeholder:text-[var(--c-text-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--c-accent-hover)]";
const inputFullClass = `${inputClass} w-full`;
const selectClass = "w-full rounded-md bg-[var(--c-bg3)] px-3 py-2 text-sm text-[var(--c-text)] focus:outline-none focus:ring-1 focus:ring-[var(--c-accent-hover)]";
