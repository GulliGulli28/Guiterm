import { describe, expect, it } from "vitest";
import type { GuiVaultStatus } from "./types";
import { sectionRoleLabel, splitByVault, vaultSections } from "./vaultSections";

const status = (over: Partial<GuiVaultStatus> = {}): GuiVaultStatus => ({
  configured: true, unlocked: true, serverUrl: "https://v", email: "a@b", userId: "u", fingerprint: null, deviceName: null,
  autoSyncSecs: 0, persistUnlock: true, lastSyncAt: null, accounts: [], viewLocal: false, rollbacks: [],
  vaults: [
    { id: "v-perso", name: "Personnel", kind: "personal", role: "owner", revision: 1 },
    { id: "v-infra", name: "Équipe infra", kind: "shared", role: "writer", revision: 1 },
    { id: "v-lect", name: "Prod bancaire", kind: "shared", role: "reader", revision: 1 },
  ],
  ...over,
});

describe("vaultSections", () => {
  it("Personnel d'abord, puis chaque vault partagé dans l'ordre du compte", () => {
    expect(vaultSections(status())?.map((s) => [s.id, s.name])).toEqual([
      [null, "Personnel"], ["v-infra", "Équipe infra"], ["v-lect", "Prod bancaire"],
    ]);
  });

  it("aucune section sans compte affiché : déconnecté, verrouillé, ou profil local à l'écran", () => {
    expect(vaultSections(null)).toBeNull();
    expect(vaultSections(status({ configured: false }))).toBeNull();
    expect(vaultSections(status({ unlocked: false }))).toBeNull();
    expect(vaultSections(status({ viewLocal: true }))).toBeNull();
  });

  it("seule la lecture seule mérite une mention", () => {
    const [perso, infra, lect] = vaultSections(status())!;
    expect(sectionRoleLabel(perso)).toBeNull();
    expect(sectionRoleLabel(infra)).toBeNull();
    expect(sectionRoleLabel(lect)).toBe("lecture seule");
  });
});

describe("splitByVault", () => {
  const sections = vaultSections(status())!;
  const items = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];

  it("range chaque entité sous son vault, le personnel étant l'absence d'affiliation", () => {
    const out = splitByVault(items, { b: "v-infra", c: "v-lect" }, sections);
    expect(out.map((b) => [b.section.name, b.items.map((i) => i.id)])).toEqual([
      ["Personnel", ["a", "d"]], ["Équipe infra", ["b"]], ["Prod bancaire", ["c"]],
    ]);
  });

  it("garde les sections vides (un emplacement possible) et sans `vaultBindings`", () => {
    const out = splitByVault(items, undefined, sections);
    expect(out.map((b) => b.items.length)).toEqual([4, 0, 0]);
  });

  it("une affiliation vers un vault inconnu n'est ni cachée ni rangée dans le personnel", () => {
    const out = splitByVault(items, { a: "v-parti" }, sections);
    const stray = out.find((b) => b.section.id === "v-parti");
    expect(stray?.section.name).toBe("Vault inaccessible");
    expect(stray?.items.map((i) => i.id)).toEqual(["a"]);
    expect(out[0].items.map((i) => i.id)).toEqual(["b", "c", "d"]);
  });
});
