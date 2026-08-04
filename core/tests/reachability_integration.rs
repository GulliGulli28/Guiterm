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
