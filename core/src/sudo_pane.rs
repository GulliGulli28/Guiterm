//! Un panneau de transfert qui voit les fichiers avec les droits de root.
//!
//! Même moule que [`crate::docker_pane`] et [`crate::k8s_pane`] : un
//! [`RemoteFileClient`] bâti sur un `sh` distant plutôt que sur SFTP, parce
//! que le sous-système SFTP tourne sous **l'identité de l'utilisateur** et
//! qu'aucune option du protocole ne permet de s'élever. Ici le `sh` est le
//! shell root persistant de [`crate::sudo_session`].
//!
//! ## Les octets passent quand même par SFTP
//!
//! Faire transiter le contenu d'un fichier à travers un shell obligerait à
//! l'encoder (base64, +33 %) et ferait perdre la progression et l'annulation
//! que [`crate::sftp::SftpClient`] sait déjà rapporter. À la place, chaque
//! transfert utilise un **fichier de transit** dans le dossier personnel de
//! l'utilisateur :
//!
//! - descente : root copie le fichier vers le transit et le donne à
//!   l'utilisateur (`chown`), puis SFTP ordinaire le rapatrie ;
//! - montée : SFTP ordinaire dépose le transit, puis root le recopie à sa
//!   place définitive.
//!
//! Le transit est créé en 0600 et effacé dans tous les cas, y compris en
//! erreur. Le coût est un doublon temporaire du fichier sur l'hôte — accepté :
//! l'alternative encodait tout en mémoire.
use crate::pane_ops::ShellExec;
use crate::remote_shell_pane::{LIST_SCRIPT, SET_MTIME_SCRIPT, parse_listing};
use crate::sftp::{self, Entry, MAX_EDIT_BYTES, RemoteFileClient};
use crate::sudo_session::SudoSession;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;

/// Copie un fichier vers le transit et le rend lisible par l'utilisateur.
/// `$1` source (souvent illisible pour lui), `$2` transit, `$3` son `uid`.
///
/// `--` **avant** le mode, pas après : le `getopt` BSD (macOS) s'arrête au
/// premier argument qui n'est pas une option, donc `chmod 600 -- f` y prend
/// `--` pour un fichier — « chmod: --: No such file or directory » sur le CI
/// macOS. GNU l'accepte aux deux places ; la forme `-- 600 f` marche partout,
/// comme le `chown -- uid f` juste au-dessus.
const STAGE_OUT_SCRIPT: &str = r#"
cp -- "$1" "$2" || exit 1
chown -- "$3" "$2" || exit 1
chmod -- 600 "$2"
"#;

/// Recopie le transit à sa place définitive. Le `cp` (et non un `mv`) est
/// délibéré : quand la destination existe déjà, `cp` écrit *dedans* et lui
/// laisse son propriétaire et ses droits, là où `mv` la remplacerait par un
/// fichier appartenant à l'utilisateur.
const STAGE_IN_SCRIPT: &str = r#"cp -- "$1" "$2""#;

/// L'identité de l'utilisateur du côté distant, telle qu'elle sert à placer et
/// à donner les fichiers de transit.
pub struct RemoteIdentity {
    pub uid: String,
    pub home: String,
}

/// Demande à l'hôte son `uid` et son dossier personnel, **sans élévation** :
/// c'est bien l'utilisateur qui doit pouvoir lire le transit.
pub async fn probe_identity(exec: &dyn ShellExec) -> anyhow::Result<RemoteIdentity> {
    let output = exec.run(r#"printf '%s\n%s\n' "$(id -u)" "$HOME""#, &[]).await?;
    let mut lines = output.lines();
    let uid = lines.next().unwrap_or("").trim().to_string();
    let home = lines.next().unwrap_or("").trim().to_string();
    if uid.is_empty() || home.is_empty() {
        anyhow::bail!("l'hôte n'a pas su dire quel est le dossier personnel de l'utilisateur");
    }
    Ok(RemoteIdentity { uid, home })
}

pub struct SudoPaneClient {
    session: Arc<SudoSession>,
    /// Le client non élevé de la même connexion — c'est lui qui déplace les
    /// octets, à travers le fichier de transit.
    plain: Arc<dyn RemoteFileClient>,
    identity: RemoteIdentity,
}

impl SudoPaneClient {
    pub fn new(
        session: Arc<SudoSession>,
        plain: Arc<dyn RemoteFileClient>,
        identity: RemoteIdentity,
    ) -> Self {
        Self { session, plain, identity }
    }

    fn staging_path(&self) -> String {
        sftp::join(&self.identity.home, &format!(".guiterm-transit-{}", uuid::Uuid::new_v4()))
    }

    /// Efface un transit, quel que soit le sort du transfert. Best-effort des
    /// deux côtés : le transit appartient à l'utilisateur, donc `plain` suffit
    /// normalement, mais un `cp` interrompu peut l'avoir laissé à root.
    async fn discard_staging(&self, path: &str) {
        if self.plain.remove_file(path).await.is_ok() {
            return;
        }
        let _ = self.session.run_script(r#"rm -f -- "$1""#, &[path]).await;
    }
}

/// Ce que `pane_ops` attend d'un panneau pour ses opérations récursives — ici
/// exécutées en root, ce qui est tout l'intérêt : un `du` ou un `find` sous un
/// dossier fermé rendait jusqu'ici une erreur ou un résultat tronqué.
#[async_trait::async_trait]
impl ShellExec for SudoPaneClient {
    async fn run(&self, script: &str, args: &[&str]) -> anyhow::Result<String> {
        let out = self.session.run_script(script, args).await?;
        Ok(String::from_utf8_lossy(&out).into_owned())
    }
}

#[async_trait::async_trait]
impl RemoteFileClient for SudoPaneClient {
    async fn list(&self, path: &str) -> anyhow::Result<Vec<Entry>> {
        let out = self.session.run_script(LIST_SCRIPT, &[path]).await?;
        Ok(parse_listing(&out))
    }

    async fn make_dir(&self, path: &str) -> anyhow::Result<()> {
        self.session.run_script(r#"mkdir -- "$1""#, &[path]).await.map(|_| ())
    }

    async fn remove_file(&self, path: &str) -> anyhow::Result<()> {
        self.session.run_script(r#"rm -f -- "$1""#, &[path]).await.map(|_| ())
    }

    async fn remove_dir(&self, path: &str) -> anyhow::Result<()> {
        // Sémantique POSIX de `rmdir` (dossiers vides seulement), comme
        // `SftpClient::remove_dir` : `transfer::remove_remote_dir_recursive`
        // a déjà vidé l'arborescence avant d'arriver ici.
        self.session.run_script(r#"rmdir -- "$1""#, &[path]).await.map(|_| ())
    }

    async fn rename(&self, from: &str, to: &str) -> anyhow::Result<()> {
        self.session.run_script(r#"mv -- "$1" "$2""#, &[from, to]).await.map(|_| ())
    }

    async fn set_permissions(&self, path: &str, mode: u32) -> anyhow::Result<()> {
        let mode_str = format!("{mode:o}");
        self.session.run_script(r#"chmod -- "$1" "$2""#, &[&mode_str, path]).await.map(|_| ())
    }

    async fn set_modified(&self, path: &str, mtime_secs: u64) -> anyhow::Result<()> {
        self.session.run_script(SET_MTIME_SCRIPT, &[path, &mtime_secs.to_string()]).await?;
        Ok(())
    }

    async fn read_to_string(&self, path: &str) -> anyhow::Result<String> {
        // `head -c` borné une unité au-dessus du plafond : de quoi savoir que
        // le fichier le dépasse sans jamais rapatrier le reste, exactement
        // comme la version SFTP.
        let cap = (MAX_EDIT_BYTES + 1).to_string();
        let bytes = self
            .session
            .run_script(r#"head -c "$2" -- "$1""#, &[path, &cap])
            .await?;
        if bytes.len() as u64 > MAX_EDIT_BYTES {
            anyhow::bail!(
                "fichier trop volumineux pour l'édition rapide (> {} Mo)",
                MAX_EDIT_BYTES / (1024 * 1024)
            );
        }
        String::from_utf8(bytes)
            .map_err(|_| anyhow::anyhow!("le fichier n'est pas du texte UTF-8 valide"))
    }

    async fn write_string(&self, path: &str, content: &str) -> anyhow::Result<()> {
        // Passe par le même chemin qu'une montée ordinaire plutôt que de
        // pousser le contenu dans la ligne de commande : `ARG_MAX` plafonne un
        // argument bien en dessous des 5 Mo que l'édition rapide autorise.
        let local = std::env::temp_dir().join(format!("guiterm-sudo-edit-{}", uuid::Uuid::new_v4()));
        crate::secure_file::write_private(&local, content.as_bytes())?;
        let result = self
            .upload(&local, path, &AtomicBool::new(false), &mut |_, _| {})
            .await;
        let _ = tokio::fs::remove_file(&local).await;
        result
    }

    async fn download(
        &self,
        remote_path: &str,
        local_path: &std::path::Path,
        total: u64,
        cancel: &AtomicBool,
        on_progress: &mut (dyn FnMut(u64, u64) + Send),
    ) -> anyhow::Result<()> {
        let staging = self.staging_path();
        // Le ménage dans tous les cas, y compris quand c'est la copie vers le
        // transit qui a échoué : un `cp` interrompu en cours de route laisse
        // derrière lui un fichier partiel appartenant à root.
        let staged = self
            .session
            .run_script(STAGE_OUT_SCRIPT, &[remote_path, &staging, &self.identity.uid])
            .await;
        let result = match staged {
            Ok(_) => {
                self.plain
                    .download(&staging, local_path, total, cancel, on_progress)
                    .await
            }
            Err(e) => Err(e),
        };
        self.discard_staging(&staging).await;
        result
    }

    async fn upload(
        &self,
        local_path: &std::path::Path,
        remote_path: &str,
        cancel: &AtomicBool,
        on_progress: &mut (dyn FnMut(u64, u64) + Send),
    ) -> anyhow::Result<()> {
        let staging = self.staging_path();
        let sent = self.plain.upload(local_path, &staging, cancel, on_progress).await;
        let result = match sent {
            Ok(()) => self
                .session
                .run_script(STAGE_IN_SCRIPT, &[&staging, remote_path])
                .await
                .map(|_| ()),
            Err(e) => Err(e),
        };
        self.discard_staging(&staging).await;
        result
    }
}
