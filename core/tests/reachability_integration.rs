//! The reachability probe against a real `sshd`, on real ports.
//!
//! The unit tests in `reachability` classify captured tool output; nothing
//! there proves the script itself runs, survives the trip through a login
//! shell, or that its markers come back intact. That is what this covers — and
//! it is the only place the promise "a refusal and a silence are different
//! answers" is checked end to end, on a port that really is listening and one
//! that really is not.

mod common;

use common::{ClientKey, TestSshd, free_port, test_host};
use termius_core::model::Workspace;
use termius_core::reachability::{self, Verdict, PROBE_TIMEOUT_SECS};
use termius_core::ssh;

async fn probe(workspace: &Workspace, host_id: termius_core::model::HostId, host: &str, port: u16) -> Verdict {
    let connection = ssh::connect(workspace, host_id).await.expect("connect should succeed");
    let script = reachability::probe_script(host, port, PROBE_TIMEOUT_SECS);
    let output = ssh::run_command_capture(&connection, &script)
        .await
        .expect("la sonde doit s'exécuter");
    reachability::parse_verdict(&output.stdout, &output.stderr)
}

#[tokio::test]
async fn an_open_port_and_a_closed_one_get_different_answers() {
    let key = ClientKey::generate();
    let sshd = TestSshd::start("reachability", &key.public);
    let host = test_host(&sshd, &key, "test-reachability");
    let host_id = host.id;
    let mut workspace = Workspace::default();
    workspace.hosts.push(host);

    // Open: the very `sshd` this probe travels through is listening there, so
    // this cannot be a false positive from a mock.
    let open = probe(&workspace, host_id, "127.0.0.1", sshd.port).await;
    assert!(
        matches!(open, Verdict::Open { .. }),
        "un port qui écoute doit être joignable, obtenu {open:?}"
    );

    // Refused: nothing listens there, and the kernel answers with a RST — the
    // case that must never read as "filtered", since it means the machine was
    // reached and the remedy is on the service, not on the network.
    let closed = free_port();
    let refused = probe(&workspace, host_id, "127.0.0.1", closed).await;
    assert!(
        matches!(refused, Verdict::Refused { .. }),
        "un port fermé sur une machine joignable est un refus, pas un silence — obtenu {refused:?}"
    );
}

/// The `nc` branch, run against this platform's own `nc`.
///
/// Linux never takes it — it has `timeout`, so the probe uses `bash`'s
/// `/dev/tcp` — which is precisely why the macOS CI caught what the Linux runs
/// could not: on a machine without `timeout`, every probe goes through `nc`,
/// and BSD `nc -z` without `-v` says nothing at all. A closed port was
/// therefore reported as a firewall, the exact opposite of the truth.
///
/// This asserts on the wording *this* machine's `nc` produces, so the same
/// test tells the truth on both runners.
#[tokio::test]
async fn this_platforms_nc_tells_a_refusal_from_a_silence() {
    let key = ClientKey::generate();
    let sshd = TestSshd::start("reachability-nc", &key.public);
    let host = test_host(&sshd, &key, "test-reachability-nc");
    let host_id = host.id;
    let mut workspace = Workspace::default();
    workspace.hosts.push(host);

    let connection = ssh::connect(&workspace, host_id).await.expect("connect should succeed");
    // The measurement around it is what the script does; the call itself comes
    // from `nc_command`, so the part that differs between platforms cannot
    // drift away from what the app really runs.
    async fn run(connection: &termius_core::ssh::Connection, port: u16) -> Verdict {
        let command = format!(
            "s=$(date +%s); m=$({} 2>&1); c=$?; e=$(date +%s); echo GUITERM-PROBE nc $c $((e-s)); echo \"$m\"",
            reachability::nc_command("127.0.0.1", &port.to_string(), PROBE_TIMEOUT_SECS)
        );
        let output = ssh::run_command_capture(connection, &command)
            .await
            .expect("la sonde nc doit s'exécuter");
        reachability::parse_verdict(&output.stdout, &output.stderr)
    }

    let open = run(&connection, sshd.port).await;
    assert!(matches!(open, Verdict::Open { .. }), "port qui écoute, obtenu {open:?}");

    let refused = run(&connection, free_port()).await;
    assert!(
        matches!(refused, Verdict::Refused { .. }),
        "un port fermé doit être un refus même quand nc est laconique — obtenu {refused:?}"
    );
}

/// A name that resolves nowhere is a DNS problem, not a network one, and the
/// probe has to say so — the two send you to completely different places.
#[tokio::test]
async fn a_name_that_resolves_nowhere_is_reported_as_such() {
    let key = ClientKey::generate();
    let sshd = TestSshd::start("reachability-dns", &key.public);
    let host = test_host(&sshd, &key, "test-reachability-dns");
    let host_id = host.id;
    let mut workspace = Workspace::default();
    workspace.hosts.push(host);

    // `.invalid` is reserved by RFC 2606 precisely so it can never resolve.
    let verdict = probe(&workspace, host_id, "guiterm-nexiste-pas.invalid", 443).await;
    assert!(
        matches!(verdict, Verdict::UnknownHost { .. }),
        "un nom qui ne résout pas doit être distingué d'un réseau injoignable — obtenu {verdict:?}"
    );
}
