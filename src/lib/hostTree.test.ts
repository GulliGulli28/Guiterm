import { describe, expect, it } from "vitest";
import { buildHostTree } from "./hostTree";
import type { Group, GroupId, Host, HostId } from "./types";

// L'arbre de la barre latérale n'était jusqu'ici exercé que par le rendu de
// `HostsPanel` — donc pas du tout. Le sortir en fonction pure sert d'abord à
// ça : ces cas échouent si l'indexation, le tri ou la remontée des dossiers
// correspondants se trompent, ce qu'aucun test ne voyait avant.

function host(label: string, groupId: string | null, extra: Partial<Host> = {}): Host {
  return {
    id: `h-${label}` as HostId,
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

function group(id: string, name: string, parentId: string | null): Group {
  return { id: id as GroupId, name, parentId: parentId as GroupId | null };
}

describe("buildHostTree", () => {
  const groups = [
    group("prod", "Prod", null),
    group("web", "Web", "prod"),
    group("db", "Db", "prod"),
    group("lab", "Lab", null),
  ];
  const hosts = [
    host("zeta", null),
    host("alpha", null),
    host("nginx", "web"),
    host("pg", "db"),
  ];

  it("indexe les hôtes par dossier, triés par libellé", () => {
    const { hostsByGroup } = buildHostTree(hosts, groups, "");
    expect(hostsByGroup.get(null)?.map((h) => h.label)).toEqual(["alpha", "zeta"]);
    expect(hostsByGroup.get("web" as GroupId)?.map((h) => h.label)).toEqual(["nginx"]);
    // Un dossier sans hôte est absent de la Map, pas présent avec un tableau vide.
    expect(hostsByGroup.has("lab" as GroupId)).toBe(false);
  });

  it("indexe les dossiers par parent, triés par nom", () => {
    const { groupsByParent } = buildHostTree(hosts, groups, "");
    expect(groupsByParent.get(null)?.map((g) => g.name)).toEqual(["Lab", "Prod"]);
    expect(groupsByParent.get("prod" as GroupId)?.map((g) => g.name)).toEqual(["Db", "Web"]);
  });

  it("marque les ancêtres d'un hôte correspondant, pas seulement son dossier", () => {
    // C'est tout l'intérêt : chercher « nginx » doit garder « Prod » affiché,
    // sinon le dossier parent disparaît et l'hôte trouvé avec lui.
    const { matchingGroups } = buildHostTree(hosts, groups, "nginx");
    expect(matchingGroups.has("web" as GroupId)).toBe(true);
    expect(matchingGroups.has("prod" as GroupId)).toBe(true);
    expect(matchingGroups.has("db" as GroupId)).toBe(false);
    expect(matchingGroups.has("lab" as GroupId)).toBe(false);
  });

  it("cherche aussi dans l'adresse, l'utilisateur et les tags", () => {
    const tagged = [host("srv", "lab", { tags: ["prod", "eu-west"], username: "deploy" })];
    expect(buildHostTree(tagged, groups, "eu-west").hostsByGroup.size).toBe(1);
    expect(buildHostTree(tagged, groups, "deploy").hostsByGroup.size).toBe(1);
    expect(buildHostTree(tagged, groups, "srv.example").hostsByGroup.size).toBe(1);
    expect(buildHostTree(tagged, groups, "absent").hostsByGroup.size).toBe(0);
  });

  it("ne retient rien quand la recherche ne correspond à aucun hôte", () => {
    const tree = buildHostTree(hosts, groups, "introuvable");
    expect(tree.hostsByGroup.size).toBe(0);
    expect(tree.matchingGroups.size).toBe(0);
    // Les dossiers restent indexés : c'est `matchingGroups` qui décide de
    // l'affichage, pas l'absence de la Map.
    expect(tree.groupsByParent.get(null)).toHaveLength(2);
  });

  it("termine même si les parents forment un cycle", () => {
    // Donnée incohérente (jamais produite par l'UI, mais un workspace.json
    // édité à la main peut l'être) : la version récursive précédente bouclait
    // indéfiniment ici et figeait la fenêtre.
    const cyclic = [group("a", "A", "b"), group("b", "B", "a")];
    const tree = buildHostTree([host("x", "a")], cyclic, "x");
    expect(tree.matchingGroups).toEqual(new Set(["a", "b"]));
  });
});
