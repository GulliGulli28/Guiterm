import { describe, expect, it } from "vitest";
import { sectionForStage, sectionsFor } from "./hostFormSections";
import type { ConnectStage, HostKind } from "./types";

describe("sectionsFor", () => {
  it("donne les cinq sections à un hôte SSH, Connexion en tête", () => {
    expect(sectionsFor("ssh")).toEqual(["connexion", "auth", "reseau", "session", "organisation"]);
  });

  it("ne donne ni réseau SSH ni shell à un hôte RDP", () => {
    // Le constat de l'audit : le formulaire RDP proposait l'agent SSH.
    expect(sectionsFor("rdp")).not.toContain("reseau");
    expect(sectionsFor("rdp")).not.toContain("session");
    expect(sectionsFor("rdp")).toContain("auth");
  });

  it("ne demande pas d'authentification à Docker ni à Kubernetes", () => {
    for (const kind of ["dockerExec", "k8sExec"] as HostKind[]) {
      expect(sectionsFor(kind)).not.toContain("auth");
      expect(sectionsFor(kind)).toContain("session");
    }
  });

  it("garde toujours Connexion et Organisation", () => {
    for (const kind of ["ssh", "rdp", "dockerExec", "k8sExec"] as HostKind[]) {
      expect(sectionsFor(kind)[0]).toBe("connexion");
      expect(sectionsFor(kind)).toContain("organisation");
    }
  });
});

describe("sectionForStage", () => {
  it("ouvre la section qui contient de quoi corriger", () => {
    const expected: Record<ConnectStage, string | null> = {
      resolve: "connexion",
      reach: "connexion",
      handshake: "connexion",
      proxy: "reseau",
      relay: "reseau",
      auth: "auth",
      // Une clé d'hôte changée se règle dans Known Hosts, pas ici.
      hostKey: null,
    };
    for (const [stage, section] of Object.entries(expected)) {
      expect(sectionForStage(stage as ConnectStage)).toBe(section);
    }
  });

  it("n'ouvre jamais une section absente pour un hôte SSH", () => {
    for (const stage of ["resolve", "reach", "handshake", "proxy", "relay", "auth", "hostKey"] as ConnectStage[]) {
      const section = sectionForStage(stage);
      if (section) expect(sectionsFor("ssh")).toContain(section);
    }
  });
});
