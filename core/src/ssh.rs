//! SSH connectivity: direct connections, bastion/jump-host chaining and interactive shells.
//!
//! A "chain" connection is built hop by hop. For each hop after the first, a
//! `direct-tcpip` channel is opened on the *previous* hop's already-authenticated
//! session and turned into a byte stream that the next hop's SSH handshake runs over
//! (`russh::client::connect_stream`). This is the same mechanism `ssh -J` (ProxyJump)
//! relies on.
use crate::sync_ext::MutexExt;
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

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKey,
    ) -> Result<bool, Self::Error> {
        let identity = self.identity.clone();
        let label = self.label.clone();
        let key = server_public_key.clone();
        // known_hosts::check_and_trust does synchronous disk I/O — run it off the
        // tokio worker thread so a slow/contended handshake doesn't stall other
        // async work sharing it.
        let verdict = tokio::task::spawn_blocking(move || {
            known_hosts::check_and_trust(&identity, &label, &key)
        })
        .await
        .unwrap_or_else(|e| Err(anyhow::anyhow!("check_and_trust panicked: {e}")));
        match verdict {
            Ok(Verdict::AlreadyTrusted | Verdict::NewlyTrusted) => Ok(true),
            Ok(Verdict::Mismatch {
                previous_fingerprint,
            }) => {
                *self.host_key_mismatch.lock_recover() = Some(HostKeyMismatch {
                    host_label: self.label.clone(),
                    previous_fingerprint,
                    offered_fingerprint: server_public_key.fingerprint(HashAlg::Sha256).to_string(),
                });
                Ok(false)
            }
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
            .lock_recover()
            .get(&(connected_address.to_string(), connected_port))
            .cloned();
        let Some((dest_address, dest_port)) = dest else {
            return Ok(());
        };
        tokio::spawn(async move {
            let Ok(local) =
                tokio::net::TcpStream::connect((dest_address.as_str(), dest_port as u16)).await
            else {
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
    async fn server_channel_open_agent_forward(
        &mut self,
        channel: Channel<client::Msg>,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
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

    /// Whether every hop in the chain is still usable. Consulted by
    /// [`crate::ssh_pool`] before handing this connection to another caller:
    /// a connection the server or the network has since dropped would fail on
    /// channel open, and the pool must replace it rather than reuse it.
    ///
    /// Every hop counts, not just the target — a bastion that went away takes
    /// the tunnel the later hops ride on with it.
    pub fn is_alive(&self) -> bool {
        self.chain.iter().all(|hop| !hop.is_closed())
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
fn mismatch_error(
    mismatch: &Arc<Mutex<Option<HostKeyMismatch>>>,
    fallback: impl FnOnce() -> anyhow::Error,
) -> anyhow::Error {
    match mismatch.lock_recover().take() {
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

async fn authenticate(
    handle: &mut client::Handle<AppHandler>,
    host: &Host,
    workspace: &Workspace,
) -> anyhow::Result<()> {
    let result = match &host.auth {
        AuthMethod::Password => {
            let password = vault::load(host.id, SecretKind::Password)?
                .ok_or_else(|| anyhow::anyhow!("no stored password for '{}'", host.label))?;
            handle
                .authenticate_password(host.username.clone(), password)
                .await?
        }
        AuthMethod::PrivateKey { path, key_id } => {
            let lookup_id = key_id.unwrap_or(host.id);
            let passphrase = vault::load(lookup_id, SecretKind::KeyPassphrase)?;
            // Prefer embedded key content over reading the file from disk: it lives
            // in the encrypted master vault when unlocked, otherwise in the
            // workspace (0600). Fall back to the original key file if neither has it.
            let key = if let Some(kid) = *key_id {
                let stored = vault::load_key_content(kid)?.or_else(|| {
                    workspace
                        .keychain
                        .iter()
                        .find(|k| k.id == kid)
                        .and_then(|k| k.content.clone())
                });
                if let Some(content) = stored {
                    decode_secret_key(&content, passphrase.as_deref())
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
        }
        AuthMethod::Agent => return authenticate_with_agent(handle, host).await,
        AuthMethod::KeyboardInteractive => {
            return authenticate_keyboard_interactive(handle, host).await;
        }
    };
    ensure_success(result, &host.label)
}

/// Decides which prompts of one round can be answered from the stored
/// password, returning one slot per prompt (`None` = ask the user).
///
/// Takes the password out of `stored_password` when it uses it, so this can
/// only ever fire on the *first* round that has a hidden prompt. That
/// restriction is the whole point: servers ask password-then-second-factor,
/// so round two is where the OTP lives. Auto-answering there would send a
/// stale password as if it were the code — burning one of the few attempts
/// the server allows, with no way for the user to see why.
///
/// `echoes` is the prompts' `echo` flags in order; a hidden prompt
/// (`echo == false`) is the server saying "this is secret-like", which is how
/// it asks for a password. An OTP is usually echoed, since it is single-use.
fn autofilled_answers(echoes: &[bool], stored_password: &mut Option<String>) -> Vec<Option<String>> {
    let mut answers: Vec<Option<String>> = vec![None; echoes.len()];
    if let Some(index) = echoes.iter().position(|echo| !echo)
        && let Some(password) = stored_password.take()
    {
        answers[index] = Some(password);
    }
    answers
}

/// Drives an RFC 4256 keyboard-interactive exchange — the method servers use
/// for MFA/OTP.
///
/// Unlike every other method, this is a *conversation*: the server sends
/// rounds of prompts and decides when it has enough. Each round is forwarded
/// to whoever installed a [`crate::interactive_auth::Prompter`] (the UI, in
/// the app's case) and the answers are sent back, until the server reports
/// success or failure.
///
/// A stored password is auto-filled for the first non-echoed prompt of the
/// first round only. Servers ask password-then-second-factor in practice, so
/// this spares retyping the password on every connection while never
/// auto-answering anything on a later round — where the OTP lives, and where
/// a wrong silent answer would just burn an attempt.
///
/// The loop is bounded: a server that keeps asking (misconfigured, or
/// deliberately) would otherwise keep the user in a prompt cycle forever.
async fn authenticate_keyboard_interactive(
    handle: &mut client::Handle<AppHandler>,
    host: &Host,
) -> anyhow::Result<()> {
    use crate::interactive_auth::{InfoRequest, PromptField};
    use russh::client::KeyboardInteractiveAuthResponse;

    /// Rounds accepted before giving up. Real deployments use one or two.
    const MAX_ROUNDS: usize = 10;

    let prompter = crate::interactive_auth::prompter().ok_or_else(|| {
        anyhow::anyhow!(
            "l'authentification interactive (MFA) nécessite l'interface graphique — \
             aucun moyen de poser la question ici"
        )
    })?;

    let mut stored_password = vault::load(host.id, SecretKind::Password)?;
    let mut response = handle
        .authenticate_keyboard_interactive_start(host.username.clone(), None)
        .await?;

    for _ in 0..MAX_ROUNDS {
        let (name, instructions, prompts) = match response {
            KeyboardInteractiveAuthResponse::Success => return Ok(()),
            KeyboardInteractiveAuthResponse::Failure { partial_success, .. } => {
                return ensure_success(
                    AuthResult::Failure {
                        remaining_methods: russh::MethodSet::empty(),
                        partial_success,
                    },
                    &host.label,
                );
            }
            KeyboardInteractiveAuthResponse::InfoRequest { name, instructions, prompts } => {
                (name, instructions, prompts)
            }
        };

        let echoes: Vec<bool> = prompts.iter().map(|p| p.echo).collect();
        let mut answers = autofilled_answers(&echoes, &mut stored_password);

        let remaining: Vec<PromptField> = prompts
            .iter()
            .zip(&answers)
            .filter(|(_, answered)| answered.is_none())
            .map(|(p, _)| PromptField { prompt: p.prompt.clone(), echo: p.echo })
            .collect();

        if !remaining.is_empty() {
            let request = InfoRequest { name, instructions, prompts: remaining };
            let mut supplied = prompter.prompt(&host.label, request).await?.into_iter();
            for answer in answers.iter_mut() {
                if answer.is_none() {
                    *answer = Some(supplied.next().ok_or_else(|| {
                        anyhow::anyhow!("réponse manquante pour l'authentification interactive")
                    })?);
                }
            }
        }

        response = handle
            .authenticate_keyboard_interactive_respond(
                answers.into_iter().map(|a| a.unwrap_or_default()).collect(),
            )
            .await?;
    }

    anyhow::bail!(
        "authentification interactive abandonnée pour « {} » : le serveur a dépassé {MAX_ROUNDS} séries de questions",
        host.label
    )
}

#[cfg(unix)]
async fn authenticate_with_agent(
    handle: &mut client::Handle<AppHandler>,
    host: &Host,
) -> anyhow::Result<()> {
    use russh::keys::agent::AgentIdentity;
    use russh::keys::agent::client::AgentClient;

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
async fn authenticate_with_agent(
    _handle: &mut client::Handle<AppHandler>,
    _host: &Host,
) -> anyhow::Result<()> {
    anyhow::bail!("ssh-agent authentication is only supported on Unix in this build")
}

fn ensure_success(result: AuthResult, host_label: &str) -> anyhow::Result<()> {
    match result {
        AuthResult::Success => Ok(()),
        AuthResult::Failure {
            partial_success, ..
        } => {
            anyhow::bail!(
                "authentication failed for '{host_label}'{}",
                if partial_success {
                    " (partial success, more steps required)"
                } else {
                    ""
                }
            )
        }
    }
}

/// Connects to `target`, transparently chaining through its bastion hosts (if any).
///
/// Traced (host label, address, hop count, outcome) — "I can't connect and I
/// don't know why" is the single most common thing a user needs help with, and
/// the shipped Windows binary has no console, so without this the log file
/// says nothing about it. Deliberately logs labels/addresses only: never a
/// password, passphrase, or key material.
pub async fn connect(workspace: &Workspace, target: HostId) -> anyhow::Result<Connection> {
    let chain = workspace.jump_chain(target)?;
    let target_label = chain.last().map(|h| label_of(h)).unwrap_or_default();
    let hops = chain.len() - 1;
    tracing::info!(host = %target_label, bastions = hops, "connexion SSH : début");
    let started = std::time::Instant::now();
    let result = connect_chain(workspace, chain).await;
    match &result {
        Ok(_) => tracing::info!(host = %target_label, elapsed_ms = started.elapsed().as_millis() as u64, "connexion SSH : établie"),
        Err(e) => tracing::warn!(host = %target_label, error = %e, "connexion SSH : échec"),
    }
    result
}

/// The body of [`connect`], split out so the tracing wrapper above can report
/// one outcome for the whole chain rather than being threaded through every
/// early return.
async fn connect_chain(workspace: &Workspace, chain: Vec<&Host>) -> anyhow::Result<Connection> {

    // Keepalive is configured off the *target* host only — bastions just relay bytes,
    // so what matters for keeping the interactive session alive is the last hop.
    let mut config = client::Config::default();
    if let Some(secs) = chain
        .last()
        .expect("chain is never empty")
        .keepalive_interval_secs
        .filter(|&s| s > 0)
    {
        config.keepalive_interval = Some(Duration::from_secs(secs as u64));
    }
    let config = Arc::new(config);

    let remote_forward_routes: RemoteForwardRoutes = Arc::new(Mutex::new(HashMap::new()));

    let first = chain[0];
    let first_routes = if chain.len() == 1 {
        remote_forward_routes.clone()
    } else {
        Default::default()
    };
    let first_handler = AppHandler::new(identity_of(first), label_of(first), first_routes);
    let first_mismatch = first_handler.host_key_mismatch.clone();
    let mut handle = client::connect(
        config.clone(),
        (first.address.as_str(), first.port),
        first_handler,
    )
    .await
    .map_err(|e| {
        mismatch_error(&first_mismatch, || {
            anyhow::anyhow!("could not reach '{}': {e}", first.label)
        })
    })?;
    authenticate(&mut handle, first, workspace).await?;

    let mut hops = vec![handle];
    for (i, next) in chain[1..].iter().enumerate() {
        let is_target = i + 2 == chain.len();
        let previous = hops.last().expect("hops is never empty");
        let channel = previous
            .channel_open_direct_tcpip(
                next.address.clone(),
                next.port as u32,
                "127.0.0.1".to_string(),
                0,
            )
            .await
            .map_err(|e| anyhow::anyhow!("bastion could not reach '{}': {e}", next.label))?;
        let stream = channel.into_stream();
        let routes = if is_target {
            remote_forward_routes.clone()
        } else {
            Default::default()
        };
        let next_handler = AppHandler::new(identity_of(next), label_of(next), routes);
        let next_mismatch = next_handler.host_key_mismatch.clone();
        let mut next_handle = client::connect_stream(config.clone(), stream, next_handler)
            .await
            .map_err(|e| {
                mismatch_error(&next_mismatch, || {
                    anyhow::anyhow!("SSH handshake with '{}' failed: {e}", next.label)
                })
            })?;
        authenticate(&mut next_handle, next, workspace).await?;
        hops.push(next_handle);
    }

    Ok(Connection {
        chain: hops,
        remote_forward_routes,
    })
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
pub async fn open_shell(
    connection: &Connection,
    cols: u16,
    rows: u16,
    agent_forward: bool,
) -> anyhow::Result<ShellSession> {
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

    Ok(ShellSession {
        input: input_tx,
        output: output_rx,
    })
}

/// Captured result of running a command to completion on a remote host.
#[derive(Debug, Clone)]
pub struct CommandOutput {
    /// Exit status reported by the remote command. `None` if the channel closed
    /// without an `exit-status` (e.g. the command was killed by a signal — see
    /// [`run_command_capture`]).
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

/// Runs `command` on `connection`'s target host to completion — non-interactive,
/// no PTY (unlike [`open_shell`]) — capturing stdout, stderr and the exit status
/// separately. This is the "exec + capture" path the fleet executor needs: an
/// interactive shell streams raw bytes with no notion of an exit code, which a
/// structured fan-out run has to report per host.
pub async fn run_command_capture(
    connection: &Connection,
    command: &str,
) -> anyhow::Result<CommandOutput> {
    let mut channel = connection.target().channel_open_session().await?;
    channel.exec(true, command).await?;

    let mut stdout: Vec<u8> = Vec::new();
    let mut stderr: Vec<u8> = Vec::new();
    let mut exit_code: Option<i32> = None;
    // Read until the channel actually closes. `exit-status` normally arrives
    // before EOF, but the SSH spec doesn't guarantee ordering, so don't stop on
    // `Eof` — only on `Close`/channel drop — to avoid dropping a late status.
    while let Some(msg) = channel.wait().await {
        match msg {
            ChannelMsg::Data { data } => stdout.extend_from_slice(&data),
            // ext == 1 is SSH_EXTENDED_DATA_STDERR; fold any other extended data
            // in with stderr rather than discarding it.
            ChannelMsg::ExtendedData { data, .. } => stderr.extend_from_slice(&data),
            ChannelMsg::ExitStatus { exit_status } => exit_code = Some(exit_status as i32),
            ChannelMsg::ExitSignal { signal_name, error_message, .. } => {
                stderr.extend_from_slice(
                    format!("[interrompu par signal {signal_name:?}] {error_message}").as_bytes(),
                );
            }
            ChannelMsg::Close => break,
            _ => {}
        }
    }

    Ok(CommandOutput {
        exit_code,
        stdout: String::from_utf8_lossy(&stdout).into_owned(),
        stderr: String::from_utf8_lossy(&stderr).into_owned(),
    })
}

/// Lightweight reachability check: a raw TCP connect attempt with a short timeout,
/// no SSH handshake. Meant for a quick "online / offline" indicator, not a real
/// connection test (auth or host-key issues won't show up here).
///
/// For a host reached through one or more bastions, `host`'s own address is
/// typically a private IP that isn't directly reachable from here — only the
/// first hop is. So this probes the first hop in the jump chain (the entry
/// bastion, or `host` itself when there's none) rather than the target directly.
pub async fn probe(workspace: &Workspace, host_id: HostId) -> bool {
    let Ok(chain) = workspace.jump_chain(host_id) else {
        return false;
    };
    let first = chain[0];
    tokio::time::timeout(
        Duration::from_secs(3),
        tokio::net::TcpStream::connect((first.address.as_str(), first.port)),
    )
    .await
    .map(|r| r.is_ok())
    .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_of_uses_host_id_not_address() {
        // Same address:port, but Host::new mints a fresh random id each time —
        // identity_of must track that id, not the address, so two unrelated
        // hosts that happen to reuse the same private IP never share a
        // known-hosts trust entry (see the doc comment on identity_of).
        let a = Host::new("web-a", "10.0.0.5", "root");
        let b = Host::new("web-b", "10.0.0.5", "root");
        assert_ne!(identity_of(&a), identity_of(&b));
        assert_eq!(identity_of(&a), a.id.to_string());
    }

    #[test]
    fn label_of_formats_label_address_port() {
        let mut host = Host::new("prod-db", "10.0.0.5", "root");
        host.port = 2222;
        assert_eq!(label_of(&host), "prod-db (10.0.0.5:2222)");
    }

    #[test]
    fn mismatch_error_uses_stored_mismatch_when_present() {
        let mismatch = Arc::new(Mutex::new(Some(HostKeyMismatch {
            host_label: "bastion".to_string(),
            previous_fingerprint: "AA:BB".to_string(),
            offered_fingerprint: "CC:DD".to_string(),
        })));

        let err = mismatch_error(&mismatch, || anyhow::anyhow!("unused fallback"));
        let message = err.to_string();
        assert!(message.contains("bastion"));
        assert!(message.contains("AA:BB"));
        assert!(message.contains("CC:DD"));

        // take() must have emptied the slot, so a second handshake attempt on
        // the same connection doesn't resurface a stale mismatch.
        assert!(mismatch.lock_recover().is_none());
    }

    #[test]
    fn mismatch_error_falls_back_when_absent() {
        let mismatch: Arc<Mutex<Option<HostKeyMismatch>>> = Arc::new(Mutex::new(None));
        let err = mismatch_error(&mismatch, || anyhow::anyhow!("could not reach 'x': boom"));
        assert_eq!(err.to_string(), "could not reach 'x': boom");
    }

    #[test]
    fn ensure_success_ok_on_auth_success() {
        assert!(ensure_success(AuthResult::Success, "web1").is_ok());
    }

    #[test]
    fn ensure_success_err_on_auth_failure() {
        let result = AuthResult::Failure {
            remaining_methods: russh::MethodSet::empty(),
            partial_success: false,
        };
        let err = ensure_success(result, "web1").unwrap_err();
        assert_eq!(err.to_string(), "authentication failed for 'web1'");
    }

    #[test]
    fn stored_password_answers_the_first_hidden_prompt() {
        let mut stored = Some("hunter2".to_string());
        // Typical first round: one hidden "Password:" prompt.
        assert_eq!(autofilled_answers(&[false], &mut stored), vec![Some("hunter2".to_string())]);
        assert!(stored.is_none(), "the password must be consumed, not reusable on a later round");
    }

    #[test]
    fn the_otp_round_is_never_auto_answered() {
        // This is the case that matters: the password was already spent on
        // round one, so round two's prompt has to reach the user. Answering it
        // with anything would burn a server-side attempt.
        let mut spent: Option<String> = None;
        assert_eq!(autofilled_answers(&[false], &mut spent), vec![None]);
        assert_eq!(autofilled_answers(&[true], &mut spent), vec![None]);
    }

    #[test]
    fn an_echoed_only_round_leaves_the_password_untouched() {
        // Nothing hidden to fill, e.g. a server asking only "Verification
        // code:" (echoed). The password must stay available for a later hidden
        // prompt rather than being silently dropped.
        let mut stored = Some("hunter2".to_string());
        assert_eq!(autofilled_answers(&[true, true], &mut stored), vec![None, None]);
        assert_eq!(stored.as_deref(), Some("hunter2"));
    }

    #[test]
    fn only_the_first_hidden_prompt_of_a_round_is_filled() {
        // A round with two hidden prompts (password + hidden second factor):
        // only the first is ours to answer.
        let mut stored = Some("hunter2".to_string());
        assert_eq!(
            autofilled_answers(&[true, false, false], &mut stored),
            vec![None, Some("hunter2".to_string()), None],
        );
    }

    #[test]
    fn no_stored_password_asks_for_everything() {
        let mut none: Option<String> = None;
        assert_eq!(autofilled_answers(&[false, true], &mut none), vec![None, None]);
    }

    #[test]
    fn ensure_success_notes_partial_success() {
        let result = AuthResult::Failure {
            remaining_methods: russh::MethodSet::empty(),
            partial_success: true,
        };
        let err = ensure_success(result, "web1").unwrap_err();
        assert!(err.to_string().ends_with(" (partial success, more steps required)"));
    }
}
