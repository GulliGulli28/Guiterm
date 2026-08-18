import { describe, expect, it } from "vitest";
import type { SqlConnection, Workspace } from "./types";
import { attachmentCount, connectionViaHostId, hasAttachments, hostAttachments } from "./hostGraph";

const conn = (over: Partial<SqlConnection> & Pick<SqlConnection, "engine">): SqlConnection =>
  ({ id: "c", label: "db", groupId: null, tags: [], ...over }) as SqlConnection;

const workspace = (over: Partial<Workspace>): Workspace =>
  ({
    hosts: [],
    groups: [],
    snippets: [],
    keychain: [],
    portForwards: [],
    sqlConnections: [],
    ...over,
  }) as unknown as Workspace;

describe("connectionViaHostId", () => {
  it("suit un tunnel SSH", () => {
    expect(connectionViaHostId(conn({ engine: "postgres", tunnel: { kind: "sshHost", hostId: "h1" } }))).toBe("h1");
  });

  it("suit un fichier SQLite posé sur un hôte", () => {
    // SQLite n'a pas de tunnel : le fichier est rapatrié par SFTP. Lire
    // `tunnel` pour ce moteur ne trouverait jamais rien, et le lien serait
    // silencieusement perdu — c'est le cas que cette fonction existe pour
    // ne pas oublier.
    expect(connectionViaHostId(conn({ engine: "sqlite", path: "/srv/app.db", sqliteHostId: "h2" }))).toBe("h2");
  });

  it("suit un tunnel SSH pour MongoDB aussi", () => {
    expect(connectionViaHostId(conn({ engine: "mongodb", connectionString: "mongodb://x", tunnel: { kind: "sshHost", hostId: "h3" } }))).toBe("h3");
  });

  it("ne rattache rien quand la connexion ne passe par aucun hôte enregistré", () => {
    expect(connectionViaHostId(conn({ engine: "mysql", tunnel: { kind: "direct" } }))).toBeNull();
    // SSM traverse bien un relais, mais c'est un identifiant d'instance AWS,
    // pas un hôte de ce workspace : le rattacher inventerait un lien. Cette
    // assertion documente l'intention sans discriminer grand-chose — un tunnel
    // SSM ne porte aucun champ d'hôte, donc même une implémentation qui lirait
    // `tunnel.hostId` à l'aveugle rendrait `null`. Vérifié en la cassant.
    expect(connectionViaHostId(conn({ engine: "mysql", tunnel: { kind: "ssm", target: "i-123" } }))).toBeNull();
    expect(connectionViaHostId(conn({ engine: "sqlite", path: "/tmp/local.db" }))).toBeNull();
    // Une connexion enregistrée avant l'existence du champ : absent vaut
    // « direct », pas « rattachée à on ne sait quoi ».
    expect(connectionViaHostId(conn({ engine: "postgres" }))).toBeNull();
  });
});

describe("hostAttachments", () => {
  const ws = workspace({
    hosts: [
      { id: "bastion", label: "bastion", kind: "ssh" },
      { id: "docker1", label: "docker", kind: "dockerExec", dockerViaHostId: "bastion" },
      { id: "autre", label: "autre", kind: "ssh" },
    ],
    portForwards: [
      { id: "f1", hostId: "bastion", kind: "local", bindAddress: "127.0.0.1", bindPort: 1, destAddress: "d", destPort: 2 },
      { id: "f2", hostId: "autre", kind: "local", bindAddress: "127.0.0.1", bindPort: 3, destAddress: "d", destPort: 4 },
    ],
    sqlConnections: [
      conn({ id: "db1", engine: "postgres", tunnel: { kind: "sshHost", hostId: "bastion" } }),
      conn({ id: "db2", engine: "sqlite", path: "/srv/a.db", sqliteHostId: "bastion" }),
      conn({ id: "db3", engine: "mysql", tunnel: { kind: "direct" } }),
    ],
  } as Partial<Workspace>);

  it("rassemble tout ce qui passe par l'hôte", () => {
    const found = hostAttachments(ws, "bastion");
    expect(found.forwards.map((f) => f.id)).toEqual(["f1"]);
    expect(found.databases.map((d) => d.id)).toEqual(["db1", "db2"]);
    expect(found.relayedHosts.map((h) => h.id)).toEqual(["docker1"]);
    expect(attachmentCount(found)).toBe(4);
  });

  it("n'attribue à un hôte que ce qui le vise", () => {
    const found = hostAttachments(ws, "autre");
    expect(found.forwards.map((f) => f.id)).toEqual(["f2"]);
    expect(found.databases).toEqual([]);
    expect(found.relayedHosts).toEqual([]);
  });

  it("ne rattache pas un hôte à lui-même", () => {
    // Un `dockerViaHostId` pointant sur son propre hôte se listerait sous
    // lui-même, et l'affichage inviterait à ouvrir l'hôte depuis l'hôte.
    const selfRef = workspace({
      hosts: [{ id: "h", label: "h", kind: "dockerExec", dockerViaHostId: "h" }],
    } as Partial<Workspace>);
    expect(hostAttachments(selfRef, "h").relayedHosts).toEqual([]);
  });

  it("rend un résultat vide, pas une erreur, sur un hôte sans rien", () => {
    const empty = hostAttachments(workspace({}), "inconnu");
    expect(hasAttachments(empty)).toBe(false);
    expect(attachmentCount(empty)).toBe(0);
  });
});
