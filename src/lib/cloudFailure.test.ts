import { describe, expect, it } from "vitest";
import { describeCloudFailure, readCloudFailure, tenantFromAzureError } from "./cloudFailure";
import type { CloudCliError } from "./types";

/** The real refusal, pasted from `az vm list` on 2026-08-10 against a session
 * that had lapsed — jargon, trace ids and line breaks included, because that
 * is exactly what the parser receives. */
const EXPIRED_AZURE = `ERROR: V2Error: invalid_grant AADSTS700082: The refresh token has expired due to inactivity.�The token was issued on 2026-04-20T14:30:28.0990908Z and was inactive for 90.00:00:00. Trace ID: 20a49692-70c3-40ae-8130-bf9902091400 Correlation ID: be3b62e3-cf49-42f2-93e6-2cd4529d3615 Timestamp: 2026-08-10 09:16:47Z. Status: Response_Status.Status_InteractionRequired, Error code: 3399614467, Tag: 558133255
Run the command below to authenticate interactively; additional arguments may be added as needed:
az logout
az login --tenant "eeff6f72-412a-4df3-9eac-064920c95e17" --scope "https://management.core.windows.net//.default"`;

describe("tenantFromAzureError", () => {
  it("lifts the tenant out of a real expired-session error", () => {
    expect(tenantFromAzureError(EXPIRED_AZURE)).toBe("eeff6f72-412a-4df3-9eac-064920c95e17");
  });

  it("reads an unquoted tenant too", () => {
    expect(tenantFromAzureError("az login --tenant contoso.onmicrosoft.com --scope x"))
      .toBe("contoso.onmicrosoft.com");
  });

  it("yields nothing when there is no tenant to find", () => {
    expect(tenantFromAzureError("ERROR: something else entirely")).toBeNull();
    expect(tenantFromAzureError("")).toBeNull();
  });

  /** Rather than pre-fill the form with a URL or a fragment of prose. */
  it("drops an implausible capture", () => {
    expect(tenantFromAzureError('--tenant ""')).toBeNull();
    expect(tenantFromAzureError("--tenant https://example.com/x?y=1")).toBeNull();
  });
});

describe("describeCloudFailure", () => {
  it("names the missing CLI and how to install it", () => {
    const described = describeCloudFailure({
      kind: "cliMissing",
      program: "az",
      installHint: "Installez Azure CLI…",
    });
    expect(described.message).toContain("az");
    expect(described.remedy).toBe("Installez Azure CLI…");
    expect(described.needsLogin).toBe(false);
  });

  it("offers to sign in only when signing in is the fix", () => {
    const notLogged = describeCloudFailure({
      kind: "notLoggedIn",
      program: "gcloud",
      message: "You do not currently have an active account selected.",
      loginHint: "Lancez `gcloud auth login`…",
    });
    expect(notLogged.needsLogin).toBe(true);
    expect(notLogged.remedy).toContain("gcloud auth login");
  });

  /** A permissions refusal must not offer to log in: the user would
   * re-authenticate successfully and hit the very same wall. */
  it("offers no remedy for a refusal signing in cannot fix", () => {
    const refused = describeCloudFailure({
      kind: "refused",
      message: "AuthorizationFailed: the client does not have authorization",
    });
    expect(refused.needsLogin).toBe(false);
    expect(refused.remedy).toBeNull();
    expect(refused.message).toContain("AuthorizationFailed");
  });

  it("shows unreadable output as-is rather than swallowing it", () => {
    const unreadable = describeCloudFailure({ kind: "unreadable", message: "JSON tronqué" });
    expect(unreadable.message).toBe("JSON tronqué");
    expect(unreadable.needsLogin).toBe(false);
  });

  /** The anti-vacuity check: proves the `assertNever` arm is reachable at all,
   * so the exhaustiveness guard isn't decorative. A variant that bypasses the
   * type system (a backend that grew a case the frontend doesn't know) must
   * throw loudly rather than render an empty panel. */
  it("throws on a variant no branch handles", () => {
    const rogue = { kind: "quotaExceeded", message: "…" } as unknown as CloudCliError;
    expect(() => describeCloudFailure(rogue)).toThrow(/cas non géré/);
  });
});

describe("readCloudFailure", () => {
  it("reads the typed shape Tauri rejects with", () => {
    const described = readCloudFailure({
      message: "…",
      reason: { kind: "notLoggedIn", program: "az", message: "expiré", loginHint: "az login" },
    });
    expect(described.needsLogin).toBe(true);
  });

  /** A panic or a bug in the command layer arrives as a string, not as a
   * `CloudFailure`. It still has to render — showing nothing would be worse
   * than showing raw text. */
  it("falls back to the raw text when the failure isn't typed", () => {
    expect(readCloudFailure("boom").message).toBe("boom");
    expect(readCloudFailure(new Error("cassé")).message).toContain("cassé");
    expect(readCloudFailure(null).message).toBe("null");
    expect(readCloudFailure({ reason: {} }).message).toContain("object");
  });
});
