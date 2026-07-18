//! Local (`ssh -L`) and remote (`ssh -R`) TCP port forwarding over an
//! established [`crate::ssh::Connection`].
use crate::sync_ext::MutexExt;
use crate::model::{PortForward, PortForwardKind};
use crate::ssh::Connection;
use std::sync::Arc;
use tokio::net::TcpListener;
use tokio::task::JoinHandle;

/// A forward currently relaying traffic. Dropping this does **not** stop the
/// forward — call [`ActiveForward::stop`] explicitly.
pub struct ActiveForward {
    config: PortForward,
    kind: ActiveKind,
}

enum ActiveKind {
    Local(JoinHandle<()>),
    Remote,
}

impl ActiveForward {
    pub async fn stop(self, connection: &Connection) {
        match self.kind {
            ActiveKind::Local(accept_loop) => accept_loop.abort(),
            ActiveKind::Remote => {
                connection
                    .remote_forward_routes()
                    .lock_recover()
                    .remove(&(
                        self.config.bind_address.clone(),
                        self.config.bind_port as u32,
                    ));
                let _ = connection
                    .target()
                    .cancel_tcpip_forward(
                        self.config.bind_address.clone(),
                        self.config.bind_port as u32,
                    )
                    .await;
            }
        }
    }
}

/// `connection` is an `Arc` because local forwarding spawns a long-lived
/// background task that keeps issuing channel opens on it; the `Arc` keeps
/// the whole bastion chain alive for as long as that task runs.
pub async fn start(
    connection: Arc<Connection>,
    forward: PortForward,
) -> anyhow::Result<ActiveForward> {
    match forward.kind {
        PortForwardKind::Local => start_local(connection, forward).await,
        PortForwardKind::Remote => start_remote(&connection, forward).await,
        PortForwardKind::Dynamic => start_dynamic(connection, forward).await,
    }
}

async fn start_local(
    connection: Arc<Connection>,
    forward: PortForward,
) -> anyhow::Result<ActiveForward> {
    let listener = TcpListener::bind((forward.bind_address.as_str(), forward.bind_port))
        .await
        .map_err(|e| {
            anyhow::anyhow!(
                "could not listen on {}:{}: {e}",
                forward.bind_address,
                forward.bind_port
            )
        })?;

    let dest_address = forward.dest_address.clone();
    let dest_port = forward.dest_port;

    let accept_loop = tokio::spawn(async move {
        loop {
            let Ok((stream, peer)) = listener.accept().await else {
                break;
            };
            let connection = connection.clone();
            let dest_address = dest_address.clone();
            tokio::spawn(async move {
                let mut stream = stream;
                let channel = match connection
                    .target()
                    .channel_open_direct_tcpip(
                        dest_address,
                        dest_port as u32,
                        peer.ip().to_string(),
                        peer.port() as u32,
                    )
                    .await
                {
                    Ok(channel) => channel,
                    Err(_) => return,
                };
                let mut remote = channel.into_stream();
                let _ = tokio::io::copy_bidirectional(&mut stream, &mut remote).await;
            });
        }
    });

    Ok(ActiveForward {
        config: forward,
        kind: ActiveKind::Local(accept_loop),
    })
}

/// A local SOCKS5 proxy (`ssh -D`): each accepted connection picks its own
/// destination via the SOCKS handshake, unlike `start_local` where the
/// destination is fixed for the whole listener. Reuses `ActiveKind::Local`
/// since stopping it means the same thing: abort the accept loop.
async fn start_dynamic(
    connection: Arc<Connection>,
    forward: PortForward,
) -> anyhow::Result<ActiveForward> {
    let listener = TcpListener::bind((forward.bind_address.as_str(), forward.bind_port))
        .await
        .map_err(|e| {
            anyhow::anyhow!(
                "could not listen on {}:{}: {e}",
                forward.bind_address,
                forward.bind_port
            )
        })?;

    let accept_loop = tokio::spawn(async move {
        loop {
            let Ok((stream, peer)) = listener.accept().await else {
                break;
            };
            let connection = connection.clone();
            tokio::spawn(async move {
                let _ = handle_socks_connection(&connection, stream, peer).await;
            });
        }
    });

    Ok(ActiveForward {
        config: forward,
        kind: ActiveKind::Local(accept_loop),
    })
}

/// Minimal SOCKS5 server (RFC 1928): no authentication, `CONNECT` only.
/// Domain-name destinations are passed through as-is to
/// `channel_open_direct_tcpip`, which lets the *remote* sshd resolve them —
/// exactly the point of `-D`, no local DNS involved.
async fn handle_socks_connection(
    connection: &Connection,
    mut stream: tokio::net::TcpStream,
    peer: std::net::SocketAddr,
) -> anyhow::Result<()> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let mut greeting = [0u8; 2];
    stream.read_exact(&mut greeting).await?;
    anyhow::ensure!(greeting[0] == 0x05, "unsupported SOCKS version {}", greeting[0]);
    let mut methods = vec![0u8; greeting[1] as usize];
    stream.read_exact(&mut methods).await?;
    stream.write_all(&[0x05, 0x00]).await?; // no authentication required

    let mut request = [0u8; 4];
    stream.read_exact(&mut request).await?;
    let dest_address = match request[3] {
        0x01 => {
            let mut buf = [0u8; 4];
            stream.read_exact(&mut buf).await?;
            std::net::Ipv4Addr::from(buf).to_string()
        }
        0x03 => {
            let mut len = [0u8; 1];
            stream.read_exact(&mut len).await?;
            let mut buf = vec![0u8; len[0] as usize];
            stream.read_exact(&mut buf).await?;
            String::from_utf8(buf)?
        }
        0x04 => {
            let mut buf = [0u8; 16];
            stream.read_exact(&mut buf).await?;
            std::net::Ipv6Addr::from(buf).to_string()
        }
        atyp => anyhow::bail!("unsupported SOCKS address type {atyp}"),
    };
    let mut port_buf = [0u8; 2];
    stream.read_exact(&mut port_buf).await?;
    let dest_port = u16::from_be_bytes(port_buf);

    if request[1] != 0x01 {
        stream.write_all(&socks_reply(0x07)).await?;
        anyhow::bail!("unsupported SOCKS command {}", request[1]);
    }

    let channel = match connection
        .target()
        .channel_open_direct_tcpip(
            dest_address,
            dest_port as u32,
            peer.ip().to_string(),
            peer.port() as u32,
        )
        .await
    {
        Ok(channel) => channel,
        Err(e) => {
            stream.write_all(&socks_reply(0x05)).await?;
            anyhow::bail!("SOCKS destination unreachable: {e}");
        }
    };
    stream.write_all(&socks_reply(0x00)).await?;

    let mut remote = channel.into_stream();
    tokio::io::copy_bidirectional(&mut stream, &mut remote).await?;
    Ok(())
}

/// A `CONNECT` reply with `BND.ADDR`/`BND.PORT` left as `0.0.0.0:0` — every
/// SOCKS5 client tested against this server only cares about `REP` for that
/// command, not the bound address.
fn socks_reply(rep: u8) -> [u8; 10] {
    [0x05, rep, 0x00, 0x01, 0, 0, 0, 0, 0, 0]
}

async fn start_remote(
    connection: &Connection,
    forward: PortForward,
) -> anyhow::Result<ActiveForward> {
    let route_key = (forward.bind_address.clone(), forward.bind_port as u32);

    // Register the route *before* asking the server to forward: the server can start
    // pushing connections as soon as it acks the request, so inserting the mapping
    // first avoids a race where an early connection finds no route and gets dropped
    // (see `AppHandler::server_channel_open_forwarded_tcpip`).
    connection
        .remote_forward_routes()
        .lock_recover()
        .insert(
            route_key.clone(),
            (forward.dest_address.clone(), forward.dest_port as u32),
        );

    if let Err(e) = connection
        .target()
        .tcpip_forward(forward.bind_address.clone(), forward.bind_port as u32)
        .await
    {
        connection
            .remote_forward_routes()
            .lock_recover()
            .remove(&route_key);
        anyhow::bail!(
            "remote refused to forward {}:{}: {e}",
            forward.bind_address,
            forward.bind_port
        );
    }

    Ok(ActiveForward {
        config: forward,
        kind: ActiveKind::Remote,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn socks_reply_success() {
        assert_eq!(socks_reply(0x00), [0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]);
    }

    #[test]
    fn socks_reply_command_not_supported() {
        assert_eq!(socks_reply(0x07)[1], 0x07);
    }

    #[test]
    fn socks_reply_host_unreachable() {
        assert_eq!(socks_reply(0x05)[1], 0x05);
    }

    #[test]
    fn socks_reply_bnd_addr_and_port_are_always_zero() {
        let reply = socks_reply(0x00);
        assert_eq!(&reply[4..], &[0, 0, 0, 0, 0, 0]);
    }
}
