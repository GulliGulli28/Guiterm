//! SSH connectivity: direct connections, bastion/jump-host chaining and interactive shells.
//!
//! A "chain" connection is built hop by hop. For each hop after the first, a
//! `direct-tcpip` channel is opened on the *previous* hop's already-authenticated
//! session and turned into a byte stream that the next hop's SSH handshake runs over
//! (`russh::client::connect_stream`). This is the same mechanism `ssh -J` (ProxyJump)
//! relies on.
use crate::known_hosts::{self, Verdict};
use crate::model::{AuthMethod, Host, HostId, Workspace};
use crate::vault::{self, SecretKind};
use russh::client::{self, AuthResult};
use russh::keys::ssh_key::{HashAlg, PublicKey};
use russh::keys::{PrivateKeyWithHashAlg, decode_secret_key, load_secret_key};
use russh::{Channel, ChannelMsg, Disconnect};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::mpsc;

/// Where a remote-forwarded connection for `(bind_address, bind_port)` should
/// be relayed to locally. Populated by [`crate::port_forward`] and consulted
/// by [`AppHandler::server_channel_open_forwarded_tcpip`].
pub type RemoteForwardRoutes = Arc<Mutex<HashMap<(String, u32), (String, u32)>>>;

/// Details recorded when a server offers a host key that doesn't match the one
/// previously trusted for this identity, so [`connect`] can turn the otherwise
/// generic handshake failure into an actionable message.
#[derive(Debug, Clone)]
pub struct HostKeyMismatch {
    pub host_label: String,
    pub previous_fingerprint: String,
    pub offered_fingerprint: String,
}

/// SSH client handler: verifies host keys via trust-on-first-use, and relays
/// any remote-forwarded ("`ssh -R`") connections the server pushes back to us.
pub struct AppHandler {
    identity: String,
    label: String,
    pub host_key_mismatch: Arc<Mutex<Option<HostKeyMismatch>>>,
    remote_forward_routes: RemoteForwardRoutes,
}

impl AppHandler {
    fn new(identity: String, label: String, remote_forward_routes: RemoteForwardRoutes) -> Self {
        Self {
            identity,
            label,
            host_key_mismatch: Arc::new(Mutex::new(None)),
            remote_forward_routes,
        }
    }
}

impl client::Handler for AppHandler {
    type Error = russh::Error;

    async fn check_server_key(&mut self, server_public_key: &PublicKey) -> Result<bool, Self::Error> {
        match known_hosts::check_and_trust(&self.identity, &self.label, server_public_key) {
            Ok(Verdict::AlreadyTrusted | Verdict::NewlyTrusted) => Ok(true),
            Ok(Verdict::Mismatch { previous_fingerprint }) => {
                *self.host_key_mismatch.lock().expect("lock poisoned") = Some(HostKeyMismatch {
                    host_label: self.label.clone(),
                    previous_fingerprint,
                    offered_fingerprint: server_public_key.fingerprint(HashAlg::Sha256).to_string(),
                });
                Ok(false)
            },
            Err(_) => Ok(false),
        }
    }

    async fn server_channel_open_forwarded_tcpip(
        &mut self,
        channel: Channel<client::Msg>,
        connected_address: &str,
        connected_port: u32,
        _originator_address: &str,
        _originator_port: u32,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        let dest = self
            .remote_forward_routes
            .lock()
            .expect("lock poisoned")
            .get(&(connected_address.to_string(), connected_port))
            .cloned();
        let Some((dest_address, dest_port)) = dest else {
            return Ok(());
        };
        tokio::spawn(async move {
            let Ok(local) = tokio::net::TcpStream::connect((dest_address.as_str(), dest_port as u16)).await else {
                return;
            };
            let mut local = local;
            let mut remote = channel.into_stream();
            let _ = tokio::io::copy_bidirectional(&mut local, &mut remote).await;
        });
        Ok(())
    }

    /// Bridges an agent-forwarding channel the server opened back to our local
    /// ssh-agent (`SSH_AUTH_SOCK`), so the remote host can use locally-held keys
    /// without them ever leaving this machine. Only requested in the first place
    /// when the connecting host has `agent_forward` enabled (see [`open_shell`]).
    #[cfg(unix)]
    async fn server_channel_open_agent_forward(&mut self, channel: Channel<client::Msg>, _session: &mut client::Session) -> Result<(), Self::Error> {
        let Ok(sock_path) = std::env::var("SSH_AUTH_SOCK") else {
            return Ok(());
        };
        tokio::spawn(async move {
            let Ok(mut agent) = tokio::net::UnixStream::connect(&sock_path).await else {
                return;
            };
            let mut remote = channel.into_stream();
            let _ = tokio::io::copy_bidirectional(&mut agent, &mut remote).await;
        });
        Ok(())
    }
}

/// A live SSH connection, possibly tunnelled through one or more bastions.
/// All hops are kept alive for the lifetime of this value; only the last
/// (target) hop is meant to be used to open further channels.
pub struct Connection {
    chain: Vec<client::Handle<AppHandler>>,
    remote_forward_routes: RemoteForwardRoutes,
}

impl Connection {
    /// The authenticated session for the target host, used to open shell,
    /// SFTP or port-forwarding channels.
    pub fn target(&self) -> &client::Handle<AppHandler> {
        self.chain.last().expect("connection chain is never empty")
    }

    /// Shared with the target hop's [`AppHandler`] so remote port forwards
    /// registered after the fact are picked up by the already-running handler.
    pub fn remote_forward_routes(&self) -> RemoteForwardRoutes {
        self.remote_forward_routes.clone()
    }

    pub async fn disconnect(&mut self) {
        for handle in self.chain.iter().rev() {
            let _ = handle.disconnect(Disconnect::ByApplication, "", "en").await;
        }
    }
}

/// Stable identity for known-hosts trust: the workspace host's own ID, not its
/// address. Private IPs are routinely reused across unrelated environments
/// (separate VPCs each behind their own bastion), so keying by `address:port`
/// would make an unrelated machine's key rotation look like this host's, or
/// vice-versa.
fn identity_of(host: &Host) -> String {
    host.id.to_string()
}

fn label_of(host: &Host) -> String {
    format!("{} ({}:{})", host.label, host.address, host.port)
}

/// Builds a precise "host key changed" error if `mismatch` was populated during
/// the handshake, otherwise falls back to `fallback` (the raw connect/handshake error).
fn mismatch_error(mismatch: &Arc<Mutex<Option<HostKeyMismatch>>>, fallback: impl FnOnce() -> anyhow::Error) -> anyhow::Error {
    match mismatch.lock().expect("lock poisoned").take() {
        Some(m) => anyhow::anyhow!(
            "la clé de l'hôte « {} » a changé : clé précédemment approuvée {}, clé reçue {}. \
             Si ce changement est inattendu, cela peut indiquer une usurpation (MITM) — vérifiez avant de continuer. \
             Si vous savez que cette adresse pointe désormais vers une machine différente (par ex. un autre \
             environnement réutilisant la même IP) ou que l'hôte a été réinstallé, retirez son entrée dans \
             « Known Hosts » puis reconnectez-vous.",
            m.host_label,
            m.previous_fingerprint,
            m.offered_fingerprint
        ),
        None => fallback(),
    }
}

async fn authenticate(handle: &mut client::Handle<AppHandler>, host: &Host, workspace: &Workspace) -> anyhow::Result<()> {
    let result = match &host.auth {
        AuthMethod::Password => {
            let password = vault::load(host.id, SecretKind::Password)?
                .ok_or_else(|| anyhow::anyhow!("no stored password for '{}'", host.label))?;
            handle.authenticate_password(host.username.clone(), password).await?
        },
        AuthMethod::PrivateKey { path, key_id } => {
            let lookup_id = key_id.unwrap_or(host.id);
            let passphrase = vault::load(lookup_id, SecretKind::KeyPassphrase)?;
            // Prefer embedded key content (stored at import time) over reading the file from disk.
            let key = if let Some(kid) = *key_id {
                if let Some(content) = workspace.keychain.iter()
                    .find(|k| k.id == kid)
                    .and_then(|k| k.content.as_deref())
                {
                    decode_secret_key(content, passphrase.as_deref())
                        .map_err(|e| anyhow::anyhow!("could not decode stored key: {e}"))?
                } else {
                    load_secret_key(path, passphrase.as_deref())
                        .map_err(|e| anyhow::anyhow!("could not load private key '{path}': {e}"))?
                }
            } else {
                load_secret_key(path, passphrase.as_deref())
                    .map_err(|e| anyhow::anyhow!("could not load private key '{path}': {e}"))?
            };
            let hash_alg = handle.best_supported_rsa_hash().await?.flatten();
            handle
                .authenticate_publickey(
                    host.username.clone(),
                    PrivateKeyWithHashAlg::new(Arc::new(key), hash_alg),
                )
                .await?
        },
        AuthMethod::Agent => return authenticate_with_agent(handle, host).await,
    };
    ensure_success(result, &host.label)
}

#[cfg(unix)]
async fn authenticate_with_agent(handle: &mut client::Handle<AppHandler>, host: &Host) -> anyhow::Result<()> {
    use russh::keys::agent::client::AgentClient;
    use russh::keys::agent::AgentIdentity;

    let mut agent = AgentClient::connect_env()
        .await
        .map_err(|e| anyhow::anyhow!("could not reach ssh-agent (SSH_AUTH_SOCK): {e}"))?;
    let identities = agent.request_identities().await?;
    if identities.is_empty() {
        anyhow::bail!("ssh-agent has no loaded identities");
    }

    for identity in identities {
        let AgentIdentity::PublicKey { key, .. } = identity else {
            continue;
        };
        let hash_alg = handle.best_supported_rsa_hash().await?.flatten();
        match handle
            .authenticate_publickey_with(host.username.clone(), key, hash_alg, &mut agent)
            .await
        {
            Ok(AuthResult::Success) => return Ok(()),
            Ok(AuthResult::Failure { .. }) => continue,
            Err(_) => continue,
        }
    }
    anyhow::bail!("ssh-agent authentication failed for '{}'", host.label)
}

#[cfg(not(unix))]
async fn authenticate_with_agent(_handle: &mut client::Handle<AppHandler>, _host: &Host) -> anyhow::Result<()> {
    anyhow::bail!("ssh-agent authentication is only supported on Unix in this build")
}

fn ensure_success(result: AuthResult, host_label: &str) -> anyhow::Result<()> {
    match result {
        AuthResult::Success => Ok(()),
        AuthResult::Failure { partial_success, .. } => {
            anyhow::bail!(
                "authentication failed for '{host_label}'{}",
                if partial_success { " (partial success, more steps required)" } else { "" }
            )
        },
    }
}

/// Connects to `target`, transparently chaining through its bastion hosts (if any).
pub async fn connect(workspace: &Workspace, target: HostId) -> anyhow::Result<Connection> {
    let chain = workspace.jump_chain(target)?;

    // Keepalive is configured off the *target* host only — bastions just relay bytes,
    // so what matters for keeping the interactive session alive is the last hop.
    let mut config = client::Config::default();
    if let Some(secs) = chain.last().expect("chain is never empty").keepalive_interval_secs.filter(|&s| s > 0) {
        config.keepalive_interval = Some(Duration::from_secs(secs as u64));
    }
    let config = Arc::new(config);

    let remote_forward_routes: RemoteForwardRoutes = Arc::new(Mutex::new(HashMap::new()));

    let first = chain[0];
    let first_routes = if chain.len() == 1 { remote_forward_routes.clone() } else { Default::default() };
    let first_handler = AppHandler::new(identity_of(first), label_of(first), first_routes);
    let first_mismatch = first_handler.host_key_mismatch.clone();
    let mut handle = client::connect(config.clone(), (first.address.as_str(), first.port), first_handler)
        .await
        .map_err(|e| mismatch_error(&first_mismatch, || anyhow::anyhow!("could not reach '{}': {e}", first.label)))?;
    authenticate(&mut handle, first, workspace).await?;

    let mut hops = vec![handle];
    for (i, next) in chain[1..].iter().enumerate() {
        let is_target = i + 2 == chain.len();
        let previous = hops.last().expect("hops is never empty");
        let channel = previous
            .channel_open_direct_tcpip(next.address.clone(), next.port as u32, "127.0.0.1".to_string(), 0)
            .await
            .map_err(|e| anyhow::anyhow!("bastion could not reach '{}': {e}", next.label))?;
        let stream = channel.into_stream();
        let routes = if is_target { remote_forward_routes.clone() } else { Default::default() };
        let next_handler = AppHandler::new(identity_of(next), label_of(next), routes);
        let next_mismatch = next_handler.host_key_mismatch.clone();
        let mut next_handle = client::connect_stream(config.clone(), stream, next_handler)
            .await
            .map_err(|e| mismatch_error(&next_mismatch, || anyhow::anyhow!("SSH handshake with '{}' failed: {e}", next.label)))?;
        authenticate(&mut next_handle, next, workspace).await?;
        hops.push(next_handle);
    }

    Ok(Connection { chain: hops, remote_forward_routes })
}

/// Input sent to an interactive remote shell.
#[derive(Debug, Clone)]
pub enum ShellInput {
    Data(Vec<u8>),
    Resize { cols: u16, rows: u16 },
}

/// A running interactive shell channel, bridged onto plain byte-stream channels
/// so the terminal widget never needs to know about SSH itself.
pub struct ShellSession {
    pub input: mpsc::Sender<ShellInput>,
    pub output: mpsc::Receiver<Vec<u8>>,
}

/// Opens an interactive PTY + shell on `connection`'s target host. When `agent_forward`
/// is set, requests agent forwarding on the channel first — the actual bridging back to
/// `SSH_AUTH_SOCK` happens in [`AppHandler::server_channel_open_agent_forward`] once the
/// server opens its side of the forwarding channel.
pub async fn open_shell(connection: &Connection, cols: u16, rows: u16, agent_forward: bool) -> anyhow::Result<ShellSession> {
    let channel = connection.target().channel_open_session().await?;
    if agent_forward {
        channel.agent_forward(false).await?;
    }
    channel
        .request_pty(false, "xterm-256color", cols as u32, rows as u32, 0, 0, &[])
        .await?;
    channel.request_shell(true).await?;

    let (input_tx, mut input_rx) = mpsc::channel::<ShellInput>(256);
    let (output_tx, output_rx) = mpsc::channel::<Vec<u8>>(256);

    tokio::spawn(async move {
        let mut channel = channel;
        loop {
            tokio::select! {
                incoming = input_rx.recv() => {
                    match incoming {
                        Some(ShellInput::Data(bytes)) => {
                            if channel.data(&bytes[..]).await.is_err() {
                                break;
                            }
                        },
                        Some(ShellInput::Resize { cols, rows }) => {
                            let _ = channel.window_change(cols as u32, rows as u32, 0, 0).await;
                        },
                        None => {
                            let _ = channel.eof().await;
                            break;
                        },
                    }
                },
                msg = channel.wait() => {
                    match msg {
                        Some(ChannelMsg::Data { data }) | Some(ChannelMsg::ExtendedData { data, .. }) => {
                            if output_tx.send(data.to_vec()).await.is_err() {
                                break;
                            }
                        },
                        Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => break,
                        _ => {},
                    }
                },
            }
        }
    });

    Ok(ShellSession { input: input_tx, output: output_rx })
}

/// Lightweight reachability check: a raw TCP connect attempt with a short timeout,
/// no SSH handshake. Meant for a quick "online / offline" indicator, not a real
/// connection test (auth or host-key issues won't show up here).
pub async fn probe(host: &Host) -> bool {
    tokio::time::timeout(Duration::from_secs(3), tokio::net::TcpStream::connect((host.address.as_str(), host.port)))
        .await
        .map(|r| r.is_ok())
        .unwrap_or(false)
}
