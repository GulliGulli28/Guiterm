import { assertNever } from "./exhaustive";
import type { AwsProfile, AwsSsoState, AwsSsoSessionStatus } from "./types";

/**
 * How long a session has left, in the coarsest unit that still says something.
 *
 * An SSO token lasts hours, so seconds are noise; below a minute the number
 * stops mattering and "moins d'une minute" is the honest reading. The point of
 * showing this at all is answering "do I need to sign in before starting" —
 * not being a stopwatch.
 */
export function formatRemaining(seconds: number): string {
  if (seconds <= 0) return "expirée";
  if (seconds < 60) return "moins d'une minute";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  if (hours < 24) return restMinutes > 0 ? `${hours} h ${restMinutes} min` : `${hours} h`;
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours > 0 ? `${days} j ${restHours} h` : `${days} j`;
}

/** What the badge next to a session says, and how alarming it looks. */
export interface StateBadge {
  tone: "ok" | "warn" | "idle";
  label: string;
  /** Shown on hover, for the state whose one-liner can't say everything. */
  detail?: string;
  /** Whether signing in is what fixes (or starts) this session. */
  needsLogin: boolean;
}

/**
 * Turns the backend's state into the one line shown next to a session.
 *
 * Closed with `assertNever`: adding a state to the union without deciding how
 * it reads becomes a `tsc` error rather than a session that silently renders
 * as nothing — the shape of hole that shipped MongoDB unreachable.
 */
export function describeState(state: AwsSsoState): StateBadge {
  switch (state.kind) {
    case "neverLoggedIn":
      return { tone: "idle", label: "Jamais connectée", needsLogin: true };
    // Not a failure, and deliberately not worded as one: an access token lives
    // an hour while the session behind it lives a day or more, so this is what
    // a working session looks like most of the time. Calling it "expirée" was
    // the first thing that looked broken — the profiles underneath answered
    // perfectly well.
    case "renewable":
      return {
        tone: "idle",
        label: "Connectée · jeton à renouveler",
        detail:
          "Le jeton d'accès a une heure de validité ; la CLI en obtient un nouveau toute seule, "
          + "sans navigateur, tant que la session AWS tient. Reconnecter si elle ne le fait plus.",
        needsLogin: false,
      };
    case "expired":
      return {
        tone: "warn",
        label: "Session expirée",
        detail: "Aucun jeton de renouvellement en cache : il faut repasser par le navigateur.",
        needsLogin: true,
      };
    case "valid":
      return {
        tone: "ok",
        label:
          state.secondsLeft === null
            ? "Connectée"
            : `Connectée · expire dans ${formatRemaining(state.secondsLeft)}`,
        needsLogin: false,
      };
    default:
      return assertNever(state, "état de session SSO");
  }
}

export interface IdentityGroup {
  /** `null` for the profiles that belong to no session. */
  session: AwsSsoSessionStatus | null;
  profiles: AwsProfile[];
}

/**
 * Lays the profiles out under the session each one signs in through.
 *
 * The session is the unit of *login*, so this is the layout that makes "these
 * six profiles stopped working at once" legible as one expired session rather
 * than six unrelated failures.
 *
 * Two things deliberately don't disappear:
 * - a session with no profile yet is still listed, because that is exactly the
 *   state right after configuring one, and hiding it would look like the setup
 *   failed;
 * - a profile naming a session that no longer exists lands in the sessionless
 *   group rather than vanishing — it is broken, and invisible-and-broken is
 *   the worst of the two.
 */
export function groupIdentities(
  sessions: AwsSsoSessionStatus[],
  profiles: AwsProfile[],
): IdentityGroup[] {
  const groups: IdentityGroup[] = sessions.map((session) => ({
    session,
    profiles: profiles.filter((profile) => profile.ssoSession === session.name),
  }));
  const known = new Set(sessions.map((session) => session.name));
  const loose = profiles.filter((profile) => !profile.ssoSession || !known.has(profile.ssoSession));
  // Only when there is something in it: an empty "Sans session SSO" heading is
  // a question the user has to answer for nothing.
  if (loose.length > 0) groups.push({ session: null, profiles: loose });
  return groups;
}

/**
 * The role an ARN names, for a `sts get-caller-identity` result.
 *
 * `arn:aws:sts::1670:assumed-role/AWSReservedSSO_AdministratorAccess_a1b2/glorin`
 * is what AWS answers and nobody reads. The `AWSReservedSSO_` prefix and the
 * trailing hash are IAM Identity Center's own bookkeeping — what was actually
 * assumed is `AdministratorAccess`.
 *
 * Returns `null` rather than guessing when the shape is anything else (an IAM
 * user, a root account), and the caller falls back to the full ARN.
 */
export function roleFromArn(arn: string): string | null {
  const assumed = /assumed-role\/([^/]+)/.exec(arn);
  if (!assumed) return null;
  const role = assumed[1];
  const sso = /^AWSReservedSSO_(.+)_[0-9a-f]+$/.exec(role);
  return sso ? sso[1] : role;
}
