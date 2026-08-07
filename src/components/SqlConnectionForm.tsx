import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import type { DbTunnel, HostId, SqlConnection, SqlConnectionId, SqlEngine, SqlEngineConfig, Workspace } from "../lib/types";
import { DIRECT_TUNNEL, sqlConnectionTunnel } from "../lib/types";
import { IconTrash } from "./ui-icons";
import { DbTunnelPicker, type ProbeTarget } from "./DbTunnelPicker";
import { SqliteRemoteFilePicker } from "./SqliteRemoteFilePicker";

/** What the form submits: the identity/grouping fields plus exactly the
 * engine-specific config that engine actually has (see `SqlEngineConfig`),
 * which is the same flattened shape `save_sql_connection` deserialises. */
export type SqlConnectionFormData = {
  id: SqlConnectionId | null;
  label: string;
  groupId: null;
  tags: string[];
  /** Plaintext password, stored in the vault by the backend — `null` leaves
   * whichever password is already stored untouched. */
  secret: string | null;
} & SqlEngineConfig;

interface SqlConnectionFormProps {
  workspace: Workspace;
  /** `null` — a new connection. */
  connection: SqlConnection | null;
  onCancel: () => void;
  onSave: (input: SqlConnectionFormData) => void;
  onDeleteConnection?: (id: SqlConnectionId) => void;
}

const DEFAULT_PORTS: Record<Exclude<SqlEngine, "sqlite" | "mongodb">, string> = { mysql: "3306", postgres: "5432", redis: "6379" };

const SQLITE_FILTERS = [{ name: "SQLite", extensions: ["sqlite", "sqlite3", "db"] }, { name: "Tous les fichiers", extensions: ["*"] }];

/** Client-side heuristic only (the backend has the authoritative check at
 * connect time) — a plain single-host `mongodb://host:port/...` string can
 * be tunnelled through one TCP forward; `mongodb+srv://` (DNS-based
 * discovery) or a comma-joined multi-host string can't, see
 * `core::mongo_client::connect`'s doc comment for why. */
function isTunnelableMongoUri(uri: string): boolean {
  return mongoProbeTarget(uri) !== null;
}

/** The host/port a MongoDB URI points at, when it points at exactly one — the
 * same single-host restriction `isTunnelableMongoUri` expresses, but returning
 * what the "Tester" button needs to dial rather than a boolean. `null` for
 * `mongodb+srv://` and multi-host strings, which no single TCP forward can
 * carry (see `core::mongo_client::connect`). */
function mongoProbeTarget(uri: string): ProbeTarget | null {
  const trimmed = uri.trim();
  if (!trimmed.startsWith("mongodb://")) return null;
  const afterScheme = trimmed.slice("mongodb://".length);
  const hostPart = afterScheme.split("@").pop() ?? afterScheme;
  const hostOnly = hostPart.split(/[/?]/)[0];
  if (!hostOnly || hostOnly.includes(",")) return null;
  const [address, port] = hostOnly.split(":");
  if (!address) return null;
  return { address, port: port ? Number(port) : 27017 };
}

/** Right-panel form for creating/editing a SQL connection — same slot and
 * layout as `HostForm`/`GroupForm` (see `App.tsx`'s `showRightPanel`), rather
 * than an inline expansion in `SqlConnectionsPanel`'s list. */
export function SqlConnectionForm({ workspace, connection, onCancel, onSave, onDeleteConnection }: SqlConnectionFormProps) {
  // The form keeps one flat field per input regardless of engine (so switching
  // engine mid-edit doesn't discard what's already typed); these narrow the
  // incoming connection once so each `useState` below can seed from it.
  const existingServer =
    connection && (connection.engine === "mysql" || connection.engine === "postgres" || connection.engine === "redis")
      ? connection
      : null;
  const existingSqlite = connection?.engine === "sqlite" ? connection : null;
  const existingMongo = connection?.engine === "mongodb" ? connection : null;

  const [label, setLabel] = useState(connection?.label ?? "");
  const [engine, setEngine] = useState<SqlEngine>(connection?.engine ?? "mysql");
  // One tunnel for the whole form, shared by the server engines and MongoDB:
  // switching engine mid-edit keeps it, exactly like every other flat field
  // here.
  const [tunnel, setTunnel] = useState<DbTunnel>(connection ? sqlConnectionTunnel(connection) : DIRECT_TUNNEL);
  const [tls, setTls] = useState(existingServer?.tls ?? false);
  const [mongoTls, setMongoTls] = useState(existingMongo?.tls ?? false);
  const [mongoCaFile, setMongoCaFile] = useState(existingMongo?.tlsCaFile ?? "");
  const [mongoInsecure, setMongoInsecure] = useState(existingMongo?.tlsInsecure ?? false);
  const [address, setAddress] = useState(existingServer?.address ?? "");
  const [port, setPort] = useState(String(existingServer?.port ?? DEFAULT_PORTS.mysql));
  const [username, setUsername] = useState(existingServer?.username ?? existingMongo?.username ?? "");
  const [password, setPassword] = useState("");
  const [database, setDatabase] = useState(existingServer?.database ?? "");
  const [path, setPath] = useState(existingSqlite?.path ?? "");
  const [sqliteHostId, setSqliteHostId] = useState<HostId | "">(existingSqlite?.sqliteHostId ?? "");
  const [connectionString, setConnectionString] = useState(existingMongo?.connectionString ?? "");
  const [showRemotePicker, setShowRemotePicker] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Only switches the port if it's still at one engine's default — a custom
  // port the user already typed in is left untouched. No port to switch for
  // `sqlite`/`mongodb` (neither uses a discrete port field — see `DEFAULT_PORTS`).
  const onEngineChange = (next: SqlEngine) => {
    setEngine(next);
    if (next !== "sqlite" && next !== "mongodb" && Object.values(DEFAULT_PORTS).includes(port)) setPort(DEFAULT_PORTS[next]);
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
        engine: "sqlite",
        path: path.trim(),
        sqliteHostId: sqliteHostId || null,
        groupId: null,
        tags: [],
        secret: null,
      });
      return;
    }
    if (engine === "mongodb") {
      if (!connectionString.trim()) {
        setError("Chaîne de connexion MongoDB manquante");
        return;
      }
      onSave({
        id: connection?.id ?? null,
        label: label.trim(),
        engine: "mongodb",
        connectionString: connectionString.trim(),
        username: username.trim(),
        tunnel,
        tls: mongoTls,
        tlsCaFile: mongoCaFile.trim() || null,
        tlsInsecure: mongoInsecure,
        groupId: null,
        tags: [],
        secret: password || null,
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
      // Narrowed by the two early returns above: `sqlite`/`mongodb` are
      // already handled, so only the TCP-dialled engines reach here.
      engine,
      tunnel,
      address: address.trim(),
      port: p,
      username: username.trim(),
      database: database.trim() || null,
      tls,
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
            <option value="mongodb">MongoDB</option>
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
        ) : engine === "mongodb" ? (
          <>
            <div className="space-y-1">
              <span className="text-xs font-medium text-[var(--c-text-secondary)]">Chaîne de connexion</span>
              <textarea
                value={connectionString}
                onChange={(e) => setConnectionString(e.target.value)}
                placeholder="mongodb://hôte:27017/ma_base ou mongodb+srv://cluster.xyz.mongodb.net/ma_base"
                rows={2}
                spellCheck={false}
                className={`${inputClass} w-full resize-y font-mono`}
              />
              <p className="px-0.5 text-[11px] leading-relaxed text-[var(--c-text-muted)]">
                Peut inclure directement les identifiants (mongodb://utilisateur:motdepasse@hôte/base), ou les
                laisser dans les champs ci-dessous — insérés automatiquement à la connexion.
              </p>
            </div>

            <div className="space-y-1">
              <DbTunnelPicker
                workspace={workspace}
                value={tunnel}
                onChange={setTunnel}
                probeTarget={mongoProbeTarget(connectionString)}
              />
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={mongoTls} onChange={(e) => setMongoTls(e.target.checked)} className="h-4 w-4 accent-[var(--c-accent)]" />
                <span className="text-xs text-[var(--c-text-secondary)]">
                  Connexion chiffrée (TLS)
                  <span className="ml-1 text-[var(--c-text-faint)]">— exigé par DocumentDB</span>
                </span>
              </label>
              {mongoTls && (
                <>
                  <input
                    value={mongoCaFile}
                    onChange={(e) => setMongoCaFile(e.target.value)}
                    placeholder="Bundle CA (optionnel) — vide : magasin de certificats du système"
                    className={`${inputClass} w-full font-mono`}
                  />
                  <label className="flex items-start gap-2">
                    <input type="checkbox" checked={mongoInsecure} onChange={(e) => setMongoInsecure(e.target.checked)} className="mt-0.5 h-4 w-4 accent-[var(--c-accent)]" />
                    <span className="text-xs text-[var(--c-text-secondary)]">
                      Ne pas vérifier le certificat
                      <span className="ml-1 text-[var(--c-text-faint)]">
                        — nécessaire pour combiner TLS et un tunnel : le certificat du serveur ne peut
                        pas correspondre à l'adresse locale du tunnel. Le cas typique est DocumentDB,
                        qui n'accepte que TLS et n'est jamais joignable publiquement.
                      </span>
                    </span>
                  </label>
                </>
              )}
              {tunnel.kind !== "direct" && !isTunnelableMongoUri(connectionString) && (
                <p className="px-0.5 text-[11px] leading-relaxed text-amber-400">
                  Un tunnel ne fonctionne qu'avec une chaîne mongodb:// mono-hôte — mongodb+srv:// ou une
                  liste d'hôtes séparés par des virgules ne peut pas passer par un tunnel TCP unique. La
                  connexion échouera tant que ce tunnel est sélectionné avec cette chaîne.
                </p>
              )}
            </div>

            <div className="space-y-1">
              <span className="text-xs font-medium text-[var(--c-text-secondary)]">Utilisateur (optionnel)</span>
              <input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="Si non inclus dans la chaîne de connexion"
                className={inputFullClass}
              />
            </div>

            <div className="space-y-1">
              <span className="text-xs font-medium text-[var(--c-text-secondary)]">Mot de passe</span>
              <input
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                type="password"
                placeholder={connection ? "Laisser vide pour ne pas changer" : "Mot de passe (optionnel)"}
                className={inputFullClass}
              />
            </div>
          </>
        ) : (
          <>
            <DbTunnelPicker
              workspace={workspace}
              value={tunnel}
              onChange={setTunnel}
              probeTarget={address.trim() && Number.isInteger(Number(port)) ? { address: address.trim(), port: Number(port) } : null}
            />

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
            {/* Redis only: MySQL and PostgreSQL negotiate TLS through sqlx's
                own defaults and have never needed a switch here. */}
            {engine === "redis" && (
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={tls} onChange={(e) => setTls(e.target.checked)} className="h-4 w-4 accent-[var(--c-accent)]" />
                <span className="text-xs text-[var(--c-text-secondary)]">
                  Connexion chiffrée (TLS)
                  <span className="ml-1 text-[var(--c-text-faint)]">— requis par ElastiCache avec chiffrement en transit</span>
                </span>
              </label>
            )}

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
