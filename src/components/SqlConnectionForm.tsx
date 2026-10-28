import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import type { DbTunnel, GroupId, GuiVaultVault, HostId, SqlConnection, SqlConnectionId, SqlEngine, SqlEngineConfig, VaultId, Workspace } from "../lib/types";
import { DIRECT_TUNNEL, sqlConnectionTunnel, sqlEngineLabel } from "../lib/types";
import { IconDatabase, IconFolder, IconKeychain, IconTunnels } from "./ui-icons";
import { DbTunnelPicker, type ProbeTarget } from "./DbTunnelPicker";
import { RemoteFilePicker } from "./RemoteFilePicker";
import { ReadOnlyVaultNotice, VaultField, readOnlyVault } from "./VaultField";
import { GroupTreePicker } from "./GroupTreePicker";
import { DrawerDeleteButton, DrawerSaveButton, FormDrawer, type FormSection } from "./FormDrawer";
import { assertNever } from "../lib/exhaustive";
import { groupPath } from "../lib/hostTree";

/** What the form submits: the identity/grouping fields plus exactly the
 * engine-specific config that engine actually has (see `SqlEngineConfig`),
 * which is the same flattened shape `save_sql_connection` deserialises. */
export type SqlConnectionFormData = {
  id: SqlConnectionId | null;
  label: string;
  groupId: GroupId | null;
  tags: string[];
  /** Plaintext password, stored in the vault by the backend — `null` leaves
   * whichever password is already stored untouched. */
  secret: string | null;
} & SqlEngineConfig;

interface SqlConnectionFormProps {
  workspace: Workspace;
  /** `null` — a new connection. */
  connection: SqlConnection | null;
  /** Les vaults du compte connecté — vide sans compte : pas de champ. */
  vaults?: GuiVaultVault[];
  /** Affiliation actuelle (`null` = personnel). */
  vaultId?: VaultId | null;
  onCancel: () => void;
  /** `vaultId` en plus des données : le vault choisi (`null` = personnel),
   * absent quand le champ n'est pas affiché. */
  onSave: (input: SqlConnectionFormData, vaultId?: VaultId | null) => void;
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

/** Les sections du tiroir. SQLite n'a ni authentification ni réseau : c'est
 * un fichier. */
type SqlFormSection = "connexion" | "auth" | "reseau" | "organisation";

function sqlSectionsFor(engine: SqlEngine): SqlFormSection[] {
  switch (engine) {
    case "sqlite":
      return ["connexion", "organisation"];
    case "mysql":
    case "postgres":
    case "redis":
    case "mongodb":
      return ["connexion", "auth", "reseau", "organisation"];
    default:
      return assertNever(engine, "moteur");
  }
}

/** Form for creating/editing a database connection, in the same drawer as
 * `HostForm`/`GroupForm` (`FormDrawer`), rather than an inline expansion in
 * `SqlConnectionsPanel`'s list. */
export function SqlConnectionForm({ workspace, connection, vaults = [], vaultId: initialVaultId = null, onCancel, onSave: onSaveProp, onDeleteConnection }: SqlConnectionFormProps) {
  const [vaultId, setVaultId] = useState<VaultId | "">(initialVaultId ?? "");
  const readOnlyIn = readOnlyVault(vaults, initialVaultId);
  // Le vault n'est transmis que si le champ est affiché : sans compte, rien
  // à changer.
  const onSave = (input: SqlConnectionFormData) =>
    onSaveProp(input, vaults.some((v) => v.kind === "shared") || vaultId !== "" ? vaultId || null : undefined);
  // The form keeps one flat field per input regardless of engine (so switching
  // engine mid-edit doesn't discard what's already typed); these narrow the
  // incoming connection once so each `useState` below can seed from it.
  const existingServer =
    connection && (connection.engine === "mysql" || connection.engine === "postgres" || connection.engine === "redis")
      ? connection
      : null;
  const existingSqlite = connection?.engine === "sqlite" ? connection : null;
  const existingMongo = connection?.engine === "mongodb" ? connection : null;

  const [section, setSection] = useState<SqlFormSection>("connexion");
  const [label, setLabel] = useState(connection?.label ?? "");
  const [groupId, setGroupId] = useState<GroupId | null>(connection?.groupId ?? null);
  // Le formulaire ne montre pas les étiquettes : il garde celles qui y sont
  // (un import AWS en pose), au lieu de les effacer à l'enregistrement.
  const tags = connection?.tags ?? [];
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
    setSection("connexion");
    if (!label.trim()) {
      setError("Le nom est requis");
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
        groupId,
        tags,
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
        groupId,
        tags,
        secret: password || null,
      });
      return;
    }
    const p = Number(port);
    // `username` is optional for Redis (empty means legacy `requirepass`-only
    // auth, still the common case) — required for MySQL/PostgreSQL.
    if (!address.trim() || !Number.isInteger(p) || p < 1 || p > 65535) {
      setError("Adresse ou port invalide");
      return;
    }
    if (engine !== "redis" && !username.trim()) {
      setSection("auth");
      setError("L'utilisateur est requis");
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
      groupId,
      tags,
      secret: password || null,
    });
  };

  const visibleSections = sqlSectionsFor(engine);
  const activeSection = visibleSections.includes(section) ? section : "connexion";
  const folderPath = groupPath(workspace.groups, groupId);
  const viaHost = (id: HostId) => workspace.hosts.find((h) => h.id === id)?.label ?? "hôte inconnu";
  const target = engine === "sqlite"
    ? (path.trim() ? path.trim().replace(/\\/g, "/").split("/").pop() : "fichier à choisir")
    : engine === "mongodb"
      ? (mongoProbeTarget(connectionString)?.address ?? (connectionString.trim() ? "chaîne de connexion" : "chaîne à saisir"))
      : (address.trim() ? `${address.trim()}:${port}` : "adresse à saisir");
  const tunnelSummary = tunnel.kind === "direct" ? "Directe" : tunnel.kind === "sshHost" ? `via ${viaHost(tunnel.hostId)}` : `SSM · ${tunnel.target}`;
  const SECTIONS: Record<SqlFormSection, FormSection<SqlFormSection>> = {
    connexion: { id: "connexion", label: "Connexion", icon: <IconDatabase size={13} />, summary: `${sqlEngineLabel(engine)} · ${target}` },
    auth: { id: "auth", label: "Authentification", icon: <IconKeychain size={13} />, summary: username.trim() || "Sans utilisateur" },
    reseau: { id: "reseau", label: "Réseau", icon: <IconTunnels size={13} />, summary: tunnelSummary },
    organisation: { id: "organisation", label: "Organisation", icon: <IconFolder size={13} />, summary: folderPath.length ? folderPath[folderPath.length - 1] : "Racine" },
  };
  const vaultName = vaults.find((v) => v.id === (vaultId || initialVaultId))?.name ?? null;

  const passwordField = (
    <div className="space-y-1">
      <span className="field-label">Mot de passe</span>
      <input
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        type="password"
        placeholder={connection ? "Laisser vide pour ne pas changer" : engine === "mongodb" ? "Mot de passe (optionnel)" : "Mot de passe"}
        className={inputFullClass}
      />
    </div>
  );

  const renderConnexion = () => (
    <div className="space-y-4">
      <div>
        <span className="field-label">Nom</span>
        <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Nom" data-autofocus className={inputFullClass} />
      </div>

      <div>
        <span className="field-label">Moteur</span>
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
          <span className="field-label">Fichier SQLite</span>
          <div className="flex gap-1.5">
            <input
              value={path}
              onChange={(e) => { setPath(e.target.value); setSqliteHostId(""); }}
              placeholder="Chemin du fichier .sqlite / .db"
              className={`${inputClass} input-mono w-full`}
            />
            <button type="button" onClick={browseLocalFile} className="btn btn-ghost shrink-0">
              Parcourir…
            </button>
          </div>
          <button type="button" onClick={() => setShowRemotePicker(true)} className="px-0.5 text-[11px] text-[var(--c-accent-text)] hover:underline">
            …ou choisir un fichier sur un hôte enregistré
          </button>
          {sqliteHostId ? (
            <p className="help-text px-0.5" title="Copié localement à la connexion, renvoyé automatiquement à la fermeture propre de l'onglet.">
              Sur l'hôte « {workspace.hosts.find((h) => h.id === sqliteHostId)?.label ?? "?"} », copié le temps de l'onglet.
            </p>
          ) : (
            <p className="help-text px-0.5">Fichier local à cette machine.</p>
          )}
        </div>
      ) : engine === "mongodb" ? (
        <>
          <div className="space-y-1">
            <span className="field-label">Chaîne de connexion</span>
            <textarea
              value={connectionString}
              onChange={(e) => setConnectionString(e.target.value)}
              placeholder="mongodb://hôte:27017/ma_base ou mongodb+srv://cluster.xyz.mongodb.net/ma_base"
              rows={2}
              spellCheck={false}
              className={`${inputClass} w-full resize-y font-mono`}
            />
            <p className="help-text px-0.5" title="mongodb://utilisateur:motdepasse@hôte/base marche aussi ; les champs de la section Authentification sont insérés à la connexion.">
              Les identifiants vont de préférence dans la section Authentification.
            </p>
          </div>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={mongoTls} onChange={(e) => setMongoTls(e.target.checked)} className="h-3.5 w-3.5" />
            <span className="text-[12px] text-[var(--c-text-secondary)]">
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
                className={`${inputClass} input-mono w-full`}
              />
              <label className="flex items-start gap-2">
                <input type="checkbox" checked={mongoInsecure} onChange={(e) => setMongoInsecure(e.target.checked)} className="mt-0.5 h-3.5 w-3.5" />
                <span
                  className="text-[12px] text-[var(--c-text-secondary)]"
                  title="Le certificat du serveur ne peut pas correspondre à l'adresse locale d'un tunnel. Le cas typique est DocumentDB, qui n'accepte que TLS et n'est jamais joignable publiquement."
                >
                  Ne pas vérifier le certificat
                  <span className="ml-1 text-[var(--c-text-faint)]">— nécessaire pour combiner TLS et un tunnel</span>
                </span>
              </label>
            </>
          )}
        </>
      ) : (
        <>
          <div className="grid grid-cols-[minmax(0,1fr)_96px] gap-3">
            <div className="min-w-0 space-y-1">
              <span className="field-label">Adresse</span>
              <input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="Adresse" className={`${inputClass} input-mono w-full`} />
            </div>
            <div className="space-y-1">
              <span className="field-label">Port</span>
              <input value={port} onChange={(e) => setPort(e.target.value)} placeholder="Port" inputMode="numeric" className={`${inputClass} input-mono w-full`} />
            </div>
          </div>
          {/* Redis only: MySQL and PostgreSQL negotiate TLS through sqlx's
              own defaults and have never needed a switch here. */}
          {engine === "redis" && (
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={tls} onChange={(e) => setTls(e.target.checked)} className="h-3.5 w-3.5" />
              <span className="text-[12px] text-[var(--c-text-secondary)]">
                Connexion chiffrée (TLS)
                <span className="ml-1 text-[var(--c-text-faint)]">— requis par ElastiCache avec chiffrement en transit</span>
              </span>
            </label>
          )}
          {engine === "redis" ? (
            <div className="space-y-1">
              <span className="field-label">Base (0-15)</span>
              <select value={database || "0"} onChange={(e) => setDatabase(e.target.value)} className={selectClass}>
                {Array.from({ length: 16 }, (_, i) => (
                  <option key={i} value={i}>{i}</option>
                ))}
              </select>
            </div>
          ) : (
            <div className="space-y-1">
              <span className="field-label">Base de données (optionnel)</span>
              <input value={database} onChange={(e) => setDatabase(e.target.value)} placeholder="Base de données (optionnel)" className={inputFullClass} />
              {engine === "postgres" && !database.trim() && (
                <p className="help-text px-0.5">Laissée vide : toutes les bases du serveur sont listées.</p>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );

  const renderAuth = () => (
    <div className="space-y-4">
      {engine === "mongodb" ? (
        <div className="space-y-1">
          <span className="field-label">Utilisateur (optionnel)</span>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="Si non inclus dans la chaîne de connexion"
            className={inputFullClass}
          />
        </div>
      ) : (
        <div className="space-y-1">
          <span className="field-label">
            Utilisateur{engine === "redis" ? " (optionnel)" : ""}
          </span>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder={engine === "redis" ? "Utilisateur ACL (optionnel)" : "Utilisateur"}
            className={inputFullClass}
          />
          {engine === "redis" && !username.trim() && (
            <p className="help-text px-0.5">Laissé vide : mot de passe seul (`requirepass`), le cas le plus courant.</p>
          )}
        </div>
      )}
      {passwordField}
    </div>
  );

  const renderReseau = () => (
    <div className="space-y-4">
      <DbTunnelPicker
        workspace={workspace}
        value={tunnel}
        onChange={setTunnel}
        probeTarget={engine === "mongodb"
          ? mongoProbeTarget(connectionString)
          : address.trim() && Number.isInteger(Number(port)) ? { address: address.trim(), port: Number(port) } : null}
      />
      {engine === "mongodb" && tunnel.kind !== "direct" && !isTunnelableMongoUri(connectionString) && (
        <p
          className="callout callout-warn"
          title="mongodb+srv:// ou une liste d'hôtes séparés par des virgules ne peut pas passer par un tunnel TCP unique."
        >
          Un tunnel ne marche qu'avec une chaîne mongodb:// à un seul hôte : la connexion échouera avec celle-ci.
        </p>
      )}
    </div>
  );

  const renderOrganisation = () => (
    <div className="space-y-4">
      <div className="space-y-1">
        <span className="field-label">Dossier</span>
        <GroupTreePicker groups={workspace.groups} value={groupId} onChange={setGroupId} customIcons={workspace.customIcons} />
      </div>
      <VaultField vaults={vaults} value={vaultId} onChange={setVaultId} readOnly={readOnlyIn !== null} hint="L'hôte de son tunnel, s'il y en a un, est proposé." />
    </div>
  );

  const renderSection = () => {
    switch (activeSection) {
      case "connexion": return renderConnexion();
      case "auth": return renderAuth();
      case "reseau": return renderReseau();
      case "organisation": return renderOrganisation();
      default: return assertNever(activeSection, "section du formulaire de connexion");
    }
  };

  return (
    <FormDrawer
      title={connection ? connection.label : "Nouvelle connexion"}
      subtitle={
        <>
          {vaultName && <span className="truncate">{vaultName}</span>}
          {vaultName && <span aria-hidden="true">·</span>}
          <span className="truncate">{folderPath.length ? folderPath.join(" › ") : "Racine"}</span>
        </>
      }
      icon={<IconDatabase size={16} />}
      sections={visibleSections.map((id) => SECTIONS[id])}
      active={activeSection}
      onSection={setSection}
      onCancel={onCancel}
      onSubmit={submit}
      submitDisabled={readOnlyIn !== null}
      footer={
        <>
          {connection && onDeleteConnection && readOnlyIn === null && (
            <DrawerDeleteButton
              what="cette connexion"
              confirming={confirmDelete}
              onAsk={() => setConfirmDelete(true)}
              onConfirm={() => onDeleteConnection(connection.id)}
              onCancel={() => setConfirmDelete(false)}
            />
          )}
          <span className="flex-1" />
          <button type="button" onClick={onCancel} className="btn btn-ghost">Annuler</button>
          <DrawerSaveButton label={connection ? "Enregistrer" : "Ajouter"} onClick={submit} disabled={readOnlyIn !== null} />
        </>
      }
    >
      <fieldset disabled={readOnlyIn !== null} className="contents min-w-0">
      <div data-sql-form-section={activeSection} className="space-y-4">
        {readOnlyIn && <ReadOnlyVaultNotice vault={readOnlyIn} what="cette connexion" />}
        {error && <p className="callout callout-danger">{error}</p>}
        {renderSection()}
      </div>
      </fieldset>

      {showRemotePicker && (
        <RemoteFilePicker workspace={workspace} onCancel={() => setShowRemotePicker(false)} onSelect={onRemoteFilePicked} />
      )}
    </FormDrawer>
  );
}

const inputClass = "input";
const inputFullClass = inputClass;
const selectClass = "input";
