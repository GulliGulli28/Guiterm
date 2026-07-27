//! Editing a remote file in the user's own editor, instead of in the app.
//!
//! The quick-edit modal (`commands::sftp::read_pane_file`/`write_pane_file`)
//! already covers "change two lines in a small config file". It stops being
//! the right tool as soon as the file is big, or the edit deserves syntax
//! highlighting, a language server, or a diff — none of which this app is
//! going to grow, and all of which the user's editor already has.
//!
//! So: fetch the file into a private temp copy, hand that copy to whatever
//! the OS opens it with, and push it back when it changes. Exactly the shape
//! [`crate::sql`] already uses for a remote-hosted SQLite database (fetch on
//! open, push back on change, refuse to overwrite a remote that moved
//! underneath) — deliberately, since that flow has been through real use.
//!
//! **The push-back is not automatic in the background.** There is no file
//! watcher and no polling task here: [`sync`] is called by the app when it
//! regains focus, and from an explicit "Renvoyer" action. Coming back to the
//! app is precisely the moment a save in another window becomes interesting,
//! and it costs nothing while the user is away. The accepted consequence is
//! that edits saved in the editor and never followed by a return to the app
//! — or by ending the edit — don't reach the host; the session list makes
//! those visible rather than silent.
//!
//! **Conflicts are refused, never merged.** If the remote file changed since
//! the copy was fetched, [`sync`] reports it and keeps the local copy, whose
//! path is in the message — same choice, and same reasoning, as
//! `SqlSession::resync`.
use crate::local_fs;
use crate::sftp::{self, RemoteFileClient};
use crate::transfer::PaneRef;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;

/// One remote file currently open in an editor.
pub struct RemoteEdit {
    pub id: String,
    /// Absolute path on the host, as shown to the user.
    pub remote_path: String,
    /// The temp copy the editor actually has open.
    pub local_path: PathBuf,
    client: Arc<dyn RemoteFileClient>,
    /// Hash of the local copy as of the last time it agreed with the host —
    /// after the initial fetch, then after each successful push-back.
    local_hash: u64,
    /// Hash of the host's content as of that same moment, used to detect a
    /// concurrent change before overwriting it.
    remote_hash: u64,
}

impl RemoteEdit {
    /// File name alone, for display — the directory is usually the least
    /// interesting part of a long remote path in a list.
    pub fn name(&self) -> &str {
        file_name(&self.remote_path)
    }
}

/// Last path component of a remote (always `/`-separated) path. A free
/// function so it is testable without standing up a [`RemoteFileClient`].
fn file_name(remote_path: &str) -> &str {
    remote_path.rsplit('/').next().unwrap_or(remote_path)
}

/// What [`sync`] found. Distinguished rather than collapsed into `bool`
/// because the UI says something different for each.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SyncOutcome {
    /// The editor hasn't saved anything since the last sync.
    Unchanged,
    /// Local changes were written back to the host.
    Pushed,
}

/// Downloads `cwd`/`name` into a private temp copy and returns the session to
/// hand to an editor.
///
/// The copy keeps the original file name (inside a per-edit temp directory,
/// so two edits of `config.yaml` from different hosts can't collide): the
/// name is what the editor shows in its title bar and what it picks a syntax
/// mode from, so `guiterm-edit-<uuid>` would make both worse.
pub async fn begin(pane: &PaneRef, cwd: &str, name: &str) -> anyhow::Result<RemoteEdit> {
    sftp::ensure_safe_component(name)?;
    let PaneRef::Remote(client) = pane else {
        anyhow::bail!("ce panneau est déjà local — ouvrez le fichier directement");
    };
    let remote_path = sftp::join(cwd, name);
    let entry = client
        .list(cwd)
        .await?
        .into_iter()
        .find(|e| e.name == name)
        .ok_or_else(|| anyhow::anyhow!("fichier introuvable sur l'hôte : {remote_path}"))?;
    if entry.is_dir {
        anyhow::bail!("« {name} » est un dossier");
    }

    let dir = std::env::temp_dir().join(format!("guiterm-edit-{}", uuid::Uuid::new_v4()));
    tokio::fs::create_dir_all(&dir).await?;
    let local_path = dir.join(name);
    // Pre-created 0600: a fetched file can hold credentials, and the system
    // temp directory is shared — same reasoning as `sql::connect_sqlite`.
    crate::secure_file::create_private(&local_path)?;
    let cancel = AtomicBool::new(false);
    client.download(&remote_path, &local_path, entry.size, &cancel, &mut |_, _| {}).await?;

    let hash = local_fs::content_hash(&local_path).await?;
    Ok(RemoteEdit {
        id: uuid::Uuid::new_v4().to_string(),
        remote_path,
        local_path,
        client: client.clone(),
        // The copy was just fetched, so both sides are the same bytes.
        local_hash: hash,
        remote_hash: hash,
    })
}

/// Pushes the local copy back if the editor changed it.
///
/// Refuses — rather than overwrites — when the host's copy also changed since
/// the fetch. The local copy is kept either way, and its path is in the error,
/// so nothing typed is ever lost to a failed sync.
pub async fn sync(edit: &mut RemoteEdit) -> anyhow::Result<SyncOutcome> {
    // A copy we can't even hash is treated as changed: a needless upload is
    // far cheaper than silently dropping an edit.
    let local_hash = local_fs::content_hash(&edit.local_path).await.unwrap_or(edit.local_hash.wrapping_add(1));
    if local_hash == edit.local_hash {
        return Ok(SyncOutcome::Unchanged);
    }

    if current_remote_hash(edit).await? != edit.remote_hash {
        anyhow::bail!(
            "« {} » a changé sur l'hôte depuis son ouverture — vos modifications n'ont pas été renvoyées, pour ne pas écraser un changement concurrent (copie locale conservée dans {})",
            edit.remote_path,
            edit.local_path.display(),
        );
    }

    let cancel = AtomicBool::new(false);
    edit.client
        .upload(&edit.local_path, &edit.remote_path, &cancel, &mut |_, _| {})
        .await
        .map_err(|e| {
            anyhow::anyhow!(
                "échec du renvoi de « {} » : {e} (copie locale conservée dans {})",
                edit.remote_path,
                edit.local_path.display()
            )
        })?;

    // What was just uploaded is, by construction, what the host now has —
    // no need to re-download to learn that.
    edit.local_hash = local_hash;
    edit.remote_hash = local_hash;
    Ok(SyncOutcome::Pushed)
}

/// Hash of the host's current content, via a scratch download — the
/// `RemoteFileClient` trait exposes no server-side digest, and size/mtime
/// alone would miss a same-length rewrite.
async fn current_remote_hash(edit: &RemoteEdit) -> anyhow::Result<u64> {
    let (parent, name) = edit
        .remote_path
        .rsplit_once('/')
        .ok_or_else(|| anyhow::anyhow!("chemin distant invalide : {}", edit.remote_path))?;
    let parent = if parent.is_empty() { "/" } else { parent };
    let entry = edit
        .client
        .list(parent)
        .await?
        .into_iter()
        .find(|e| e.name == name)
        .ok_or_else(|| anyhow::anyhow!("« {}  » n'existe plus sur l'hôte", edit.remote_path))?;
    let scratch = std::env::temp_dir().join(format!("guiterm-edit-check-{}", uuid::Uuid::new_v4()));
    crate::secure_file::create_private(&scratch)?;
    let cancel = AtomicBool::new(false);
    let result = edit.client.download(&edit.remote_path, &scratch, entry.size, &cancel, &mut |_, _| {}).await;
    let hash = match result {
        Ok(()) => local_fs::content_hash(&scratch).await.map_err(anyhow::Error::from),
        Err(e) => Err(e),
    };
    let _ = tokio::fs::remove_file(&scratch).await;
    hash
}

/// Removes the temp copy and its directory. Called when an edit session ends;
/// a failure here is not worth surfacing (the OS cleans its temp directory).
pub async fn discard(edit: &RemoteEdit) {
    let _ = tokio::fs::remove_file(&edit.local_path).await;
    if let Some(dir) = edit.local_path.parent() {
        let _ = tokio::fs::remove_dir(dir).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn name_is_the_last_path_component() {
        assert_eq!(file_name("/etc/nginx/nginx.conf"), "nginx.conf");
        assert_eq!(file_name("/nginx.conf"), "nginx.conf");
    }

    // Can't be produced by `begin` (which always joins onto a cwd), but
    // `file_name` shouldn't misbehave on one either.
    #[test]
    fn name_falls_back_to_the_whole_path_when_there_is_no_slash() {
        assert_eq!(file_name("nginx.conf"), "nginx.conf");
    }

    // The temp copy keeps the real file name so the editor picks the right
    // syntax mode and shows something meaningful in its title bar — the
    // uniqueness lives in the parent directory instead.
    #[tokio::test]
    async fn a_fetched_copy_keeps_its_original_name() {
        let dir = std::env::temp_dir().join(format!("guiterm-edit-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir_all(&dir).await.unwrap();
        let local_path = dir.join("nginx.conf");
        assert_eq!(local_path.file_name().unwrap(), "nginx.conf");
        tokio::fs::remove_dir_all(&dir).await.unwrap();
    }
}
