import { assertNever } from "./exhaustive";
import type { CloudCliError, CloudFailure } from "./types";

/** A failure turned into the two things the panel shows: what happened, and
 * what to do about it. */
export interface DescribedFailure {
  /** The provider's own words, or ours when the provider never ran. */
  message: string;
  /** The remedy, when there is one. `null` means "nothing you can do from
   * here" — and the panel must not invent a button for it. */
  remedy: string | null;
  /** Whether the remedy is "log in again". What decides if a sign-in hint
   * appears, kept out of the rendering code so it is never re-derived by
   * matching on message text — that would silently stop working the day a
   * provider rewords an error. */
  needsLogin: boolean;
}

/** Reads a rejected cloud command into something displayable.
 *
 * The `switch` closes on {@link assertNever}: adding a variant to
 * `CloudCliError` without deciding how it reads becomes a `tsc` error rather
 * than a silent fallthrough to a generic message. That is the guard this repo
 * added after the MongoDB tab shipped unreachable.
 */
export function describeCloudFailure(reason: CloudCliError): DescribedFailure {
  switch (reason.kind) {
    case "cliMissing":
      return {
        message: `La CLI \`${reason.program}\` est introuvable.`,
        remedy: reason.installHint,
        needsLogin: false,
      };
    case "notLoggedIn":
      return { message: reason.message, remedy: reason.loginHint, needsLogin: true };
    case "refused":
      return { message: reason.message, remedy: null, needsLogin: false };
    case "unreadable":
      return { message: reason.message, remedy: null, needsLogin: false };
    default:
      return assertNever(reason, "describeCloudFailure");
  }
}

/** The tenant id an Azure refusal names, when it names one.
 *
 * The CLI's expired-session error ends with the exact command to run, tenant
 * included. Lifting it out means the sign-in form arrives pre-filled with the
 * right directory instead of asking the user to copy a GUID out of an error
 * message — the difference between a remedy and a homework assignment.
 *
 * Presentation-level on purpose, unlike `needsLogin`: a miss leaves the field
 * empty and the CLI's default tenant is used, which is correct for the
 * single-tenant case anyway. Nothing branches on it, so it stays out of the
 * typed error the backend sends.
 */
export function tenantFromAzureError(message: string): string | null {
  const after = message.split("--tenant")[1];
  if (after === undefined) return null;
  const trimmed = after.trimStart();
  const value = (trimmed.startsWith('"') ? trimmed.slice(1).split('"')[0] : trimmed.split(/\s/)[0]).trim();
  // A tenant is a GUID or a domain; anything else is a parse that went
  // sideways and is better dropped than pre-filled wrongly.
  return value && value.length <= 100 && /^[A-Za-z0-9.-]+$/.test(value) ? value : null;
}

/** Reads whatever a rejected `invoke` threw.
 *
 * Tauri rejects with the serialised error value, so a {@link CloudFailure}
 * arrives as a plain object rather than an `Error` — but a bug in the command
 * layer, or a panic, arrives as a string. Both have to render, so this never
 * assumes the typed shape is there.
 */
export function readCloudFailure(thrown: unknown): DescribedFailure {
  const failure = thrown as Partial<CloudFailure> | null | undefined;
  if (failure && typeof failure === "object" && failure.reason && "kind" in failure.reason) {
    return describeCloudFailure(failure.reason as CloudCliError);
  }
  return { message: String(thrown), remedy: null, needsLogin: false };
}
