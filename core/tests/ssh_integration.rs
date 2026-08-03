//! End-to-end test against real `sshd` processes (not mocks): verifies a
//! direct connection, a password-rejected case, and a two-hop bastion chain
//! actually negotiate SSH, authenticate and run a command over the wire.
mod common;

use common::{ClientKey, TestSshd, test_host};
use termius_core::model::{AuthMethod, Workspace};
use termius_core::ssh;

async fn run_command(
    workspace: &Workspace,
    host_id: termius_core::model::HostId,
    command: &str,
) -> String {
    let connection = ssh::connect(workspace, host_id)
        .await
        .expect("connect should succeed");
    let mut channel = connection
        .target()
        .channel_open_session()
        .await
        .expect("open session channel");
    channel.exec(true, command).await.expect("exec");

    let mut output = Vec::new();
    loop {
        match channel.wait().await {
            Some(russh::ChannelMsg::Data { data }) => output.extend_from_slice(&data),
            Some(russh::ChannelMsg::ExitStatus { .. }) | None => break,
            _ => {}
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
    host.auth = AuthMethod::PrivateKey {
        path: wrong_key.private.to_string_lossy().to_string(),
        key_id: None,
    };
    let host_id = host.id;

    let mut workspace = Workspace::default();
    workspace.hosts.push(host);

    let err = match ssh::connect(&workspace, host_id).await {
        Ok(_) => panic!("auth with the wrong key must fail"),
        Err(err) => err,
    };
    assert!(
        err.to_string().to_lowercase().contains("auth"),
        "unexpected error: {err}"
    );
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

/// A host reached through a `ProxyCommand` — the mechanism cloud VMs with no
/// public IP and no inbound SSH depend on (AWS SSM, GCP IAP, Azure Bastion,
/// `cloudflared`).
///
/// `nc` stands in for the cloud helper. That substitution is the point rather
/// than a shortcut: none of those tools do anything the SSH client can see
/// beyond relaying bytes on stdin/stdout, so a helper that relays bytes
/// exercises exactly the same code path — and unlike a real cloud tunnel, it
/// runs without credentials.
#[tokio::test]
async fn proxy_command_reaches_the_target() {
    let key = ClientKey::generate();
    let sshd = TestSshd::start("proxy-cmd", &key.public);

    let mut host = test_host(&sshd, &key, "test-proxy");
    // Written with the tokens rather than the resolved port, so this also
    // proves the expansion feeds the process that actually runs.
    host.proxy_command = Some("nc %h %p".to_string());
    let host_id = host.id;

    let mut workspace = Workspace::default();
    workspace.hosts.push(host);

    let output = run_command(&workspace, host_id, "echo hello-through-proxy-command").await;
    assert_eq!(output.trim(), "hello-through-proxy-command");
}

/// A proxy command that fails must say why. Without the helper's own stderr
/// this surfaces as a bare handshake failure, which tells the user nothing
/// about the expired login or mistyped instance id behind it.
#[tokio::test]
async fn a_failing_proxy_command_reports_its_own_error() {
    let key = ClientKey::generate();
    let sshd = TestSshd::start("proxy-cmd-fail", &key.public);

    let mut host = test_host(&sshd, &key, "test-proxy-fail");
    host.proxy_command = Some("echo 'identifiants expires' >&2; exit 1".to_string());
    let host_id = host.id;

    let mut workspace = Workspace::default();
    workspace.hosts.push(host);

    let err = match ssh::connect(&workspace, host_id).await {
        Ok(_) => panic!("a proxy command that exits immediately cannot yield a connection"),
        Err(err) => err,
    };
    assert!(
        err.to_string().contains("identifiants expires"),
        "the helper's own stderr must reach the user, got: {err}"
    );
}

/// A proxy command belongs to the first hop of a chain — the only hop with a
/// local transport to replace. On the first hop it works; on a later one it is
/// refused rather than silently ignored.
#[tokio::test]
async fn a_proxy_command_applies_to_the_first_hop_only() {
    let key = ClientKey::generate();
    let bastion_sshd = TestSshd::start("proxy-bastion", &key.public);
    let target_sshd = TestSshd::start("proxy-bastion-target", &key.public);

    // The bastion is chain[0], so its proxy command is legal and used —
    // reaching a target through a bastion that is itself only reachable via
    // SSM is the realistic cloud shape.
    let mut bastion = test_host(&bastion_sshd, &key, "test-bastion-proxied");
    bastion.proxy_command = Some("nc %h %p".to_string());
    let bastion_id = bastion.id;
    let mut target = test_host(&target_sshd, &key, "test-target-behind");
    target.jump_via = vec![bastion_id];
    let target_id = target.id;

    let mut workspace = Workspace::default();
    workspace.hosts.push(bastion);
    workspace.hosts.push(target);

    let output = run_command(&workspace, target_id, "echo hello-behind-proxied-bastion").await;
    assert_eq!(output.trim(), "hello-behind-proxied-bastion");

    // ...whereas on the target of a chain it has no meaning at all.
    let bastion = test_host(&bastion_sshd, &key, "plain-bastion");
    let bastion_id = bastion.id;
    let mut target = test_host(&target_sshd, &key, "proxied-target");
    target.jump_via = vec![bastion_id];
    target.proxy_command = Some("nc %h %p".to_string());
    let target_id = target.id;

    let mut workspace = Workspace::default();
    workspace.hosts.push(bastion);
    workspace.hosts.push(target);

    let err = match ssh::connect(&workspace, target_id).await {
        Ok(_) => panic!("a proxy command on a non-first hop must be refused"),
        Err(err) => err,
    };
    assert!(
        err.to_string().contains("jump host"),
        "unexpected error: {err}"
    );
}
