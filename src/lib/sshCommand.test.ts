import { describe, expect, it } from "vitest";
import { shellQuote, sshCommandLine, type SshCommandSpec } from "./sshCommand";
import type { Host, HostId } from "./types";

const bastion = {
  id: "b" as HostId, label: "bastion", address: "bastion.exemple.fr", port: 22, username: "jump",
  auth: "agent", jumpVia: [], tags: [], startupSnippets: [], envVars: [], groupId: null,
} as unknown as Host;

const base: SshCommandSpec = { address: "203.0.113.10", port: 22, username: "deploy", auth: "agent", jumpVia: [] };

describe("sshCommandLine", () => {
  it("se réduit à ssh utilisateur@adresse dans le cas simple", () => {
    expect(sshCommandLine(base, [])).toBe("ssh deploy@203.0.113.10");
  });

  it("reprend le bastion comme la maquette (-J)", () => {
    expect(sshCommandLine({ ...base, jumpVia: [bastion.id] }, [bastion])).toBe("ssh -J jump@bastion.exemple.fr deploy@203.0.113.10");
  });

  it("dit le port, la clé, le certificat, l'agent et le keepalive", () => {
    const line = sshCommandLine({
      ...base,
      port: 2222,
      auth: { privateKey: { path: "~/.ssh/id_ed25519", keyId: null, certPath: "~/.ssh/id_ed25519-cert.pub" } },
      agentForward: true,
      keepaliveIntervalSecs: 30,
    }, []);
    expect(line).toBe("ssh -p 2222 -i ~/.ssh/id_ed25519 -o CertificateFile=~/.ssh/id_ed25519-cert.pub -A -o ServerAliveInterval=30 deploy@203.0.113.10");
  });

  it("met la commande de proxy entre guillemets, jetons compris", () => {
    const line = sshCommandLine({ ...base, proxyCommand: "nc %h %p" }, []);
    expect(line).toBe("ssh -o 'ProxyCommand=nc %h %p' deploy@203.0.113.10");
  });

  it("ignore un bastion qui n'existe plus plutôt que d'écrire un id", () => {
    expect(sshCommandLine({ ...base, jumpVia: ["disparu" as HostId] }, [])).toBe("ssh deploy@203.0.113.10");
  });
});

describe("shellQuote", () => {
  it("échappe une apostrophe", () => {
    expect(shellQuote("C:\\Users\\l'admin\\id")).toBe(`'C:\\Users\\l'\\''admin\\id'`);
  });
});
