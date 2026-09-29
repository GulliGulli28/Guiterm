//! L'agent SSH face aux vrais outils OpenSSH : `ssh-add -L` liste les clés,
//! `ssh-keygen -Y sign -n git` signe comme `git commit -S` le ferait (et la
//! signature se vérifie), un refus de l'utilisateur fait échouer la
//! signature, et un vrai `ssh` se connecte à un vrai `sshd` — en annonçant
//! son serveur (`session-bind@openssh.com`), que l'agent reconnaît : seule la
//! clé de cet hôte est présentée.
#![cfg(unix)]

mod common;

use common::{ClientKey, TestSshd};
use russh::keys::ssh_key::{PrivateKey, PublicKey};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use termius_core::ssh_agent::{Agent, AgentKey, Backend, Decision, KnownHost, UsePurpose, UseRequest, server};

/// Un trousseau de test : des clés en mémoire, un hôte reconnu à sa clé
/// d'hôte, et des réponses de l'utilisateur écrites d'avance.
struct TestBackend {
    keys: Vec<(AgentKey, PrivateKey)>,
    host: Option<(PublicKey, KnownHost)>,
    allow: bool,
    asked: Mutex<Vec<UseRequest>>,
}

#[async_trait::async_trait]
impl Backend for TestBackend {
    fn keys(&self) -> Vec<AgentKey> {
        self.keys.iter().map(|(k, _)| k.clone()).collect()
    }
    fn hosts_with_key(&self, host_key: &PublicKey) -> Vec<KnownHost> {
        match &self.host {
            Some((k, h)) if k.key_data() == host_key.key_data() => vec![h.clone()],
            _ => vec![],
        }
    }
    fn private_key(&self, key_id: &str) -> anyhow::Result<PrivateKey> {
        self.keys.iter().find(|(k, _)| k.id == key_id).map(|(_, p)| p.clone()).ok_or_else(|| anyhow::anyhow!("clé inconnue"))
    }
    async fn confirm(&self, request: UseRequest) -> Decision {
        self.asked.lock().unwrap().push(request);
        Decision { allow: self.allow, remember: false }
    }
}

fn load(key: &ClientKey, id: &str, hosts: &[&str]) -> (AgentKey, PrivateKey) {
    let private = PrivateKey::read_openssh_file(&key.private).unwrap();
    let agent = AgentKey { id: id.into(), name: format!("key-{id}"), public: private.public_key().clone(), hosts: hosts.iter().map(|h| h.to_string()).collect() };
    (agent, private)
}

/// Sous `/tmp`, et court : une socket Unix tient en 104 octets sous macOS,
/// dont le `temp_dir()` (`/var/folders/…/T/`) en prend déjà la moitié.
fn socket_path() -> String {
    let id = uuid::Uuid::new_v4().simple().to_string();
    format!("/tmp/guiterm-agent-{}/agent.sock", &id[..12])
}

async fn start(backend: Arc<TestBackend>) -> server::Running {
    server::start(&socket_path(), Arc::new(Agent::new(backend))).await.unwrap()
}

/// Lance un outil OpenSSH contre l'agent, hors du runtime (il bloque).
async fn run(sock: &str, program: &str, args: Vec<String>, stdin: Option<Vec<u8>>) -> (bool, String) {
    let sock = sock.to_string();
    let program = program.to_string();
    tokio::task::spawn_blocking(move || {
        let mut child = Command::new(&program)
            .args(&args)
            .env("SSH_AUTH_SOCK", &sock)
            .stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap_or_else(|e| panic!("{program} introuvable : {e}"));
        if let Some(input) = stdin {
            use std::io::Write;
            child.stdin.take().unwrap().write_all(&input).unwrap();
        }
        let out = child.wait_with_output().unwrap();
        (out.status.success(), format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr)))
    })
    .await
    .unwrap()
}

#[tokio::test]
async fn ssh_add_lists_and_git_style_signature_verifies() {
    let key = ClientKey::generate();
    let backend = Arc::new(TestBackend { keys: vec![load(&key, "k1", &[])], host: None, allow: true, asked: Mutex::new(vec![]) });
    let running = start(backend.clone()).await;

    let (ok, out) = run(&running.endpoint, "ssh-add", vec!["-L".into()], None).await;
    assert!(ok, "ssh-add -L : {out}");
    let pubkey = std::fs::read_to_string(&key.public).unwrap();
    let blob = pubkey.split_whitespace().nth(1).unwrap();
    assert!(out.contains(blob), "la clé du trousseau est listée : {out}");

    // Ce que fait `git commit -S` avec gpg.format=ssh : ssh-keygen -Y sign
    // avec la clé publique, la clé privée restant dans l'agent.
    let dir = key.public.parent().unwrap().to_path_buf();
    let message = dir.join("commit.txt");
    std::fs::write(&message, "tree 1234\nauthor Alice\n\nUn commit signé\n").unwrap();
    let (ok, out) = run(
        &running.endpoint,
        "ssh-keygen",
        vec!["-Y".into(), "sign".into(), "-n".into(), "git".into(), "-f".into(), key.public.to_string_lossy().into(), message.to_string_lossy().into()],
        None,
    )
    .await;
    assert!(ok, "ssh-keygen -Y sign : {out}");
    let sig = format!("{}.sig", message.to_string_lossy());
    let (ok, out) = run(
        &running.endpoint,
        "ssh-keygen",
        vec!["-Y".into(), "check-novalidate".into(), "-n".into(), "git".into(), "-s".into(), sig],
        Some(std::fs::read(&message).unwrap()),
    )
    .await;
    assert!(ok, "la signature se vérifie : {out}");

    let asked = backend.asked.lock().unwrap().clone();
    assert_eq!(asked.len(), 1, "une confirmation, pour la signature");
    assert_eq!(asked[0].purpose, UsePurpose::GitSignature);
    assert_eq!(asked[0].key_name, "key-k1");
    assert_eq!(asked[0].client.program.as_deref(), Some("ssh-keygen"));
}

#[tokio::test]
async fn a_refusal_makes_the_signature_fail() {
    let key = ClientKey::generate();
    let backend = Arc::new(TestBackend { keys: vec![load(&key, "k1", &[])], host: None, allow: false, asked: Mutex::new(vec![]) });
    let running = start(backend.clone()).await;
    let message = key.public.parent().unwrap().join("fichier.txt");
    std::fs::write(&message, "données").unwrap();
    let (ok, _) = run(
        &running.endpoint,
        "ssh-keygen",
        vec!["-Y".into(), "sign".into(), "-n".into(), "file".into(), "-f".into(), key.public.to_string_lossy().into(), message.to_string_lossy().into()],
        None,
    )
    .await;
    assert!(!ok, "refusée par l'utilisateur, la signature échoue");
    assert_eq!(backend.asked.lock().unwrap()[0].purpose, UsePurpose::Sshsig { namespace: "file".into() });
}

#[tokio::test]
async fn real_ssh_login_presents_only_the_hosts_key() {
    // Deux clés dans l'agent ; seule la seconde est autorisée par le serveur,
    // et c'est celle que l'hôte Guiterm « Prod » utilise.
    let other = ClientKey::generate();
    let right = ClientKey::generate();
    let sshd = TestSshd::start("agent", &right.public);
    let host_key = PublicKey::read_openssh_file(sshd.host_public_key_path()).unwrap();
    let prod = KnownHost { id: "h-prod".into(), label: "Prod".into() };
    let backend = Arc::new(TestBackend {
        keys: vec![load(&other, "autre", &[]), load(&right, "prod", &["h-prod"])],
        host: Some((host_key, prod.clone())),
        allow: true,
        asked: Mutex::new(vec![]),
    });
    let running = start(backend.clone()).await;

    let user = std::env::var("USER").unwrap_or_else(|_| "root".into());
    let login = |sock: String| {
        let user = user.clone();
        let port = sshd.port;
        async move {
            run(
                &sock,
                "ssh",
                vec![
                    "-v".into(),
                    "-F".into(), "/dev/null".into(),
                    "-o".into(), "BatchMode=yes".into(),
                    "-o".into(), "StrictHostKeyChecking=no".into(),
                    "-o".into(), "UserKnownHostsFile=/dev/null".into(),
                    "-o".into(), "IdentityFile=/dev/null".into(),
                    "-p".into(), port.to_string(),
                    format!("{user}@127.0.0.1"),
                    "true".into(),
                ],
                None,
            )
            .await
        }
    };
    let (ok, out) = login(running.endpoint.clone()).await;
    assert!(ok, "ssh par l'agent : {out}");
    // `ssh -v` dit que le client a lié sa session à la clé d'hôte, et quelles
    // clés l'agent lui a présentées : celle de l'hôte seulement.
    assert!(out.contains("bound agent to hostkey"), "session-bind envoyé : {out}");
    assert!(out.contains("agent returned 1 keys") && out.contains("key-prod"), "la clé de l'hôte est proposée : {out}");
    assert!(!out.contains("key-autre"), "l'autre clé n'est pas présentée : {out}");

    // Une seule demande : la bonne clé du premier coup, pour l'hôte reconnu.
    let asked = backend.asked.lock().unwrap().clone();
    assert_eq!(asked.len(), 1, "une seule signature demandée : {asked:?}");
    assert_eq!(asked[0].key_id, "prod");
    match &asked[0].purpose {
        UsePurpose::SshLogin { user: u, hosts, fingerprint } => {
            assert_eq!(u, &user);
            assert_eq!(hosts, &vec![prod]);
            assert!(fingerprint.as_deref().is_some_and(|f| f.starts_with("SHA256:")));
        }
        other => panic!("attendu une connexion SSH, pas {other:?}"),
    }
    assert_eq!(asked[0].client.program.as_deref(), Some("ssh"));

    // Hôte inconnu de Guiterm : toutes les clés, comme un agent ordinaire.
    let unknown = Arc::new(TestBackend {
        keys: vec![load(&other, "autre", &[]), load(&right, "prod", &["h-prod"])],
        host: None,
        allow: true,
        asked: Mutex::new(vec![]),
    });
    let running = start(unknown.clone()).await;
    let (ok, out) = login(running.endpoint.clone()).await;
    assert!(ok, "ssh par l'agent : {out}");
    assert!(out.contains("agent returned 2 keys") && out.contains("key-autre"), "les deux clés sont présentées : {out}");
    match &unknown.asked.lock().unwrap()[0].purpose {
        UsePurpose::SshLogin { hosts, .. } => assert!(hosts.is_empty()),
        other => panic!("attendu une connexion SSH, pas {other:?}"),
    }
}
