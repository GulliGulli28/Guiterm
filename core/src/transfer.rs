//! Generic local/remote file transfer helpers shared by any UI: copying
//! between two arbitrary "panes" (local filesystem or an open SFTP session),
//! including the remote-to-remote case which SFTP can't do directly.
use crate::local_fs;
use crate::sftp::{self, Entry, SftpClient};
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

/// Copies between two already-open panes never support mid-transfer cancellation
/// (only OS drag-and-drop uploads/downloads do) — a flag that's never set.
fn never_cancel() -> AtomicBool {
    AtomicBool::new(false)
}

#[derive(Clone)]
pub enum PaneRef {
    Local,
    Remote(Arc<SftpClient>),
}

pub async fn list(pane: &PaneRef, path: &str) -> anyhow::Result<Vec<Entry>> {
    match pane {
        PaneRef::Local => local_fs::list(path),
        PaneRef::Remote(client) => client.list(path).await,
    }
}

pub async fn mkdir(pane: &PaneRef, cwd: &str, name: &str) -> anyhow::Result<()> {
    let path = sftp::join(cwd, name);
    match pane {
        PaneRef::Local => Ok(tokio::fs::create_dir(&path).await?),
        PaneRef::Remote(client) => client.make_dir(&path).await,
    }
}

pub async fn rename(pane: &PaneRef, cwd: &str, old_name: &str, new_name: &str) -> anyhow::Result<()> {
    let from = sftp::join(cwd, old_name);
    let to = sftp::join(cwd, new_name);
    match pane {
        PaneRef::Local => Ok(tokio::fs::rename(&from, &to).await?),
        PaneRef::Remote(client) => client.rename(&from, &to).await,
    }
}

pub async fn set_permissions(pane: &PaneRef, cwd: &str, name: &str, mode: u32) -> anyhow::Result<()> {
    match pane {
        PaneRef::Local => anyhow::bail!("le changement de permissions n'est pas pris en charge pour le système de fichiers local"),
        PaneRef::Remote(client) => client.set_permissions(&sftp::join(cwd, name), mode).await,
    }
}

/// Reads a file's whole content as text, for quick in-place editing.
pub async fn read_text(pane: &PaneRef, cwd: &str, name: &str) -> anyhow::Result<String> {
    let path = sftp::join(cwd, name);
    match pane {
        PaneRef::Local => Ok(tokio::fs::read_to_string(&path).await?),
        PaneRef::Remote(client) => client.read_to_string(&path).await,
    }
}

/// Overwrites a file's whole content, for quick in-place editing.
pub async fn write_text(pane: &PaneRef, cwd: &str, name: &str, content: &str) -> anyhow::Result<()> {
    let path = sftp::join(cwd, name);
    match pane {
        PaneRef::Local => Ok(tokio::fs::write(&path, content).await?),
        PaneRef::Remote(client) => client.write_string(&path, content).await,
    }
}

/// Deletes `entry` (file or directory, recursively) from `cwd` on `pane`.
pub async fn remove(pane: &PaneRef, cwd: &str, entry: &Entry) -> anyhow::Result<()> {
    let path = sftp::join(cwd, &entry.name);
    match (pane, entry.is_dir) {
        (PaneRef::Local, false) => Ok(tokio::fs::remove_file(&path).await?),
        (PaneRef::Local, true) => Ok(tokio::fs::remove_dir_all(&path).await?),
        (PaneRef::Remote(client), false) => client.remove_file(&path).await,
        (PaneRef::Remote(client), true) => remove_remote_dir_recursive(client, &path).await,
    }
}

/// SFTP's `remove_dir` (like POSIX `rmdir`) only removes empty directories,
/// so a recursive delete has to walk the tree itself.
fn remove_remote_dir_recursive<'a>(client: &'a SftpClient, path: &'a str) -> std::pin::Pin<Box<dyn std::future::Future<Output = anyhow::Result<()>> + Send + 'a>> {
    Box::pin(async move {
        for child in client.list(path).await? {
            let child_path = sftp::join(path, &child.name);
            if child.is_dir {
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
pub async fn copy_entry(source: &PaneRef, source_cwd: &str, entry: &Entry, dest: &PaneRef, dest_cwd: &str) -> anyhow::Result<()> {
    if entry.is_dir {
        return copy_dir(source, source_cwd, &entry.name, dest, dest_cwd).await;
    }
    match (source, dest) {
        (PaneRef::Local, PaneRef::Local) => {
            let src = sftp::join(source_cwd, &entry.name);
            let dst = sftp::join(dest_cwd, &entry.name);
            tokio::fs::copy(src, dst).await?;
            Ok(())
        },
        (PaneRef::Local, PaneRef::Remote(dst_client)) => {
            let local = std::path::PathBuf::from(sftp::join(source_cwd, &entry.name));
            let remote = sftp::join(dest_cwd, &entry.name);
            dst_client.upload(&local, &remote, &never_cancel(), |_, _| {}).await
        },
        (PaneRef::Remote(src_client), PaneRef::Local) => {
            let remote = sftp::join(source_cwd, &entry.name);
            let local = std::path::PathBuf::from(sftp::join(dest_cwd, &entry.name));
            src_client.download(&remote, &local, entry.size, &never_cancel(), |_, _| {}).await
        },
        (PaneRef::Remote(src_client), PaneRef::Remote(dst_client)) => {
            copy_remote_to_remote_file(src_client, source_cwd, &entry.name, entry.size, dst_client, dest_cwd).await
        },
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
            if child.is_dir {
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
                        dc.upload(&local, &remote, &never_cancel(), |_, _| {}).await?;
                    }
                    (PaneRef::Remote(sc), PaneRef::Local) => {
                        let remote = sftp::join(&src_path, &child.name);
                        let local = std::path::PathBuf::from(sftp::join(&dst_path, &child.name));
                        sc.download(&remote, &local, child.size, &never_cancel(), |_, _| {}).await?;
                    }
                    (PaneRef::Remote(sc), PaneRef::Remote(dc)) => {
                        copy_remote_to_remote_file(sc, &src_path, &child.name, child.size, dc, &dst_path).await?;
                    }
                }
            }
        }
        Ok(())
    })
}

/// SFTP has no server-to-server copy, so a remote-to-remote transfer is
/// relayed through a temporary local file, same as WinSCP/Termius do.
async fn copy_remote_to_remote_file(src: &SftpClient, source_cwd: &str, name: &str, size: u64, dst: &SftpClient, dest_cwd: &str) -> anyhow::Result<()> {
    let tmp = std::env::temp_dir().join(format!("gui-termius-transfer-{}", uuid::Uuid::new_v4()));
    let remote_src = sftp::join(source_cwd, name);
    src.download(&remote_src, &tmp, size, &never_cancel(), |_, _| {}).await?;
    let remote_dst = sftp::join(dest_cwd, name);
    let upload_result = dst.upload(&tmp, &remote_dst, &never_cancel(), |_, _| {}).await;
    let _ = tokio::fs::remove_file(&tmp).await;
    upload_result
}
