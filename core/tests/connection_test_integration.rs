//! La connexion d'essai du formulaire d'hôte (`ssh::test_connection`), contre
//! de vrais `sshd`.
//!
//! Ce qu'on vérifie, au-delà de « ça se connecte » : l'étape nommée en cas
//! d'échec (c'est elle qui choisit la section du formulaire à ouvrir), et
//! qu'un essai **ne laisse rien** derrière lui — aucune clé d'hôte approuvée,
//! puisqu'un hôte en cours de création n'a qu'un id tiré pour l'occasion.
mod common;

use common::{ClientKey, TestSshd, run_ok, test_host};
use russh::keys::ssh_key::{HashAlg, PublicKey};
use std::process::Command;
use termius_core::known_hosts;
use termius_core::model::{AuthMethod, Host, Workspace};
use termius_core::ssh::{self, ConnectStage, ConnectionTestOutcome};

fn host_fingerprint(sshd: &TestSshd) -> String {
    let raw = std::fs::read_to_string(sshd.host_public_key_path()).unwrap();
    PublicKey::from_openssh(raw.trim()).unwrap().fingerprint(HashAlg::Sha256).to_string()
}

fn is_trusted(host: &Host) -> bool {
    known_hosts::list().iter().any(|(identity, _, _)| *identity == host.id.to_string())
}

fn failed(outcome: &ConnectionTestOutcome) -> (ConnectStage, &str, &str) {
    match outcome {
        ConnectionTestOutcome::Failed { stage, host, message } => (*stage, host.as_str(), message.as_str()),
        other => panic!("l'essai devait échouer : {other:?}"),
    }
}

#[tokio::test]
async fn an_unsaved_host_connects_without_trusting_its_key() {
    let key = ClientKey::generate();
    let sshd = TestSshd::start("essai", &key.public);
    let host = test_host(&sshd, &key, "essai-neuf");

    // Absent du workspace : c'est un hôte en cours de création.
    let report = ssh::test_connection(&Workspace::default(), host.clone(), None).await;
    match &report.outcome {
        ConnectionTestOutcome::Connected { host_key: Some(seen), bastions: 0 } => {
            assert!(!seen.known, "la clé ne pouvait pas être déjà connue");
            assert_eq!(seen.fingerprint, host_fingerprint(&sshd));
        }
        other => panic!("essai : {other:?}"),
    }
    assert!(!is_trusted(&host), "un essai ne doit approuver aucune clé d'hôte");

    // Une vraie connexion l'approuve ; l'essai suivant la dit connue.
    let mut workspace = Workspace::default();
    workspace.hosts.push(host.clone());
    ssh::connect(&workspace, host.id).await.expect("connexion ordinaire").disconnect().await;
    let again = ssh::test_connection(&workspace, host.clone(), None).await;
    match &again.outcome {
        ConnectionTestOutcome::Connected { host_key: Some(seen), .. } => assert!(seen.known),
        other => panic!("second essai : {other:?}"),
    }
    known_hosts::remove(&host.id.to_string()).unwrap();
}

#[tokio::test]
async fn a_refused_key_fails_at_authentication() {
    let key = ClientKey::generate();
    let other = ClientKey::generate();
    let sshd = TestSshd::start("essai-auth", &key.public);
    let mut host = test_host(&sshd, &key, "essai-auth");
    host.auth = AuthMethod::PrivateKey { path: other.private.to_string_lossy().into(), key_id: None, cert_path: None };

    let report = ssh::test_connection(&Workspace::default(), host, None).await;
    let (stage, label, _) = failed(&report.outcome);
    assert_eq!(stage, ConnectStage::Auth);
    assert_eq!(label, "essai-auth");
}

#[tokio::test]
async fn a_closed_port_fails_at_reaching_it() {
    // Le port 1 et pas `free_port()` : un port pris dans la plage éphémère
    // peut, sous Linux, se connecter à lui-même (la socket cliente reçoit ce
    // même numéro comme port source) — la connexion « aboutit » alors, et
    // l'échec tombe à la poignée de main. Vu une fois sur cinq en parallèle.
    let mut host = Host::new("essai-port", "127.0.0.1", "personne");
    host.port = 1;
    let report = ssh::test_connection(&Workspace::default(), host, None).await;
    assert_eq!(failed(&report.outcome).0, ConnectStage::Reach);
}

#[tokio::test]
async fn an_unknown_name_fails_at_resolving_it() {
    // `.invalid` est réservé (RFC 2606) : aucun résolveur ne lui répond.
    let host = Host::new("essai-nom", "introuvable.invalid", "personne");
    let report = ssh::test_connection(&Workspace::default(), host, None).await;
    let (stage, _, message) = failed(&report.outcome);
    assert_eq!(stage, ConnectStage::Resolve, "{message}");
    assert!(message.contains("introuvable.invalid"), "{message}");
}

#[tokio::test]
async fn a_bastion_that_cannot_reach_the_target_is_named() {
    let key = ClientKey::generate();
    let bastion_sshd = TestSshd::start("essai-bastion", &key.public);
    let bastion = test_host(&bastion_sshd, &key, "essai-bastion");
    let mut target = Host::new("essai-derriere", "127.0.0.1", "personne");
    target.port = 1;
    target.jump_via = vec![bastion.id];

    let mut workspace = Workspace::default();
    workspace.hosts.push(bastion.clone());
    let report = ssh::test_connection(&workspace, target, None).await;
    let (stage, label, _) = failed(&report.outcome);
    assert_eq!(stage, ConnectStage::Relay);
    assert_eq!(label, "essai-derriere");
    assert!(!is_trusted(&bastion), "le bastion n'est pas approuvé non plus");
}

#[tokio::test]
async fn a_changed_host_key_stops_before_authenticating() {
    let key = ClientKey::generate();
    let sshd = TestSshd::start("essai-cle", &key.public);
    let host = test_host(&sshd, &key, "essai-cle");
    // Une autre clé approuvée pour cet hôte : celle du client fait l'affaire.
    let impostor = PublicKey::from_openssh(std::fs::read_to_string(&key.public).unwrap().trim()).unwrap();
    known_hosts::check_and_trust(&host.id.to_string(), "essai-cle", &impostor).unwrap();

    let mut workspace = Workspace::default();
    workspace.hosts.push(host.clone());
    let report = ssh::test_connection(&workspace, host.clone(), None).await;
    let (stage, _, message) = failed(&report.outcome);
    assert_eq!(stage, ConnectStage::HostKey, "{message}");
    assert!(message.contains("a changé"), "{message}");
    known_hosts::remove(&host.id.to_string()).unwrap();
}

/// Le formulaire teste ce qu'on vient de taper, pas ce qui est enregistré.
#[tokio::test]
async fn the_typed_passphrase_is_the_one_used() {
    let dir = std::env::temp_dir().join(format!("guiterm-test-essai-passphrase-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let private = dir.join("id_ed25519");
    run_ok(Command::new("ssh-keygen").args(["-t", "ed25519", "-f"]).arg(&private).args(["-N", "phrase-de-test"]));
    let sshd = TestSshd::start("essai-passphrase", &dir.join("id_ed25519.pub"));
    let mut host = Host::new("essai-passphrase", "127.0.0.1", common::current_username());
    host.port = sshd.port;
    host.auth = AuthMethod::PrivateKey { path: private.to_string_lossy().into(), key_id: None, cert_path: None };

    let without = ssh::test_connection(&Workspace::default(), host.clone(), None).await;
    assert_eq!(failed(&without.outcome).0, ConnectStage::Auth, "sans passphrase, la clé ne se déchiffre pas");
    let with = ssh::test_connection(&Workspace::default(), host, Some("phrase-de-test")).await;
    assert!(matches!(with.outcome, ConnectionTestOutcome::Connected { .. }), "{:?}", with.outcome);
    let _ = std::fs::remove_dir_all(&dir);
}
