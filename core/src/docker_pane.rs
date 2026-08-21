//! A Docker container's filesystem as one side of a transfer pane
//! ([`crate::sftp::RemoteFileClient`], driven generically by
//! `crate::transfer`) — there's no SFTP-equivalent subsystem for `docker
//! exec`, so this is built on two different Docker Engine API surfaces
//! instead of one real protocol:
//!
//! - **Metadata operations** (list/mkdir/rename/remove/chmod) shell out to
//!   the container's own `sh`/coreutils via a non-interactive `exec`
//!   ([`crate::docker::exec_capture`]) — mirroring the portability care
//!   `docker::open_exec` already takes (`command -v` before `exec`ing a
//!   shell) since there's no other way to get this information out of an
//!   arbitrary container. A container with no POSIX shell at all (`FROM
//!   scratch`, distroless) can't be browsed this way.
//! - **File content** (read/write/upload/download) uses the container
//!   *archive* endpoints (`GET`/`PUT /containers/{id}/archive`, tar
//!   streams) — `bollard::Docker::download_from_container`/
//!   `upload_to_container`, unused elsewhere in this codebase before this.
//!
//! **Known limitation, accepted for a first version**: unlike SFTP's
//! genuinely chunked transfer, both directions here buffer the whole file
//! (wrapped in a one-entry tar) in memory before/after the Engine API call —
//! fine for ordinary config/source files, risky for multi-gigabyte ones.
//! Progress reporting is real for `download` (the tar stream arrives in
//! chunks) but only approximate for `upload` (reported while reading the
//! local file into memory, not while it's actually in flight to the daemon).

use crate::docker::exec_capture;
use crate::remote_shell_pane::{LIST_SCRIPT, build_single_file_tar, extract_single_file, parse_listing, read_local_file_chunked, split_parent_and_name};
use crate::sftp::{Entry, MAX_EDIT_BYTES, RemoteFileClient};
use bollard::Docker;
use bollard::query_parameters::{DownloadFromContainerOptionsBuilder, UploadToContainerOptionsBuilder};
use futures_util::StreamExt;
use std::sync::atomic::{AtomicBool, Ordering};

pub struct DockerPaneClient {
    docker: Docker,
    container_id: String,
}

impl DockerPaneClient {
    pub fn new(docker: Docker, container_id: String) -> Self {
        Self { docker, container_id }
    }

    async fn run(&self, cmd: Vec<String>, stdin: Option<Vec<u8>>) -> anyhow::Result<Vec<u8>> {
        exec_capture(&self.docker, &self.container_id, cmd, stdin).await
    }

    /// Runs a `sh -c '<script>' sh <args...>` command, `args` passed as real
    /// positional parameters (`$1`, `$2`, ...) rather than interpolated into
    /// the script text — the untrusted part (a path, possibly server- or
    /// entry-name-derived) never touches shell quoting/escaping at all.
    async fn run_script(&self, script: &str, args: &[&str]) -> anyhow::Result<Vec<u8>> {
        let mut cmd = vec!["sh".to_string(), "-c".to_string(), script.to_string(), "sh".to_string()];
        cmd.extend(args.iter().map(|s| s.to_string()));
        self.run(cmd, None).await
    }

    /// Downloads the tar archive `GET /containers/{id}/archive?path=...`
    /// returns for a single file, capped at `cap` bytes (plus a small margin
    /// for tar header/padding overhead) — used by `read_to_string` to avoid
    /// pulling an arbitrarily large file fully into memory just to reject it
    /// for being too big. `on_chunk` is called with the running total as
    /// bytes arrive, for callers that want progress.
    async fn download_tar_capped(
        &self,
        path: &str,
        cap: Option<u64>,
        mut on_chunk: impl FnMut(u64),
    ) -> anyhow::Result<Vec<u8>> {
        const TAR_OVERHEAD_MARGIN: u64 = 16 * 1024;
        let opts = DownloadFromContainerOptionsBuilder::new().path(path).build();
        let mut stream = self.docker.download_from_container(&self.container_id, Some(opts));
        let mut buf = Vec::new();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk?;
            buf.extend_from_slice(&chunk);
            on_chunk(buf.len() as u64);
            if let Some(cap) = cap
                && buf.len() as u64 > cap + TAR_OVERHEAD_MARGIN
            {
                anyhow::bail!("fichier trop volumineux (> {} Mo)", cap / (1024 * 1024));
            }
        }
        Ok(buf)
    }

    async fn upload_bytes(&self, path: &str, content: &[u8]) -> anyhow::Result<()> {
        let (parent, name) = split_parent_and_name(path)?;
        let tar_bytes = build_single_file_tar(&name, content)?;
        let opts = UploadToContainerOptionsBuilder::new().path(&parent).build();
        self.docker
            .upload_to_container(&self.container_id, Some(opts), bollard::body_full(tar_bytes.into()))
            .await?;
        Ok(())
    }
}

/// La même `sh -c` que les opérations de fichiers ci-dessous, exposée à
/// `crate::pane_ops` : c'est ce qui permet à un « calculer la taille », une
/// recherche ou un archivage de s'exécuter DANS le conteneur au lieu de
/// rapatrier son arborescence entière.
#[async_trait::async_trait]
impl crate::pane_ops::ShellExec for DockerPaneClient {
    async fn run(&self, script: &str, args: &[&str]) -> anyhow::Result<String> {
        let out = self.run_script(script, args).await?;
        Ok(String::from_utf8_lossy(&out).into_owned())
    }
}

#[async_trait::async_trait]
impl RemoteFileClient for DockerPaneClient {
    async fn list(&self, path: &str) -> anyhow::Result<Vec<Entry>> {
        let out = self.run_script(LIST_SCRIPT, &[path]).await?;
        Ok(parse_listing(&out))
    }

    async fn make_dir(&self, path: &str) -> anyhow::Result<()> {
        self.run_script(r#"mkdir -- "$1""#, &[path]).await.map(|_| ())
    }

    async fn remove_file(&self, path: &str) -> anyhow::Result<()> {
        self.run_script(r#"rm -f -- "$1""#, &[path]).await.map(|_| ())
    }

    async fn remove_dir(&self, path: &str) -> anyhow::Result<()> {
        // POSIX `rmdir` semantics (empty directories only) — matches
        // `SftpClient::remove_dir`; `transfer::remove_remote_dir_recursive`
        // already walks and empties the tree before calling this.
        self.run_script(r#"rmdir -- "$1""#, &[path]).await.map(|_| ())
    }

    async fn rename(&self, from: &str, to: &str) -> anyhow::Result<()> {
        self.run_script(r#"mv -- "$1" "$2""#, &[from, to]).await.map(|_| ())
    }

    async fn set_permissions(&self, path: &str, mode: u32) -> anyhow::Result<()> {
        let mode_str = format!("{mode:o}");
        self.run_script(r#"chmod -- "$1" "$2""#, &[&mode_str, path]).await.map(|_| ())
    }

    async fn read_to_string(&self, path: &str) -> anyhow::Result<String> {
        let tar_bytes = self.download_tar_capped(path, Some(MAX_EDIT_BYTES), |_| {}).await?;
        let bytes = extract_single_file(&tar_bytes)?;
        if bytes.len() as u64 > MAX_EDIT_BYTES {
            anyhow::bail!("fichier trop volumineux pour l'édition rapide (> {} Mo)", MAX_EDIT_BYTES / (1024 * 1024));
        }
        String::from_utf8(bytes).map_err(|_| anyhow::anyhow!("le fichier n'est pas du texte UTF-8 valide"))
    }

    async fn write_string(&self, path: &str, content: &str) -> anyhow::Result<()> {
        self.upload_bytes(path, content.as_bytes()).await
    }

    async fn download(
        &self,
        remote_path: &str,
        local_path: &std::path::Path,
        total: u64,
        cancel: &AtomicBool,
        on_progress: &mut (dyn FnMut(u64, u64) + Send),
    ) -> anyhow::Result<()> {
        let cancelled = std::sync::atomic::AtomicBool::new(false);
        let tar_result = self
            .download_tar_capped(remote_path, None, |done| {
                if cancel.load(Ordering::Relaxed) {
                    cancelled.store(true, Ordering::Relaxed);
                }
                on_progress(done.min(total), total);
            })
            .await;
        if cancelled.load(Ordering::Relaxed) {
            anyhow::bail!("transfert annulé");
        }
        let tar_bytes = tar_result?;
        let bytes = extract_single_file(&tar_bytes)?;
        if let Err(e) = tokio::fs::write(local_path, &bytes).await {
            let _ = tokio::fs::remove_file(local_path).await;
            return Err(e.into());
        }
        Ok(())
    }

    async fn upload(
        &self,
        local_path: &std::path::Path,
        remote_path: &str,
        cancel: &AtomicBool,
        on_progress: &mut (dyn FnMut(u64, u64) + Send),
    ) -> anyhow::Result<()> {
        let content = read_local_file_chunked(local_path, cancel, on_progress).await?;
        self.upload_bytes(remote_path, &content).await
    }
}
