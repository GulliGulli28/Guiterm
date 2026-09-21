import { describe, expect, it } from "vitest";
import { secretSlot, secretToSave } from "./hostSecret";

// Le bug d'origine : « je change le mot de passe, j'enregistre, la connexion
// utilise toujours l'ancien ». Ce qui part vers `save_host` est décidé ici.

describe("secretSlot", () => {
  it("le mot de passe sert à l'auth par mot de passe et à l'interactive", () => {
    expect(secretSlot("ssh", "password", null)).toBe("password");
    expect(secretSlot("ssh", "keyboardInteractive", null)).toBe("password");
  });
  it("RDP est toujours à mot de passe, même si le sélecteur SSH dit autre chose", () => {
    expect(secretSlot("rdp", "agent", null)).toBe("password");
  });
  it("une clé par chemin a sa passphrase sur l'hôte, une clé du trousseau non", () => {
    expect(secretSlot("ssh", "privateKey", null)).toBe("passphrase");
    expect(secretSlot("ssh", "privateKey", "k-1")).toBeNull();
  });
  it("l'agent, Docker et K8s n'ont pas de secret", () => {
    expect(secretSlot("ssh", "agent", null)).toBeNull();
    expect(secretSlot("dockerExec", "password", null)).toBeNull();
    expect(secretSlot("k8sExec", "password", null)).toBeNull();
  });
});

describe("secretToSave", () => {
  it("une valeur tapée remplace, quoi qu'ait dit le coffre", () => {
    expect(secretToSave("nouveau", "loaded")).toBe("nouveau");
    expect(secretToSave("nouveau", "unavailable")).toBe("nouveau");
    expect(secretToSave("nouveau", "loading")).toBe("nouveau");
  });
  it("un champ vidé efface — seulement si la valeur enregistrée était visible", () => {
    expect(secretToSave("", "loaded")).toBe("");
    expect(secretToSave("", "unavailable")).toBeNull();
    expect(secretToSave("", "loading")).toBeNull();
  });
  it("pas de champ, pas de secret à toucher", () => {
    expect(secretToSave(null, "loaded")).toBeNull();
  });
});
