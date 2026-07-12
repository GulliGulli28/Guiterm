//! Docker container `exec` sessions (`docker exec -it` equivalent), via the
//! Docker Engine API (`bollard`) — talks to the daemon directly (unix
//! socket, Windows named pipe, or a plain tcp/http host) by default, or
//! tunnelled over an existing SSH connection ([`connect_via_ssh`]) when a
//! bastion is needed. Mirrors `docker exec` itself rather than `ssh` +
//! `docker exec`.
use crate::ssh::{Connection, ShellInput, ShellSession};
use bollard::Docker;
use bollard::container::LogOutput;
use bollard::exec::{CreateExecOptions, ResizeExecOptions, StartExecOptions, StartExecResults};
use bollard::query_parameters::ListContainersOptions;
use futures_util::StreamExt;
use serde::Serialize;
use std::sync::Arc;
use tokio::io::AsyncWriteExt;
use tokio::sync::mpsc;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerSummary {
    pub id: String,
    pub name: String,
    pub image: String,
    /// Docker's own state keyword (`running`, `exited`, `paused`, ...).
    pub state: String,
    /// Human-readable status text (e.g. `Up 3 hours`).
    pub status: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DockerHostKind {
    /// Empty string: use the platform default (local socket/named pipe).
    LocalDefault,
    Socket,
    Http,
}

fn classify_docker_host(docker_host: &str) -> DockerHostKind {
    let host = docker_host.trim();
    if host.is_empty() {
        DockerHostKind::LocalDefault
    } else if host.starts_with("unix://") || host.starts_with("npipe://") {
        DockerHostKind::Socket
    } else {
        DockerHostKind::Http
    }
}

/// Connects to a Docker daemon at `docker_host` — a unix socket path
/// (`unix:///var/run/docker.sock`), a Windows named pipe
/// (`npipe:////./pipe/docker_engine`), a plain tcp/http host
/// (`tcp://10.0.4.12:2375`), or an empty string for the local default.
pub fn connect(docker_host: &str) -> anyhow::Result<Docker> {
    let host = docker_host.trim();
    let docker = match classify_docker_host(host) {
        DockerHostKind::LocalDefault => Docker::connect_with_socket_defaults()?,
        DockerHostKind::Socket => Docker::connect_with_socket(host, 120, bollard::API_DEFAULT_VERSION)?,
        DockerHostKind::Http => Docker::connect_with_http(host, 120, bollard::API_DEFAULT_VERSION)?,
    };
    Ok(docker)
}

/// Wraps a `russh` channel stream so it can implement
/// [`hyper_util::client::legacy::connect::Connection`] — a marker trait
/// `ChannelStream` itself, being foreign to this crate, can't implement
/// directly (orphan rules). Delegates `AsyncRead`/`AsyncWrite` straight
/// through; `ChannelStream` is `Unpin` (a plain struct over channel
/// senders/receivers), so this newtype is too, and `get_mut()` is always
/// available.
struct DialStdioStream(russh::ChannelStream<russh::client::Msg>);

impl tokio::io::AsyncRead for DialStdioStream {
    fn poll_read(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &mut tokio::io::ReadBuf<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::pin::Pin::new(&mut self.get_mut().0).poll_read(cx, buf)
    }
}

impl tokio::io::AsyncWrite for DialStdioStream {
    fn poll_write(self: std::pin::Pin<&mut Self>, cx: &mut std::task::Context<'_>, buf: &[u8]) -> std::task::Poll<std::io::Result<usize>> {
        std::pin::Pin::new(&mut self.get_mut().0).poll_write(cx, buf)
    }

    fn poll_flush(self: std::pin::Pin<&mut Self>, cx: &mut std::task::Context<'_>) -> std::task::Poll<std::io::Result<()>> {
        std::pin::Pin::new(&mut self.get_mut().0).poll_flush(cx)
    }

    fn poll_shutdown(self: std::pin::Pin<&mut Self>, cx: &mut std::task::Context<'_>) -> std::task::Poll<std::io::Result<()>> {
        std::pin::Pin::new(&mut self.get_mut().0).poll_shutdown(cx)
    }
}

impl hyper_util::client::legacy::connect::Connection for DialStdioStream {
    fn connected(&self) -> hyper_util::client::legacy::connect::Connected {
        hyper_util::client::legacy::connect::Connected::new()
    }
}

/// A [`tower_service::Service`] connector for [`hyper_util::client::legacy::Client`]
/// that opens a *fresh* SSH `exec` channel running `docker system dial-stdio`
/// on `connection`'s target host for every underlying connection the client
/// asks for — the same bridge Docker's own `ssh://` context type uses (see
/// `bollard`'s own, unused-here, `src/ssh.rs`, which does the equivalent by
/// shelling out to `openssh` instead of reusing an already-authenticated
/// `russh` session), so the remote daemon never needs to expose a TCP port.
/// Only the `docker` CLI needs to be on the remote `PATH`, reachable by the
/// connecting user (typically: in the `docker` group, or root).
///
/// One channel per underlying connection the client asks for — never shared
/// across requests, but this falls out naturally from the connection pool
/// itself rather than needing to force it (see `connect_via_ssh`'s doc
/// comment on `pool_max_idle_per_host`): a request that upgrades the
/// connection (`exec`'s attach, see `docker::open_exec`) removes it from the
/// pool entirely once hijacked, so a concurrent request (e.g. `resize_exec`
/// while that attach is still streaming) always gets a fresh connection —
/// and therefore a fresh channel — rather than queueing behind it.
#[derive(Clone)]
struct DialStdioConnector {
    connection: Arc<Connection>,
}

impl tower_service::Service<hyper::Uri> for DialStdioConnector {
    type Response = hyper_util::rt::TokioIo<DialStdioStream>;
    type Error = anyhow::Error;
    type Future = std::pin::Pin<Box<dyn std::future::Future<Output = Result<Self::Response, Self::Error>> + Send>>;

    fn poll_ready(&mut self, _cx: &mut std::task::Context<'_>) -> std::task::Poll<Result<(), Self::Error>> {
        std::task::Poll::Ready(Ok(()))
    }

    fn call(&mut self, _destination: hyper::Uri) -> Self::Future {
        let connection = Arc::clone(&self.connection);
        Box::pin(async move {
            let channel = connection.target().channel_open_session().await?;
            channel.exec(true, "docker system dial-stdio").await?;
            Ok(hyper_util::rt::TokioIo::new(DialStdioStream(channel.into_stream())))
        })
    }
}

/// Connects to `connection`'s target host's Docker daemon by tunnelling the
/// Engine API over that already-authenticated SSH session
/// ([`DialStdioConnector`]) instead of a direct socket/TCP connection — for
/// [`crate::model::Host::docker_via_host_id`]. Goes through a real
/// `hyper_util::client::legacy::Client` (like `bollard`'s own `Unix`/`Http`/
/// `Ssh` transports do internally) rather than driving `hyper`'s low-level
/// connection API by hand: the legacy client is what fills in the `Host`
/// header from the request URI and handles pooling — a hand-rolled
/// `hyper::client::conn::http1` version of this (tried first) sent requests
/// with no `Host` header at all, which the Docker daemon rejects outright
/// (`400 Bad Request: missing required Host header`) since the low-level API
/// has no such default, unlike the legacy client.
///
/// Uses the client builder's plain defaults, deliberately not calling
/// `pool_max_idle_per_host(0)` — matching `bollard`'s own (unused-here)
/// `connect_with_ssh`, which doesn't either. An earlier version of this
/// function did set it (to force one channel per request, before realizing
/// the pool already guarantees that for free — see `DialStdioConnector`'s
/// doc comment), which broke `exec`'s attach/hijack entirely: forcing no
/// idle connections made the client eagerly shut down (a real
/// `SSH_MSG_CHANNEL_EOF`, not a soft close — see `DialStdioStream`) the
/// connection right after sending `start_exec`'s request body, before the
/// upgrade could hand off the raw stream — an interactive session would open
/// with no error, just an empty, permanently unresponsive terminal, since
/// the channel carrying it was already dead on arrival.
pub fn connect_via_ssh(connection: Arc<Connection>) -> anyhow::Result<Docker> {
    let connector = DialStdioConnector { connection };
    let client_builder = hyper_util::client::legacy::Client::builder(hyper_util::rt::TokioExecutor::new());
    let client = client_builder.build(connector);

    let transport = move |req: bollard::BollardRequest| {
        let client = client.clone();
        Box::pin(async move { client.request(req).await.map_err(bollard::errors::Error::from) })
    };
    let docker = Docker::connect_with_custom_transport(
        transport,
        Some("http://docker-over-ssh"),
        120,
        bollard::API_DEFAULT_VERSION,
    )?;
    Ok(docker)
}

/// Connects to `host`'s Docker daemon — directly via `host.address`
/// ([`connect`]), or tunnelled over SSH ([`connect_via_ssh`]) through
/// `host.docker_via_host_id` when that's set. `workspace` is only consulted
/// in the SSH case, to establish that other host's connection (auth,
/// known_hosts, bastion chaining all handled by [`crate::ssh::connect`]).
pub async fn connect_for_host(workspace: &crate::model::Workspace, host: &crate::model::Host) -> anyhow::Result<Docker> {
    match host.docker_via_host_id {
        Some(via_host_id) => {
            let connection = crate::ssh::connect(workspace, via_host_id)
                .await
                .map_err(|e| anyhow::anyhow!("hôte SSH relais : {e}"))?;
            connect_via_ssh(Arc::new(connection))
        }
        None => connect(&host.address),
    }
}

pub async fn list_containers(docker: &Docker) -> anyhow::Result<Vec<ContainerSummary>> {
    let containers = docker
        .list_containers(Some(ListContainersOptions {
            all: true,
            ..Default::default()
        }))
        .await?;
    Ok(containers
        .into_iter()
        .map(|c| ContainerSummary {
            id: c.id.unwrap_or_default(),
            name: c
                .names
                .and_then(|names| names.into_iter().next())
                .map(|n| n.trim_start_matches('/').to_string())
                .unwrap_or_default(),
            image: c.image.unwrap_or_default(),
            state: c.state.map(|s| s.to_string()).unwrap_or_default(),
            status: c.status.unwrap_or_default(),
        })
        .collect())
}

/// Opens an interactive TTY `exec` session in `container_id`, bridged onto
/// the same plain byte-stream channels as [`crate::ssh::open_shell`] so the
/// terminal widget never needs to know which backend it's talking to.
pub async fn open_exec(
    docker: Docker,
    container_id: &str,
    cols: u16,
    rows: u16,
) -> anyhow::Result<ShellSession> {
    let exec = docker
        .create_exec(
            container_id,
            CreateExecOptions::<String> {
                attach_stdin: Some(true),
                attach_stdout: Some(true),
                attach_stderr: Some(true),
                tty: Some(true),
                // `command -v bash` first, rather than letting a failed `exec
                // bash` fall through to `|| exec sh` directly: BusyBox `ash`
                // (Alpine's default `/bin/sh` — no `bash` package by default)
                // treats `exec`ing a missing command as fatal and exits the
                // whole `sh -c` script immediately instead of returning a
                // non-zero status `||` could catch, so the `exec sh` fallback
                // was never actually reached on those images — an empty,
                // instantly-closed session, not a real error. `bash`/`dash`
                // don't have this quirk, but `command -v` (a portable POSIX
                // builtin) sidesteps it everywhere by only ever `exec`ing a
                // command already confirmed to exist. Found by reproducing
                // against a real `alpine` container, not by reading docs.
                cmd: Some(vec![
                    "sh".to_string(),
                    "-c".to_string(),
                    "command -v bash >/dev/null 2>&1 && exec bash || exec sh".to_string(),
                ]),
                ..Default::default()
            },
        )
        .await?
        .id;

    let started = docker
        .start_exec(
            &exec,
            Some(StartExecOptions {
                detach: false,
                tty: true,
                output_capacity: None,
            }),
        )
        .await?;
    let StartExecResults::Attached { mut output, mut input } = started else {
        anyhow::bail!("le conteneur n'a pas accepté la connexion exec");
    };
    let _ = docker
        .resize_exec(&exec, ResizeExecOptions { height: rows, width: cols })
        .await;

    let (input_tx, mut input_rx) = mpsc::channel::<ShellInput>(256);
    let (output_tx, output_rx) = mpsc::channel::<Vec<u8>>(256);

    tokio::spawn(async move {
        while let Some(msg) = input_rx.recv().await {
            match msg {
                ShellInput::Data(bytes) => {
                    if input.write_all(&bytes).await.is_err() {
                        break;
                    }
                }
                ShellInput::Resize { cols, rows } => {
                    let _ = docker
                        .resize_exec(&exec, ResizeExecOptions { height: rows, width: cols })
                        .await;
                }
            }
        }
    });

    tokio::spawn(async move {
        while let Some(Ok(chunk)) = output.next().await {
            if output_tx.send(chunk.as_ref().to_vec()).await.is_err() {
                break;
            }
        }
    });

    Ok(ShellSession { input: input_tx, output: output_rx })
}

/// Runs `cmd` inside `container_id` to completion — non-interactive, no PTY
/// (`tty: false`, unlike [`open_exec`]) — writes `stdin` if given (shutting
/// its write half down afterward so the remote command sees EOF, needed for
/// anything reading until end-of-input), and returns captured stdout.
/// Errors on a non-zero exit code, with stderr folded into the message —
/// used by `crate::docker_pane` for the shell-based Docker pane operations
/// (listing, mkdir, rename, remove, chmod) that have no Engine API
/// equivalent. `cmd`'s arguments are passed as a real argv array (never
/// string-interpolated into a shell command line), so callers building a
/// `sh -c '<script>' sh "$1" "$2" ...` invocation can hand untrusted path
/// segments through positional parameters without any escaping of their own.
pub(crate) async fn exec_capture(
    docker: &Docker,
    container_id: &str,
    cmd: Vec<String>,
    stdin: Option<Vec<u8>>,
) -> anyhow::Result<Vec<u8>> {
    let exec = docker
        .create_exec(
            container_id,
            CreateExecOptions::<String> {
                attach_stdin: Some(stdin.is_some()),
                attach_stdout: Some(true),
                attach_stderr: Some(true),
                tty: Some(false),
                cmd: Some(cmd),
                ..Default::default()
            },
        )
        .await?
        .id;

    let started = docker
        .start_exec(&exec, Some(StartExecOptions { detach: false, tty: false, output_capacity: None }))
        .await?;
    let StartExecResults::Attached { mut output, input } = started else {
        anyhow::bail!("le conteneur n'a pas accepté la commande");
    };

    if let Some(data) = stdin {
        let mut input = input;
        input.write_all(&data).await?;
        input.shutdown().await?;
    }

    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    while let Some(chunk) = output.next().await {
        match chunk? {
            LogOutput::StdOut { message } => stdout.extend_from_slice(&message),
            LogOutput::StdErr { message } => stderr.extend_from_slice(&message),
            LogOutput::StdIn { .. } | LogOutput::Console { .. } => {}
        }
    }

    let inspect = docker.inspect_exec(&exec).await?;
    if inspect.exit_code != Some(0) {
        let detail = String::from_utf8_lossy(&stderr).trim().to_string();
        anyhow::bail!(
            "commande distante en échec (code {:?}){}",
            inspect.exit_code,
            if detail.is_empty() { String::new() } else { format!(" : {detail}") }
        );
    }
    Ok(stdout)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_empty_as_local_default() {
        assert_eq!(classify_docker_host(""), DockerHostKind::LocalDefault);
        assert_eq!(classify_docker_host("   "), DockerHostKind::LocalDefault);
    }

    #[test]
    fn classifies_unix_and_npipe_as_socket() {
        assert_eq!(classify_docker_host("unix:///var/run/docker.sock"), DockerHostKind::Socket);
        assert_eq!(classify_docker_host("npipe:////./pipe/docker_engine"), DockerHostKind::Socket);
    }

    #[test]
    fn classifies_tcp_and_http_as_http() {
        assert_eq!(classify_docker_host("tcp://10.0.4.12:2375"), DockerHostKind::Http);
        assert_eq!(classify_docker_host("http://10.0.4.12:2375"), DockerHostKind::Http);
    }
}
