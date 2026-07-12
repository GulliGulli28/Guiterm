//! Wire protocol between the Tauri app and the `rdp-sidecar` process.
//! Shared crate so the reader (`src-tauri`) and writer (`rdp-sidecar`) can
//! never drift out of sync on the framing — see CLAUDE.md's "Pourquoi un
//! processus RDP séparé" section for why this lives in its own crate
//! instead of `core` (which depends on `russh`, whose pinned `ecdsa`
//! version conflicts with `ironrdp-connector`'s).

use serde::{Deserialize, Serialize, de::DeserializeOwned};
use std::io;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

async fn write_json_line(mut w: impl AsyncWrite + Unpin, value: &impl Serialize) -> io::Result<()> {
    let mut line = serde_json::to_string(value).expect("gui-termius types always serialize");
    line.push('\n');
    w.write_all(line.as_bytes()).await?;
    w.flush().await
}

/// Reads one newline-terminated JSON line. `None` on a clean EOF before any
/// bytes arrive (the stream closed without a value ever being sent).
async fn read_json_line<T: DeserializeOwned>(mut r: impl AsyncRead + Unpin) -> io::Result<Option<T>> {
    let mut line = Vec::new();
    let mut byte = [0u8; 1];
    loop {
        match r.read_exact(&mut byte).await {
            Ok(_) => {}
            Err(e) if e.kind() == io::ErrorKind::UnexpectedEof && line.is_empty() => return Ok(None),
            Err(e) => return Err(e),
        }
        if byte[0] == b'\n' {
            break;
        }
        line.push(byte[0]);
    }
    serde_json::from_slice(&line)
        .map(Some)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))
}

/// Sent exactly once, as a single JSON line, on the sidecar's stdin, before
/// any [`ClientMessage`]. `width`/`height`: the RDP session's initial
/// resolution — measured from the view's container at connect time rather
/// than hardcoded, so the session starts already close to the right size
/// instead of always negotiating a fixed default and letterboxing until the
/// first [`ClientMessage::Resize`]. The sidecar still clamps these to
/// MS-RDPEDISP's valid range (200..=8192, even width) before using them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConnectRequest {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: String,
    pub width: u16,
    pub height: u16,
}

impl ConnectRequest {
    pub async fn write_to(&self, w: impl AsyncWrite + Unpin) -> io::Result<()> {
        write_json_line(w, self).await
    }

    pub async fn read_from(r: impl AsyncRead + Unpin) -> io::Result<Option<Self>> {
        read_json_line(r).await
    }
}

/// Sent continuously on the sidecar's stdin, after the initial
/// [`ConnectRequest`] line — one input event per JSON line, same framing.
/// Phase 2 (mouse/keyboard forwarding) counterpart to [`SidecarMessage`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ClientMessage {
    MouseMove { x: u16, y: u16 },
    /// `button`: DOM `MouseEvent.button` value (0 = left, 1 = middle, 2 = right, 3/4 = back/forward).
    MouseButton { x: u16, y: u16, button: u8, pressed: bool },
    /// `delta_y`: DOM `WheelEvent.deltaY`, sign and rough magnitude only.
    MouseWheel { x: u16, y: u16, #[serde(rename = "deltaY")] delta_y: i16 },
    /// `code`: DOM `KeyboardEvent.code` — physical key, layout-independent
    /// (e.g. `"KeyA"`, `"ArrowLeft"`), translated to an RDP scancode by the
    /// sidecar (see `rdp-sidecar/src/main.rs`'s `scancode_for`).
    Key { code: String, pressed: bool },
    /// Sent when the view loses focus/visibility, so the sidecar can release
    /// every currently-held key/button server-side and avoid a stuck input.
    ReleaseAll,
    /// The view's container was resized (debounced client-side — see
    /// `RdpTab.tsx` — so this isn't sent on every intermediate frame of a
    /// window drag). Requires the server to support the Display Control
    /// Virtual Channel; if it doesn't, the sidecar just ignores this and the
    /// session stays at its current resolution rather than reconnecting.
    Resize { width: u16, height: u16 },
    /// Types `text` into the remote session as a sequence of Unicode keyboard
    /// events (`ironrdp_input::Operation::UnicodeKeyPressed`/`Released` — a
    /// real IME-style text-input PDU, distinct from the scancode-based `Key`
    /// variant above, which only covers physical keys and can't express
    /// arbitrary Unicode). Used to run snippets/broadcast commands on a
    /// session that has no shell/PTY of its own, just a remote desktop —
    /// see `commands/rdp_view.rs`'s doc comment on why this exists at all.
    /// Every `\n`/`\r` in `text` is sent as a real Enter *keypress*
    /// (scancode-based) rather than typed as a literal character, so a
    /// caller wanting to "submit" a line the way SSH's `command + "\r"`
    /// convention does can just include a trailing `\n` — see
    /// `rdp-sidecar/src/main.rs`'s `operations_for`.
    TypeText { text: String },
    /// Makes local files/folders available on the remote session's CLIPRDR
    /// clipboard, then has the sidecar simulate a Ctrl+V right after (see
    /// `paste_key_sequence` in `rdp-sidecar/src/main.rs`) so it pastes
    /// automatically — pushed once, on demand, from the app's own file
    /// browser (drag onto the RDP view),
    /// **not** a passive mirror of the local OS clipboard the way text sync
    /// is (see CLAUDE.md's "RDP intégré" section: text sync reacts to real
    /// `WM_CLIPBOARDUPDATE` events, this is triggered directly by the app).
    /// `files` is the full flat list already recursively walked — a
    /// directory contributes its own entry (`is_dir: true`, no content ever
    /// requested for it) plus one entry per descendant file/subdirectory,
    /// `relative_path` chaining to describe nesting. See
    /// `rdp-sidecar/src/clipboard.rs`'s `FileTable` for how the sidecar
    /// answers the remote's later byte-range requests using `local_path`.
    PushClipboardFiles { files: Vec<PushedFile> },
}

/// One entry in a [`ClientMessage::PushClipboardFiles`] batch — either a
/// directory marker (`is_dir: true`, `local_path` unused/empty: a directory
/// has no bytes to serve, only its presence in the list matters so the
/// receiving side recreates the folder structure) or a real file backed by
/// `local_path` on the machine running the sidecar. `local_path` for a
/// non-local source (SFTP/Docker) is a temp copy downloaded *before* this
/// message is sent — `on_file_contents_request` is a synchronous callback
/// deep inside the CLIPRDR protocol engine with no way to `.await` a remote
/// fetch, so the byte source has to already be a real local file by the time
/// the remote asks for it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PushedFile {
    pub local_path: String,
    /// Basename, as it should appear on the remote clipboard.
    pub name: String,
    /// Parent path within the dragged collection, `\`-separated (matching
    /// `CLIPRDR_FILEDESCRIPTOR`'s wire convention — see
    /// `ironrdp_cliprdr::pdu::FileDescriptor::relative_path`'s doc comment).
    /// `None` for a root-level entry (dragged directly, not nested inside
    /// another dragged directory).
    pub relative_path: Option<String>,
    pub is_dir: bool,
    pub size: u64,
}

impl ClientMessage {
    pub async fn write_to(&self, w: impl AsyncWrite + Unpin) -> io::Result<()> {
        write_json_line(w, self).await
    }

    pub async fn read_from(r: impl AsyncRead + Unpin) -> io::Result<Option<Self>> {
        read_json_line(r).await
    }
}

/// Framed messages the sidecar streams on stdout once connected.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SidecarMessage {
    /// A rectangle of RGBA8 pixels, row-major, `4 * width * height` bytes,
    /// to be painted at (`x`, `y`) on a canvas whose *current full* size is
    /// (`canvas_width`, `canvas_height`) — usually just the dirty region a
    /// single `GraphicsUpdate` touched (a blinking cursor, one changed line
    /// of text, ...), not the whole framebuffer: re-sending everything on
    /// every update was the original, simpler approach, but made typing or
    /// scrolling in the remote session visibly heavy even on a fast link,
    /// since a single 1280x800 update alone is ~4 MB of raw pixels before
    /// base64. `canvas_width`/`canvas_height` repeat the same unchanged
    /// value on most messages (only the dirty rectangle actually shrinks) —
    /// cheap (4 bytes) and lets the frontend tell "the desktop itself
    /// resized, resize my `<canvas>`" apart from "same-size partial paint,
    /// don't touch canvas dimensions or `putImageData` would clear
    /// everything painted so far outside this rectangle". `x == y == 0 &&
    /// width == canvas_width && height == canvas_height` for a full frame
    /// (sent right after connecting and after every resize's Deactivation-
    /// Reactivation Sequence, to guarantee a fully painted canvas rather
    /// than trusting whatever the next natural `GraphicsUpdate` happens to
    /// cover — see `rdp-sidecar/src/main.rs`), but the frontend never needs
    /// to special-case that: `putImageData(imageData, x, y)` handles both
    /// shapes identically.
    Image {
        canvas_width: u16,
        canvas_height: u16,
        x: u16,
        y: u16,
        width: u16,
        height: u16,
        pixels: Vec<u8>,
    },
    Error(String),
    Closed,
}

const TAG_IMAGE: u8 = 1;
const TAG_ERROR: u8 = 2;
const TAG_CLOSED: u8 = 3;

impl SidecarMessage {
    pub async fn write_to(&self, mut w: impl AsyncWrite + Unpin) -> io::Result<()> {
        match self {
            SidecarMessage::Image { canvas_width, canvas_height, x, y, width, height, pixels } => {
                let mut header = Vec::with_capacity(17);
                header.push(TAG_IMAGE);
                header.extend_from_slice(&canvas_width.to_be_bytes());
                header.extend_from_slice(&canvas_height.to_be_bytes());
                header.extend_from_slice(&x.to_be_bytes());
                header.extend_from_slice(&y.to_be_bytes());
                header.extend_from_slice(&width.to_be_bytes());
                header.extend_from_slice(&height.to_be_bytes());
                header.extend_from_slice(&u32::try_from(pixels.len()).unwrap_or(u32::MAX).to_be_bytes());
                w.write_all(&header).await?;
                w.write_all(pixels).await?;
            }
            SidecarMessage::Error(msg) => {
                let bytes = msg.as_bytes();
                let mut header = Vec::with_capacity(5);
                header.push(TAG_ERROR);
                header.extend_from_slice(&u32::try_from(bytes.len()).unwrap_or(u32::MAX).to_be_bytes());
                w.write_all(&header).await?;
                w.write_all(bytes).await?;
            }
            SidecarMessage::Closed => {
                w.write_all(&[TAG_CLOSED]).await?;
            }
        }
        w.flush().await
    }

    /// `Ok(None)` on a clean EOF between messages (the sidecar process
    /// exited or closed its stdout).
    pub async fn read_from(mut r: impl AsyncRead + Unpin) -> io::Result<Option<Self>> {
        let mut tag = [0u8; 1];
        if let Err(e) = r.read_exact(&mut tag).await {
            return if e.kind() == io::ErrorKind::UnexpectedEof { Ok(None) } else { Err(e) };
        }
        match tag[0] {
            TAG_IMAGE => {
                let mut dims = [0u8; 12];
                r.read_exact(&mut dims).await?;
                let canvas_width = u16::from_be_bytes([dims[0], dims[1]]);
                let canvas_height = u16::from_be_bytes([dims[2], dims[3]]);
                let x = u16::from_be_bytes([dims[4], dims[5]]);
                let y = u16::from_be_bytes([dims[6], dims[7]]);
                let width = u16::from_be_bytes([dims[8], dims[9]]);
                let height = u16::from_be_bytes([dims[10], dims[11]]);
                let mut len_buf = [0u8; 4];
                r.read_exact(&mut len_buf).await?;
                let len = u32::from_be_bytes(len_buf) as usize;
                let mut pixels = vec![0u8; len];
                r.read_exact(&mut pixels).await?;
                Ok(Some(SidecarMessage::Image { canvas_width, canvas_height, x, y, width, height, pixels }))
            }
            TAG_ERROR => {
                let mut len_buf = [0u8; 4];
                r.read_exact(&mut len_buf).await?;
                let len = u32::from_be_bytes(len_buf) as usize;
                let mut bytes = vec![0u8; len];
                r.read_exact(&mut bytes).await?;
                Ok(Some(SidecarMessage::Error(String::from_utf8_lossy(&bytes).into_owned())))
            }
            TAG_CLOSED => Ok(Some(SidecarMessage::Closed)),
            other => Err(io::Error::new(io::ErrorKind::InvalidData, format!("unknown sidecar message tag {other}"))),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn connect_request_roundtrips_through_a_pipe() {
        let (client, server) = tokio::io::duplex(4096);
        let req = ConnectRequest {
            host: "10.0.4.12".to_string(),
            port: 3389,
            username: "alice".to_string(),
            password: "hunter2".to_string(),
            width: 1440,
            height: 900,
        };
        req.write_to(client).await.unwrap();
        let decoded = ConnectRequest::read_from(server).await.unwrap().expect("a request was sent");
        assert_eq!(decoded.host, req.host);
        assert_eq!(decoded.port, req.port);
        assert_eq!(decoded.username, req.username);
        assert_eq!(decoded.password, req.password);
        assert_eq!(decoded.width, req.width);
        assert_eq!(decoded.height, req.height);
    }

    #[tokio::test]
    async fn connect_request_read_is_none_on_immediate_eof() {
        let (client, server) = tokio::io::duplex(4096);
        drop(client);
        let decoded = ConnectRequest::read_from(server).await.unwrap();
        assert_eq!(decoded, None);
    }

    #[tokio::test]
    async fn client_message_variants_roundtrip_through_a_pipe() {
        let (mut client, mut server) = tokio::io::duplex(4096);
        let messages = [
            ClientMessage::MouseMove { x: 12, y: 34 },
            ClientMessage::MouseButton { x: 12, y: 34, button: 0, pressed: true },
            ClientMessage::MouseWheel { x: 12, y: 34, delta_y: -120 },
            ClientMessage::Key { code: "KeyA".to_string(), pressed: true },
            ClientMessage::ReleaseAll,
            ClientMessage::Resize { width: 1600, height: 1000 },
            ClientMessage::TypeText { text: "echo café ☕\n".to_string() },
            ClientMessage::PushClipboardFiles {
                files: vec![
                    PushedFile { local_path: String::new(), name: "sub".to_string(), relative_path: None, is_dir: true, size: 0 },
                    PushedFile {
                        local_path: "/tmp/gui-termius-abc/nested.txt".to_string(),
                        name: "nested.txt".to_string(),
                        relative_path: Some("sub".to_string()),
                        is_dir: false,
                        size: 42,
                    },
                ],
            },
        ];
        for msg in &messages {
            msg.write_to(&mut client).await.unwrap();
        }
        drop(client);
        for expected in &messages {
            let decoded = ClientMessage::read_from(&mut server).await.unwrap().expect("a message was sent");
            assert_eq!(&decoded, expected);
        }
        assert_eq!(ClientMessage::read_from(&mut server).await.unwrap(), None);
    }

    /// `#[serde(rename_all = "camelCase")]` on an internally-tagged enum
    /// only renames the variant names (the `"type"` values) — it does NOT
    /// cascade into struct-variant field names, so `delta_y` needed its own
    /// `#[serde(rename = "deltaY")]` to match the hand-written TS literal in
    /// `RdpTab.tsx`. A silent mismatch here means every wheel event fails to
    /// deserialize server-side — not a compile error on either side, so this
    /// is worth pinning down explicitly rather than trusting the round-trip
    /// test above (which only proves Rust decodes what Rust encoded).
    #[test]
    fn mouse_wheel_delta_y_field_is_camel_case_on_the_wire() {
        let json = serde_json::to_string(&ClientMessage::MouseWheel { x: 1, y: 2, delta_y: -120 }).unwrap();
        assert!(json.contains("\"deltaY\":-120"), "expected camelCase deltaY in {json:?}");
    }

    #[tokio::test]
    async fn image_message_roundtrips_through_a_pipe() {
        let (client, server) = tokio::io::duplex(65536);
        // A partial update, deliberately not shaped like a full frame
        // (canvas bigger than the region, non-zero offset), so the
        // roundtrip actually exercises `x`/`y` rather than always leaving
        // them at their zero default.
        let msg = SidecarMessage::Image { canvas_width: 100, canvas_height: 80, x: 10, y: 20, width: 4, height: 2, pixels: (0..32).collect() };
        msg.write_to(client).await.unwrap();
        let decoded = SidecarMessage::read_from(server).await.unwrap().expect("a message was sent");
        assert_eq!(decoded, msg);
    }

    #[tokio::test]
    async fn error_message_roundtrips_through_a_pipe() {
        let (client, server) = tokio::io::duplex(4096);
        let msg = SidecarMessage::Error("connexion refusée".to_string());
        msg.write_to(client).await.unwrap();
        let decoded = SidecarMessage::read_from(server).await.unwrap().expect("a message was sent");
        assert_eq!(decoded, msg);
    }

    #[tokio::test]
    async fn closed_message_roundtrips_through_a_pipe() {
        let (client, server) = tokio::io::duplex(4096);
        SidecarMessage::Closed.write_to(client).await.unwrap();
        let decoded = SidecarMessage::read_from(server).await.unwrap().expect("a message was sent");
        assert_eq!(decoded, SidecarMessage::Closed);
    }

    #[tokio::test]
    async fn multiple_messages_are_framed_independently_on_the_same_stream() {
        let (client, mut server) = tokio::io::duplex(65536);
        let mut client = client;
        let a = SidecarMessage::Image { canvas_width: 2, canvas_height: 1, x: 0, y: 0, width: 2, height: 1, pixels: vec![1, 2, 3, 4, 5, 6, 7, 8] };
        let b = SidecarMessage::Error("timeout".to_string());
        a.write_to(&mut client).await.unwrap();
        b.write_to(&mut client).await.unwrap();
        drop(client);

        let first = SidecarMessage::read_from(&mut server).await.unwrap().expect("first message");
        let second = SidecarMessage::read_from(&mut server).await.unwrap().expect("second message");
        let third = SidecarMessage::read_from(&mut server).await.unwrap();
        assert_eq!(first, a);
        assert_eq!(second, b);
        assert_eq!(third, None);
    }

    #[tokio::test]
    async fn read_is_none_on_immediate_eof() {
        let (client, server) = tokio::io::duplex(4096);
        drop(client);
        let decoded = SidecarMessage::read_from(server).await.unwrap();
        assert_eq!(decoded, None);
    }
}
