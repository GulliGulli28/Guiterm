//! A Kubernetes pod's filesystem as one side of a transfer pane
//! ([`crate::sftp::RemoteFileClient`]) — mirrors [`crate::docker_pane`], but
//! Kubernetes has no equivalent to Docker's dedicated container-archive
//! endpoints, so file content also goes through `exec` (running `tar` inside
//! the pod), the same approach `kubectl cp` itself uses client-side.
//!
//! **Known limitation, same spirit as `docker_pane`'s**: uploads and the
//! uncapped `download()` (real file transfers, not the quick-edit path)
//! still buffer the whole file in memory — fine for ordinary config/source
//! files, risky for multi-gigabyte ones. Unlike Docker's version, download
//! progress here isn't even approximate: [`crate::k8s::exec_capture`]
//! returns the whole captured tar archive at once (no partial-byte-count
//! stream to report from), so `on_progress` only ever fires once, at
//! completion. Upload progress remains approximate, same as Docker
//! (reported while reading the local file into memory, not while it's
//! actually in transit). The size-*capped* download path (`read_to_string`,
//! used for quick in-app editing) is the exception: [`exec_capped`] enforces
//! the cap incrementally while draining stdout, so an oversized file is
//! rejected without ever being fully buffered.

use crate::k8s::{exec_capped, exec_capture};
use crate::remote_shell_pane::{LIST_SCRIPT, SET_MTIME_SCRIPT, build_single_file_tar, extract_single_file, parse_listing, read_local_file_chunked, split_parent_and_name};
use crate::sftp::{Entry, MAX_EDIT_BYTES, RemoteFileClient};
use kube::Client;
use std::sync::atomic::{AtomicBool, Ordering};

pub struct K8sPaneClient {
    client: Client,
    namespace: String,
    pod_name: String,
    container: Option<String>,
}

impl K8sPaneClient {
    pub fn new(client: Client, namespace: String, pod_name: String, container: Option<String>) -> Self {
        Self { client, namespace, pod_name, container }
    }

    async fn run(&self, cmd: Vec<String>, stdin: Option<Vec<u8>>) -> anyhow::Result<Vec<u8>> {
        exec_capture(&self.client, &self.namespace, &self.pod_name, self.container.as_deref(), cmd, stdin).await
    }

    /// Runs a `sh -c '<script>' sh <args...>` command, `args` passed as real
    /// positional parameters (`$1`, `$2`, ...) rather than interpolated into
    /// the script text — same convention as `docker_pane`'s `run_script`,
    /// for the same reason (untrusted path segments never touch shell
    /// quoting/escaping of their own).
    async fn run_script(&self, script: &str, args: &[&str]) -> anyhow::Result<Vec<u8>> {
        let mut cmd = vec!["sh".to_string(), "-c".to_string(), script.to_string(), "sh".to_string()];
        cmd.extend(args.iter().map(|s| s.to_string()));
        self.run(cmd, None).await
    }

    /// Downloads `path` as a single-entry tar archive by running `tar cf -
    /// -C <parent> <name>` inside the pod and capturing stdout — the same
    /// tar shape Docker's container-archive endpoint returns, so
    /// [`crate::remote_shell_pane::extract_single_file`] reads it
    /// identically either way. `parent`/`name` are passed as real argv
    /// entries to `tar`, never interpolated into a shell string.
    ///
    /// When `cap` is set, the size limit is enforced incrementally (via
    /// [`exec_capped`]) rather than after buffering the whole archive —
    /// otherwise a huge file would still have to be fully received (twice,
    /// once here and once in `extract_single_file`) before being rejected
    /// for being too large, defeating the point of capping at all.
    async fn download_tar_capped(&self, path: &str, cap: Option<u64>) -> anyhow::Result<Vec<u8>> {
        const TAR_OVERHEAD_MARGIN: u64 = 16 * 1024;
        let (parent, name) = split_parent_and_name(path)?;
        let cmd = vec!["tar".to_string(), "cf".to_string(), "-".to_string(), "-C".to_string(), parent, name];
        match cap {
            Some(cap) => exec_capped(&self.client, &self.namespace, &self.pod_name, self.container.as_deref(), cmd, cap + TAR_OVERHEAD_MARGIN).await,
            None => self.run(cmd, None).await,
        }
    }

    /// Uploads `content` by piping a single-entry tar archive as stdin to
    /// `tar xf - -C <parent>` inside the pod — the write-side equivalent of
    /// [`download_tar_capped`].
    async fn upload_bytes(&self, path: &str, content: &[u8]) -> anyhow::Result<()> {
        let (parent, name) = split_parent_and_name(path)?;
        let tar_bytes = build_single_file_tar(&name, content)?;
        let cmd = vec!["tar".to_string(), "xf".to_string(), "-".to_string(), "-C".to_string(), parent];
        self.run(cmd, Some(tar_bytes)).await?;
        Ok(())
    }
}

/// Même rôle que l'implémentation jumelle de `docker_pane` : `crate::pane_ops`
/// lance `du`/`find`/`tar` dans le pod plutôt que d'en rapatrier l'arborescence.
#[async_trait::async_trait]
impl crate::pane_ops::ShellExec for K8sPaneClient {
    async fn run(&self, script: &str, args: &[&str]) -> anyhow::Result<String> {
        let out = self.run_script(script, args).await?;
        Ok(String::from_utf8_lossy(&out).into_owned())
    }
}

#[async_trait::async_trait]
impl RemoteFileClient for K8sPaneClient {
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
        // `docker_pane`'s and `SftpClient::remove_dir`'s;
        // `transfer::remove_remote_dir_recursive` already walks and empties
        // the tree before calling this.
        self.run_script(r#"rmdir -- "$1""#, &[path]).await.map(|_| ())
    }

    async fn rename(&self, from: &str, to: &str) -> anyhow::Result<()> {
        self.run_script(r#"mv -- "$1" "$2""#, &[from, to]).await.map(|_| ())
    }

    async fn set_permissions(&self, path: &str, mode: u32) -> anyhow::Result<()> {
        let mode_str = format!("{mode:o}");
        self.run_script(r#"chmod -- "$1" "$2""#, &[&mode_str, path]).await.map(|_| ())
    }

    async fn set_modified(&self, path: &str, mtime_secs: u64) -> anyhow::Result<()> {
        self.run_script(SET_MTIME_SCRIPT, &[path, &mtime_secs.to_string()]).await?;
        Ok(())
    }

    async fn read_to_string(&self, path: &str) -> anyhow::Result<String> {
        let tar_bytes = self.download_tar_capped(path, Some(MAX_EDIT_BYTES)).await?;
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
        if cancel.load(Ordering::Relaxed) {
            anyhow::bail!("transfert annulé");
        }
        let tar_bytes = self.download_tar_capped(remote_path, None).await?;
        if cancel.load(Ordering::Relaxed) {
            anyhow::bail!("transfert annulé");
        }
        let bytes = extract_single_file(&tar_bytes)?;
        on_progress(bytes.len() as u64, total);
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
