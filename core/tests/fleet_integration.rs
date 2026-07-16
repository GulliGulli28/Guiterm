//! End-to-end test of the fleet executor against a real `sshd`: verifies the
//! parallel fan-out actually connects, runs the command on each host, and maps
//! stdout / stderr / the exit code back to the right host — plus that an
//! unsupported host kind is reported as a per-host error, not a hard failure.
mod common;

use common::{test_host, ClientKey, TestSshd};
use std::collections::HashMap;
use std::sync::Arc;
use termius_core::fleet::{self, HostOutcome};
use termius_core::model::{Host, HostId, HostKind, Workspace};

async fn run(workspace: Workspace, host_ids: Vec<HostId>, command: &str) -> HashMap<HostId, HostOutcome> {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let commands = fleet::uniform_commands(&host_ids, command);
    fleet::run_on_hosts(Arc::new(workspace), commands, fleet::DEFAULT_CONCURRENCY, tx).await;
    let mut out = HashMap::new();
    while let Some(o) = rx.recv().await {
        out.insert(o.host_id, o);
    }
    out
}

#[tokio::test]
async fn fleet_captures_stdout_stderr_and_exit_code_per_host() {
    let key = ClientKey::generate();
    let sshd = TestSshd::start("fleet", &key.public);

    // Two host entries pointing at the same real sshd — enough to exercise the
    // parallel fan-out and the per-host result mapping.
    let host_a = test_host(&sshd, &key, "fleet-a");
    let host_b = test_host(&sshd, &key, "fleet-b");
    let (a, b) = (host_a.id, host_b.id);
    let mut workspace = Workspace::default();
    workspace.hosts.push(host_a);
    workspace.hosts.push(host_b);

    // Prints to both streams and exits non-zero, so we check stdout, stderr and
    // a non-zero exit code are all captured (a failed command is a *result*,
    // not an error).
    let outcomes = run(workspace.clone(), vec![a, b], "printf out; printf err >&2; exit 3").await;
    assert_eq!(outcomes.len(), 2, "both hosts should report");
    for id in [a, b] {
        let o = &outcomes[&id];
        assert_eq!(o.error, None, "command ran, so no connection-level error");
        assert_eq!(o.exit_code, Some(3));
        assert_eq!(o.stdout, "out");
        assert!(o.stderr.contains("err"), "stderr was: {:?}", o.stderr);
    }

    // A command that succeeds reports exit 0.
    let outcomes = run(workspace, vec![a], "echo hi").await;
    let o = &outcomes[&a];
    assert_eq!(o.error, None);
    assert_eq!(o.exit_code, Some(0));
    assert_eq!(o.stdout.trim(), "hi");
}

#[tokio::test]
async fn fleet_reports_unsupported_kind_as_error() {
    // No sshd needed: an RDP host has no shell, so the executor must surface a
    // per-host error rather than attempting an SSH connection.
    let mut host = Host::new("rdp-box", "10.0.0.9", "user");
    host.kind = HostKind::Rdp;
    let id = host.id;
    let mut workspace = Workspace::default();
    workspace.hosts.push(host);

    let outcomes = run(workspace, vec![id], "whoami").await;
    let o = &outcomes[&id];
    assert!(o.error.is_some(), "unsupported kind should report an error");
    assert_eq!(o.exit_code, None);
}
