//! Le panneau élevé, contre un vrai `sshd`.
//!
//! **Ce qui n'est pas testé ici, et pourquoi** : l'authentification `sudo`
//! elle-même. Elle demande un `sudo` utilisable sans mot de passe (ou le vrai
//! mot de passe de l'utilisateur) sur la machine qui lance les tests, ce
//! qu'on n'a ni sur ce poste de dev ni sur un runner. Le shell élevé est donc
//! ouvert par [`SudoSession::open_with_launcher`] avec un `sh` ordinaire : le
//! cadrage par sentinelle, le listing, les transferts par fichier de transit
//! et les opérations récursives sont exactement ceux du mode élevé — seule la
//! commande qui ouvre le shell diffère. La lecture de ce que répond `sudo`
//! est couverte, elle, par les tests unitaires de `sudo_session`.
mod common;

use common::{ClientKey, TestSshd, test_host};
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use termius_core::model::Workspace;
use termius_core::pane_ops::{PaneExec, SshShellExec};
use termius_core::sftp::{self, RemoteFileClient, SftpClient};
use termius_core::sudo_pane::{SudoPaneClient, probe_identity};
use termius_core::sudo_session::SudoSession;
use termius_core::transfer::{self, CopyProgress, PaneRef};
use termius_core::{pane_ops, ssh};
use uuid::Uuid;

#[tokio::test]
async fn an_elevated_pane_browses_and_transfers_like_an_ordinary_one() {
    let key = ClientKey::generate();
    let sshd = TestSshd::start("sudo-pane", &key.public);
    let host = test_host(&sshd, &key, "test-sudo-pane");
    let host_id = host.id;
    let mut workspace = Workspace::default();
    workspace.hosts.push(host);

    let connection = Arc::new(ssh::connect(&workspace, host_id).await.expect("connexion"));
    let plain: Arc<dyn RemoteFileClient> =
        Arc::new(SftpClient::open(&connection).await.expect("session sftp"));
    let plain_exec = SshShellExec::new(connection.clone());
    let identity = probe_identity(&plain_exec).await.expect("identité distante");

    let session = Arc::new(
        SudoSession::open_with_launcher(&connection, "sh", None)
            .await
            .expect("shell « élevé » ouvert"),
    );
    let elevated: Arc<dyn RemoteFileClient> =
        Arc::new(SudoPaneClient::new(session.clone(), plain.clone(), identity));

    let home = SftpClient::open(&connection)
        .await
        .expect("sftp")
        .home_dir()
        .await
        .expect("dossier personnel");
    let root = sftp::join(&home, &format!("guiterm-test-sudo-{}", Uuid::new_v4()));

    // ── Créer, lister, renommer, repermissionner ────────────────────────────
    elevated.make_dir(&root).await.expect("mkdir élevé");
    elevated
        .write_string(&sftp::join(&root, "note.txt"), "bonjour")
        .await
        .expect("écriture élevée");

    let entries = elevated.list(&root).await.expect("listing élevé");
    assert_eq!(entries.len(), 1, "un seul fichier attendu, vu {entries:?}");
    assert_eq!(entries[0].name, "note.txt");
    assert!(!entries[0].is_dir);
    assert_eq!(entries[0].size, "bonjour".len() as u64);

    assert_eq!(
        elevated.read_to_string(&sftp::join(&root, "note.txt")).await.expect("lecture élevée"),
        "bonjour"
    );

    elevated
        .rename(&sftp::join(&root, "note.txt"), &sftp::join(&root, "renommé.txt"))
        .await
        .expect("mv élevé");
    elevated
        .set_permissions(&sftp::join(&root, "renommé.txt"), 0o640)
        .await
        .expect("chmod élevé");
    elevated
        .set_modified(&sftp::join(&root, "renommé.txt"), 1_600_000_000)
        .await
        .expect("date élevée");

    let entries = elevated.list(&root).await.expect("listing après renommage");
    assert_eq!(entries[0].name, "renommé.txt", "un nom accentué doit survivre au parcours");
    assert_eq!(entries[0].permissions, Some(0o640));
    assert_eq!(entries[0].modified, Some(1_600_000_000));
    assert_eq!(entries[0].size, "bonjour".len() as u64, "aucune de ces opérations ne tronque");

    // ── Descendre et remonter un fichier, par le transit ────────────────────
    // Plus d'un morceau de 256 Ko, pour que la boucle de transfert tourne
    // vraiment, et pour qu'un transit tronqué se voie.
    let payload = "guiterm".repeat(100_000);
    let big_remote = sftp::join(&root, "gros.bin");
    let staged_local = std::env::temp_dir().join(format!("guiterm-sudo-src-{}", Uuid::new_v4()));
    tokio::fs::write(&staged_local, payload.as_bytes()).await.unwrap();

    let mut sent = 0u64;
    elevated
        .upload(&staged_local, &big_remote, &AtomicBool::new(false), &mut |done, _| sent = done)
        .await
        .expect("montée élevée");
    assert_eq!(sent, payload.len() as u64, "la progression doit compter tous les octets");

    let uploaded = elevated
        .list(&root)
        .await
        .expect("listing après montée")
        .into_iter()
        .find(|e| e.name == "gros.bin")
        .expect("le fichier monté doit exister");
    assert_eq!(uploaded.size, payload.len() as u64);

    let back = std::env::temp_dir().join(format!("guiterm-sudo-dst-{}", Uuid::new_v4()));
    elevated
        .download(&big_remote, &back, uploaded.size, &AtomicBool::new(false), &mut |_, _| {})
        .await
        .expect("descente élevée");
    assert_eq!(tokio::fs::read_to_string(&back).await.unwrap(), payload, "contenu identique");

    // Aucun fichier de transit ne doit rester dans le dossier personnel.
    let leftovers: Vec<String> = plain
        .list(&home)
        .await
        .expect("listing du dossier personnel")
        .into_iter()
        .map(|e| e.name)
        .filter(|name| name.starts_with(".guiterm-transit-"))
        .collect();
    assert!(leftovers.is_empty(), "transits abandonnés : {leftovers:?}");

    // ── Le panneau élevé se branche sur `transfer` comme les autres ─────────
    let dest_dir = sftp::join(&root, "copie");
    elevated.make_dir(&dest_dir).await.expect("mkdir destination");
    let cancel = AtomicBool::new(false);
    let mut report = |_: u64, _: &str| {};
    let mut progress = CopyProgress { cancel: &cancel, report: &mut report, done: 0 };
    transfer::copy_entry(
        &PaneRef::Remote(elevated.clone()),
        &root,
        &uploaded,
        &PaneRef::Remote(elevated.clone()),
        &dest_dir,
        &mut progress,
    )
    .await
    .expect("copie d'un panneau élevé vers lui-même");
    let copied = elevated
        .list(&dest_dir)
        .await
        .expect("listing de la copie")
        .into_iter()
        .find(|e| e.name == "gros.bin")
        .expect("la copie doit exister");
    assert_eq!(copied.size, payload.len() as u64, "la copie porte bien le contenu");

    // ── Et sur `pane_ops`, qui est tout l'intérêt de l'élévation ────────────
    let exec = PaneExec::Shell(Arc::new(SudoPaneClient::new(
        session.clone(),
        plain.clone(),
        probe_identity(&plain_exec).await.expect("identité"),
    )));
    let size = pane_ops::dir_size(&exec, &root).await.expect("du élevé");
    assert!(size >= payload.len() as u64, "un `du` élevé doit voir les deux copies, vu {size}");

    // ── Une erreur distante est rapportée, pas avalée ───────────────────────
    let missing = elevated
        .list(&sftp::join(&root, "nexiste-pas"))
        .await
        .expect_err("lister un dossier absent doit échouer");
    assert!(
        missing.to_string().contains("commande élevée en échec"),
        "message inattendu : {missing}"
    );

    // Le shell survit à l'erreur : c'est le point du cadrage par sentinelle,
    // une commande en échec ne doit pas désynchroniser le suivant.
    assert_eq!(
        elevated.list(&dest_dir).await.expect("le shell répond encore").len(),
        1
    );

    // ── Ménage ─────────────────────────────────────────────────────────────
    elevated.remove_file(&sftp::join(&dest_dir, "gros.bin")).await.unwrap();
    elevated.remove_dir(&dest_dir).await.unwrap();
    elevated.remove_file(&big_remote).await.unwrap();
    elevated.remove_file(&sftp::join(&root, "renommé.txt")).await.unwrap();
    elevated.remove_dir(&root).await.unwrap();
    let _ = tokio::fs::remove_file(&staged_local).await;
    let _ = tokio::fs::remove_file(&back).await;
}

/// Un mot de passe refusé doit se dire en une phrase, pas en sortie brute de
/// `sudo` — c'est le message que verra l'utilisateur qui s'est trompé.
#[tokio::test]
async fn a_refused_password_is_reported_plainly() {
    let key = ClientKey::generate();
    let sshd = TestSshd::start("sudo-refus", &key.public);
    let host = test_host(&sshd, &key, "test-sudo-refus");
    let host_id = host.id;
    let mut workspace = Workspace::default();
    workspace.hosts.push(host);

    let connection = ssh::connect(&workspace, host_id).await.expect("connexion");
    // Ce que fait `sudo` face à un mot de passe faux : il se plaint et sort,
    // sans jamais lancer le shell qui répondrait.
    let error = SudoSession::open_with_launcher(
        &connection,
        "sh -c 'echo \"sudo: 3 incorrect password attempts\" >&2; exit 1'",
        Some("mauvais".to_string()),
    )
    .await
    .expect_err("un mot de passe refusé ne doit pas ouvrir de shell");
    assert_eq!(error.to_string(), "mot de passe sudo refusé", "message brut : {error:#}");
}

/// Un `sudo` qui ne répond jamais — le cas `requiretty` — ne doit pas laisser
/// l'interface attendre sans fin.
#[tokio::test]
async fn a_shell_that_never_answers_is_given_up_on() {
    let key = ClientKey::generate();
    let sshd = TestSshd::start("sudo-muet", &key.public);
    let host = test_host(&sshd, &key, "test-sudo-muet");
    let host_id = host.id;
    let mut workspace = Workspace::default();
    workspace.hosts.push(host);

    let connection = ssh::connect(&workspace, host_id).await.expect("connexion");
    let started = std::time::Instant::now();
    // `cat` avale tout ce qu'on lui écrit sans jamais imprimer de sentinelle.
    let error = tokio::time::timeout(
        std::time::Duration::from_secs(90),
        SudoSession::open_with_launcher(&connection, "cat > /dev/null", None),
    )
    .await
    .expect("l'ouverture doit rendre la main d'elle-même")
    .expect_err("un shell muet n'est pas un shell ouvert");
    assert!(error.to_string().contains("requiretty"), "message inattendu : {error}");
    assert!(started.elapsed().as_secs() >= 30, "abandonné trop tôt pour être le délai prévu");
}
