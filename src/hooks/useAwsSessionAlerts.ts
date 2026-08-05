import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type { AwsSessionAlert } from "../lib/types";

/** A minute, like the identities panel's own refresh. The thing being watched
 * moves in half-hours, so anything faster would only spend cycles making
 * "expire dans 12 min" tick down one unit sooner. */
const POLL_INTERVAL_MS = 60_000;

/**
 * The SSO sessions about to stop working that hosts actually depend on.
 *
 * Lives at the App level rather than inside `AwsIdentitiesPanel` for the
 * obvious reason: the whole point is to be seen *without* opening that panel,
 * and the panel is lazy-loaded — until now nothing polled this unless you were
 * already looking at it, which is precisely when you don't need telling.
 *
 * Safe to run for the life of the window because `list_aws_session_alerts`
 * reads local files only. Polling anything that shells out to the `aws` CLI on
 * a timer would not be.
 *
 * `epoch` re-reads on demand — signing back in has to clear the badge without
 * waiting out the interval, or the fix looks like it didn't work.
 */
export function useAwsSessionAlerts(epoch: number): AwsSessionAlert[] {
  const [alerts, setAlerts] = useState<AwsSessionAlert[]>([]);

  useEffect(() => {
    let cancelled = false;
    // Swallowed on purpose: a machine with no `~/.aws` at all is the common
    // case, not a failure to report. The identities panel is where an actual
    // problem reading the configuration gets said out loud.
    const poll = () => {
      api.listAwsSessionAlerts()
        .then((found) => { if (!cancelled) setAlerts(found); })
        .catch(() => { if (!cancelled) setAlerts([]); });
    };
    poll();
    const timer = setInterval(poll, POLL_INTERVAL_MS);
    return () => { cancelled = true; clearInterval(timer); };
  }, [epoch]);

  return alerts;
}
