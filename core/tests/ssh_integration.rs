//! End-to-end test against real `sshd` processes (not mocks): verifies a
//! direct connection, a password-rejected case, and a two-hop bastion chain
//! actually negotiate SSH, authenticate and run a command over the wire.
mod common;

use common::{ClientKey, TestSshd, test_host};
use termius_core::model::{AuthMethod, Workspace};
use termius_core::ssh;

async fn run_command(workspace: &Workspace, host_id: termius_core::model::HostId, command: &str) -> String {
    let connection = ssh::connect(workspace, host_id).await.expect("connect should succeed");
    let mut channel = connection.target().channel_open_session().await.expect("open session channel");
    channel.exec(true, command).await.expect("exec");

    let mut output = Vec::new();
    loop {
        match channel.wait().await {
            Some(russh::ChannelMsg::Data { data }) => output.extend_from_slice(&data),
            Some(russh::ChannelMsg::ExitStatus { .. }) | None => break,
            _ => {},
        }
    }
    String::from_utf8(output).unwrap()
}

#[tokio::test]
async fn direct_connection_runs_a_command() {
    let key = ClientKey::generate();
    let sshd = TestSshd::start("direct", &key.public);
    let host = test_host(&sshd, &key, "test-direct");
    let host_id = host.id;

    let mut workspace = Workspace::default();
    workspace.hosts.push(host);

    let output = run_command(&workspace, host_id, "echo hello-from-test-sshd").await;
    assert_eq!(output.trim(), "hello-from-test-sshd");
}

#[tokio::test]
async fn wrong_key_is_rejected() {
    let key = ClientKey::generate();
    let wrong_key = ClientKey::generate();
    let sshd = TestSshd::start("rejected", &key.public);

    let mut host = test_host(&sshd, &key, "test-reject");
    host.auth = AuthMethod::PrivateKey { path: wrong_key.private.to_string_lossy().to_string(), key_id: None };
    let host_id = host.id;

    let mut workspace = Workspace::default();
    workspace.hosts.push(host);

    let err = match ssh::connect(&workspace, host_id).await {
        Ok(_) => panic!("auth with the wrong key must fail"),
        Err(err) => err,
    };
    assert!(err.to_string().to_lowercase().contains("auth"), "unexpected error: {err}");
}

#[tokio::test]
async fn bastion_chain_reaches_the_target() {
    let key = ClientKey::generate();
    let bastion_sshd = TestSshd::start("bastion", &key.public);
    let target_sshd = TestSshd::start("target", &key.public);

    let bastion = test_host(&bastion_sshd, &key, "test-bastion");
    let bastion_id = bastion.id;

    let mut target = test_host(&target_sshd, &key, "test-target");
    target.jump_via = vec![bastion_id];
    let target_id = target.id;

    let mut workspace = Workspace::default();
    workspace.hosts.push(bastion);
    workspace.hosts.push(target);

    let output = run_command(&workspace, target_id, "echo hello-through-bastion").await;
    assert_eq!(output.trim(), "hello-through-bastion");
}

