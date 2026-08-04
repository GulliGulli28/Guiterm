import { describe, expect, it } from "vitest";
import { filterAwsInstances, groupProfilesBySession, profileLabel } from "./awsInstances";
import type { AwsInstance } from "./types";

function instance(overrides: Partial<AwsInstance>): AwsInstance {
  return {
    instanceId: "i-0000000000000000",
    name: null,
    privateIp: null,
    publicIp: null,
    state: "running",
    platform: null,
    ssmOnline: true,
    tags: [],
    defaultUsername: "ec2-user",
    ...overrides,
  };
}

const FLEET: AwsInstance[] = [
  instance({
    instanceId: "i-0df4dfebfd9fe0362",
    name: "rocky-app-01",
    privateIp: "172.16.15.12",
    platform: "Red Hat Enterprise Linux",
    tags: [["Environment", "prod"], ["Team", "paiements"]],
  }),
  instance({
    instanceId: "i-0978d0081ce557b57",
    name: "app-db-01",
    privateIp: "172.16.20.7",
    platform: "Ubuntu",
    tags: [["Environment", "staging"]],
  }),
  instance({ instanceId: "i-0aaa111222333444", name: null, platform: "Ubuntu" }),
];

describe("filterAwsInstances", () => {
  it("returns everything for an empty or blank query", () => {
    expect(filterAwsInstances(FLEET, "")).toHaveLength(3);
    expect(filterAwsInstances(FLEET, "   ")).toHaveLength(3);
  });

  it("matches on the Name tag", () => {
    expect(filterAwsInstances(FLEET, "rocky").map((i) => i.name)).toEqual(["rocky-app-01"]);
  });

  // The id is what you have when you copied it from a ticket or the console,
  // and a partial paste has to work.
  it("matches on a fragment of the instance id", () => {
    expect(filterAwsInstances(FLEET, "0978d008")).toHaveLength(1);
  });

  it("matches on the private address and on the platform", () => {
    expect(filterAwsInstances(FLEET, "172.16.20")).toHaveLength(1);
    expect(filterAwsInstances(FLEET, "ubuntu")).toHaveLength(2);
  });

  // Tags are how fleets are actually organised, and both halves matter: you
  // may remember "prod" without remembering it lives under "Environment".
  it("matches on either half of a tag", () => {
    expect(filterAwsInstances(FLEET, "prod").map((i) => i.name)).toEqual(["rocky-app-01"]);
    expect(filterAwsInstances(FLEET, "paiements")).toHaveLength(1);
    expect(filterAwsInstances(FLEET, "Environment")).toHaveLength(2);
  });

  it("is case-insensitive", () => {
    expect(filterAwsInstances(FLEET, "ROCKY")).toHaveLength(1);
  });

  // Several terms narrow the result, and each may land on a different field —
  // that combination is the whole reason to split on whitespace rather than
  // matching the phrase.
  it("narrows with each term, across different fields", () => {
    expect(filterAwsInstances(FLEET, "ubuntu staging").map((i) => i.name)).toEqual(["app-db-01"]);
    expect(filterAwsInstances(FLEET, "ubuntu prod")).toHaveLength(0);
  });

  it("copes with an instance that has no name and no tags", () => {
    expect(filterAwsInstances(FLEET, "0aaa111")).toHaveLength(1);
  });
});

describe("groupProfilesBySession", () => {
  const profiles = [
    { name: "ReadOnly-999", ssoSession: "ma-boite" },
    { name: "static-old", ssoSession: null },
    { name: "Admin-167", ssoSession: "ma-boite" },
    { name: "Admin-client", ssoSession: "client" },
  ];

  it("gathers the profiles of one session together", () => {
    const groups = groupProfilesBySession(profiles);
    const boite = groups.find((g) => g.session === "ma-boite");
    expect(boite?.profiles.map((p) => p.name)).toEqual(["ReadOnly-999", "Admin-167"]);
  });

  it("orders sessions by name and leaves the sessionless ones last", () => {
    const groups = groupProfilesBySession(profiles);
    expect(groups.map((g) => g.session)).toEqual(["client", "ma-boite", null]);
  });

  it("handles a config with no SSO at all", () => {
    const groups = groupProfilesBySession([{ name: "default", ssoSession: null }]);
    expect(groups).toHaveLength(1);
    expect(groups[0].session).toBeNull();
  });
});

describe("profileLabel", () => {
  const profile = { name: "AdministratorAccess-167004607868", accountId: "167004607868" };

  it("shows the account name when it could be resolved", () => {
    expect(profileLabel(profile, { "167004607868": "prod" }))
      .toBe("AdministratorAccess-167004607868 · prod (167004607868)");
  });

  // The number is already half of the profile name; what it does not say is
  // which account that is. Falling back to it beats showing nothing.
  it("falls back to the account number when it is unknown", () => {
    expect(profileLabel(profile, {})).toBe("AdministratorAccess-167004607868 · 167004607868");
  });

  it("leaves a profile with no account alone", () => {
    expect(profileLabel({ name: "static-old", accountId: null }, {})).toBe("static-old");
  });
});
