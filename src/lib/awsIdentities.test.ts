import { describe, expect, it } from "vitest";
import { describeState, formatRemaining, groupIdentities, roleFromArn } from "./awsIdentities";
import type { AwsProfile, AwsSsoSessionStatus } from "./types";

const session = (name: string, state: AwsSsoSessionStatus["state"]): AwsSsoSessionStatus => ({
  name,
  startUrl: `https://${name}.awsapps.com/start`,
  region: "eu-west-3",
  state,
});

const profile = (name: string, ssoSession: string | null): AwsProfile => ({
  name,
  ssoSession,
  accountId: null,
  roleName: null,
  region: null,
});

describe("formatRemaining", () => {
  it("descend à l'unité la plus grossière qui dit encore quelque chose", () => {
    expect(formatRemaining(30)).toBe("moins d'une minute");
    expect(formatRemaining(42 * 60)).toBe("42 min");
    expect(formatRemaining(6 * 3600 + 12 * 60)).toBe("6 h 12 min");
    expect(formatRemaining(6 * 3600)).toBe("6 h");
    expect(formatRemaining(50 * 3600)).toBe("2 j 2 h");
  });

  it("ne rend jamais une durée négative comme une durée", () => {
    expect(formatRemaining(0)).toBe("expirée");
    expect(formatRemaining(-120)).toBe("expirée");
  });
});

describe("describeState", () => {
  it("propose de se connecter exactement quand c'est le remède", () => {
    expect(describeState({ kind: "neverLoggedIn" }).needsLogin).toBe(true);
    expect(describeState({ kind: "expired", expiresAt: "2020-01-01T00:00:00Z" }).needsLogin).toBe(true);
    expect(describeState({ kind: "valid", expiresAt: null, secondsLeft: 3600 }).needsLogin).toBe(false);
  });

  it("affiche le compte à rebours quand il est connu", () => {
    expect(describeState({ kind: "valid", expiresAt: "x", secondsLeft: 3600 }).label).toBe(
      "Connectée · expire dans 1 h",
    );
  });

  // A token whose expiry the cache didn't carry is usable; inventing "expire
  // dans NaN" or calling it expired would send someone re-authenticating for
  // nothing.
  it("reste lisible quand le cache n'a pas d'échéance", () => {
    const badge = describeState({ kind: "valid", expiresAt: null, secondsLeft: null });
    expect(badge.label).toBe("Connectée");
    expect(badge.tone).toBe("ok");
  });
});

describe("groupIdentities", () => {
  const sessions = [
    session("ma-boite", { kind: "valid", expiresAt: null, secondsLeft: 7200 }),
    session("client-x", { kind: "neverLoggedIn" }),
  ];

  it("range chaque profil sous la session qui l'authentifie", () => {
    const groups = groupIdentities(sessions, [
      profile("admin-1670", "ma-boite"),
      profile("ro-1670", "ma-boite"),
    ]);
    expect(groups[0].session?.name).toBe("ma-boite");
    expect(groups[0].profiles.map((p) => p.name)).toEqual(["admin-1670", "ro-1670"]);
  });

  // Right after configuring a session, before creating any profile. Hiding it
  // would look exactly like the setup having failed.
  it("garde une session encore sans profil", () => {
    const groups = groupIdentities(sessions, []);
    expect(groups).toHaveLength(2);
    expect(groups[1].profiles).toEqual([]);
  });

  it("regroupe les profils sans session à la fin", () => {
    const groups = groupIdentities(sessions, [profile("perso", null)]);
    expect(groups[groups.length - 1].session).toBeNull();
    expect(groups[groups.length - 1].profiles.map((p) => p.name)).toEqual(["perso"]);
  });

  // A profile pointing at a deleted session is broken. Dropping it from the
  // listing would leave the user with a profile they can neither see nor fix.
  it("n'escamote pas un profil dont la session a disparu", () => {
    const groups = groupIdentities(sessions, [profile("orphelin", "session-supprimée")]);
    const loose = groups.find((group) => group.session === null);
    expect(loose?.profiles.map((p) => p.name)).toEqual(["orphelin"]);
  });

  it("n'affiche pas de rubrique « sans session » vide", () => {
    expect(groupIdentities(sessions, [profile("admin", "ma-boite")]).some((g) => g.session === null)).toBe(false);
  });
});

describe("roleFromArn", () => {
  it("retrouve le rôle derrière la comptabilité d'Identity Center", () => {
    expect(
      roleFromArn("arn:aws:sts::167004607868:assumed-role/AWSReservedSSO_AdministratorAccess_a1b2c3d4/glorin"),
    ).toBe("AdministratorAccess");
  });

  it("laisse un rôle assumé ordinaire tel quel", () => {
    expect(roleFromArn("arn:aws:sts::1670:assumed-role/deploy-role/session")).toBe("deploy-role");
  });

  it("préfère ne rien dire plutôt que deviner", () => {
    expect(roleFromArn("arn:aws:iam::167004607868:user/guillaume")).toBeNull();
    expect(roleFromArn("")).toBeNull();
  });
});
