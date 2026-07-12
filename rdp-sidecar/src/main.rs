//! Standalone RDP client used as a Tauri sidecar process — see `CLAUDE.md`'s
//! "Pourquoi un processus RDP séparé" section for why this can't be a normal
//! dependency of `core`.
//!
//! **Phase 2: mouse/keyboard forwarding, dynamic resize, still no cursor
//! rendering.** Connects, authenticates (NLA/CredSSP handled internally by
//! `ironrdp-connector`), streams decoded framebuffer updates out as
//! `rdp-ipc` messages, and injects [`rdp_ipc::ClientMessage`] input events
//! back into the session via `ironrdp_input::Database` (see `input.rs` for
//! the scancode table it doesn't provide, and `operations_for`'s
//! [`rdp_ipc::ClientMessage::TypeText`] arm for arbitrary-Unicode text
//! input — used to run snippets/broadcast commands, which have no shell to
//! target here). Resizes (initial connect size and
//! later [`rdp_ipc::ClientMessage::Resize`]) go through the Display Control
//! Virtual Channel, which on acceptance the server answers with a
//! Deactivation-Reactivation Sequence (MS-RDPBCGR §1.3.1.3) — handled in
//! `handle_deactivate_all`.
//!
//! Protocol: exactly one [`rdp_ipc::ConnectRequest`] JSON line is read from
//! stdin, followed by a continuous stream of [`rdp_ipc::ClientMessage`]
//! lines for the rest of the process's life. [`rdp_ipc::SidecarMessage`]s
//! stream out on stdout until the session ends or this process is killed by
//! its parent. There is no "disconnect" command in the protocol for this
//! phase — the parent just kills the process.

use std::net::SocketAddr;
use std::num::NonZeroU16;

use ironrdp::cliprdr::CliprdrClient;
use ironrdp::cliprdr::backend::{CliprdrBackend, CliprdrBackendFactory, ClipboardMessage};
use ironrdp::cliprdr::pdu::{ClipboardFileAttributes, FileDescriptor};
use ironrdp::connector::connection_activation::{ConnectionActivationSequence, ConnectionActivationState};
use ironrdp::connector::{
    BitmapConfig, ClientConnector, Config as ConnectorConfig, ConnectionResult, Credentials, DesktopSize, ServerName,
};
use ironrdp::core::WriteBuf;
use ironrdp::displaycontrol::client::DisplayControlClient;
use ironrdp::displaycontrol::pdu::MonitorLayoutEntry;
use ironrdp::dvc::DrdynvcClient;
use ironrdp::echo::client::EchoClient;
use ironrdp::graphics::image_processing::PixelFormat;
use ironrdp::pdu::gcc::KeyboardType;
use ironrdp::pdu::geometry::InclusiveRectangle;
use ironrdp::pdu::rdp::capability_sets::{BitmapCodecs, MajorPlatformType};
use ironrdp::pdu::rdp::client_info::{CompressionType, PerformanceFlags, TimezoneInfo};
use ironrdp::session::image::DecodedImage;
use ironrdp::session::{ActiveStage, ActiveStageOutput};
use ironrdp::input::{Database as InputDatabase, MouseButton, MousePosition, Operation, WheelRotations};
use ironrdp_tokio::reqwest::ReqwestNetworkClient;
use ironrdp_tokio::{FramedWrite as _, TokioFramed, single_sequence_step_read, split_tokio_framed};
use rdp_ipc::{ClientMessage, ConnectRequest, SidecarMessage};
use tokio::io::{AsyncRead, AsyncWrite, ReadHalf, WriteHalf};
use tokio::net::TcpStream;
use tokio::sync::mpsc;

mod clipboard;
mod input;

/// `ironrdp-tokio` takes the transport as a bare type parameter rather than
/// exposing a boxed-trait-object alias, so the erasure trait used to unify
/// the pre-TLS `TcpStream` and post-TLS `TlsStream` behind one
/// [`UpgradedFramed`] type has to be defined here (`ironrdp-client`, the
/// reference this was ported from, does the same in its own crate).
trait AsyncReadWrite: AsyncRead + AsyncWrite {}
impl<T: AsyncRead + AsyncWrite> AsyncReadWrite for T {}

type UpgradedReader = TokioFramed<ReadHalf<Box<dyn AsyncReadWrite + Unpin + Send + Sync>>>;
type UpgradedWriter = TokioFramed<WriteHalf<Box<dyn AsyncReadWrite + Unpin + Send + Sync>>>;

#[tokio::main]
async fn main() {
    // Defaults to the same INFO level as before when `RUST_LOG` is unset
    // (the parent only sets it for a targeted diagnostic run — see
    // `commands/rdp_view.rs`).
    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")))
        .init();

    // `ironrdp-tls`'s rustls path calls `ClientConfig::builder()` (the
    // "process default" convenience constructor), which panics unless a
    // default `CryptoProvider` was installed first — and rustls 0.23 won't
    // pick one implicitly when more than one provider feature is linked in
    // (both `ring` and `aws-lc-rs` end up in this binary's dependency
    // graph). Discovered by an actual crash on first real use, not by
    // reading docs — see CLAUDE.md.
    rustls::crypto::ring::default_provider().install_default().expect("impossible d'installer le provider crypto rustls");

    let mut stdin = tokio::io::stdin();
    let request = match ConnectRequest::read_from(&mut stdin).await {
        Ok(Some(req)) => req,
        Ok(None) => return, // parent closed stdin before sending a request
        Err(e) => {
            let mut stdout = tokio::io::stdout();
            let _ = SidecarMessage::Error(format!("requête de connexion invalide : {e}")).write_to(&mut stdout).await;
            return;
        }
    };

    // The rest of stdin, for the lifetime of the process, is a continuous
    // stream of `ClientMessage` lines rather than one more framed value —
    // read it on its own task so a slow/absent client app never blocks the
    // read loop against the RDP server in `active_session`.
    let (input_tx, input_rx) = mpsc::unbounded_channel();
    tokio::spawn(async move {
        // Loop exits on `Ok(None)` (stdin closed) or `Err(_)` (malformed
        // line) alike — the view keeps running read-only until killed.
        while let Ok(Some(msg)) = ClientMessage::read_from(&mut stdin).await {
            if input_tx.send(msg).is_err() {
                break; // active_session ended first, nothing left to feed
            }
        }
    });

    let mut stdout = tokio::io::stdout();
    let outcome = run(&request, input_rx, &mut stdout).await;
    let final_message = match outcome {
        Ok(()) => SidecarMessage::Closed,
        Err(e) => SidecarMessage::Error(error_chain(&e)),
    };
    let _ = final_message.write_to(&mut stdout).await;
}

/// `anyhow::Error::to_string()`/`Display` only shows the outermost
/// `.context(...)`/`anyhow!(...)` message — the underlying `ironrdp-*` error
/// it wraps (reachable via `.source()`/`.chain()`) carries the actually
/// useful detail (e.g. *which* PDU/decode step failed) but is silently
/// dropped by a plain `.to_string()`. Found the hard way: a real resize
/// failure surfaced only `"[Fast-Path @ .../lib.rs:98] custom error"` with
/// no way to tell what the real cause was — see CLAUDE.md.
fn error_chain(e: &anyhow::Error) -> String {
    e.chain().map(|c| c.to_string()).collect::<Vec<_>>().join(" — causé par : ")
}

async fn run(
    request: &ConnectRequest,
    input_rx: mpsc::UnboundedReceiver<ClientMessage>,
    stdout: &mut (impl tokio::io::AsyncWrite + Unpin),
) -> anyhow::Result<()> {
    let (cliprdr_factory, clipboard_rx, clipboard_files) = clipboard::init().await?;
    let (connection_result, framed) = connect(request, cliprdr_factory.as_ref()).await?;
    active_session(framed, connection_result, input_rx, clipboard_rx, clipboard_files, stdout).await
}

// ── Connect ──────────────────────────────────────────────────────────────

fn build_config(request: &ConnectRequest) -> ConnectorConfig {
    let (width, height) = MonitorLayoutEntry::adjust_display_size(u32::from(request.width), u32::from(request.height));
    // In range by construction (`adjust_display_size` clamps to 200..=8192).
    let width = u16::try_from(width).expect("clamped to 200..=8192 by adjust_display_size");
    let height = u16::try_from(height).expect("clamped to 200..=8192 by adjust_display_size");
    ConnectorConfig {
        credentials: Credentials::UsernamePassword {
            username: request.username.clone(),
            password: request.password.clone(),
        },
        domain: None,
        enable_tls: true,
        enable_credssp: true,
        keyboard_type: KeyboardType::IbmEnhanced,
        keyboard_subtype: 0,
        keyboard_layout: 0,
        keyboard_functional_keys_count: 12,
        ime_file_name: String::new(),
        dig_product_id: String::new(),
        desktop_size: DesktopSize { width, height },
        desktop_scale_factor: 0,
        // Empty codec list: no RemoteFX/QOI/etc. negotiation, just plain
        // bitmap updates. Simplest correct baseline for a first pass that
        // can't be tested against a real server before shipping.
        bitmap: Some(BitmapConfig { color_depth: 32, lossy_compression: true, codecs: BitmapCodecs(Vec::new()) }),
        client_build: 0,
        client_name: "gui-termius".to_string(),
        client_dir: String::new(),
        platform: MajorPlatformType::UNSPECIFIED,
        hardware_id: None,
        license_cache: None,
        enable_server_pointer: true,
        autologon: false,
        enable_audio_playback: false,
        request_data: None,
        pointer_software_rendering: false,
        multitransport_flags: None,
        compression_type: Some(CompressionType::K64),
        performance_flags: PerformanceFlags::default(),
        timezone_info: TimezoneInfo::default(),
        alternate_shell: String::new(),
        work_dir: String::new(),
    }
}

/// Baseline dynamic/static virtual channels every client attaches: the DVCs
/// are unconditional (display resize negotiation + keepalive, regardless of
/// what a user opts into), ported as-is from `ironrdp-client`'s
/// `build_connector`; the CLIPRDR static channel's actual backend is
/// platform-dependent — see `clipboard.rs`.
fn build_connector(config: ConnectorConfig, client_addr: SocketAddr, cliprdr_backend: Box<dyn CliprdrBackend>) -> ClientConnector {
    let drdynvc = DrdynvcClient::new()
        .with_dynamic_channel(DisplayControlClient::new(|_caps| Ok(Vec::new())))
        .with_dynamic_channel(EchoClient::new());
    ClientConnector::new(config, client_addr)
        .with_static_channel(drdynvc)
        .with_static_channel(CliprdrClient::new(cliprdr_backend))
}

type UpgradedFramed = TokioFramed<Box<dyn AsyncReadWrite + Unpin + Send + Sync>>;

async fn connect(request: &ConnectRequest, cliprdr_factory: &dyn CliprdrBackendFactory) -> anyhow::Result<(ConnectionResult, UpgradedFramed)> {
    let dest = format!("{}:{}", request.host, request.port);
    let stream = TcpStream::connect(&dest).await.map_err(|e| anyhow::anyhow!("connexion TCP à {dest} : {e}"))?;
    let client_addr = stream.local_addr().map_err(|e| anyhow::anyhow!("adresse locale : {e}"))?;
    let mut framed = TokioFramed::new(stream);

    let config = build_config(request);
    let mut connector = build_connector(config, client_addr, cliprdr_factory.build_cliprdr_backend());

    let should_upgrade = ironrdp_tokio::connect_begin(&mut framed, &mut connector)
        .await
        .map_err(|e| anyhow::anyhow!("négociation initiale : {}", e.report()))?;

    let (initial_stream, leftover_bytes) = framed.into_inner();

    let (tls_stream, tls_cert) = ironrdp_tls::upgrade(initial_stream, &request.host)
        .await
        .map_err(|e| anyhow::anyhow!("passage en TLS : {e}"))?;

    let upgraded = ironrdp_tokio::mark_as_upgraded(should_upgrade, &mut connector);

    let erased_stream: Box<dyn AsyncReadWrite + Unpin + Send + Sync> = Box::new(tls_stream);
    let mut upgraded_framed = TokioFramed::new_with_leftover(erased_stream, leftover_bytes);

    let server_public_key = ironrdp_tls::extract_tls_server_public_key(&tls_cert)
        .ok_or_else(|| anyhow::anyhow!("impossible d'extraire la clé publique du certificat serveur"))?
        .to_owned();

    let connection_result = ironrdp_tokio::connect_finalize(
        upgraded,
        connector,
        &mut upgraded_framed,
        &mut ReqwestNetworkClient::new(),
        ServerName::from(request.host.as_str()),
        server_public_key,
        None, // No Kerberos config: NTLM fallback via `sspi`, matching a plain username/password login.
    )
    .await
    .map_err(|e| anyhow::anyhow!("authentification : {}", e.report()))?;

    Ok((connection_result, upgraded_framed))
}

// ── Input ────────────────────────────────────────────────────────────────

/// One notch per wheel event, direction only — see the module doc on why
/// magnitude isn't passed through as-is (`MousePdu`'s wire encoding
/// truncates the rotation count to a signed byte, so relaying a browser
/// `deltaY` verbatim risks wrapping into a nonsense value on a single big
/// scroll gesture).
const WHEEL_NOTCH: i16 = 120;

fn operations_for(msg: ClientMessage) -> Vec<Operation> {
    match msg {
        ClientMessage::MouseMove { x, y } => vec![Operation::MouseMove(MousePosition { x, y })],
        ClientMessage::MouseButton { x, y, button, pressed } => {
            let mut ops = vec![Operation::MouseMove(MousePosition { x, y })];
            if let Some(button) = MouseButton::from_web_button(button) {
                ops.push(if pressed { Operation::MouseButtonPressed(button) } else { Operation::MouseButtonReleased(button) });
            }
            ops
        }
        ClientMessage::MouseWheel { x, y, delta_y } => {
            let mut ops = vec![Operation::MouseMove(MousePosition { x, y })];
            // DOM `deltaY > 0` means "scrolling down" (wheel rotated toward the
            // user), which MS-RDPBCGR represents as a *negative* rotation count.
            match delta_y.cmp(&0) {
                std::cmp::Ordering::Greater => ops.push(Operation::WheelRotations(WheelRotations { is_vertical: true, rotation_units: -WHEEL_NOTCH })),
                std::cmp::Ordering::Less => ops.push(Operation::WheelRotations(WheelRotations { is_vertical: true, rotation_units: WHEEL_NOTCH })),
                std::cmp::Ordering::Equal => {}
            }
            ops
        }
        ClientMessage::Key { code, pressed } => match input::scancode_for(&code) {
            Some(scancode) => vec![if pressed { Operation::KeyPressed(scancode) } else { Operation::KeyReleased(scancode) }],
            None => Vec::new(),
        },
        // `\n`/`\r` become a real Enter keypress (scancode-based, matching a
        // physical keyboard) rather than a `UnicodeKeyPressed('\n')` — most
        // apps don't treat a literal-text newline as "submit this line" the
        // way an actual Enter keystroke is, which is the whole point of this
        // variant (see its doc comment in `rdp-ipc`). Every other character
        // goes through `ironrdp_input`'s Unicode keyboard event PDU, which
        // — unlike the scancode table in `input.rs` — isn't limited to a
        // fixed set of physical keys.
        ClientMessage::TypeText { text } => {
            let mut ops = Vec::with_capacity(text.chars().count() * 2);
            for ch in text.chars() {
                if ch == '\n' || ch == '\r' {
                    if let Some(scancode) = input::scancode_for("Enter") {
                        ops.push(Operation::KeyPressed(scancode));
                        ops.push(Operation::KeyReleased(scancode));
                    }
                } else {
                    ops.push(Operation::UnicodeKeyPressed(ch));
                    ops.push(Operation::UnicodeKeyReleased(ch));
                }
            }
            ops
        }
        // Handled directly by the caller (`Database::release_all()` /
        // `ActiveStage::encode_resize()` / `push_clipboard_files()`) — none
        // of the three is expressible as an `Operation`; unreachable here in
        // practice since `active_session` intercepts all three before
        // calling this function, but `ClientMessage` must still be matched
        // exhaustively.
        ClientMessage::ReleaseAll | ClientMessage::Resize { .. } | ClientMessage::PushClipboardFiles { .. } => Vec::new(),
    }
}

/// A synthetic Ctrl+V press+release, sent right after a successful
/// `push_clipboard_files` so the user doesn't have to click into the remote
/// session and paste themselves. Safe to send immediately (rather than
/// waiting for the server's `FormatListResponse` ack) because both PDUs
/// travel over the same ordered TCP stream and are written here in the same
/// order they're built in — `active_session` flushes each
/// `ActiveStageOutput::ResponseFrame` via `write_all` sequentially, so the
/// format-list announcement is guaranteed to reach the server, and be
/// processed (RDP servers process PDUs in receive order), before these
/// keystrokes do. `None` only if the scancode table (`input.rs`) somehow
/// stopped covering Ctrl/V, which it always does today.
fn paste_key_sequence() -> Option<Vec<Operation>> {
    let ctrl = input::scancode_for("ControlLeft")?;
    let v = input::scancode_for("KeyV")?;
    Some(vec![Operation::KeyPressed(ctrl), Operation::KeyPressed(v), Operation::KeyReleased(v), Operation::KeyReleased(ctrl)])
}

/// Keeps a `recv()` branch of the `active_session` `select!` from
/// busy-looping once its channel closes: an exhausted `mpsc::Receiver`
/// resolves to `None` immediately on every poll, so once we've seen that
/// once we switch this branch to a future that never resolves instead of
/// polling the dead receiver again. Shared by the `ClientMessage` (stdin)
/// and `ClipboardMessage` (clipboard thread) channels alike.
async fn recv_or_pending<T>(rx: &mut Option<mpsc::UnboundedReceiver<T>>) -> Option<T> {
    match rx {
        Some(r) => r.recv().await,
        None => std::future::pending().await,
    }
}

// ── Clipboard ────────────────────────────────────────────────────────────

/// Drives the actual `CliprdrClient` SVC calls in response to a
/// `ClipboardMessage` produced by the platform clipboard backend (see
/// `clipboard.rs`) — `Ok(None)` means nothing needs to go out on the wire
/// (channel not negotiated, or the message was informational only).
fn clipboard_svc_frame(active_stage: &mut ActiveStage, msg: ClipboardMessage) -> anyhow::Result<Option<Vec<u8>>> {
    let Some(cliprdr) = active_stage.get_svc_processor_mut::<CliprdrClient>() else {
        return Ok(None); // server rejected/hasn't finished negotiating the channel yet
    };
    let svc_messages = match msg {
        ClipboardMessage::SendInitiateCopy(formats) => cliprdr.initiate_copy(&formats),
        ClipboardMessage::SendFormatData(response) => cliprdr.submit_format_data(response),
        ClipboardMessage::SendInitiatePaste(format) => cliprdr.initiate_paste(format),
        // Answers a `FileContentsRequest` the server sent us — see
        // `FilePushBackend::on_file_contents_request` (`clipboard.rs`),
        // which is what actually produces this message now that
        // `STREAM_FILECLIP_ENABLED` is advertised (see its doc comment).
        ClipboardMessage::SendFileContentsResponse(response) => cliprdr.submit_file_contents(response),
        // We never call `Cliprdr::request_file_contents` (that's the paste
        // direction, remote → local — out of scope, see CLAUDE.md's "Pas de
        // curseur rendu"-style known-limitations list) so the crate should
        // never hand us one of these to send out; ignore defensively rather
        // than fail the whole session over an unreachable corner.
        ClipboardMessage::SendFileContentsRequest(_) => {
            tracing::warn!("requête de contenu de fichier CLIPRDR sortante inattendue, ignorée");
            return Ok(None);
        }
        ClipboardMessage::Error(e) => {
            tracing::warn!(error = %e, "erreur du presse-papiers local");
            return Ok(None);
        }
    }
    .map_err(|e| anyhow::anyhow!("presse-papiers CLIPRDR : {}", e.report()))?;

    active_stage
        .process_svc_processor_messages(svc_messages)
        .map(Some)
        .map_err(|e| anyhow::anyhow!("encodage presse-papiers : {}", e.report()))
}

/// Turns one `ClientMessage::PushClipboardFiles` batch into CLIPRDR PDUs:
/// builds a `FileDescriptor` per entry, in the same order `files` arrived
/// in, and records that same order's local paths in `clipboard_files` —
/// `FilePushBackend::on_file_contents_request` (`clipboard.rs`) resolves a
/// later `FileContentsRequest`'s index straight back into this table, which
/// only holds if nothing here reorders or drops an entry relative to what
/// was pushed. `Ok(None)` only if the CLIPRDR channel isn't negotiated yet,
/// matching `clipboard_svc_frame`'s convention.
fn push_clipboard_files(
    active_stage: &mut ActiveStage,
    clipboard_files: &clipboard::FileTable,
    files: Vec<rdp_ipc::PushedFile>,
) -> anyhow::Result<Option<Vec<u8>>> {
    let Some(cliprdr) = active_stage.get_svc_processor_mut::<CliprdrClient>() else {
        return Ok(None);
    };

    let mut descriptors = Vec::with_capacity(files.len());
    let mut paths = Vec::with_capacity(files.len());
    for file in files {
        let attrs = if file.is_dir { ClipboardFileAttributes::DIRECTORY } else { ClipboardFileAttributes::NORMAL };
        let mut descriptor = FileDescriptor::new(file.name).with_attributes(attrs);
        if let Some(relative_path) = file.relative_path {
            descriptor = descriptor.with_relative_path(relative_path);
        }
        if !file.is_dir {
            descriptor = descriptor.with_file_size(file.size);
        }
        descriptors.push(descriptor);
        paths.push(std::path::PathBuf::from(file.local_path));
    }
    clipboard_files.set(paths);

    let svc_messages = cliprdr.initiate_file_copy(descriptors).map_err(|e| anyhow::anyhow!("initiate_file_copy : {}", e.report()))?;
    active_stage
        .process_svc_processor_messages(svc_messages)
        .map(Some)
        .map_err(|e| anyhow::anyhow!("encodage presse-papiers (fichiers) : {}", e.report()))
}

// ── Active session ───────────────────────────────────────────────────────

async fn active_session(
    framed: UpgradedFramed,
    connection_result: ConnectionResult,
    input_rx: mpsc::UnboundedReceiver<ClientMessage>,
    clipboard_rx: mpsc::UnboundedReceiver<ClipboardMessage>,
    clipboard_files: clipboard::FileTable,
    stdout: &mut (impl tokio::io::AsyncWrite + Unpin),
) -> anyhow::Result<()> {
    let (mut reader, mut writer) = split_tokio_framed(framed);
    let desktop_size = connection_result.desktop_size;
    let mut image = DecodedImage::new(PixelFormat::RgbA32, desktop_size.width, desktop_size.height);
    let mut active_stage = ActiveStage::new(connection_result);
    let mut input_db = InputDatabase::new();
    let mut input_rx = Some(input_rx);
    let mut clipboard_rx = Some(clipboard_rx);
    // Forces the *next* `GraphicsUpdate` to be sent as a full frame rather
    // than just its reported region — right after connecting and after every
    // resize's Deactivation-Reactivation Sequence, `image` is either brand
    // new or was just reallocated at a new size, and nothing guarantees the
    // very next update the server happens to send covers the whole thing
    // (a resize commonly triggers a full repaint in practice, but relying on
    // that would leave stale/black pixels in an untouched corner if it
    // doesn't). Cleared after being consumed once.
    let mut send_full_next = true;

    loop {
        let outputs = tokio::select! {
            frame = reader.read_pdu() => {
                let (action, payload) = frame.map_err(|e| anyhow::anyhow!("lecture d'une trame : {e}"))?;
                match active_stage.process(&mut image, action, &payload) {
                    Ok(outputs) => outputs,
                    Err(e) => {
                        // Observed in practice: the bulk (MPPC) decompressor is
                        // rebuilt from scratch on every Deactivation-Reactivation
                        // Sequence (see `handle_deactivate_all`), but its sliding-
                        // window history can't be carried over through the public
                        // `ironrdp-session` API (no getter on `fast_path::Processor`)
                        // — the server's own history keeps going, so the first
                        // update(s) right after a resize can legitimately fail to
                        // decode. This is a read-only preview: losing one frame's
                        // worth of pixels and catching up on the next server update
                        // beats tearing down the whole session over it.
                        tracing::warn!(error = %e.report(), "trame ignorée après erreur de traitement");
                        Vec::new()
                    }
                }
            }
            input_msg = recv_or_pending(&mut input_rx) => {
                let Some(input_msg) = input_msg else {
                    input_rx = None; // stdin closed: stop polling it, keep the session running read-only
                    continue;
                };
                match input_msg {
                    ClientMessage::Resize { width, height } => {
                        let (width, height) = MonitorLayoutEntry::adjust_display_size(u32::from(width), u32::from(height));
                        match active_stage.encode_resize(width, height, None, None) {
                            Some(Ok(frame)) => vec![ActiveStageOutput::ResponseFrame(frame)],
                            Some(Err(e)) => return Err(anyhow::anyhow!("redimensionnement : {}", e.report())),
                            // Display Control Virtual Channel unavailable/not yet connected on the
                            // server side — stay at the current resolution rather than reconnecting
                            // (the heavier fallback the reference implementation uses); acceptable
                            // for a resize, which the user can just trigger again later.
                            None => continue,
                        }
                    }
                    ClientMessage::PushClipboardFiles { files } => {
                        // Best-effort, deliberately non-fatal unlike the `clip_msg`
                        // branch below: this is triggered by one explicit user
                        // drag, not a protocol invariant — e.g. the server simply
                        // not supporting file transfer is a completely normal
                        // outcome that shouldn't tear down an otherwise-healthy
                        // view-only session over it.
                        match push_clipboard_files(&mut active_stage, &clipboard_files, files) {
                            Ok(Some(frame)) => {
                                let mut outs = vec![ActiveStageOutput::ResponseFrame(frame)];
                                // Auto-paste: see `paste_key_sequence`'s doc comment for
                                // why sending this right away (same loop iteration, no
                                // wait for the server's ack) is safe. A failure here
                                // only means the user has to press Ctrl+V themselves —
                                // not worth tearing down the session over.
                                if let Some(ops) = paste_key_sequence() {
                                    let events = input_db.apply(ops);
                                    match active_stage.process_fastpath_input(&mut image, &events) {
                                        Ok(more) => outs.extend(more),
                                        Err(e) => tracing::warn!(error = %e.report(), "collage automatique après envoi de fichiers"),
                                    }
                                }
                                outs
                            }
                            Ok(None) => continue,
                            Err(e) => {
                                tracing::warn!(error = %e, "envoi de fichiers vers le presse-papiers distant");
                                continue;
                            }
                        }
                    }
                    other => {
                        let events = match other {
                            ClientMessage::ReleaseAll => input_db.release_all(),
                            other => input_db.apply(operations_for(other)),
                        };
                        active_stage
                            .process_fastpath_input(&mut image, &events)
                            .map_err(|e| anyhow::anyhow!("traitement d'un événement d'entrée : {}", e.report()))?
                    }
                }
            }
            clip_msg = recv_or_pending(&mut clipboard_rx) => {
                let Some(clip_msg) = clip_msg else {
                    clipboard_rx = None; // clipboard thread gone: keep the session running without it
                    continue;
                };
                match clipboard_svc_frame(&mut active_stage, clip_msg) {
                    Ok(Some(frame)) => vec![ActiveStageOutput::ResponseFrame(frame)],
                    Ok(None) => continue,
                    Err(e) => return Err(e),
                }
            }
        };

        for out in outputs {
            match out {
                ActiveStageOutput::ResponseFrame(frame) => {
                    writer.write_all(&frame).await.map_err(|e| anyhow::anyhow!("envoi d'une réponse : {e}"))?;
                }
                ActiveStageOutput::GraphicsUpdate(region) => {
                    if send_full_next {
                        send_frame(&image, stdout).await?;
                        send_full_next = false;
                    } else {
                        send_region(&image, &region, stdout).await?;
                    }
                }
                ActiveStageOutput::Terminate(reason) => {
                    tracing::info!(%reason, "session terminée par le serveur");
                    return Ok(());
                }
                ActiveStageOutput::DeactivateAll(sequence) => {
                    // Deactivation-Reactivation Sequence (MS-RDPBCGR §1.3.1.3):
                    // the server's answer to our resize request (or one it
                    // initiates itself, e.g. a host-side display change) — the
                    // whole capability-exchange/finalization dance runs again
                    // in miniature before either side can resume normal
                    // traffic, ending with a fresh `share_id` and desktop size.
                    handle_deactivate_all(&mut reader, &mut writer, &mut active_stage, &mut image, *sequence).await?;
                    send_full_next = true;
                }
                // Cursor shape/position — not rendered in this view-only first pass.
                ActiveStageOutput::PointerDefault
                | ActiveStageOutput::PointerHidden
                | ActiveStageOutput::PointerPosition { .. }
                | ActiveStageOutput::PointerBitmap(_) => {}
                ActiveStageOutput::MultitransportRequest(_) | ActiveStageOutput::AutoDetect(_) => {}
            }
        }
    }
}

/// Drives one Deactivation-Reactivation Sequence to completion — reading and
/// writing PDUs directly on `reader`/`writer` (bypassing `active_session`'s
/// usual `reader.read_pdu()`/`ActiveStageOutput` loop, since this is its own
/// self-contained sub-protocol) — then rebuilds `image` and updates
/// `active_stage`'s `share_id`/pointer-rendering flag for the new activation.
/// Ported from `ironrdp-client/src/rdp.rs`'s handling of the same output,
/// adapted to the resolved crate API: `ActiveStageOutput::DeactivateAll`
/// hands us a ready `ConnectionActivationSequence` directly (no
/// `activation_factory.create()` step needed, unlike the newer reference).
///
/// Deliberately does **not** call `active_stage.set_fastpath_processor(...)`
/// (unlike the reference, and unlike an earlier version of this function) —
/// that would discard and rebuild the whole `fast_path::Processor`, whose
/// bulk (MPPC) decompressor keeps a sliding-window history that has to stay
/// continuous with the server's own, never-reset compression stream (a
/// Deactivation-Reactivation Sequence renegotiates capabilities, it doesn't
/// restart bulk compression). `fast_path::Processor` exposes no getter to
/// carry that history through a rebuild, and there's no public API to patch
/// just the processor's stale `share_id`/channel IDs (used only for
/// `FrameAcknowledgePdu`, a bandwidth-pacing hint, not rendering) in place —
/// so the least-bad option is to leave the existing processor untouched
/// entirely. Found by testing an earlier "rebuild with a fresh decompressor"
/// version against a real server: it stopped crashing (a still-real bug,
/// fixed first) but every update after a resize decoded to a permanently
/// black screen, because the fresh decompressor's history never
/// resynchronizes with the server's on its own — see CLAUDE.md.
async fn handle_deactivate_all(
    reader: &mut UpgradedReader,
    writer: &mut UpgradedWriter,
    active_stage: &mut ActiveStage,
    image: &mut DecodedImage,
    mut sequence: ConnectionActivationSequence,
) -> anyhow::Result<()> {
    let mut buf = WriteBuf::new();
    loop {
        let written = single_sequence_step_read(reader, &mut sequence, &mut buf)
            .await
            .map_err(|e| anyhow::anyhow!("étape de la séquence de réactivation : {}", e.report()))?;
        if written.size().is_some() {
            writer
                .write_all(buf.filled())
                .await
                .map_err(|e| anyhow::anyhow!("envoi d'une étape de la séquence de réactivation : {e}"))?;
        }
        if let ConnectionActivationState::Finalized { desktop_size, share_id, enable_server_pointer, .. } =
            sequence.connection_activation_state()
        {
            tracing::info!(?desktop_size, "séquence de réactivation terminée");
            *image = DecodedImage::new(PixelFormat::RgbA32, desktop_size.width, desktop_size.height);
            active_stage.set_share_id(share_id);
            active_stage.set_enable_server_pointer(enable_server_pointer);
            return Ok(());
        }
    }
}

/// RGBA8 — the only `PixelFormat` `DecodedImage` is ever constructed with in
/// this file (`PixelFormat::RgbA32`, both at initial connect and after every
/// reactivation) — see `send_region`'s manual row-by-row crop, which relies
/// on this to compute byte offsets into `image.data()`.
const BYTES_PER_PIXEL: usize = 4;

async fn send_frame(image: &DecodedImage, stdout: &mut (impl tokio::io::AsyncWrite + Unpin)) -> anyhow::Result<()> {
    let width = NonZeroU16::new(image.width()).ok_or_else(|| anyhow::anyhow!("largeur d'image nulle"))?;
    let height = NonZeroU16::new(image.height()).ok_or_else(|| anyhow::anyhow!("hauteur d'image nulle"))?;
    // `DecodedImage` is already RGBA8 (see `PixelFormat::RgbA32` above), so
    // this is a plain copy — no conversion needed, unlike the reference
    // client which repacks into `Vec<u32>` for its own renderer's benefit.
    let message = SidecarMessage::Image {
        canvas_width: width.get(),
        canvas_height: height.get(),
        x: 0,
        y: 0,
        width: width.get(),
        height: height.get(),
        pixels: image.data().to_vec(),
    };
    message.write_to(stdout).await.map_err(|e| anyhow::anyhow!("envoi d'une image : {e}"))
}

/// Sends just the rectangle `region` covers within `image`, instead of the
/// whole framebuffer — see `SidecarMessage::Image`'s doc comment for why
/// this matters (a single full 1280x800 frame is ~4 MB of raw pixels before
/// base64, and most updates in practice only touch a small area: a cursor,
/// a line of new text, ...). `region` comes straight from the
/// `ActiveStageOutput::GraphicsUpdate` that was just applied to `image`, so
/// it's guaranteed to already be within bounds — no clamping needed.
async fn send_region(
    image: &DecodedImage,
    region: &InclusiveRectangle,
    stdout: &mut (impl tokio::io::AsyncWrite + Unpin),
) -> anyhow::Result<()> {
    let canvas_width = NonZeroU16::new(image.width()).ok_or_else(|| anyhow::anyhow!("largeur d'image nulle"))?;
    let canvas_height = NonZeroU16::new(image.height()).ok_or_else(|| anyhow::anyhow!("hauteur d'image nulle"))?;
    let width = NonZeroU16::new(region.right - region.left + 1).ok_or_else(|| anyhow::anyhow!("largeur de région nulle"))?;
    let height = NonZeroU16::new(region.bottom - region.top + 1).ok_or_else(|| anyhow::anyhow!("hauteur de région nulle"))?;

    let stride = image.stride();
    let row_bytes = usize::from(width.get()) * BYTES_PER_PIXEL;
    let left_offset = usize::from(region.left) * BYTES_PER_PIXEL;
    let data = image.data();
    let mut pixels = Vec::with_capacity(row_bytes * usize::from(height.get()));
    for row in 0..usize::from(height.get()) {
        let row_start = (usize::from(region.top) + row) * stride + left_offset;
        pixels.extend_from_slice(&data[row_start..row_start + row_bytes]);
    }

    let message = SidecarMessage::Image {
        canvas_width: canvas_width.get(),
        canvas_height: canvas_height.get(),
        x: region.left,
        y: region.top,
        width: width.get(),
        height: height.get(),
        pixels,
    };
    message.write_to(stdout).await.map_err(|e| anyhow::anyhow!("envoi d'une région : {e}"))
}
