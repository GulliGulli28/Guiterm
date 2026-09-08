import { describe, expect, it } from "vitest";
import { describeObject, describeSource, directoryOf } from "./appObject";
import type { Workspace } from "./types";

const workspace = {
  hosts: [{ id: "h1", label: "prod-web-1" }],
} as unknown as Workspace;

describe("describeSource", () => {
  it("ne dit rien de la machine locale", () => {
    // « /etc/hosts — cette machine » n'apprend rien qu'un chemin local ne dise
    // déjà, et allongerait chaque en-tête de menu pour rien.
    expect(describeSource({ kind: "local" }, workspace)).toBe("");
  });

  it("nomme l'hôte, le conteneur et le pod", () => {
    expect(describeSource({ kind: "remote", hostId: "h1" }, workspace)).toBe("prod-web-1");
    expect(describeSource({ kind: "docker", hostId: "h1", containerId: "abc123" }, workspace)).toBe("prod-web-1 : abc123");
    expect(describeSource({ kind: "k8s", hostId: "h1", podName: "api-0", containerName: null }, workspace)).toBe("prod-web-1 : api-0");
  });

  it("dit qu'un hôte a disparu au lieu de rendre une chaîne vide", () => {
    // Le cas arrive : l'hôte peut être supprimé pendant qu'un onglet le
    // référence encore. Un nom vide laisserait croire à un objet sans nom.
    expect(describeSource({ kind: "remote", hostId: "parti" }, workspace)).toBe("hôte supprimé");
  });
});

describe("describeObject", () => {
  it("accole le chemin et sa provenance", () => {
    expect(describeObject(
      { kind: "remotePath", source: { kind: "remote", hostId: "h1" }, path: "/var/log", isDir: true },
      workspace,
    )).toBe("/var/log — prod-web-1");
  });

  it("laisse un chemin local nu", () => {
    expect(describeObject(
      { kind: "remotePath", source: { kind: "local" }, path: "/home/moi", isDir: true },
      workspace,
    )).toBe("/home/moi");
  });
});

describe("directoryOf", () => {
  const at = (path: string, isDir: boolean) =>
    directoryOf({ kind: "remotePath", source: { kind: "local" }, path, isDir });

  it("rend un dossier tel quel", () => {
    expect(at("/etc/nginx", true)).toBe("/etc/nginx");
  });

  it("remonte au parent depuis un fichier", () => {
    expect(at("/etc/nginx/nginx.conf", false)).toBe("/etc/nginx");
  });

  it("ne quitte pas la racine POSIX", () => {
    expect(at("/passwd", false)).toBe("/");
  });

  it("remonte correctement sous Windows", () => {
    // Le panneau **gauche** d'un transfert est local : sous Windows un
    // `remotePath` vaut bien `C:\...`, et un découpage sur `/` renverrait ici
    // la racine du disque au lieu du dossier — le bug que raconte
    // `panePath.ts`.
    expect(at("C:\\Users\\moi\\notes.txt", false)).toBe("C:\\Users\\moi");
    expect(at("C:\\notes.txt", false)).toBe("C:\\");
  });
});
