//! Native OS clipboard bridge for CLIPRDR (RDP clipboard redirection) — see
//! CLAUDE.md's "RDP intégré" section for the full design rationale.
//!
//! Windows only for now on the *text* side: `ironrdp-cliprdr-native`'s
//! `WinClipboard` does the actual OS clipboard reads/writes and format
//! negotiation internally — real, automatic, bidirectional mirroring of
//! whatever the local OS clipboard holds. It relies on `WM_CLIPBOARDUPDATE`
//! being delivered to a hidden window it owns, which needs an actual Win32
//! message loop pumping — something this otherwise message-loop-free,
//! pure-tokio process doesn't have without one. On any other platform,
//! `StubClipboard` is a real, complete no-op backend (not a partial
//! implementation) — attaching it still negotiates the CLIPRDR channel so
//! the server doesn't see anything unusual, it just never produces or
//! accepts any clipboard data.
//!
//! **File-list support (`STREAM_FILECLIP_ENABLED`) is layered on top of
//! whichever of those two backends is active, cross-platform, via
//! [`FilePushBackend`]** — a decorator that delegates every text-related
//! method straight to the inner backend and only implements the file-push
//! use case itself: the app's own file browser (`RdpTab.tsx`'s drop target)
//! pushes local files/folders on demand (see
//! `rdp_ipc::ClientMessage::PushClipboardFiles`), never touching the real OS
//! clipboard at all. This is deliberately *not* built into `WinClipboard`
//! itself: `ironrdp-cliprdr-native` 0.6.0 has no file-transfer support
//! wired up on any platform (`client_capabilities()` on both backends
//! advertises none — verified by reading its source, not assumed), and
//! implementing genuine OS-level delayed-rendering file clipboard support
//! (`CFSTR_FILEDESCRIPTORW`/`CFSTR_FILECONTENTS` COM machinery on Windows)
//! would be a much larger, Windows-only, higher-risk undertaking for a
//! use case that doesn't actually need it — the file bytes here always come
//! from a path the app already knows, not from asking the OS "what's on the
//! clipboard right now".

use ironrdp::cliprdr::backend::{CliprdrBackend, CliprdrBackendFactory, ClipboardMessage};
use ironrdp::cliprdr::pdu::{
    ClipboardFormat, ClipboardGeneralCapabilityFlags, FileContentsFlags, FileContentsRequest, FileContentsResponse,
    FormatDataRequest, FormatDataResponse, LockDataId,
};
use ironrdp::core::impl_as_any;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;

/// Index → local path for the files most recently pushed via
/// [`ironrdp::cliprdr::CliprdrClient::initiate_file_copy`] — shared between
/// `active_session` (populates it right before calling `initiate_file_copy`,
/// see `main.rs`'s `push_clipboard_files`) and [`FilePushBackend`] (reads it
/// to answer `on_file_contents_request`). A plain `Vec` indexed by position,
/// not a map: the index the crate assigns each descriptor in a
/// `FileContentsRequest` is exactly its position in the `Vec<FileDescriptor>`
/// passed to `initiate_file_copy`, *if* nothing in that call filters or
/// reorders it — `main.rs` pre-validates each entry the same way
/// `initiate_file_copy` itself does, specifically so this positional
/// assumption holds.
#[derive(Clone, Default, Debug)]
pub struct FileTable(Arc<Mutex<Vec<PathBuf>>>);

impl FileTable {
    pub fn set(&self, paths: Vec<PathBuf>) {
        *self.0.lock().unwrap_or_else(|e| e.into_inner()) = paths;
    }

    fn get(&self, index: usize) -> Option<PathBuf> {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).get(index).cloned()
    }
}

/// Sets up the clipboard backend factory (used once per connection attempt
/// to build a fresh [`CliprdrBackend`]), the channel `active_session` reads
/// `ClipboardMessage`s from, and the [`FileTable`] it populates before
/// calling `initiate_file_copy`. On Windows, awaits the dedicated clipboard
/// thread finishing its hidden-window setup before returning — a failure
/// there (e.g. window class registration) is reported as an error rather
/// than silently disabling clipboard support.
pub async fn init() -> anyhow::Result<(Box<dyn CliprdrBackendFactory + Send>, mpsc::UnboundedReceiver<ClipboardMessage>, FileTable)> {
    let (tx, rx) = mpsc::unbounded_channel();
    let files = FileTable::default();

    #[cfg(windows)]
    let inner_factory = windows_impl::spawn(tx.clone()).await?;
    #[cfg(not(windows))]
    let inner_factory = {
        let _ = &tx; // no proxy on this platform: the stub backend never calls it
        ironrdp_cliprdr_native::StubClipboard::new().backend_factory()
    };

    let factory = FilePushBackendFactory { inner: inner_factory, files: files.clone(), tx };
    Ok((Box::new(factory), rx, files))
}

struct FilePushBackendFactory {
    inner: Box<dyn CliprdrBackendFactory + Send>,
    files: FileTable,
    tx: mpsc::UnboundedSender<ClipboardMessage>,
}

impl CliprdrBackendFactory for FilePushBackendFactory {
    fn build_cliprdr_backend(&self) -> Box<dyn CliprdrBackend> {
        Box::new(FilePushBackend { inner: self.inner.build_cliprdr_backend(), files: self.files.clone(), tx: self.tx.clone() })
    }
}

#[derive(Debug)]
struct FilePushBackend {
    inner: Box<dyn CliprdrBackend>,
    files: FileTable,
    tx: mpsc::UnboundedSender<ClipboardMessage>,
}

impl_as_any!(FilePushBackend);

impl CliprdrBackend for FilePushBackend {
    fn temporary_directory(&self) -> &str {
        self.inner.temporary_directory()
    }

    fn client_capabilities(&self) -> ClipboardGeneralCapabilityFlags {
        self.inner.client_capabilities() | ClipboardGeneralCapabilityFlags::STREAM_FILECLIP_ENABLED
    }

    fn on_ready(&mut self) {
        self.inner.on_ready();
    }

    fn on_request_format_list(&mut self) {
        self.inner.on_request_format_list();
    }

    fn on_format_list_response(&mut self, ok: bool) {
        self.inner.on_format_list_response(ok);
    }

    fn on_process_negotiated_capabilities(&mut self, capabilities: ClipboardGeneralCapabilityFlags) {
        self.inner.on_process_negotiated_capabilities(capabilities);
    }

    fn on_remote_copy(&mut self, available_formats: &[ClipboardFormat]) {
        self.inner.on_remote_copy(available_formats);
    }

    fn on_format_data_request(&mut self, request: FormatDataRequest) {
        self.inner.on_format_data_request(request);
    }

    fn on_format_data_response(&mut self, response: FormatDataResponse<'_>) {
        self.inner.on_format_data_response(response);
    }

    /// The one method this wrapper actually implements itself — everything
    /// else here is text sync, untouched, exactly `inner`'s behavior.
    fn on_file_contents_request(&mut self, request: FileContentsRequest) {
        let response = build_file_contents_response(&self.files, &request);
        let _ = self.tx.send(ClipboardMessage::SendFileContentsResponse(response));
    }

    fn on_file_contents_response(&mut self, response: FileContentsResponse<'_>) {
        self.inner.on_file_contents_response(response);
    }

    fn on_lock(&mut self, data_id: LockDataId) {
        self.inner.on_lock(data_id);
    }

    fn on_unlock(&mut self, data_id: LockDataId) {
        self.inner.on_unlock(data_id);
    }

    fn now_ms(&self) -> u64 {
        self.inner.now_ms()
    }

    fn elapsed_ms(&self, since: u64) -> u64 {
        self.inner.elapsed_ms(since)
    }
}

/// Answers one `FileContentsRequest` by reading straight off the local path
/// `main.rs`'s `push_clipboard_files` recorded at `request.index` — a
/// `SIZE` request gets the file's real length, a `RANGE` request gets up to
/// `requested_size` bytes starting at `position` (fewer near EOF is normal,
/// per MS-RDPECLIP — the remote keeps asking until a read stops making
/// progress, a short read isn't itself an error). Blocking I/O is
/// deliberate: this runs synchronously inside the CLIPRDR protocol engine's
/// own call stack (`CliprdrBackend::on_file_contents_request` has no way to
/// `.await`), and every byte source here is already a real local file by
/// construction (`rdp_ipc::PushedFile::local_path`, downloaded ahead of time
/// if the original source was remote) — never a network fetch made here.
fn build_file_contents_response(files: &FileTable, request: &FileContentsRequest) -> FileContentsResponse<'static> {
    let Ok(index) = usize::try_from(request.index) else {
        return FileContentsResponse::new_error(request.stream_id);
    };
    let Some(path) = files.get(index) else {
        return FileContentsResponse::new_error(request.stream_id);
    };
    if request.flags.contains(FileContentsFlags::SIZE) {
        match std::fs::metadata(&path) {
            Ok(meta) => FileContentsResponse::new_size_response(request.stream_id, meta.len()),
            Err(e) => {
                tracing::warn!(error = %e, path = %path.display(), "taille de fichier presse-papiers illisible");
                FileContentsResponse::new_error(request.stream_id)
            }
        }
    } else {
        match read_range(&path, request.position, request.requested_size) {
            Ok(data) => FileContentsResponse::new_data_response(request.stream_id, data),
            Err(e) => {
                tracing::warn!(error = %e, path = %path.display(), "contenu de fichier presse-papiers illisible");
                FileContentsResponse::new_error(request.stream_id)
            }
        }
    }
}

fn read_range(path: &std::path::Path, position: u64, len: u32) -> std::io::Result<Vec<u8>> {
    use std::io::{Read, Seek, SeekFrom};
    let mut file = std::fs::File::open(path)?;
    file.seek(SeekFrom::Start(position))?;
    let mut buf = vec![0u8; len as usize];
    let n = file.read(&mut buf)?;
    buf.truncate(n);
    Ok(buf)
}

#[cfg(windows)]
mod windows_impl {
    use ironrdp::cliprdr::backend::{CliprdrBackendFactory, ClipboardMessage, ClipboardMessageProxy};
    use tokio::sync::{mpsc, oneshot};
    use windows::Win32::UI::WindowsAndMessaging::{DispatchMessageW, GetMessageW, MSG, TranslateMessage};

    /// Forwards `ClipboardMessage`s from the clipboard thread into the tokio
    /// world, where `active_session` drives the actual `CliprdrClient` calls
    /// (`initiate_copy`/`submit_format_data`/`initiate_paste`) in response.
    /// `send_clipboard_message` is a plain synchronous call (not `async`),
    /// so this is safe to invoke from a non-tokio OS thread —
    /// `UnboundedSender::send` never blocks or requires an executor.
    #[derive(Debug)]
    struct TokioClipboardProxy {
        tx: mpsc::UnboundedSender<ClipboardMessage>,
    }

    impl ClipboardMessageProxy for TokioClipboardProxy {
        fn send_clipboard_message(&self, message: ClipboardMessage) {
            let _ = self.tx.send(message);
        }
    }

    /// Spawns the dedicated clipboard thread and blocks (asynchronously)
    /// until it's ready. `WinClipboard` is `!Send`: it owns a hidden window
    /// tied to the thread that created it, and that same thread must be the
    /// one pumping Win32 messages for `WM_CLIPBOARDUPDATE` to ever arrive —
    /// so it has to be born, used, and (if this ever returns) dropped
    /// entirely within the spawned thread's closure, never moved across
    /// threads. The thread is intentionally never joined: it keeps pumping
    /// messages for the rest of the process's life, torn down only when the
    /// parent kills us — there is no graceful-shutdown path for this
    /// process (see `rdp-ipc`'s doc comment on why).
    pub(super) async fn spawn(tx: mpsc::UnboundedSender<ClipboardMessage>) -> anyhow::Result<Box<dyn CliprdrBackendFactory + Send>> {
        let (ready_tx, ready_rx) = oneshot::channel();

        std::thread::spawn(move || {
            let proxy = TokioClipboardProxy { tx };
            let win_clipboard = match ironrdp_cliprdr_native::WinClipboard::new(proxy) {
                Ok(wc) => wc,
                Err(e) => {
                    let _ = ready_tx.send(Err(anyhow::anyhow!("initialisation du presse-papiers Windows : {e}")));
                    return;
                }
            };
            let factory = win_clipboard.backend_factory();
            if ready_tx.send(Ok(factory)).is_err() {
                return; // caller gave up waiting — nothing left to serve
            }

            let mut msg = MSG::default();
            loop {
                // SAFETY: `msg` is a valid out-parameter; `hwnd = None` means
                // "any message for a window owned by this thread", which is
                // exactly the hidden window `WinClipboard` just created —
                // including `WM_CLIPRDR_BACKEND_EVENT`, posted internally by
                // `ironrdp-cliprdr-native` to wake this loop up when there's
                // an event to process.
                let ret = unsafe { GetMessageW(&mut msg, None, 0, 0) };
                if ret.0 <= 0 {
                    break; // WM_QUIT (0) or an error (-1) — stop pumping either way
                }
                // SAFETY: `msg` was just populated by the successful `GetMessageW` call above.
                unsafe {
                    let _ = TranslateMessage(&msg);
                    DispatchMessageW(&msg);
                }
            }
            // Reached only if something posts WM_QUIT to this thread, which
            // nothing in this codebase does — dropping here would
            // unregister the clipboard listener the same way `Drop` for
            // `WinClipboard` documents.
            drop(win_clipboard);
        });

        match ready_rx.await {
            Ok(result) => result,
            Err(_) => Err(anyhow::anyhow!("le thread du presse-papiers Windows s'est arrêté avant d'être prêt")),
        }
    }
}
