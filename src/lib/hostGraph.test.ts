import { describe, expect, it } from "vitest";
import type { SqlConnection, Workspace } from "./types";
import { attachmentCount, hasAttachments, hostAttachments } from "./hostGraph";

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

// Les tests de résolution d'hôte (tunnel SSH, fichier SQLite, SSM, connexion
// d'avant le champ) ne sont pas ici : ils existaient déjà dans
// `dbTunnel.test.ts` pour `sqlConnectionViaHostId`, que ce module réutilise.
// Ce fichier ne teste que ce qui est neuf : l'agrégation par hôte.

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
