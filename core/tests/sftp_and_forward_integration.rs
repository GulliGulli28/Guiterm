//! Real end-to-end coverage for SFTP and TCP port forwarding, against an
//! actual `sshd` (not a mock).
mod common;

use common::{ClientKey, TestSshd, test_host};
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use termius_core::model::{PortForward, PortForwardKind, Workspace};
use termius_core::{port_forward, sftp, ssh};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use uuid::Uuid;

#[tokio::test]
async fn sftp_round_trip() {
    let key = ClientKey::generate();
    let sshd = TestSshd::start("sftp", &key.public);
    let host = test_host(&sshd, &key, "test-sftp");
    let host_id = host.id;

    let mut workspace = Workspace::default();
    workspace.hosts.push(host);

    let connection = ssh::connect(&workspace, host_id)
        .await
        .expect("connect should succeed");
    let client = sftp::SftpClient::open(&connection)
        .await
        .expect("open sftp session");

    let home = client.home_dir().await.expect("home dir");
    let dir = sftp::join(&home, &format!("guiterm-test-{}", Uuid::new_v4()));
    client.make_dir(&dir).await.expect("mkdir");

    let remote_file = sftp::join(&dir, "hello.txt");
    let local_src = std::env::temp_dir().join(format!("guiterm-upload-{}.txt", Uuid::new_v4()));
    tokio::fs::write(&local_src, b"hello sftp").await.unwrap();

    client
        .upload(&local_src, &remote_file, &AtomicBool::new(false), |_, _| {})
        .await
        .expect("upload");

    let entries = client.list(&dir).await.expect("list dir");
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].name, "hello.txt");
    assert!(!entries[0].is_dir);
    assert_eq!(entries[0].size, "hello sftp".len() as u64);

    let local_dst =
        std::env::temp_dir().join(format!("guiterm-download-{}.txt", Uuid::new_v4()));
    client
        .download(
            &remote_file,
            &local_dst,
            entries[0].size,
            &AtomicBool::new(false),
            |_, _| {},
        )
        .await
        .expect("download");
    let downloaded = tokio::fs::read_to_string(&local_dst).await.unwrap();
    assert_eq!(downloaded, "hello sftp");

    let renamed = sftp::join(&dir, "renamed.txt");
    client.rename(&remote_file, &renamed).await.expect("rename");
    client.remove_file(&renamed).await.expect("remove file");
    client.remove_dir(&dir).await.expect("remove dir");

    let _ = tokio::fs::remove_file(&local_src).await;
    let _ = tokio::fs::remove_file(&local_dst).await;
}

#[tokio::test]
async fn local_port_forward_reaches_a_local_service() {
    let key = ClientKey::generate();
    let sshd = TestSshd::start("fwd-local", &key.public);
    let host = test_host(&sshd, &key, "test-fwd-local");
    let host_id = host.id;

    let mut workspace = Workspace::default();
    workspace.hosts.push(host);
    let connection = Arc::new(
        ssh::connect(&workspace, host_id)
            .await
            .expect("connect should succeed"),
    );

    // A trivial echo service "behind" the SSH server, reachable only via the tunnel.
    let echo_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let echo_port = echo_listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        if let Ok((mut stream, _)) = echo_listener.accept().await {
            let mut buf = [0u8; 64];
            if let Ok(n) = stream.read(&mut buf).await {
                let _ = stream.write_all(&buf[..n]).await;
            }
        }
    });

    let local_bind_port = common::free_port();
    let forward = PortForward {
        id: Uuid::new_v4(),
        host_id,
        kind: PortForwardKind::Local,
        bind_address: "127.0.0.1".to_string(),
        bind_port: local_bind_port,
        dest_address: "127.0.0.1".to_string(),
        dest_port: echo_port,
    };
    let active = port_forward::start(connection.clone(), forward)
        .await
        .expect("start local forward");

    let mut client = TcpStream::connect(("127.0.0.1", local_bind_port))
        .await
        .expect("connect to forwarded port");
    client.write_all(b"ping").await.unwrap();
    let mut buf = [0u8; 4];
    client.read_exact(&mut buf).await.unwrap();
    assert_eq!(&buf, b"ping");

    active.stop(&connection).await;
}

/// `bind_port: 0` (an OS-assigned ephemeral port) is exactly what
/// `core::sql::connect` uses for its ad-hoc, never-persisted SSH tunnel —
/// `ActiveForward::bound_addr()` is how the caller finds out which port was
/// actually picked, since `TcpListener::bind` never reports it back on its
/// own.
#[tokio::test]
async fn local_forward_with_ephemeral_bind_port_reports_the_bound_port() {
    let key = ClientKey::generate();
    let sshd = TestSshd::start("fwd-ephemeral", &key.public);
    let host = test_host(&sshd, &key, "test-fwd-ephemeral");
    let host_id = host.id;

    let mut workspace = Workspace::default();
    workspace.hosts.push(host);
    let connection = Arc::new(
        ssh::connect(&workspace, host_id)
            .await
            .expect("connect should succeed"),
    );

    let echo_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let echo_port = echo_listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        if let Ok((mut stream, _)) = echo_listener.accept().await {
            let mut buf = [0u8; 64];
            if let Ok(n) = stream.read(&mut buf).await {
                let _ = stream.write_all(&buf[..n]).await;
            }
        }
    });

    let forward = PortForward {
        id: Uuid::new_v4(),
        host_id,
        kind: PortForwardKind::Local,
        bind_address: "127.0.0.1".to_string(),
        bind_port: 0,
        dest_address: "127.0.0.1".to_string(),
        dest_port: echo_port,
    };
    let active = port_forward::start(connection.clone(), forward)
        .await
        .expect("start local forward");

    let bound = active.bound_addr().expect("ephemeral bind reports its port");
    assert_ne!(bound.port(), 0, "the OS should have assigned a real port");

    let mut client = TcpStream::connect(bound)
        .await
        .expect("connect to the reported ephemeral port");
    client.write_all(b"ping").await.unwrap();
    let mut buf = [0u8; 4];
    client.read_exact(&mut buf).await.unwrap();
    assert_eq!(&buf, b"ping");

    active.stop(&connection).await;
}

#[tokio::test]
async fn remote_port_forward_reaches_a_local_service() {
    let key = ClientKey::generate();
    let sshd = TestSshd::start("fwd-remote", &key.public);
    let host = test_host(&sshd, &key, "test-fwd-remote");
    let host_id = host.id;

    let mut workspace = Workspace::default();
    workspace.hosts.push(host);
    let connection = Arc::new(
        ssh::connect(&workspace, host_id)
            .await
            .expect("connect should succeed"),
    );

    // A trivial echo service on "our" side, reachable from the SSH server via -R.
    let echo_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let echo_port = echo_listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        loop {
            let Ok((mut stream, _)) = echo_listener.accept().await else {
                break;
            };
            tokio::spawn(async move {
                let mut buf = [0u8; 64];
                if let Ok(n) = stream.read(&mut buf).await {
                    let _ = stream.write_all(&buf[..n]).await;
                }
            });
        }
    });

    let remote_bind_port = common::free_port();
    let forward = PortForward {
        id: Uuid::new_v4(),
        host_id,
        kind: PortForwardKind::Remote,
        bind_address: "127.0.0.1".to_string(),
        bind_port: remote_bind_port,
        dest_address: "127.0.0.1".to_string(),
        dest_port: echo_port,
    };
    let active = port_forward::start(connection.clone(), forward)
        .await
        .expect("start remote forward");

    // Ask the *sshd* itself to connect to the port it is now forwarding for us.
    let mut probe = connection
        .target()
        .channel_open_direct_tcpip("127.0.0.1", remote_bind_port as u32, "127.0.0.1", 0)
        .await
        .expect("probe channel");
    probe.data(&b"pong"[..]).await.unwrap();

    let mut received = Vec::new();
    loop {
        match probe.wait().await {
            Some(russh::ChannelMsg::Data { data }) => {
                received.extend_from_slice(&data);
                if received.len() >= 4 {
                    break;
                }
            }
            Some(russh::ChannelMsg::Eof) | Some(russh::ChannelMsg::Close) | None => break,
            _ => {}
        }
    }
    assert_eq!(received, b"pong");

    active.stop(&connection).await;
}

#[tokio::test]
async fn dynamic_port_forward_reaches_a_local_service() {
    let key = ClientKey::generate();
    let sshd = TestSshd::start("fwd-dynamic", &key.public);
    let host = test_host(&sshd, &key, "test-fwd-dynamic");
    let host_id = host.id;

    let mut workspace = Workspace::default();
    workspace.hosts.push(host);
    let connection = Arc::new(
        ssh::connect(&workspace, host_id)
            .await
            .expect("connect should succeed"),
    );

    // A trivial echo service "behind" the SSH server, reachable only via the tunnel —
    // same as the local-forward test, but this time the client picks it at connect time.
    let echo_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let echo_port = echo_listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        if let Ok((mut stream, _)) = echo_listener.accept().await {
            let mut buf = [0u8; 64];
            if let Ok(n) = stream.read(&mut buf).await {
                let _ = stream.write_all(&buf[..n]).await;
            }
        }
    });

    let local_bind_port = common::free_port();
    let forward = PortForward {
        id: Uuid::new_v4(),
        host_id,
        kind: PortForwardKind::Dynamic,
        bind_address: "127.0.0.1".to_string(),
        bind_port: local_bind_port,
        dest_address: String::new(),
        dest_port: 0,
    };
    let active = port_forward::start(connection.clone(), forward)
        .await
        .expect("start dynamic forward");

    let mut client = TcpStream::connect(("127.0.0.1", local_bind_port))
        .await
        .expect("connect to SOCKS listener");

    // SOCKS5 greeting: version 5, one method offered, "no authentication".
    client.write_all(&[0x05, 0x01, 0x00]).await.unwrap();
    let mut method_reply = [0u8; 2];
    client.read_exact(&mut method_reply).await.unwrap();
    assert_eq!(method_reply, [0x05, 0x00], "server should accept no-auth");

    // CONNECT request to the echo service, addressed by IPv4.
    let mut request = vec![0x05, 0x01, 0x00, 0x01];
    request.extend_from_slice(&[127, 0, 0, 1]);
    request.extend_from_slice(&echo_port.to_be_bytes());
    client.write_all(&request).await.unwrap();

    let mut connect_reply = [0u8; 10];
    client.read_exact(&mut connect_reply).await.unwrap();
    assert_eq!(connect_reply[1], 0x00, "CONNECT should succeed");

    client.write_all(b"ping").await.unwrap();
    let mut buf = [0u8; 4];
    client.read_exact(&mut buf).await.unwrap();
    assert_eq!(&buf, b"ping");

    active.stop(&connection).await;
}
