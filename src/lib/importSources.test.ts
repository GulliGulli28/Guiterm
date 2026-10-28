import { describe, expect, it } from "vitest";
import { awsStatus, cloudCliStatus, IMPORT_SOURCES, sshConfigStatus } from "./importSources";

describe("IMPORT_SOURCES", () => {
  it("propose les six sources de la maquette, ~/.ssh/config en tête", () => {
    expect(IMPORT_SOURCES.map((s) => s.id)).toEqual(["sshConfig", "aws", "gcp", "azure", "ansible", "file"]);
  });
});

describe("lignes d'état", () => {
  it("~/.ssh/config compte ce qui reste à importer, pas ce qui est déjà là", () => {
    expect(sshConfigStatus(null, 0).text).toBe("Lecture…");
    expect(sshConfigStatus(14, 2)).toEqual({ tone: "ok", text: "12 hôtes à importer" });
    expect(sshConfigStatus(3, 3).tone).toBe("muted");
    expect(sshConfigStatus(0, 0).text).toBe("Aucun hôte trouvé");
  });

  it("AWS signale l'absence de profil", () => {
    expect(awsStatus(0).tone).toBe("warn");
    expect(awsStatus(1).text).toBe("1 profil");
  });

  it("une CLI cloud dit pourquoi elle ne listera rien", () => {
    const words: [string, string] = ["projet", "projets"];
    expect(cloudCliStatus("gcloud", { scopes: 2 }, words)).toEqual({ tone: "ok", text: "gcloud connecté · 2 projets" });
    expect(cloudCliStatus("az", { reason: { kind: "cliMissing", program: "az", installHint: "" } }, words).text).toBe("CLI az introuvable");
    expect(cloudCliStatus("az", { reason: { kind: "notLoggedIn", program: "az", message: "", loginHint: "" } }, words).text).toBe("Connexion requise");
    expect(cloudCliStatus("az", { reason: null }, words).tone).toBe("warn");
    expect(cloudCliStatus("az", null, words).tone).toBe("muted");
  });
});
