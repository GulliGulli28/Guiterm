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

    /// Splits a POSIX remote path into its parent directory and final
    /// component — `upload_to_container`'s `path` option names a
    /// *directory* to extract into, so the tar's own entry only ever needs
    /// the bare filename, not the full path.
    fn split_parent_and_name(path: &str) -> anyhow::Result<(String, String)> {
        let trimmed = path.trim_end_matches('/');
        match trimmed.rfind('/') {
            Some(0) => Ok(("/".to_string(), trimmed[1..].to_string())),
            Some(idx) => Ok((trimmed[..idx].to_string(), trimmed[idx + 1..].to_string())),
            None => anyhow::bail!("chemin distant invalide : {path:?}"),
        }
    }

    async fn upload_bytes(&self, path: &str, content: &[u8]) -> anyhow::Result<()> {
        let (parent, name) = Self::split_parent_and_name(path)?;
        let tar_bytes = build_single_file_tar(&name, content)?;
        let opts = UploadToContainerOptionsBuilder::new().path(&parent).build();
        self.docker
            .upload_to_container(&self.container_id, Some(opts), bollard::body_full(tar_bytes.into()))
            .await?;
        Ok(())
    }
}

fn build_single_file_tar(name: &str, content: &[u8]) -> anyhow::Result<Vec<u8>> {
    let mut header = tar::Header::new_gnu();
    header.set_size(content.len() as u64);
    header.set_mode(0o644);
    header.set_mtime(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0));
    let mut builder = tar::Builder::new(Vec::new());
    builder.append_data(&mut header, name, content)?;
    Ok(builder.into_inner()?)
}

/// Extracts the first regular-file entry's content from a tar archive — the
/// container-archive endpoint's response for a single-file request has
/// exactly one meaningful entry (named by the requested path's basename, not
/// the full path), so there's nothing to match against by name.
fn extract_single_file(tar_bytes: &[u8]) -> anyhow::Result<Vec<u8>> {
    let mut archive = tar::Archive::new(std::io::Cursor::new(tar_bytes));
    for entry in archive.entries()? {
        let mut entry = entry?;
        if entry.header().entry_type().is_file() {
            let mut buf = Vec::new();
            std::io::Read::read_to_end(&mut entry, &mut buf)?;
            return Ok(buf);
        }
    }
    anyhow::bail!("archive vide ou fichier introuvable")
}

const LIST_SCRIPT: &str = r#"
cd -- "$1" || exit 1
ls -1a . | while IFS= read -r f; do
  [ "$f" = "." ] && continue
  [ "$f" = ".." ] && continue
  if [ -L "$f" ]; then sym=1; else sym=0; fi
  if [ -d "$f" ]; then isdir=1; else isdir=0; fi
  size=$(stat -c %s -- "$f" 2>/dev/null || echo 0)
  mtime=$(stat -c %Y -- "$f" 2>/dev/null || echo 0)
  perm=$(stat -c %a -- "$f" 2>/dev/null || echo "")
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$sym" "$isdir" "$size" "$mtime" "$perm" "$f"
done
"#;

/// Parses [`LIST_SCRIPT`]'s tab-delimited output. Splits each line into at
/// most 6 fields (`splitn`), so a filename containing a literal tab is still
/// captured intact in the final field rather than shifting every column
/// after it — a filename containing a literal newline still breaks parsing
/// (read line-by-line, same as a real terminal's `ls` would visually split
/// it), an accepted, rare edge case for what is inherently text-based
/// plumbing rather than a real framed protocol like SFTP.
fn parse_listing(output: &[u8]) -> Vec<Entry> {
    let text = String::from_utf8_lossy(output);
    let mut entries = Vec::new();
    for line in text.lines() {
        let mut parts = line.splitn(6, '\t');
        let (Some(sym), Some(isdir), Some(size), Some(mtime), Some(perm), Some(name)) =
            (parts.next(), parts.next(), parts.next(), parts.next(), parts.next(), parts.next())
        else {
            continue;
        };
        entries.push(Entry {
            name: name.to_string(),
            is_dir: isdir == "1",
            is_symlink: sym == "1",
            size: size.parse().unwrap_or(0),
            modified: mtime.parse().ok(),
            permissions: u32::from_str_radix(perm, 8).ok(),
        });
    }
    entries
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
        use tokio::io::AsyncReadExt;
        const CHUNK_SIZE: usize = 256 * 1024;
        let mut local_file = tokio::fs::File::open(local_path).await?;
        let total = local_file.metadata().await?.len();
        let mut content = Vec::with_capacity(total as usize);
        let mut buf = vec![0u8; CHUNK_SIZE];
        loop {
            if cancel.load(Ordering::Relaxed) {
                anyhow::bail!("transfert annulé");
            }
            let n = local_file.read(&mut buf).await?;
            if n == 0 {
                break;
            }
            content.extend_from_slice(&buf[..n]);
            on_progress(content.len() as u64, total);
        }
        self.upload_bytes(remote_path, &content).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_listing_line_per_entry() {
        let out = b"0\t1\t4096\t1700000000\t755\tsub\n1\t0\t0\t1700000001\t777\tlink -> target\n0\t0\t12\t1700000002\t644\tnotes.txt\n";
        let entries = parse_listing(out);
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0].name, "sub");
        assert!(entries[0].is_dir);
        assert!(!entries[0].is_symlink);
        assert_eq!(entries[0].permissions, Some(0o755));
        assert_eq!(entries[1].name, "link -> target");
        assert!(entries[1].is_symlink);
        assert_eq!(entries[2].size, 12);
        assert_eq!(entries[2].modified, Some(1_700_000_002));
    }

    #[test]
    fn tolerates_a_tab_inside_the_filename() {
        // Only the first 5 fields are ever split off; whatever remains
        // (including further tabs) is the name verbatim.
        let out = b"0\t0\t1\t1700000000\t644\tweird\tname.txt\n";
        let entries = parse_listing(out);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].name, "weird\tname.txt");
    }

    #[test]
    fn ignores_malformed_lines() {
        let out = b"not enough fields\n0\t0\t1\t1700000000\t644\tok.txt\n";
        let entries = parse_listing(out);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].name, "ok.txt");
    }

    #[test]
    fn splits_parent_and_name() {
        assert_eq!(DockerPaneClient::split_parent_and_name("/etc/hosts").unwrap(), ("/etc".to_string(), "hosts".to_string()));
        assert_eq!(DockerPaneClient::split_parent_and_name("/notes.txt").unwrap(), ("/".to_string(), "notes.txt".to_string()));
        assert!(DockerPaneClient::split_parent_and_name("no-slash").is_err());
    }

    #[test]
    fn tar_roundtrips_a_single_file() {
        let tar_bytes = build_single_file_tar("hello.txt", b"bonjour").unwrap();
        let extracted = extract_single_file(&tar_bytes).unwrap();
        assert_eq!(extracted, b"bonjour");
    }
}
