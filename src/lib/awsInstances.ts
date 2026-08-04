import type { AwsInstance } from "./types";

/**
 * Filters the discovered instances against what the user typed.
 *
 * Matches across every field they might recognise a machine by — the Name tag,
 * the instance id, the private and public addresses, the platform, and both
 * halves of every tag — because there is no telling which one someone has in
 * mind. An account with a few hundred instances is the normal case, and the
 * `Name` tag is often the one thing that *isn't* distinctive ("web", "web",
 * "web").
 *
 * Whitespace-separated terms are ANDed, so "prod ubuntu" narrows rather than
 * widens; each term may match a different field, which is what makes that
 * combination useful.
 */
export function filterAwsInstances(instances: AwsInstance[], query: string): AwsInstance[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return instances;
  return instances.filter((instance) => {
    const haystack = [
      instance.name ?? "",
      instance.instanceId,
      instance.privateIp ?? "",
      instance.publicIp ?? "",
      instance.platform ?? "",
      instance.state,
      ...instance.tags.flatMap(([key, value]) => [key, value]),
    ]
      .join(" ")
      .toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

/**
 * Groups profiles by their SSO session, for the picker.
 *
 * The session is the unit of *login* — `aws sso login` authenticates a session,
 * not a profile — so profiles sharing one become usable together and expire
 * together. Grouping them makes "everything under this session stopped
 * working" legible at a glance instead of looking like six unrelated
 * failures.
 *
 * Profiles without a session (static credentials, `credentials` file entries)
 * come last under their own heading rather than being hidden or mixed in.
 */
export function groupProfilesBySession<T extends { name: string; ssoSession: string | null }>(
  profiles: T[],
): { session: string | null; profiles: T[] }[] {
  const bySession = new Map<string | null, T[]>();
  for (const profile of profiles) {
    const key = profile.ssoSession ?? null;
    const bucket = bySession.get(key);
    if (bucket) bucket.push(profile);
    else bySession.set(key, [profile]);
  }
  return [...bySession.entries()]
    .map(([session, group]) => ({ session, profiles: group }))
    .sort((a, b) => {
      if (a.session === b.session) return 0;
      // Sessionless entries last: they're the exception, and burying the SSO
      // ones under them would defeat the grouping.
      if (a.session === null) return 1;
      if (b.session === null) return -1;
      return a.session.localeCompare(b.session);
    });
}

/**
 * How a profile is shown in the picker: its name, then the account it reaches.
 *
 * The account *name* when it could be resolved, the number otherwise — never
 * neither. A profile called `AdministratorAccess-167004607868` already carries
 * the number; what it doesn't say, and what someone with several accounts
 * needs, is which one that is.
 */
export function profileLabel(
  profile: { name: string; accountId: string | null },
  accountNames: Record<string, string>,
): string {
  if (!profile.accountId) return profile.name;
  const known = accountNames[profile.accountId];
  return known
    ? `${profile.name} · ${known} (${profile.accountId})`
    : `${profile.name} · ${profile.accountId}`;
}
