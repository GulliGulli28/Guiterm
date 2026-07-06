//! Local (`ssh -L`) and remote (`ssh -R`) TCP port forwarding over an
//! established [`crate::ssh::Connection`].
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
    pub fn config(&self) -> &PortForward {
        &self.config
    }

    pub async fn stop(self, connection: &Connection) {
        match self.kind {
            ActiveKind::Local(accept_loop) => accept_loop.abort(),
            ActiveKind::Remote => {
                connection
                    .remote_forward_routes()
                    .lock()
                    .expect("lock poisoned")
                    .remove(&(self.config.bind_address.clone(), self.config.bind_port as u32));
                let _ = connection.target().cancel_tcpip_forward(self.config.bind_address.clone(), self.config.bind_port as u32).await;
            },
        }
    }
}

/// `connection` is an `Arc` because local forwarding spawns a long-lived
/// background task that keeps issuing channel opens on it; the `Arc` keeps
/// the whole bastion chain alive for as long as that task runs.
pub async fn start(connection: Arc<Connection>, forward: PortForward) -> anyhow::Result<ActiveForward> {
    match forward.kind {
        PortForwardKind::Local => start_local(connection, forward).await,
        PortForwardKind::Remote => start_remote(&connection, forward).await,
    }
}

async fn start_local(connection: Arc<Connection>, forward: PortForward) -> anyhow::Result<ActiveForward> {
    let listener = TcpListener::bind((forward.bind_address.as_str(), forward.bind_port))
        .await
        .map_err(|e| anyhow::anyhow!("could not listen on {}:{}: {e}", forward.bind_address, forward.bind_port))?;

    let dest_address = forward.dest_address.clone();
    let dest_port = forward.dest_port;

    let accept_loop = tokio::spawn(async move {
        loop {
            let Ok((stream, peer)) = listener.accept().await else { break };
            let connection = connection.clone();
            let dest_address = dest_address.clone();
            tokio::spawn(async move {
                let mut stream = stream;
                let channel = match connection
                    .target()
                    .channel_open_direct_tcpip(dest_address, dest_port as u32, peer.ip().to_string(), peer.port() as u32)
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

    Ok(ActiveForward { config: forward, kind: ActiveKind::Local(accept_loop) })
}

async fn start_remote(connection: &Connection, forward: PortForward) -> anyhow::Result<ActiveForward> {
    let route_key = (forward.bind_address.clone(), forward.bind_port as u32);

    // Register the route *before* asking the server to forward: the server can start
    // pushing connections as soon as it acks the request, so inserting the mapping
    // first avoids a race where an early connection finds no route and gets dropped
    // (see `AppHandler::server_channel_open_forwarded_tcpip`).
    connection.remote_forward_routes().lock().expect("lock poisoned").insert(
        route_key.clone(),
        (forward.dest_address.clone(), forward.dest_port as u32),
    );

    if let Err(e) = connection.target().tcpip_forward(forward.bind_address.clone(), forward.bind_port as u32).await {
        connection.remote_forward_routes().lock().expect("lock poisoned").remove(&route_key);
        anyhow::bail!("remote refused to forward {}:{}: {e}", forward.bind_address, forward.bind_port);
    }

    Ok(ActiveForward { config: forward, kind: ActiveKind::Remote })
}
