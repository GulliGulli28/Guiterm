//! Generic local/remote file transfer helpers shared by any UI: copying
//! between two arbitrary "panes" (local filesystem or an open SFTP session),
//! including the remote-to-remote case which SFTP can't do directly.
use crate::local_fs;
use crate::sftp::{self, Entry, RemoteFileClient};
use std::sync::Arc;
use std::sync::atomic::AtomicBool;

/// Copies between two already-open panes never support mid-transfer cancellation
/// (only OS drag-and-drop uploads/downloads do) — a flag that's never set.
fn never_cancel() -> AtomicBool {
    AtomicBool::new(false)
}

/// No-op progress sink for the copy paths below, none of which surface
/// per-chunk progress to the UI (only OS drag-and-drop uploads do, via
/// `commands/sftp.rs::upload_one`) — a plain function rather than a closure
/// literal at each call site, since [`RemoteFileClient`]'s `download`/
/// `upload` need `&mut (dyn FnMut(u64, u64) + Send)`, not `impl FnMut`
/// (trait methods with a generic parameter aren't object-safe, and
/// [`PaneRef::Remote`] holds its client behind `Arc<dyn RemoteFileClient>`).
fn no_progress(_done: u64, _total: u64) {}

#[derive(Clone)]
pub enum PaneRef {
    Local,
    Remote(Arc<dyn RemoteFileClient>),
}

pub async fn list(pane: &PaneRef, path: &str) -> anyhow::Result<Vec<Entry>> {
    match pane {
        PaneRef::Local => local_fs::list(path),
        PaneRef::Remote(client) => client.list(path).await,
    }
}

pub async fn mkdir(pane: &PaneRef, cwd: &str, name: &str) -> anyhow::Result<()> {
    sftp::ensure_safe_component(name)?;
    let path = sftp::join(cwd, name);
    match pane {
        PaneRef::Local => Ok(tokio::fs::create_dir(&path).await?),
        PaneRef::Remote(client) => client.make_dir(&path).await,
    }
}

pub async fn rename(
    pane: &PaneRef,
    cwd: &str,
    old_name: &str,
    new_name: &str,
) -> anyhow::Result<()> {
    sftp::ensure_safe_component(old_name)?;
    sftp::ensure_safe_component(new_name)?;
    let from = sftp::join(cwd, old_name);
    let to = sftp::join(cwd, new_name);
    match pane {
        PaneRef::Local => Ok(tokio::fs::rename(&from, &to).await?),
        PaneRef::Remote(client) => client.rename(&from, &to).await,
    }
}

pub async fn set_permissions(
    pane: &PaneRef,
    cwd: &str,
    name: &str,
    mode: u32,
) -> anyhow::Result<()> {
    sftp::ensure_safe_component(name)?;
    match pane {
        PaneRef::Local => anyhow::bail!(
            "le changement de permissions n'est pas pris en charge pour le système de fichiers local"
        ),
        PaneRef::Remote(client) => client.set_permissions(&sftp::join(cwd, name), mode).await,
    }
}

/// Reads a file's whole content as text, for quick in-place editing.
pub async fn read_text(pane: &PaneRef, cwd: &str, name: &str) -> anyhow::Result<String> {
    sftp::ensure_safe_component(name)?;
    let path = sftp::join(cwd, name);
    match pane {
        PaneRef::Local => {
            let len = tokio::fs::metadata(&path).await?.len();
            if len > sftp::MAX_EDIT_BYTES {
                anyhow::bail!(
                    "fichier trop volumineux pour l'édition rapide (> {} Mo)",
                    sftp::MAX_EDIT_BYTES / (1024 * 1024)
                );
            }
            Ok(tokio::fs::read_to_string(&path).await?)
        }
        PaneRef::Remote(client) => client.read_to_string(&path).await,
    }
}

/// Overwrites a file's whole content, for quick in-place editing.
pub async fn write_text(
    pane: &PaneRef,
    cwd: &str,
    name: &str,
    content: &str,
) -> anyhow::Result<()> {
    sftp::ensure_safe_component(name)?;
    let path = sftp::join(cwd, name);
    match pane {
        PaneRef::Local => Ok(tokio::fs::write(&path, content).await?),
        PaneRef::Remote(client) => client.write_string(&path, content).await,
    }
}

/// Deletes `entry` (file or directory, recursively) from `cwd` on `pane`.
pub async fn remove(pane: &PaneRef, cwd: &str, entry: &Entry) -> anyhow::Result<()> {
    sftp::ensure_safe_component(&entry.name)?;
    let path = sftp::join(cwd, &entry.name);
    // A symlink is unlinked directly, never followed: descending into a
    // symlink-to-directory would delete the *target's* contents, which can live
    // entirely outside the tree being removed.
    let is_real_dir = entry.is_dir && !entry.is_symlink;
    match (pane, is_real_dir) {
        (PaneRef::Local, false) => Ok(tokio::fs::remove_file(&path).await?),
        (PaneRef::Local, true) => Ok(tokio::fs::remove_dir_all(&path).await?),
        (PaneRef::Remote(client), false) => client.remove_file(&path).await,
        (PaneRef::Remote(client), true) => remove_remote_dir_recursive(client.as_ref(), &path).await,
    }
}

/// SFTP's `remove_dir` (like POSIX `rmdir`) only removes empty directories,
/// so a recursive delete has to walk the tree itself.
fn remove_remote_dir_recursive<'a>(
    client: &'a dyn RemoteFileClient,
    path: &'a str,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = anyhow::Result<()>> + Send + 'a>> {
    Box::pin(async move {
        for child in client.list(path).await? {
            let child_path = sftp::join(path, &child.name);
            // Don't recurse through a symlinked directory — unlink the link itself.
            if child.is_dir && !child.is_symlink {
                remove_remote_dir_recursive(client, &child_path).await?;
            } else {
                client.remove_file(&child_path).await?;
            }
        }
        client.remove_dir(path).await
    })
}

/// Copies `entry` (file or directory) from `source_cwd` on `source` into `dest_cwd` on `dest`.
/// Directories are copied recursively.
pub async fn copy_entry(
    source: &PaneRef,
    source_cwd: &str,
    entry: &Entry,
    dest: &PaneRef,
    dest_cwd: &str,
) -> anyhow::Result<()> {
    sftp::ensure_safe_component(&entry.name)?;
    // A symlink is copied as-is (its target's content for a file), never
    // descended into: following a symlink-to-directory would recurse into a tree
    // that may live entirely outside what the user asked to copy.
    if entry.is_dir && !entry.is_symlink {
        return copy_dir(source, source_cwd, &entry.name, dest, dest_cwd).await;
    }
    match (source, dest) {
        (PaneRef::Local, PaneRef::Local) => {
            let src = sftp::join(source_cwd, &entry.name);
            let dst = sftp::join(dest_cwd, &entry.name);
            tokio::fs::copy(src, dst).await?;
            Ok(())
        }
        (PaneRef::Local, PaneRef::Remote(dst_client)) => {
            let local = std::path::PathBuf::from(sftp::join(source_cwd, &entry.name));
            let remote = sftp::join(dest_cwd, &entry.name);
            dst_client
                .upload(&local, &remote, &never_cancel(), &mut no_progress)
                .await
        }
        (PaneRef::Remote(src_client), PaneRef::Local) => {
            let remote = sftp::join(source_cwd, &entry.name);
            let local = std::path::PathBuf::from(sftp::join(dest_cwd, &entry.name));
            src_client
                .download(&remote, &local, entry.size, &never_cancel(), &mut no_progress)
                .await
        }
        (PaneRef::Remote(src_client), PaneRef::Remote(dst_client)) => {
            copy_remote_to_remote_file(
                src_client.as_ref(),
                source_cwd,
                &entry.name,
                entry.size,
                dst_client.as_ref(),
                dest_cwd,
            )
            .await
        }
    }
}

fn copy_dir<'a>(
    source: &'a PaneRef,
    source_dir: &'a str,
    name: &'a str,
    dest: &'a PaneRef,
    dest_dir: &'a str,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = anyhow::Result<()>> + Send + 'a>> {
    Box::pin(async move {
        sftp::ensure_safe_component(name)?;
        let src_path = sftp::join(source_dir, name);
        let dst_path = sftp::join(dest_dir, name);

        // Create destination directory
        match dest {
            PaneRef::Local => {
                tokio::fs::create_dir_all(&dst_path).await?;
            }
            PaneRef::Remote(client) => {
                client.make_dir(&dst_path).await?;
            }
        }

        // List source directory
        let entries = match source {
            PaneRef::Local => local_fs::list(&src_path)?,
            PaneRef::Remote(client) => client.list(&src_path).await?,
        };

        for child in entries {
            sftp::ensure_safe_component(&child.name)?;
            // Don't descend into a symlinked directory (see `copy_entry`).
            if child.is_dir && !child.is_symlink {
                copy_dir(source, &src_path, &child.name, dest, &dst_path).await?;
            } else {
                match (source, dest) {
                    (PaneRef::Local, PaneRef::Local) => {
                        let s = sftp::join(&src_path, &child.name);
                        let d = sftp::join(&dst_path, &child.name);
                        tokio::fs::copy(s, d).await?;
                    }
                    (PaneRef::Local, PaneRef::Remote(dc)) => {
                        let local = std::path::PathBuf::from(sftp::join(&src_path, &child.name));
                        let remote = sftp::join(&dst_path, &child.name);
                        dc.upload(&local, &remote, &never_cancel(), &mut no_progress)
                            .await?;
                    }
                    (PaneRef::Remote(sc), PaneRef::Local) => {
                        let remote = sftp::join(&src_path, &child.name);
                        let local = std::path::PathBuf::from(sftp::join(&dst_path, &child.name));
                        sc.download(&remote, &local, child.size, &never_cancel(), &mut no_progress)
                            .await?;
                    }
                    (PaneRef::Remote(sc), PaneRef::Remote(dc)) => {
                        copy_remote_to_remote_file(
                            sc.as_ref(),
                            &src_path,
                            &child.name,
                            child.size,
                            dc.as_ref(),
                            &dst_path,
                        )
                        .await?;
                    }
                }
            }
        }
        Ok(())
    })
}

/// SFTP has no server-to-server copy, so a remote-to-remote transfer is
/// relayed through a temporary local file, same as WinSCP/Termius do.
async fn copy_remote_to_remote_file(
    src: &dyn RemoteFileClient,
    source_cwd: &str,
    name: &str,
    size: u64,
    dst: &dyn RemoteFileClient,
    dest_cwd: &str,
) -> anyhow::Result<()> {
    let tmp = download_client_to_fresh_temp(src, source_cwd, name, size).await?;
    let remote_dst = sftp::join(dest_cwd, name);
    let upload_result = dst
        .upload(&tmp, &remote_dst, &never_cancel(), &mut no_progress)
        .await;
    let _ = tokio::fs::remove_file(&tmp).await;
    upload_result
}

async fn download_client_to_fresh_temp(
    client: &dyn RemoteFileClient,
    cwd: &str,
    name: &str,
    size: u64,
) -> anyhow::Result<std::path::PathBuf> {
    let tmp = std::env::temp_dir().join(format!("gui-termius-transfer-{}", uuid::Uuid::new_v4()));
    // Pre-create the relay file 0600 so the copied bytes are never briefly
    // world-readable in a shared /tmp; `download`'s `File::create` truncates it
    // but preserves this owner-only mode on an existing file.
    crate::secure_file::create_private(&tmp)?;
    let remote = sftp::join(cwd, name);
    client.download(&remote, &tmp, size, &never_cancel(), &mut no_progress).await?;
    Ok(tmp)
}

/// Resolves `entry` (from `source_cwd` on `pane`) to a real local
/// filesystem path — for [`PaneRef::Local`], that's just its existing path,
/// no copy made; for a remote pane, the entry is downloaded into a fresh,
/// private temp file first (never cleaned up automatically — the caller
/// doesn't know when it's safe to, e.g. once pushed onto an RDP session's
/// clipboard the file may be "pasted" from at any later, unpredictable
/// time). Used by `commands::rdp_view`'s "drag an entry onto the RDP view"
/// flow: CLIPRDR's `FileContentsRequest` is answered by a synchronous,
/// `.await`-less callback deep inside the protocol engine (see
/// `rdp-sidecar/src/clipboard.rs`), so by the time that callback can fire,
/// the bytes already have to be sitting in a real local file — an SFTP/
/// Docker fetch can't happen lazily on demand the way it does for a normal
/// pane-to-pane copy.
pub async fn resolve_local_path(pane: &PaneRef, source_cwd: &str, entry: &Entry) -> anyhow::Result<std::path::PathBuf> {
    match pane {
        PaneRef::Local => Ok(std::path::PathBuf::from(sftp::join(source_cwd, &entry.name))),
        PaneRef::Remote(client) => download_client_to_fresh_temp(client.as_ref(), source_cwd, &entry.name, entry.size).await,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn read_text_local_rejects_oversized_file() {
        let dir = tempfile::tempdir().unwrap();
        tokio::fs::write(
            dir.path().join("big.txt"),
            vec![b'a'; (sftp::MAX_EDIT_BYTES + 1) as usize],
        )
        .await
        .unwrap();
        let cwd = dir.path().to_string_lossy().to_string();
        assert!(
            read_text(&PaneRef::Local, &cwd, "big.txt").await.is_err(),
            "a file larger than the quick-edit cap must be refused, not loaded into memory"
        );
    }

    #[tokio::test]
    async fn read_text_local_reads_a_small_file() {
        let dir = tempfile::tempdir().unwrap();
        tokio::fs::write(dir.path().join("small.txt"), b"bonjour")
            .await
            .unwrap();
        let cwd = dir.path().to_string_lossy().to_string();
        let content = read_text(&PaneRef::Local, &cwd, "small.txt").await.unwrap();
        assert_eq!(content, "bonjour");
    }
}
