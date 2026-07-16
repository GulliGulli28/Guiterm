//! Best-effort host state ("facts") collection: runs one POSIX probe on each
//! host and parses OS / kernel / CPU / load / memory out of it, so the fleet UI
//! can show live state and select targets by it (e.g. "RAM used > 80%"). This is
//! Étape 2 of the control-plane spine — it reuses the fleet executor's tested
//! fan-out ([`crate::fleet::run_on_hosts`]) rather than re-implementing SSH exec.
//!
//! Everything is best-effort: a field that couldn't be read (missing `/proc`,
//! a non-POSIX shell, a Windows SSH host, an old kernel without `MemAvailable`)
//! is simply `None`, never an error. A host the probe couldn't run on at all
//! (unreachable, non-zero exit, unsupported kind) reports `facts: None` with an
//! `error` instead.

use crate::fleet::{self, HostOutcome};
use crate::model::{HostFacts, HostId, Workspace};
use serde::Serialize;
use std::sync::Arc;

/// Single-line POSIX `sh` probe. Every value is emitted as a `KEY=value` line so
/// [`parse_facts`] can ignore any unrelated shell noise and pick only the keys
/// it knows — robust against MOTD lines, warnings, etc.
const PROBE: &str = "export LC_ALL=C 2>/dev/null; \
echo \"HOSTNAME=$(hostname 2>/dev/null)\"; \
echo \"KERNEL=$(uname -sr 2>/dev/null)\"; \
echo \"ARCH=$(uname -m 2>/dev/null)\"; \
if [ -r /etc/os-release ]; then . /etc/os-release 2>/dev/null; echo \"OS_ID=$ID\"; echo \"OS_NAME=$PRETTY_NAME\"; fi; \
echo \"CPUS=$(nproc 2>/dev/null)\"; \
if [ -r /proc/uptime ]; then echo \"UPTIME=$(cut -d' ' -f1 /proc/uptime)\"; fi; \
if [ -r /proc/loadavg ]; then echo \"LOAD1=$(cut -d' ' -f1 /proc/loadavg)\"; fi; \
if [ -r /proc/meminfo ]; then awk '/^MemTotal:/{t=$2} /^MemAvailable:/{a=$2} END{if(t){print \"MEMTOTAL_KB=\"t; print \"MEMAVAIL_KB=\"a}}' /proc/meminfo; fi";

/// One host's facts result: either `facts` (probe ran) or `error` (it didn't).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FactsOutcome {
    pub host_id: HostId,
    pub facts: Option<HostFacts>,
    pub error: Option<String>,
}

/// Parses the probe's `KEY=value` output into [`HostFacts`]. Pure — unit-tested
/// without any SSH — so the flaky part (a real host) and the fiddly part
/// (parsing) are validated separately.
pub fn parse_facts(stdout: &str) -> HostFacts {
    let mut f = HostFacts::default();
    let mut mem_total_kb: Option<u64> = None;
    let mut mem_avail_kb: Option<u64> = None;
    for line in stdout.lines() {
        let Some((key, value)) = line.split_once('=') else { continue };
        let value = value.trim();
        if value.is_empty() {
            continue;
        }
        match key.trim() {
            "HOSTNAME" => f.hostname = Some(value.to_string()),
            "KERNEL" => f.kernel = Some(value.to_string()),
            "ARCH" => f.arch = Some(value.to_string()),
            "OS_ID" => f.os_id = Some(value.to_string()),
            "OS_NAME" => f.os_name = Some(value.trim_matches('"').to_string()),
            "CPUS" => f.cpus = value.parse().ok(),
            // /proc/uptime is a float ("1234.56 ..."); keep whole seconds.
            "UPTIME" => f.uptime_secs = value.split('.').next().and_then(|s| s.parse().ok()),
            "LOAD1" => f.load1 = value.parse().ok(),
            "MEMTOTAL_KB" => mem_total_kb = value.parse().ok(),
            "MEMAVAIL_KB" => mem_avail_kb = value.parse().ok(),
            _ => {}
        }
    }
    if let Some(total) = mem_total_kb {
        f.mem_total_mb = Some(total / 1024);
        if let Some(avail) = mem_avail_kb {
            let used = total.saturating_sub(avail);
            f.mem_used_mb = Some(used / 1024);
            if total > 0 {
                f.mem_used_pct = Some((used as f64 / total as f64) * 100.0);
            }
        }
    }
    f
}

/// Collects facts for every host in `host_ids` concurrently (SSH only — same
/// gate as the fleet executor). Batch: resolves once every host has reported.
pub async fn collect(
    workspace: Arc<Workspace>,
    host_ids: Vec<HostId>,
    concurrency: usize,
) -> Vec<FactsOutcome> {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<HostOutcome>();
    let commands = fleet::uniform_commands(&host_ids, PROBE);
    fleet::run_on_hosts(workspace, commands, concurrency, tx).await;
    let mut out = Vec::new();
    while let Some(outcome) = rx.recv().await {
        out.push(to_facts_outcome(outcome));
    }
    out
}

fn to_facts_outcome(o: HostOutcome) -> FactsOutcome {
    if let Some(error) = o.error {
        return FactsOutcome { host_id: o.host_id, facts: None, error: Some(error) };
    }
    if o.exit_code != Some(0) {
        return FactsOutcome {
            host_id: o.host_id,
            facts: None,
            error: Some(format!("sonde d'état en échec (code {:?})", o.exit_code)),
        };
    }
    FactsOutcome { host_id: o.host_id, facts: Some(parse_facts(&o.stdout)), error: None }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_full_ubuntu_probe() {
        let out = "\
HOSTNAME=web-01
KERNEL=Linux 6.5.0-14-generic
ARCH=x86_64
OS_ID=ubuntu
OS_NAME=Ubuntu 22.04.3 LTS
CPUS=4
UPTIME=123456.78
LOAD1=0.42
MEMTOTAL_KB=8000000
MEMAVAIL_KB=2000000
";
        let f = parse_facts(out);
        assert_eq!(f.hostname.as_deref(), Some("web-01"));
        assert_eq!(f.os_id.as_deref(), Some("ubuntu"));
        assert_eq!(f.os_name.as_deref(), Some("Ubuntu 22.04.3 LTS"));
        assert_eq!(f.kernel.as_deref(), Some("Linux 6.5.0-14-generic"));
        assert_eq!(f.arch.as_deref(), Some("x86_64"));
        assert_eq!(f.cpus, Some(4));
        assert_eq!(f.load1, Some(0.42));
        assert_eq!(f.uptime_secs, Some(123456));
        assert_eq!(f.mem_total_mb, Some(7812)); // 8_000_000 / 1024
        // used = 6_000_000 KB → 5859 MB, 75% of total
        assert_eq!(f.mem_used_mb, Some(5859));
        assert_eq!(f.mem_used_pct.map(|p| p.round()), Some(75.0));
    }

    #[test]
    fn ignores_noise_and_empty_values_and_partial_output() {
        let out = "\
some MOTD banner line that isn't KEY=value
HOSTNAME=
ARCH=aarch64
MEMTOTAL_KB=4000000
";
        let f = parse_facts(out);
        assert_eq!(f.hostname, None, "empty value stays None");
        assert_eq!(f.arch.as_deref(), Some("aarch64"));
        assert_eq!(f.mem_total_mb, Some(3906));
        // No MemAvailable → no used/pct, but total still known.
        assert_eq!(f.mem_used_mb, None);
        assert_eq!(f.mem_used_pct, None);
    }
}
