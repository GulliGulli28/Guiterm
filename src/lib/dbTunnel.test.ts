import { describe, expect, it } from "vitest";
import { sqlConnectionTunnel, sqlConnectionVia, sqlConnectionViaHostId } from "./types";
import type { DbTunnel, Host, SqlConnection } from "./types";

// What these pin, and why a type can't: `DbTunnel` being a closed union makes
// `tsc` reject an *unhandled* kind, but nothing makes it reject one handled
// *wrongly*. An SSM tunnel rendered as `null` type-checks perfectly and looks,
// in the connections list, exactly like a direct connection — a connection
// that visibly goes through AWS reading as if it went straight there. That is
// the same shape of hole as MongoDB's (see `SqlConnectionTab.test.ts`).

const hosts: Host[] = [
  {
    id: "h1",
    label: "bastion-prod",
    address: "10.0.0.1",
    port: 22,
    username: "ec2-user",
    auth: "agent",
    tags: [],
    groupId: null,
    jumpVia: [],
    startupSnippets: [],
    envVars: [],
  },
];

function serverConn(tunnel?: DbTunnel | null): SqlConnection {
  return { id: "c1", label: "db", tags: [], engine: "postgres", address: "db.internal", port: 5432, username: "app", tunnel };
}

describe("sqlConnectionTunnel", () => {
  it("treats an absent tunnel as direct", () => {
    // The shape of every connection saved before `DbTunnel` existed. The
    // backend migrates on load, so this is belt-and-braces — but a `undefined`
    // reaching `.kind` would be a blank crash in the list, not a fallback.
    expect(sqlConnectionTunnel(serverConn(undefined))).toEqual({ kind: "direct" });
    expect(sqlConnectionTunnel(serverConn(null))).toEqual({ kind: "direct" });
  });

  it("has no tunnel for SQLite, which forwards no port", () => {
    const sqlite: SqlConnection = { id: "c2", label: "f", tags: [], engine: "sqlite", path: "/tmp/a.db", sqliteHostId: "h1" };
    expect(sqlConnectionTunnel(sqlite)).toEqual({ kind: "direct" });
    // …but the host it reaches the *file* on is still surfaced, by the other
    // accessor and with its own preposition.
    expect(sqlConnectionViaHostId(sqlite)).toBe("h1");
    expect(sqlConnectionVia(sqlite, hosts)).toBe("sur bastion-prod");
  });
});

describe("sqlConnectionVia", () => {
  it("says nothing for a direct connection", () => {
    expect(sqlConnectionVia(serverConn({ kind: "direct" }), hosts)).toBeNull();
  });

  it("names the saved host for an SSH tunnel", () => {
    expect(sqlConnectionVia(serverConn({ kind: "sshHost", hostId: "h1" }), hosts)).toBe("via bastion-prod");
  });

  it("names the instance for an SSM tunnel, which has no saved host", () => {
    // The regression this file exists for: `sqlConnectionViaHostId` returns
    // null here — correctly, an SSM target is an AWS instance id and not a
    // `Host` — so a list rendering only that showed nothing at all.
    const conn = serverConn({ kind: "ssm", target: "i-0abc123", profile: "prod", region: "eu-west-1" });
    expect(sqlConnectionViaHostId(conn)).toBeNull();
    expect(sqlConnectionVia(conn, hosts)).toBe("via SSM i-0abc123");
  });

  it("degrades to a placeholder rather than vanishing when the host is gone", () => {
    // Deleting a host doesn't rewrite the connections that tunnelled through
    // it. Showing nothing would make such a connection look direct — and it
    // is the one that most needs explaining when it fails.
    expect(sqlConnectionVia(serverConn({ kind: "sshHost", hostId: "deleted" }), hosts)).toBe("via hôte inconnu");
  });

  it("describes a tunnelled MongoDB connection too", () => {
    const mongo: SqlConnection = {
      id: "c3",
      label: "docdb",
      tags: [],
      engine: "mongodb",
      connectionString: "mongodb://cluster.docdb.amazonaws.com:27017/",
      username: "app",
      tunnel: { kind: "ssm", target: "i-0dead", profile: null, region: null },
    };
    expect(sqlConnectionVia(mongo, hosts)).toBe("via SSM i-0dead");
  });
});
