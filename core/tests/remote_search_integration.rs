//! The remote search against a real `sshd`, on real files.
//!
//! The unit tests build commands and parse captured output; neither proves the
//! command survives the trip through a login shell, that `find` and `grep`
//! accept the flags as assembled, or that what comes back parses. This runs
//! both searches against files created for the occasion and reads the results.

mod common;

use common::{ClientKey, TestSshd, test_host};
use termius_core::model::Workspace;
use termius_core::remote_search::{self, SearchMode};
use termius_core::ssh;

/// A directory of its own per run, so a leftover from a previous failure can't
/// make a later run pass (or fail) for the wrong reason.
struct Fixture {
    root: std::path::PathBuf,
}

impl Fixture {
    fn create() -> Self {
        let root = std::env::temp_dir().join(format!("guiterm-search-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("conf.d")).expect("create fixture");
        std::fs::write(
            root.join("conf.d").join("nginx.conf"),
            "user www-data;\nserver_name example.com;\nlisten 80;\n",
        )
        .expect("write conf");
        std::fs::write(root.join("notes.txt"), "rien à voir ici\n").expect("write notes");
        Self { root }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

async fn search(
    workspace: &Workspace,
    host_id: termius_core::model::HostId,
    mode: SearchMode,
    root: &str,
    pattern: &str,
) -> termius_core::remote_search::SearchOutcome {
    let connection = ssh::connect(workspace, host_id).await.expect("connect should succeed");
    let command = remote_search::search_command(mode, root, pattern, 50);
    let output = ssh::run_command_capture(&connection, &command)
        .await
        .expect("la recherche doit s'exécuter");
    remote_search::parse_outcome(mode, &output.stdout, output.exit_code, 50)
}

#[tokio::test]
async fn finds_a_file_by_name_and_by_what_is_inside_it() {
    let fixture = Fixture::create();
    let root = fixture.root.display().to_string();
    let key = ClientKey::generate();
    let sshd = TestSshd::start("remote-search", &key.public);
    let host = test_host(&sshd, &key, "test-remote-search");
    let host_id = host.id;
    let mut workspace = Workspace::default();
    workspace.hosts.push(host);

    // By name, on a fragment: nobody types the wildcards, so the search has to
    // add them — a search for "nginx" that only matches a file called exactly
    // "nginx" finds nothing on the first try, every time.
    let by_name = search(&workspace, host_id, SearchMode::Name, &root, "nginx").await;
    assert_eq!(by_name.hits.len(), 1, "obtenu {:?}", by_name.hits);
    assert!(by_name.hits[0].path.ends_with("conf.d/nginx.conf"), "obtenu {:?}", by_name.hits[0]);
    assert!(!by_name.timed_out && !by_name.truncated);

    // By content: the line number and the matching line come back, which is
    // what makes a hit worth showing rather than just a path.
    let by_content = search(&workspace, host_id, SearchMode::Content, &root, "server_name").await;
    assert_eq!(by_content.hits.len(), 1, "obtenu {:?}", by_content.hits);
    let hit = &by_content.hits[0];
    assert!(hit.path.ends_with("nginx.conf"), "obtenu {}", hit.path);
    assert_eq!(hit.line, Some(2), "la ligne réelle du fichier");
    assert_eq!(hit.excerpt.as_deref(), Some("server_name example.com;"));

    // And a search that matches nothing is an empty answer, not an error.
    let nothing = search(&workspace, host_id, SearchMode::Content, &root, "introuvable-xyz").await;
    assert!(nothing.hits.is_empty());
    assert!(!nothing.timed_out, "un résultat vide ne doit pas être un abandon");
}

/// The pattern is user input spliced into a command that runs on a server. The
/// unit test proves the quoting; this proves the quoting *works where it
/// matters* — through a login shell, on a real host.
#[tokio::test]
async fn a_pattern_full_of_shell_metacharacters_stays_data() {
    let fixture = Fixture::create();
    let root = fixture.root.display().to_string();
    let canary = fixture.root.join("preuve-injection");
    let key = ClientKey::generate();
    let sshd = TestSshd::start("remote-search-inj", &key.public);
    let host = test_host(&sshd, &key, "test-remote-search-inj");
    let host_id = host.id;
    let mut workspace = Workspace::default();
    workspace.hosts.push(host);

    let hostile = format!("x'; touch {} ; echo '", canary.display());
    let outcome = search(&workspace, host_id, SearchMode::Content, &root, &hostile).await;

    assert!(outcome.hits.is_empty(), "ce motif ne correspond à rien : {:?}", outcome.hits);
    assert!(
        !canary.exists(),
        "le motif s'est exécuté au lieu d'être cherché — l'échappement a cédé"
    );
}
