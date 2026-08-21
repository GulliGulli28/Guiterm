//! Generic local/remote file transfer helpers shared by any UI: copying
//! between two arbitrary "panes" (local filesystem or an open SFTP session),
//! including the remote-to-remote case which SFTP can't do directly.
use crate::local_fs;
use crate::sftp::{self, Entry, RemoteFileClient};
use std::sync::Arc;
use std::sync::atomic::AtomicBool;

/// Les chemins qui ne rapportent rien : la résolution d'une entrée en fichier
/// local temporaire pour le presse-papiers RDP, et le relais des copies
/// distant→distant. Le suivi d'une copie demandée par l'utilisateur passe,
/// lui, par [`CopyProgress`].
fn never_cancel() -> AtomicBool {
    AtomicBool::new(false)
}

/// Puits de progression vide — une fonction nommée plutôt qu'une fermeture
/// littérale à chaque appel, puisque `download`/`upload` de
/// [`RemoteFileClient`] veulent `&mut (dyn FnMut(u64, u64) + Send)` et non
/// `impl FnMut` (une méthode de trait générique n'est pas objet-sûre, et
/// [`PaneRef::Remote`] tient son client derrière `Arc<dyn RemoteFileClient>`).
fn no_progress(_done: u64, _total: u64) {}

/// Suivi d'une copie entre panneaux : de quoi l'arrêter en route, et de quoi
/// dire où elle en est.
///
/// Copier 4 Go d'un hôte à l'autre n'affichait rien et ne s'interrompait pas :
/// toutes les copies passaient un drapeau d'annulation jamais levé et un puits
/// de progression vide. Le total est cumulatif sur **tout le lot** (et non
/// remis à zéro à chaque fichier), pour que la barre avance une fois du début
/// à la fin plutôt que de repartir en arrière à chaque nouveau fichier.
pub struct CopyProgress<'a> {
    pub cancel: &'a AtomicBool,
    /// `(octets copiés depuis le début du lot, chemin du fichier en cours)`.
    pub report: &'a mut (dyn FnMut(u64, &str) + Send),
    /// Octets déjà comptés pour les fichiers terminés.
    pub done: u64,
}

impl CopyProgress<'_> {
    fn cancelled(&self) -> bool {
        self.cancel.load(std::sync::atomic::Ordering::Relaxed)
    }

    /// Vérifie l'annulation avant d'entamer une nouvelle entrée : les copies
    /// locales (`tokio::fs::copy`) et les créations de dossier n'ont pas de
    /// point d'interruption interne, contrairement aux transferts en morceaux.
    fn check_cancelled(&self) -> anyhow::Result<()> {
        if self.cancelled() {
            anyhow::bail!("transfert annulé");
        }
        Ok(())
    }

    fn finished_file(&mut self, size: u64, path: &str) {
        self.done += size;
        (self.report)(self.done, path);
    }
}

#[derive(Clone)]
pub enum PaneRef {
    Local,
    Remote(Arc<dyn RemoteFileClient>),
}

pub async fn list(pane: &PaneRef, path: &str) -> anyhow::Result<Vec<Entry>> {
    match pane {
        // local_fs::list does synchronous std::fs I/O — run it off the tokio
        // worker thread so a large/slow (network-mounted, AV-scanned) directory
        // doesn't stall other async work sharing that thread.
        PaneRef::Local => {
            let path = path.to_string();
            tokio::task::spawn_blocking(move || local_fs::list(&path)).await?
        }
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
    progress: &mut CopyProgress<'_>,
) -> anyhow::Result<()> {
    sftp::ensure_safe_component(&entry.name)?;
    progress.check_cancelled()?;
    // A symlink is copied as-is (its target's content for a file), never
    // descended into: following a symlink-to-directory would recurse into a tree
    // that may live entirely outside what the user asked to copy.
    if entry.is_dir && !entry.is_symlink {
        return copy_dir(source, source_cwd, &entry.name, dest, dest_cwd, progress).await;
    }
    copy_file(source, source_cwd, entry, dest, dest_cwd, progress).await
}

/// Un fichier (ou un lien symbolique, copié tel quel), avec report de
/// progression cumulatif — le seul endroit qui parle aux quatre combinaisons
/// local/distant, appelé aussi bien pour une entrée choisie que pour chaque
/// fichier d'une arborescence.
async fn copy_file(
    source: &PaneRef,
    source_cwd: &str,
    entry: &Entry,
    dest: &PaneRef,
    dest_cwd: &str,
    progress: &mut CopyProgress<'_>,
) -> anyhow::Result<()> {
    progress.check_cancelled()?;
    let relative = sftp::join(source_cwd, &entry.name);
    let base = progress.done;
    let result = match (source, dest) {
        (PaneRef::Local, PaneRef::Local) => {
            let src = sftp::join(source_cwd, &entry.name);
            let dst = sftp::join(dest_cwd, &entry.name);
            tokio::fs::copy(src, dst).await.map(|_| ()).map_err(anyhow::Error::from)
        }
        (PaneRef::Local, PaneRef::Remote(dst_client)) => {
            let local = std::path::PathBuf::from(sftp::join(source_cwd, &entry.name));
            let remote = sftp::join(dest_cwd, &entry.name);
            let report = &mut *progress.report;
            let mut on_progress = |done: u64, _total: u64| report(base + done, &relative);
            dst_client
                .upload(&local, &remote, progress.cancel, &mut on_progress)
                .await
        }
        (PaneRef::Remote(src_client), PaneRef::Local) => {
            let remote = sftp::join(source_cwd, &entry.name);
            let local = std::path::PathBuf::from(sftp::join(dest_cwd, &entry.name));
            let report = &mut *progress.report;
            let mut on_progress = |done: u64, _total: u64| report(base + done, &relative);
            src_client
                .download(&remote, &local, entry.size, progress.cancel, &mut on_progress)
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
    };
    result?;
    progress.finished_file(entry.size, &relative);
    Ok(())
}

fn copy_dir<'a>(
    source: &'a PaneRef,
    source_dir: &'a str,
    name: &'a str,
    dest: &'a PaneRef,
    dest_dir: &'a str,
    progress: &'a mut CopyProgress<'_>,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = anyhow::Result<()>> + Send + 'a>> {
    Box::pin(async move {
        sftp::ensure_safe_component(name)?;
        progress.check_cancelled()?;
        let src_path = sftp::join(source_dir, name);
        let dst_path = sftp::join(dest_dir, name);

        // Le dossier de destination peut déjà exister — recopier par-dessus
        // une arborescence déjà là est une fusion, pas une erreur. `mkdir`
        // d'un dossier existant échoue en SFTP (là où `create_dir_all` local
        // ne dit rien), ce qui faisait échouer toute la copie.
        match dest {
            PaneRef::Local => {
                tokio::fs::create_dir_all(&dst_path).await?;
            }
            PaneRef::Remote(client) => {
                if client.make_dir(&dst_path).await.is_err() && client.list(&dst_path).await.is_err() {
                    anyhow::bail!("impossible de créer le dossier de destination {dst_path}");
                }
            }
        }

        // List source directory
        let entries = match source {
            // Same reasoning as `list()` above: local_fs::list does
            // synchronous std::fs I/O, keep it off the tokio worker thread.
            PaneRef::Local => {
                let src_path = src_path.clone();
                tokio::task::spawn_blocking(move || local_fs::list(&src_path)).await??
            }
            PaneRef::Remote(client) => client.list(&src_path).await?,
        };

        for child in entries {
            sftp::ensure_safe_component(&child.name)?;
            progress.check_cancelled()?;
            // Don't descend into a symlinked directory (see `copy_entry`).
            if child.is_dir && !child.is_symlink {
                copy_dir(source, &src_path, &child.name, dest, &dst_path, progress).await?;
            } else {
                copy_file(source, &src_path, &child, dest, &dst_path, progress).await?;
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
    let tmp = std::env::temp_dir().join(format!("guiterm-transfer-{}", uuid::Uuid::new_v4()));
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

    fn entry(name: &str, is_dir: bool, size: u64) -> Entry {
        Entry { name: name.to_string(), is_dir, is_symlink: false, size, modified: None, permissions: None }
    }

    /// Un arbre `projet/` : un fichier à la racine, un dans un sous-dossier.
    fn tree() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("projet/sous")).unwrap();
        std::fs::write(dir.path().join("projet/a.bin"), vec![0u8; 1000]).unwrap();
        std::fs::write(dir.path().join("projet/sous/b.bin"), vec![0u8; 2000]).unwrap();
        std::fs::create_dir(dir.path().join("cible")).unwrap();
        dir
    }

    /// Ce que la barre de progression montre : un total qui monte une seule
    /// fois du début à la fin du lot. Avant, chaque fichier repartait de zéro
    /// — ou plutôt : rien n'était rapporté du tout.
    #[tokio::test]
    async fn copy_reports_one_cumulative_total_across_a_whole_tree() {
        let dir = tree();
        let source_cwd = dir.path().to_string_lossy().to_string();
        let dest_cwd = dir.path().join("cible").to_string_lossy().to_string();

        let cancel = AtomicBool::new(false);
        let mut seen: Vec<(u64, String)> = Vec::new();
        {
            let mut report = |done: u64, path: &str| seen.push((done, path.to_string()));
            let mut progress = CopyProgress { cancel: &cancel, report: &mut report, done: 0 };
            copy_entry(&PaneRef::Local, &source_cwd, &entry("projet", true, 4096), &PaneRef::Local, &dest_cwd, &mut progress)
                .await
                .unwrap();
            assert_eq!(progress.done, 3000, "le total porte sur tous les fichiers de l'arbre");
        }

        assert_eq!(seen.len(), 2, "un report par fichier terminé : {seen:?}");
        assert!(seen.windows(2).all(|w| w[0].0 < w[1].0), "le total ne redescend jamais : {seen:?}");
        assert_eq!(seen.last().unwrap().0, 3000);
        assert!(dir.path().join("cible/projet/sous/b.bin").exists(), "l'arbre est bien copié");
    }

    #[tokio::test]
    async fn a_cancelled_copy_stops_and_says_so() {
        let dir = tree();
        let source_cwd = dir.path().to_string_lossy().to_string();
        let dest_cwd = dir.path().join("cible").to_string_lossy().to_string();

        let cancel = AtomicBool::new(true);
        let mut report = |_done: u64, _path: &str| {};
        let mut progress = CopyProgress { cancel: &cancel, report: &mut report, done: 0 };
        let error = copy_entry(&PaneRef::Local, &source_cwd, &entry("projet", true, 4096), &PaneRef::Local, &dest_cwd, &mut progress)
            .await
            .unwrap_err()
            .to_string();
        assert!(error.contains("annulé"), "message français attendu : {error}");
        assert!(!dir.path().join("cible/projet/a.bin").exists(), "rien ne doit avoir été copié");
    }

    /// Recopier un dossier là où il est déjà est une fusion, pas une erreur.
    /// Localement ça marchait déjà ; côté SFTP le `mkdir` échouait sur un
    /// dossier existant et faisait échouer toute la copie.
    #[tokio::test]
    async fn copying_a_folder_twice_merges_instead_of_failing() {
        let dir = tree();
        let source_cwd = dir.path().to_string_lossy().to_string();
        let dest_cwd = dir.path().join("cible").to_string_lossy().to_string();
        let cancel = AtomicBool::new(false);

        for _ in 0..2 {
            let mut report = |_done: u64, _path: &str| {};
            let mut progress = CopyProgress { cancel: &cancel, report: &mut report, done: 0 };
            copy_entry(&PaneRef::Local, &source_cwd, &entry("projet", true, 4096), &PaneRef::Local, &dest_cwd, &mut progress)
                .await
                .expect("une deuxième copie au même endroit doit fusionner");
        }
    }

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
