import { describe, expect, it } from "vitest";
import { describeObject, describeSource, directoryOf, parseEndpoint } from "./appObject";
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

describe("parseEndpoint", () => {
  const at = (text: string) => parseEndpoint(text);

  it("lit une adresse nue, sans port", () => {
    expect(at("10.0.3.12")).toEqual({ address: "10.0.3.12", port: null });
    expect(at("db.interne.lan")).toEqual({ address: "db.interne.lan", port: null });
    expect(at("localhost")).toEqual({ address: "localhost", port: null });
  });

  it("lit la forme hôte:port des sorties de ss, netstat et des journaux", () => {
    expect(at("10.0.3.12:5432")).toEqual({ address: "10.0.3.12", port: 5432 });
    expect(at("db.interne.lan:6379")).toEqual({ address: "db.interne.lan", port: 6379 });
  });

  it("ne garde que l'hôte d'une forme SSH", () => {
    // C'est la machine qui est joignable, pas le compte.
    expect(at("deploy@bastion.example.com")).toEqual({ address: "bastion.example.com", port: null });
    expect(at("deploy@10.0.3.12:22")).toEqual({ address: "10.0.3.12", port: 22 });
  });

  it("exige les crochets pour une IPv6 portant un port", () => {
    expect(at("[2001:db8::1]:5432")).toEqual({ address: "2001:db8::1", port: 5432 });
    expect(at("[2001:db8::1]")).toEqual({ address: "2001:db8::1", port: null });
  });

  it("ne devine pas un port au bout d'une IPv6 nue", () => {
    // `2001:db8::1:5432` est une adresse valide à part entière. Deviner qu'on
    // voulait dire « port 5432 » ferait viser une machine qui n'est pas celle
    // affichée — un tunnel silencieusement branché ailleurs.
    expect(at("2001:db8::1:5432")).toEqual({ address: "2001:db8::1:5432", port: null });
  });

  it("refuse un mot quelconque d'une sortie de commande", () => {
    // Le point est exigé dans un nom : sans ça, proposer « ouvrir un tunnel
    // vers failed » discréditerait le menu entier.
    for (const noise of ["failed", "root", "nginx", "", "   ", "Connection", "--verbose", "42"]) {
      expect(at(noise), `« ${noise} » ne devrait pas passer pour une adresse`).toBeNull();
    }
  });

  it("refuse un port impossible plutôt que de l'ignorer", () => {
    // Rendre l'hôte sans son port ferait viser le port par défaut d'un autre
    // service, en silence.
    expect(at("10.0.3.12:0")).toBeNull();
    expect(at("10.0.3.12:70000")).toBeNull();
    expect(at("10.0.3.12:http")).toBeNull();
  });

  it("refuse une IPv4 hors bornes", () => {
    expect(at("999.1.1.1")).toBeNull();
  });

  it("tolère les espaces autour d'une sélection", () => {
    expect(at("  10.0.3.12:5432 \n")).toEqual({ address: "10.0.3.12", port: 5432 });
  });
});
