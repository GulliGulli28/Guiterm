//! Getting a database client to a server it can't dial directly.
//!
//! **Why this exists as a module rather than inline.** The SSH half of it was
//! written three times — `sql::connect`, `redis_client::connect`,
//! `mongo_client::connect` — in three copies that differed only in which
//! field they read the address out of. Adding SSM would have made six, and the
//! interesting part (tearing the tunnel down on the failure path, before there
//! is any session for the caller to close) is exactly the part that gets
//! forgotten in the copy that was written last.
//!
//! What a caller does with this is always the same three steps: [`open`] to
//! learn where to dial, dial it, and either keep the returned [`OpenTunnel`]
//! alive inside its session or hand it to [`close`]. The lease-outlives-what-
//! it-opened rule from `CLAUDE.md` applies here as it does to `SshLease`: an
//! `OpenTunnel` dropped early takes the port with it.

use crate::model::{DbTunnel, PortForward, PortForwardKind, Workspace};
use crate::ssh_pool::{self, SshLease};
use crate::ssm_tunnel::{self, SsmSpec, SsmTunnel};
use crate::{port_forward, port_forward::ActiveForward};

/// A tunnel that is currently carrying a database connection.
///
/// Held by the session it serves, never persisted and never shown in the
/// Tunnels panel: these are built with `bind_port: 0` and live and die with
/// one connection, unlike the forwards a user sets up by hand.
pub enum OpenTunnel {
    /// Dialled directly — nothing was opened, and nothing needs closing.
    None,
    /// An ephemeral local forward over a pooled SSH connection. The lease is
    /// held alongside, since dropping it would return the connection to the
    /// pool while the forward still rides on it.
    Ssh(Box<(SshLease, ActiveForward)>),
    Ssm(Box<SsmTunnel>),
}

impl OpenTunnel {
    /// Turns a failure against the local port into one that names the right
    /// culprit.
    ///
    /// For an SSM tunnel this is a real question — the helper is a separate
    /// process that can die on its own — and [`SsmTunnel::explain_failure`]
    /// answers it. For the other two the answer is fixed: an SSH forward dies
    /// with its connection, which surfaces as its own error, and a direct dial
    /// has nothing in the middle to blame.
    pub async fn explain_failure(&self, error: &str) -> String {
        match self {
            OpenTunnel::Ssm(tunnel) => tunnel.explain_failure(error).await,
            OpenTunnel::None | OpenTunnel::Ssh(_) => error.to_string(),
        }
    }
}

/// Where a caller should actually dial, once the tunnel (if any) is up.
pub struct Dial {
    pub host: String,
    pub port: u16,
    /// Keep this alive for as long as the connection dialled at
    /// `host`/`port` — or pass it to [`close`].
    pub tunnel: OpenTunnel,
}

/// Opens whatever `tunnel` calls for, and reports where to dial.
///
/// `address`/`port` are the server as seen *from the far end*: the loopback
/// address a database binds to on an SSH host, or the provider endpoint that
/// only resolves inside a VPC. For [`DbTunnel::Direct`] they are returned
/// unchanged, which is what keeps the caller free of a "was there a tunnel?"
/// branch.
pub async fn open(workspace: &Workspace, tunnel: &DbTunnel, address: &str, port: u16) -> anyhow::Result<Dial> {
    match tunnel {
        DbTunnel::Direct => Ok(Dial { host: address.to_string(), port, tunnel: OpenTunnel::None }),
        DbTunnel::SshHost { host_id } => {
            let connection = ssh_pool::acquire(workspace, *host_id).await?;
            let forward = PortForward {
                id: uuid::Uuid::new_v4(),
                host_id: *host_id,
                kind: PortForwardKind::Local,
                bind_address: "127.0.0.1".to_string(),
                bind_port: 0,
                dest_address: address.to_string(),
                dest_port: port,
            };
            let active = port_forward::start(connection.connection(), forward).await?;
            let bound = active
                .bound_addr()
                .ok_or_else(|| anyhow::anyhow!("le tunnel SSH n'a pas pu s'ouvrir"))?;
            Ok(Dial {
                host: "127.0.0.1".to_string(),
                port: bound.port(),
                tunnel: OpenTunnel::Ssh(Box::new((connection, active))),
            })
        }
        DbTunnel::Ssm { target, profile, region } => {
            let session = ssm_tunnel::open(SsmSpec {
                target: target.clone(),
                profile: profile.clone(),
                region: region.clone(),
                remote_host: address.to_string(),
                remote_port: port,
            })
            .await?;
            Ok(Dial {
                host: "127.0.0.1".to_string(),
                port: session.local_port(),
                tunnel: OpenTunnel::Ssm(Box::new(session)),
            })
        }
    }
}

/// Tears a tunnel down.
///
/// Called both from a session's `close()` and — the case that is easy to
/// forget — from the error path of a connect that opened the tunnel and then
/// failed to reach the database through it. There is no session for the caller
/// to close in that second case, so a missed call here leaks a port and, for
/// SSM, a process.
pub async fn close(tunnel: OpenTunnel) {
    match tunnel {
        OpenTunnel::None => {}
        OpenTunnel::Ssh(parts) => {
            let (connection, active) = *parts;
            active.stop(&connection).await;
        }
        OpenTunnel::Ssm(session) => session.stop().await,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The one branch that needs no network: a direct dial must pass the
    /// address through untouched and open nothing. It is what every existing
    /// connection uses, so getting it wrong breaks the common case rather than
    /// the new one.
    #[tokio::test]
    async fn direct_passes_the_address_through_and_opens_nothing() {
        let workspace = Workspace::default();
        let dial = open(&workspace, &DbTunnel::Direct, "db.example.com", 5432)
            .await
            .expect("a direct dial cannot fail");

        assert_eq!(dial.host, "db.example.com");
        assert_eq!(dial.port, 5432);
        assert!(matches!(dial.tunnel, OpenTunnel::None));
        assert_eq!(
            dial.tunnel.explain_failure("connection refused").await,
            "connection refused",
            "with nothing in the middle, the error must not be dressed up"
        );
        close(dial.tunnel).await;
    }
}
