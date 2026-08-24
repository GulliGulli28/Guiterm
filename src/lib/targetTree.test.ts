import { describe, expect, it } from "vitest";
import { buildTargetTree, type TargetLike } from "./targetTree";
import type { Group, GroupId, Host, HostId } from "./types";

function host(id: string, label: string, groupId: string | null, extra: Partial<Host> = {}): Host {
  return {
    id: id as HostId,
    label,
    address: `${label}.example`,
    port: 22,
    username: "root",
    auth: "agent",
    groupId: groupId as GroupId | null,
    jumpVia: [],
    tags: [],
    startupSnippets: [],
    envVars: [],
    ...extra,
  } as Host;
}

function group(id: string, name: string, parentId: string | null = null): Group {
  return { id: id as GroupId, name, parentId: parentId as GroupId | null };
}

interface T extends TargetLike { key: string; label: string; sub: string; hostId?: HostId | null }
const target = (key: string, label: string, hostId: string | null, sub = ""): T =>
  ({ key, label, sub, hostId: hostId as HostId | null });

const GROUPS = [group("g-prod", "Prod"), group("g-web", "Web", "g-prod"), group("g-lab", "Lab")];
const HOSTS = [
  host("h-api", "api", "g-web", { tags: ["prod", "eu-west"] }),
  host("h-lab", "labo", "g-lab"),
  host("h-racine", "racine", null),
  host("h-docker", "dockerhôte", "g-prod", { kind: "dockerExec", tags: ["conteneurs"] }),
];
const TARGETS: T[] = [
  target("local", "Terminal local", null),
  target("ssh:h-api", "api", "h-api"),
  target("ssh:h-lab", "labo", "h-lab"),
  target("ssh:h-racine", "racine", "h-racine"),
  target("docker:h-docker:c1", "nginx", "h-docker"),
  target("docker:h-docker:c2", "redis", "h-docker"),
];

const build = (query = "") =>
  buildTargetTree({ targets: TARGETS, hosts: HOSTS, groups: GROUPS, query });

/** Les lignes sous une forme lisible : « profondeur type:libellé ». */
function shape(query = ""): string[] {
  return build(query).rows.map((row) => {
    const label =
      row.kind === "group" ? `dossier:${row.group.name}`
      : row.kind === "host" ? `hôte:${row.host.label}`
      : `cible:${row.target.label}`;
    return `${row.depth} ${label}`;
  });
}

describe("buildTargetTree", () => {
  it("range chaque cible sous le dossier de son hôte, dossiers imbriqués compris", () => {
    // Dossiers avant hôtes à chaque niveau, et triés par nom — donc Lab avant
    // Prod, comme la barre latérale les range.
    expect(shape()).toEqual([
      "0 cible:Terminal local",
      "0 dossier:Lab",
      "1 cible:labo",
      "0 dossier:Prod",
      "1 dossier:Web",
      "2 cible:api",
      // L'hôte Docker est un en-tête, pas une cible : ses conteneurs sont
      // les cibles, un cran plus bas.
      "1 hôte:dockerhôte",
      "2 cible:nginx",
      "2 cible:redis",
      "0 cible:racine",
    ]);
  });

  it("épingle en tête ce qui n'appartient à aucun hôte", () => {
    expect(shape()[0]).toBe("0 cible:Terminal local");
  });

  it("fait porter à un dossier toutes les clés de son sous-arbre", () => {
    const prod = build().rows.find((r) => r.kind === "group" && r.group.name === "Prod");
    expect(prod?.kind).toBe("group");
    // Prod contient Web (donc api) et l'hôte Docker (donc ses deux conteneurs).
    expect(prod?.kind === "group" && prod.keys.sort()).toEqual(
      ["docker:h-docker:c1", "docker:h-docker:c2", "ssh:h-api"],
    );
  });

  it("fait porter à un hôte relais les clés de ses conteneurs", () => {
    const relay = build().rows.find((r) => r.kind === "host");
    expect(relay?.kind === "host" && relay.keys).toEqual(["docker:h-docker:c1", "docker:h-docker:c2"]);
  });

  it("retrouve une cible par un tag de son hôte", () => {
    // « eu-west » n'apparaît ni dans le libellé ni dans le sous-titre : c'est
    // un tag de l'hôte, et c'est tout l'intérêt.
    expect(shape("eu-west")).toEqual(["0 dossier:Prod", "1 dossier:Web", "2 cible:api"]);
  });

  it("prête à un conteneur les tags de son hôte relais", () => {
    expect(shape("conteneurs")).toEqual(["0 dossier:Prod", "1 hôte:dockerhôte", "2 cible:nginx", "2 cible:redis"]);
  });

  it("fait disparaître les dossiers vidés par la recherche", () => {
    expect(shape("labo")).toEqual(["0 dossier:Lab", "1 cible:labo"]);
  });

  it("exige que tous les mots correspondent", () => {
    expect(shape("api introuvable")).toEqual([]);
  });

  it("ne liste dans visibleKeys que ce qui est cochable, dans l'ordre affiché", () => {
    // Ni les dossiers ni les hôtes relais n'y figurent : « Tout sélectionner »
    // ne doit cocher que de vraies cibles.
    expect(build().visibleKeys).toEqual([
      "local", "ssh:h-lab", "ssh:h-api", "docker:h-docker:c1", "docker:h-docker:c2", "ssh:h-racine",
    ]);
  });

  it("ne boucle pas sur un dossier dont le parent est lui-même", () => {
    const cyclic = [{ ...group("g-boucle", "Boucle"), parentId: "g-boucle" as GroupId }];
    const tree = buildTargetTree({
      targets: [target("ssh:h", "h", "h")],
      hosts: [host("h", "h", "g-boucle")],
      groups: cyclic,
      query: "",
    });
    // Le dossier n'est atteignable depuis aucune racine : sa cible n'apparaît
    // pas, mais la construction se termine.
    expect(tree.rows).toEqual([]);
  });
});
