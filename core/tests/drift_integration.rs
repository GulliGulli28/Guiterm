//! End-to-end test of drift detection against a real `sshd`.
//!
//! `create-directory` is the one operation that can be genuinely exercised
//! here: it asserts something observable, needs no privileges, and lives
//! entirely inside a temp directory this test owns — so the whole loop
//! (describe → detect → repair → detect again) runs for real without touching
//! anything outside it. Package and service checks would need root and a
//! machine we're allowed to change, and are covered by unit tests on the
//! rendering table instead.
mod common;

use common::{ClientKey, TestSshd, test_host};
use std::sync::Arc;
use termius_core::drift::{self, Verdict};
use termius_core::model::{HostFacts, Workspace};
use termius_core::{adaptive, fleet};

/// The probe evaluates conditions against the host's *persisted* facts, so a
/// host with none is treated as platform "unknown" — which would make every
/// check unobservable and the test vacuous. This is what `collect_facts` would
/// have written.
fn linux_facts() -> HostFacts {
    HostFacts {
        os_id: Some("debian".to_string()),
        os_name: Some("Debian GNU/Linux".to_string()),
        ..Default::default()
    }
}

async fn check(workspace: &Workspace, program_text: &str) -> drift::HostDrift {
    let program = adaptive::parse_program(program_text).expect("le programme doit se parser");
    let host_ids: Vec<_> = workspace.hosts.iter().map(|h| h.id).collect();
    let mut report = drift::check(
        Arc::new(workspace.clone()),
        host_ids,
        &program,
        fleet::DEFAULT_CONCURRENCY,
    )
    .await;
    assert_eq!(report.len(), 1, "un seul hôte attendu");
    report.remove(0)
}

#[tokio::test]
async fn a_missing_directory_is_a_drift_and_creating_it_closes_the_gap() {
    let key = ClientKey::generate();
    let sshd = TestSshd::start("drift", &key.public);
    let mut host = test_host(&sshd, &key, "test-drift");
    host.last_facts = Some(linux_facts());
    let mut workspace = Workspace::default();
    workspace.hosts.push(host);

    let dir = std::env::temp_dir().join(format!("guiterm-drift-{}", uuid::Uuid::new_v4()));
    let program = format!("create-directory {}", dir.display());

    // Nothing there yet: the wanted state does not hold.
    let before = check(&workspace, &program).await;
    assert_eq!(before.error, None, "la sonde doit avoir tourné");
    assert_eq!(before.checks.len(), 1);
    assert_eq!(before.checks[0].verdict, Verdict::Drifted);
    assert!(before.has_drifted());

    // Repairing is running the very same program — no second language, which
    // is the whole point of describing wanted state this way.
    std::fs::create_dir_all(&dir).unwrap();

    let after = check(&workspace, &program).await;
    assert_eq!(after.checks[0].verdict, Verdict::Matches, "l'écart doit être refermé");
    assert!(!after.has_drifted());

    let _ = std::fs::remove_dir_all(&dir);
}

/// The negative form asserts the opposite, and has to be just as real: a
/// directory that still exists when the program says it shouldn't is a drift.
#[tokio::test]
async fn the_negative_form_detects_something_that_should_not_be_there() {
    let key = ClientKey::generate();
    let sshd = TestSshd::start("drift-negative", &key.public);
    let mut host = test_host(&sshd, &key, "test-drift-negative");
    host.last_facts = Some(linux_facts());
    let mut workspace = Workspace::default();
    workspace.hosts.push(host);

    let dir = std::env::temp_dir().join(format!("guiterm-drift-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let program = format!("remove-directory {}", dir.display());

    let before = check(&workspace, &program).await;
    assert_eq!(before.checks[0].verdict, Verdict::Drifted, "le dossier est là alors qu'il ne devrait pas");

    std::fs::remove_dir_all(&dir).unwrap();
    let after = check(&workspace, &program).await;
    assert_eq!(after.checks[0].verdict, Verdict::Matches);
}

/// Several checks in one program travel in a single script and come back
/// individually attributed — the ordering assumption the parser and the
/// `CHECK<i>=` protocol share, exercised over a real connection rather than
/// against a hand-written string.
#[tokio::test]
async fn several_checks_come_back_attributed_to_the_right_lines() {
    let key = ClientKey::generate();
    let sshd = TestSshd::start("drift-multi", &key.public);
    let mut host = test_host(&sshd, &key, "test-drift-multi");
    host.last_facts = Some(linux_facts());
    let mut workspace = Workspace::default();
    workspace.hosts.push(host);

    let present = std::env::temp_dir().join(format!("guiterm-drift-{}", uuid::Uuid::new_v4()));
    let absent = std::env::temp_dir().join(format!("guiterm-drift-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&present).unwrap();

    // Middle line asserts nothing, so it must come back unknown *and* not
    // shift the answers of the lines around it — the indexing bug this pins.
    let program = format!(
        "create-directory {}\n\nupdate-packages\n\ncreate-directory {}",
        present.display(),
        absent.display(),
    );
    let report = check(&workspace, &program).await;

    assert_eq!(report.checks.len(), 3);
    assert_eq!(report.checks[0].verdict, Verdict::Matches, "{:?}", report.checks[0]);
    assert!(matches!(report.checks[1].verdict, Verdict::Unknown { .. }), "{:?}", report.checks[1]);
    assert_eq!(report.checks[2].verdict, Verdict::Drifted, "{:?}", report.checks[2]);

    let _ = std::fs::remove_dir_all(&present);
}
