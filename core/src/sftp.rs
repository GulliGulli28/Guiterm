//! SFTP file browsing over an established [`crate::ssh::Connection`].
use crate::ssh::Connection;
use russh_sftp::client::SftpSession;
use russh_sftp::client::fs::Metadata;
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};

/// One side of a [`crate::transfer::PaneRef::Remote`] pane — despite living in
/// this file, deliberately not SFTP-specific: [`crate::docker_pane::DockerPaneClient`]
/// implements it too (shelling out inside the container for the metadata
/// operations, the Engine API's archive endpoints for file content), so
/// `transfer.rs`'s local/remote dispatch logic works unmodified for either
/// backend. Lives here rather than in `transfer.rs` because [`Entry`], the
/// shared return type, already does.
#[async_trait::async_trait]
pub trait RemoteFileClient: Send + Sync {
    async fn list(&self, path: &str) -> anyhow::Result<Vec<Entry>>;
    async fn make_dir(&self, path: &str) -> anyhow::Result<()>;
    async fn remove_file(&self, path: &str) -> anyhow::Result<()>;
    async fn remove_dir(&self, path: &str) -> anyhow::Result<()>;
    async fn rename(&self, from: &str, to: &str) -> anyhow::Result<()>;
    async fn set_permissions(&self, path: &str, mode: u32) -> anyhow::Result<()>;
    async fn read_to_string(&self, path: &str) -> anyhow::Result<String>;
    async fn write_string(&self, path: &str, content: &str) -> anyhow::Result<()>;
    /// `on_progress`: `&mut dyn FnMut` rather than `impl FnMut` — trait
    /// methods with a generic parameter aren't object-safe, and `PaneRef`
    /// needs to hold this behind `Arc<dyn RemoteFileClient>`.
    async fn download(
        &self,
        remote_path: &str,
        local_path: &std::path::Path,
        total: u64,
        cancel: &AtomicBool,
        on_progress: &mut (dyn FnMut(u64, u64) + Send),
    ) -> anyhow::Result<()>;
    async fn upload(
        &self,
        local_path: &std::path::Path,
        remote_path: &str,
        cancel: &AtomicBool,
        on_progress: &mut (dyn FnMut(u64, u64) + Send),
    ) -> anyhow::Result<()>;
}

#[async_trait::async_trait]
impl RemoteFileClient for SftpClient {
    async fn list(&self, path: &str) -> anyhow::Result<Vec<Entry>> {
        self.list(path).await
    }
    async fn make_dir(&self, path: &str) -> anyhow::Result<()> {
        self.make_dir(path).await
    }
    async fn remove_file(&self, path: &str) -> anyhow::Result<()> {
        self.remove_file(path).await
    }
    async fn remove_dir(&self, path: &str) -> anyhow::Result<()> {
        self.remove_dir(path).await
    }
    async fn rename(&self, from: &str, to: &str) -> anyhow::Result<()> {
        self.rename(from, to).await
    }
    async fn set_permissions(&self, path: &str, mode: u32) -> anyhow::Result<()> {
        self.set_permissions(path, mode).await
    }
    async fn read_to_string(&self, path: &str) -> anyhow::Result<String> {
        self.read_to_string(path).await
    }
    async fn write_string(&self, path: &str, content: &str) -> anyhow::Result<()> {
        self.write_string(path, content).await
    }
    async fn download(
        &self,
        remote_path: &str,
        local_path: &std::path::Path,
        total: u64,
        cancel: &AtomicBool,
        on_progress: &mut (dyn FnMut(u64, u64) + Send),
    ) -> anyhow::Result<()> {
        self.download(remote_path, local_path, total, cancel, on_progress).await
    }
    async fn upload(
        &self,
        local_path: &std::path::Path,
        remote_path: &str,
        cancel: &AtomicBool,
        on_progress: &mut (dyn FnMut(u64, u64) + Send),
    ) -> anyhow::Result<()> {
        self.upload(local_path, remote_path, cancel, on_progress).await
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub name: String,
    pub is_dir: bool,
    pub is_symlink: bool,
    pub size: u64,
    pub modified: Option<u64>,
    /// POSIX permission bits (e.g. `0o755`), when the server reports them. `None` on
    /// filesystems without a meaningful POSIX mode (e.g. local Windows entries).
    #[serde(default)]
    pub permissions: Option<u32>,
}

/// Chunk size for streamed uploads/downloads — small enough to report smooth
/// progress, large enough to not dominate transfer time with round-trips.
const CHUNK_SIZE: usize = 256 * 1024;

/// Upper bound on a file opened for the in-app quick-edit modal. Quick-edit is
/// meant for small text files; capping the read stops a huge (or a maliciously
/// unbounded) remote file from exhausting memory.
pub const MAX_EDIT_BYTES: u64 = 5 * 1024 * 1024;

pub struct SftpClient {
    session: SftpSession,
}

impl SftpClient {
    pub async fn open(connection: &Connection) -> anyhow::Result<Self> {
        let channel = connection.target().channel_open_session().await?;
        channel.request_subsystem(true, "sftp").await?;
        let session = SftpSession::new(channel.into_stream()).await?;
        Ok(Self { session })
    }

    pub async fn home_dir(&self) -> anyhow::Result<String> {
        Ok(self.session.canonicalize(".").await?)
    }

    pub async fn list(&self, path: &str) -> anyhow::Result<Vec<Entry>> {
        let mut entries: Vec<Entry> = self
            .session
            .read_dir(path)
            .await?
            .map(|entry| {
                let metadata = entry.metadata();
                Entry {
                    name: entry.file_name(),
                    is_dir: metadata.file_type().is_dir(),
                    is_symlink: metadata.file_type().is_symlink(),
                    size: metadata.len(),
                    modified: metadata.mtime.map(|t| t as u64),
                    permissions: metadata.permissions.map(|p| p & 0o7777),
                }
            })
            .collect();
        entries.retain(|e| e.name != "." && e.name != "..");
        Ok(entries)
    }

    pub async fn make_dir(&self, path: &str) -> anyhow::Result<()> {
        Ok(self.session.create_dir(path).await?)
    }

    pub async fn remove_file(&self, path: &str) -> anyhow::Result<()> {
        Ok(self.session.remove_file(path).await?)
    }

    pub async fn remove_dir(&self, path: &str) -> anyhow::Result<()> {
        Ok(self.session.remove_dir(path).await?)
    }

    pub async fn rename(&self, from: &str, to: &str) -> anyhow::Result<()> {
        Ok(self.session.rename(from, to).await?)
    }

    pub async fn set_permissions(&self, path: &str, mode: u32) -> anyhow::Result<()> {
        let attrs = Metadata {
            permissions: Some(mode),
            ..Default::default()
        };
        Ok(self.session.set_metadata(path, attrs).await?)
    }

    /// Reads a whole remote file into memory for quick in-place editing — no local
    /// temp file involved. Only meant for small text files; callers are expected to
    /// gate on size before calling this.
    pub async fn read_to_string(&self, path: &str) -> anyhow::Result<String> {
        use tokio::io::AsyncReadExt;
        let file = self.session.open(path).await?;
        let mut buf = Vec::new();
        // Read at most one byte past the cap: enough to tell the file is over the
        // limit without ever buffering the whole thing.
        file.take(MAX_EDIT_BYTES + 1).read_to_end(&mut buf).await?;
        if buf.len() as u64 > MAX_EDIT_BYTES {
            anyhow::bail!(
                "fichier trop volumineux pour l'édition rapide (> {} Mo)",
                MAX_EDIT_BYTES / (1024 * 1024)
            );
        }
        String::from_utf8(buf)
            .map_err(|_| anyhow::anyhow!("le fichier n'est pas du texte UTF-8 valide"))
    }

    /// Overwrites a remote file's entire content, for quick in-place editing.
    pub async fn write_string(&self, path: &str, content: &str) -> anyhow::Result<()> {
        use tokio::io::AsyncWriteExt;
        let mut file = self.session.create(path).await?;
        file.write_all(content.as_bytes()).await?;
        Ok(())
    }

    /// Downloads in fixed-size chunks, reporting `(bytes_done, bytes_total)` after each
    /// one so callers can surface progress — `total` is passed in rather than re-queried
    /// from the server since the caller (a directory listing) already knows it.
    ///
    /// On cancellation or a mid-transfer error, the partially-written local file is
    /// removed rather than left behind looking like a complete download.
    pub async fn download(
        &self,
        remote_path: &str,
        local_path: &std::path::Path,
        total: u64,
        cancel: &AtomicBool,
        mut on_progress: impl FnMut(u64, u64),
    ) -> anyhow::Result<()> {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let mut remote_file = self.session.open(remote_path).await?;
        let mut local_file = tokio::fs::File::create(local_path).await?;
        let mut buf = vec![0u8; CHUNK_SIZE];
        let mut done = 0u64;
        let result: anyhow::Result<()> = loop {
            if cancel.load(Ordering::Relaxed) {
                break Err(anyhow::anyhow!("transfert annulé"));
            }
            let n = match remote_file.read(&mut buf).await {
                Ok(n) => n,
                Err(e) => break Err(e.into()),
            };
            if n == 0 {
                break Ok(());
            }
            if let Err(e) = local_file.write_all(&buf[..n]).await {
                break Err(e.into());
            }
            done += n as u64;
            on_progress(done, total);
        };
        if result.is_err() {
            drop(local_file);
            let _ = tokio::fs::remove_file(local_path).await;
        }
        result
    }

    /// Uploads in fixed-size chunks, reporting `(bytes_done, bytes_total)` after each one.
    ///
    /// On cancellation or a mid-transfer error, the partially-written remote file is
    /// removed rather than left behind looking like a complete upload.
    pub async fn upload(
        &self,
        local_path: &std::path::Path,
        remote_path: &str,
        cancel: &AtomicBool,
        mut on_progress: impl FnMut(u64, u64),
    ) -> anyhow::Result<()> {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let mut local_file = tokio::fs::File::open(local_path).await?;
        let total = local_file.metadata().await?.len();
        // `create` (unlike `write`) opens with CREATE|TRUNCATE, since the
        // remote file generally doesn't exist yet.
        let mut remote_file = self.session.create(remote_path).await?;
        let mut buf = vec![0u8; CHUNK_SIZE];
        let mut done = 0u64;
        let result: anyhow::Result<()> = loop {
            if cancel.load(Ordering::Relaxed) {
                break Err(anyhow::anyhow!("transfert annulé"));
            }
            let n = match local_file.read(&mut buf).await {
                Ok(n) => n,
                Err(e) => break Err(e.into()),
            };
            if n == 0 {
                break Ok(());
            }
            if let Err(e) = remote_file.write_all(&buf[..n]).await {
                break Err(e.into());
            }
            done += n as u64;
            on_progress(done, total);
        };
        if result.is_err() {
            drop(remote_file);
            let _ = self.session.remove_file(remote_path).await;
        }
        result
    }
}

/// Validates that `name` is a single, safe path component before it is used to
/// build a filesystem path.
///
/// A remote SFTP server fully controls the filenames it returns in a directory
/// listing. Without this check, a malicious or compromised server could return a
/// name like `../../.ssh/authorized_keys` (or one containing an absolute path)
/// and make a *download* write outside the directory the user picked — classic
/// path traversal. A legitimate filename is never empty, `.`, `..`, nor contains
/// a path separator or a NUL byte.
pub fn ensure_safe_component(name: &str) -> anyhow::Result<()> {
    if name.is_empty()
        || name == "."
        || name == ".."
        || name.contains('/')
        || name.contains('\\')
        || name.contains('\0')
    {
        anyhow::bail!("nom d'entrée invalide ou potentiellement malveillant : {name:?}");
    }
    Ok(())
}

/// Joins a remote POSIX path with a child segment (`..` navigates up).
pub fn join(base: &str, segment: &str) -> String {
    if segment == ".." {
        let trimmed = base.trim_end_matches('/');
        return match trimmed.rfind('/') {
            Some(0) => "/".to_string(),
            Some(idx) => trimmed[..idx].to_string(),
            None => "/".to_string(),
        };
    }
    if base.ends_with('/') {
        format!("{base}{segment}")
    } else {
        format!("{base}/{segment}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_traversal_and_separators() {
        for bad in [
            "", ".", "..", "../etc", "a/b", "a\\b", "/abs", "sub/../x", "x\0y",
        ] {
            assert!(
                ensure_safe_component(bad).is_err(),
                "server-supplied name {bad:?} must be rejected"
            );
        }
    }

    #[test]
    fn accepts_plain_filenames() {
        for ok in ["file.txt", "my dir", ".bashrc", "a.b.c", "café.md", "..."] {
            assert!(
                ensure_safe_component(ok).is_ok(),
                "ordinary filename {ok:?} must be accepted"
            );
        }
    }
}
