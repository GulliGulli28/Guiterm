//! Opérations récursives sur un panneau de transfert : taille d'un dossier,
//! recherche par nom, archivage d'une sélection.
//!
//! Les trois ont le même problème : les faire avec les primitives de
//! [`crate::sftp::RemoteFileClient`] (lister, télécharger, ré-envoyer) coûte
//! un aller-retour réseau par fichier — une arborescence de 10 000 fichiers
//! devient dix mille échanges SFTP pour une somme de tailles, et archiver un
//! dossier distant reviendrait à le rapatrier entièrement pour le renvoyer
//! compressé. Chaque opération est donc exécutée **du côté où vivent les
//! fichiers** :
//!
//! - panneau distant (SSH / Docker exec / K8s exec) → un petit script `sh`
//!   (`du`, `find`, `tar`/`zip`) lancé sur place via [`ShellExec`] ;
//! - panneau local → l'équivalent en Rust, puisqu'il n'y a pas de shell
//!   POSIX garanti sous Windows.
//!
//! Les scripts sont des constantes testables, et reçoivent leurs chemins en
//! **paramètres positionnels** (`$1`, `$2`, …) — jamais interpolés dans le
//! texte du script — même convention que `crate::remote_shell_pane::LIST_SCRIPT`.

use crate::shell::quote;
use crate::ssh::{self, Connection};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::Arc;

/// Exécute un script `sh` là où vivent les fichiers d'un panneau.
///
/// Implémenté par [`SshShellExec`] (panneau SFTP : un `exec` sur la connexion
/// SSH qui porte déjà le sous-système SFTP), par
/// [`crate::docker_pane::DockerPaneClient`] et par
/// [`crate::k8s_pane::K8sPaneClient`] (qui savaient déjà lancer un `sh -c` de
/// cette forme pour lister un dossier).
#[async_trait::async_trait]
pub trait ShellExec: Send + Sync {
    /// Lance `sh -c '<script>' sh <args...>` et rend sa sortie standard.
    /// Échoue si le script sort en erreur, en rapportant sa sortie d'erreur.
    async fn run(&self, script: &str, args: &[&str]) -> anyhow::Result<String>;
}

/// [`ShellExec`] pour un panneau SFTP : les commandes partent sur la même
/// connexion SSH que le sous-système SFTP du panneau (donc sans nouvelle
/// authentification), sur un canal `exec` séparé.
pub struct SshShellExec {
    connection: Arc<Connection>,
}

impl SshShellExec {
    pub fn new(connection: Arc<Connection>) -> Self {
        Self { connection }
    }
}

#[async_trait::async_trait]
impl ShellExec for SshShellExec {
    async fn run(&self, script: &str, args: &[&str]) -> anyhow::Result<String> {
        let mut command = format!("sh -c {} sh", quote(script));
        for arg in args {
            command.push(' ');
            command.push_str(&quote(arg));
        }
        let output = ssh::run_command_capture(&self.connection, &command).await?;
        if output.exit_code != Some(0) {
            let detail = output.stderr.trim();
            anyhow::bail!(
                "commande distante en échec (code {:?}){}",
                output.exit_code,
                if detail.is_empty() { String::new() } else { format!(" : {detail}") }
            );
        }
        Ok(output.stdout)
    }
}

/// De quel côté une opération s'exécute. `Local` n'est pas « pas de shell par
/// défaut » : c'est le système de fichiers de la machine qui fait tourner
/// l'app, où Windows n'a pas de `sh` et où le travail se fait donc en Rust.
#[derive(Clone)]
pub enum PaneExec {
    Local,
    Shell(Arc<dyn ShellExec>),
}

// ── Taille récursive d'un dossier ───────────────────────────────────────────

/// `du -s` du dossier passé en `$1`, en octets sur la sortie standard.
///
/// `-b` (taille réelle, GNU) d'abord, `-k` (blocs de 1 Ko, POSIX) en repli :
/// busybox et les `du` BSD ne connaissent pas `-b`, et un dossier sans taille
/// affichée est plus gênant qu'une taille arrondie au bloc. Les sous-dossiers
/// illisibles sont ignorés (`2>/dev/null`) plutôt que de faire échouer tout
/// le calcul, comme le ferait un `du` lancé à la main.
pub const DIR_SIZE_SCRIPT: &str = r#"
size=$(du -sb -- "$1" 2>/dev/null | cut -f1)
if [ -n "$size" ]; then printf '%s\n' "$size"; exit 0; fi
size=$(du -sk -- "$1" 2>/dev/null | cut -f1)
if [ -n "$size" ]; then printf '%s\n' "$((size * 1024))"; exit 0; fi
echo "impossible de calculer la taille de ce dossier" >&2
exit 1
"#;

pub async fn dir_size(exec: &PaneExec, path: &str) -> anyhow::Result<u64> {
    match exec {
        PaneExec::Local => {
            let path = std::path::PathBuf::from(path);
            tokio::task::spawn_blocking(move || local_dir_size(&path)).await?
        }
        PaneExec::Shell(shell) => {
            let out = shell.run(DIR_SIZE_SCRIPT, &[path]).await?;
            parse_dir_size(&out)
        }
    }
}

pub fn parse_dir_size(output: &str) -> anyhow::Result<u64> {
    output
        .trim()
        .lines()
        .next_back()
        .and_then(|line| line.trim().parse::<u64>().ok())
        .ok_or_else(|| anyhow::anyhow!("taille de dossier illisible : {:?}", output.trim()))
}

/// Somme des tailles de fichiers sous `root`, sans jamais suivre un lien
/// symbolique (le suivre compterait un arbre situé hors du dossier mesuré, et
/// pourrait boucler). Un sous-dossier illisible est ignoré, comme côté shell.
fn local_dir_size(root: &Path) -> anyhow::Result<u64> {
    // La première lecture remonte son erreur : un chemin inexistant doit se
    // voir, contrairement à un sous-dossier interdit rencontré en chemin.
    let mut total = 0u64;
    let mut stack = vec![std::fs::read_dir(root)?];
    while let Some(dir) = stack.pop() {
        for item in dir.flatten() {
            let Ok(metadata) = item.metadata() else { continue };
            if metadata.is_symlink() {
                continue;
            }
            if metadata.is_dir() {
                if let Ok(child) = std::fs::read_dir(item.path()) {
                    stack.push(child);
                }
            } else {
                total += metadata.len();
            }
        }
    }
    Ok(total)
}

// ── Recherche récursive par nom ─────────────────────────────────────────────

/// Profondeur maximale de la recherche, même raison que
/// [`crate::remote_search::MAX_DEPTH`] : assez pour trouver, pas assez pour
/// descendre un point de montage jusqu'au fond.
pub const FIND_MAX_DEPTH: u32 = 8;
/// Au-delà, la liste de résultats n'est plus une réponse mais une deuxième
/// recherche à faire.
pub const FIND_LIMIT: usize = 300;
/// Comme [`crate::remote_search::SEARCH_TIMEOUT_SECS`] : une recherche partie
/// depuis `/` sur une machine chargée ne doit pas rester en vol indéfiniment.
pub const FIND_TIMEOUT_SECS: u32 = 20;

/// `find` borné en profondeur, en nombre de résultats et en durée.
/// `$1` = dossier de départ, `$2` = motif (déjà entouré de `*`), `$3` =
/// profondeur, `$4` = nombre de résultats. Les dossiers sont retournés comme
/// les fichiers : chercher un dossier par son nom est exactement l'usage
/// visé dans un panneau de transfert.
pub const FIND_SCRIPT: &str = r#"
if command -v timeout >/dev/null 2>&1; then
  timeout TIMEOUT find "$1" -maxdepth "$3" -iname "$2" -print 2>/dev/null | head -n "$4"
else
  find "$1" -maxdepth "$3" -iname "$2" -print 2>/dev/null | head -n "$4"
fi
"#;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FindOutcome {
    /// Chemins absolus, dossiers compris.
    pub paths: Vec<String>,
    /// La réponse est peut-être incomplète : limite de résultats atteinte, ou
    /// budget de temps épuisé. Signalé à l'utilisateur — une liste partielle
    /// présentée comme complète est pire que pas de recherche du tout.
    ///
    /// Côté distant, seul le premier cas est détectable : quand `timeout` tue
    /// `find`, `head` rend un état de sortie 0 et rien ne distingue une
    /// recherche écourtée d'une recherche terminée. Le cas est rare (20 s de
    /// `find` borné en profondeur) et le coût d'un protocole de marqueur dans
    /// le script dépasse ce qu'il rapporterait.
    pub truncated: bool,
}

pub fn validate_find_pattern(pattern: &str) -> anyhow::Result<()> {
    let pattern = pattern.trim();
    if pattern.is_empty() {
        anyhow::bail!("Indiquer ce qu'il faut chercher.");
    }
    if pattern.contains('\n') || pattern.contains('\0') {
        anyhow::bail!("Le motif ne peut pas contenir de saut de ligne.");
    }
    Ok(())
}

/// `nginx.conf` cherché tel quel ne trouve jamais rien du premier coup —
/// personne ne tape `*nginx.conf*`. Un motif qui porte déjà un joker est
/// laissé intact.
pub fn globbed(pattern: &str) -> String {
    let pattern = pattern.trim();
    if pattern.contains(['*', '?', '[']) {
        pattern.to_string()
    } else {
        format!("*{pattern}*")
    }
}

pub async fn find(exec: &PaneExec, root: &str, pattern: &str) -> anyhow::Result<FindOutcome> {
    validate_find_pattern(pattern)?;
    let glob = globbed(pattern);
    match exec {
        PaneExec::Local => {
            let root = std::path::PathBuf::from(root);
            let needle = pattern.trim().to_lowercase();
            let budget = std::time::Duration::from_secs(FIND_TIMEOUT_SECS as u64);
            tokio::task::spawn_blocking(move || local_find(&root, &needle, budget)).await?
        }
        PaneExec::Shell(shell) => {
            let script = FIND_SCRIPT.replace("TIMEOUT", &FIND_TIMEOUT_SECS.to_string());
            let out = shell
                .run(
                    &script,
                    &[root, &glob, &FIND_MAX_DEPTH.to_string(), &FIND_LIMIT.to_string()],
                )
                .await?;
            Ok(parse_find_output(&out))
        }
    }
}

pub fn parse_find_output(stdout: &str) -> FindOutcome {
    let paths: Vec<String> = stdout
        .lines()
        .map(|line| line.trim_end_matches('\r').to_string())
        .filter(|line| !line.trim().is_empty())
        .collect();
    FindOutcome {
        truncated: paths.len() >= FIND_LIMIT,
        paths,
    }
}

/// Équivalent local du script `find` : mêmes bornes (profondeur, nombre de
/// résultats, **et durée** — une recherche lancée depuis `C:\` sur un disque
/// lent ne doit pas tourner indéfiniment pendant que l'interface affiche
/// « Recherche… »), même insensibilité à la casse, sur `std::fs` puisque
/// Windows n'a pas de `find` POSIX. Les liens symboliques ne sont pas suivis
/// (voir [`local_dir_size`]).
fn local_find(root: &Path, needle: &str, budget: std::time::Duration) -> anyhow::Result<FindOutcome> {
    let deadline = std::time::Instant::now() + budget;
    let mut paths = Vec::new();
    let mut queue = vec![(root.to_path_buf(), 0u32)];
    // Racine d'abord : un chemin inexistant doit remonter comme une erreur.
    let mut first = true;
    while let Some((dir, depth)) = queue.pop() {
        if std::time::Instant::now() >= deadline {
            return Ok(FindOutcome { paths, truncated: true });
        }
        let listing = match std::fs::read_dir(&dir) {
            Ok(listing) => listing,
            Err(e) if first => return Err(e.into()),
            Err(_) => continue,
        };
        first = false;
        for item in listing.flatten() {
            if paths.len() >= FIND_LIMIT {
                return Ok(FindOutcome { paths, truncated: true });
            }
            let name = item.file_name().to_string_lossy().to_lowercase();
            if name.contains(needle) {
                paths.push(item.path().to_string_lossy().to_string());
            }
            let Ok(metadata) = item.metadata() else { continue };
            if metadata.is_dir() && !metadata.is_symlink() && depth + 1 < FIND_MAX_DEPTH {
                queue.push((item.path(), depth + 1));
            }
        }
    }
    let truncated = paths.len() >= FIND_LIMIT;
    Ok(FindOutcome { paths, truncated })
}

// ── Archivage d'une sélection ───────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ArchiveFormat {
    TarGz,
    Zip,
}

impl ArchiveFormat {
    pub fn extension(self) -> &'static str {
        match self {
            ArchiveFormat::TarGz => ".tar.gz",
            ArchiveFormat::Zip => ".zip",
        }
    }
}

/// Nom de fichier final de l'archive : l'extension est ajoutée si l'utilisateur
/// ne l'a pas écrite, jamais doublée s'il l'a écrite (`sauvegarde` →
/// `sauvegarde.tar.gz`, `sauvegarde.tar.gz` → inchangé). `.tgz` est accepté
/// comme équivalent de `.tar.gz`.
pub fn archive_file_name(base: &str, format: ArchiveFormat) -> String {
    let base = base.trim();
    let lower = base.to_lowercase();
    let already = match format {
        ArchiveFormat::TarGz => lower.ends_with(".tar.gz") || lower.ends_with(".tgz"),
        ArchiveFormat::Zip => lower.ends_with(".zip"),
    };
    if already {
        base.to_string()
    } else {
        format!("{base}{}", format.extension())
    }
}

/// `$1` = chemin de l'archive, `$2` = dossier de travail, puis un argument par
/// entrée à archiver. `tar` est lancé depuis le dossier de travail pour que
/// l'archive contienne des chemins relatifs (`dossier/fichier`) et non le
/// chemin absolu de la machine distante.
pub const TAR_GZ_SCRIPT: &str = r#"
out=$1
dir=$2
shift 2
cd -- "$dir" || exit 1
tar -czf "$out" "$@"
"#;

/// Même forme que [`TAR_GZ_SCRIPT`]. `zip` n'est pas un utilitaire POSIX et
/// manque sur beaucoup de serveurs minimaux et dans la plupart des conteneurs :
/// c'est vérifié d'abord, pour dire lequel manque plutôt que de laisser
/// remonter un « not found » du shell.
pub const ZIP_SCRIPT: &str = r#"
out=$1
dir=$2
shift 2
command -v zip >/dev/null 2>&1 || { echo "la commande zip n'est pas disponible sur cet hôte" >&2; exit 3; }
cd -- "$dir" || exit 1
zip -q -r "$out" "$@"
"#;

/// Crée `<cwd>/<archive_name>` à partir de `names` (fichiers et/ou dossiers de
/// `cwd`). Rien ne transite par le réseau : l'archive est écrite là où sont
/// les fichiers.
pub async fn archive(
    exec: &PaneExec,
    cwd: &str,
    names: &[String],
    archive_name: &str,
    format: ArchiveFormat,
) -> anyhow::Result<()> {
    if names.is_empty() {
        anyhow::bail!("aucune entrée à archiver");
    }
    crate::sftp::ensure_safe_component(archive_name)?;
    for name in names {
        crate::sftp::ensure_safe_component(name)?;
    }
    let out = crate::sftp::join(cwd, archive_name);
    match exec {
        PaneExec::Local => {
            let dir = std::path::PathBuf::from(cwd);
            let names = names.to_vec();
            let out = std::path::PathBuf::from(out);
            tokio::task::spawn_blocking(move || local_archive(&dir, &names, &out, format)).await?
        }
        PaneExec::Shell(shell) => {
            let script = match format {
                ArchiveFormat::TarGz => TAR_GZ_SCRIPT,
                ArchiveFormat::Zip => ZIP_SCRIPT,
            };
            // `./nom` plutôt que `nom` : une entrée dont le nom commence par
            // un tiret serait lue comme une option par `tar`/`zip`, et le
            // `--` qui l'éviterait n'est pas portable sur busybox.
            let prefixed: Vec<String> = names.iter().map(|n| format!("./{n}")).collect();
            let mut args: Vec<&str> = vec![&out, cwd];
            args.extend(prefixed.iter().map(String::as_str));
            shell.run(script, &args).await?;
            Ok(())
        }
    }
}

fn local_archive(
    cwd: &Path,
    names: &[String],
    out: &Path,
    format: ArchiveFormat,
) -> anyhow::Result<()> {
    let result = match format {
        ArchiveFormat::TarGz => local_tar_gz(cwd, names, out),
        ArchiveFormat::Zip => local_zip(cwd, names, out),
    };
    if result.is_err() {
        // Pas d'archive tronquée laissée derrière, qui ressemblerait à une
        // archive complète dans le listing.
        let _ = std::fs::remove_file(out);
    }
    result
}

fn local_tar_gz(cwd: &Path, names: &[String], out: &Path) -> anyhow::Result<()> {
    use flate2::Compression;
    use flate2::write::GzEncoder;
    let file = std::fs::File::create(out)?;
    let mut builder = tar::Builder::new(GzEncoder::new(file, Compression::default()));
    // Les liens symboliques sont archivés tels quels, jamais suivis — même
    // règle que la copie et la suppression (voir `transfer::copy_entry`).
    builder.follow_symlinks(false);
    for name in names {
        let path = cwd.join(name);
        if path.symlink_metadata()?.is_dir() {
            builder.append_dir_all(name, &path)?;
        } else {
            builder.append_path_with_name(&path, name)?;
        }
    }
    builder.into_inner()?.finish()?;
    Ok(())
}

fn local_zip(cwd: &Path, names: &[String], out: &Path) -> anyhow::Result<()> {
    use std::io::Write;
    use zip::write::SimpleFileOptions;
    let file = std::fs::File::create(out)?;
    let mut writer = zip::ZipWriter::new(std::io::BufWriter::new(file));
    let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);

    // Parcours itératif, `(chemin réel, nom dans l'archive)` — le nom stocké
    // est toujours relatif à `cwd` et séparé par `/`, y compris sous Windows
    // (le format ZIP l'impose).
    let mut stack: Vec<(std::path::PathBuf, String)> =
        names.iter().rev().map(|n| (cwd.join(n), n.clone())).collect();
    while let Some((path, entry_name)) = stack.pop() {
        let metadata = path.symlink_metadata()?;
        if metadata.is_symlink() {
            continue;
        }
        if metadata.is_dir() {
            writer.add_directory(format!("{entry_name}/"), options)?;
            for item in std::fs::read_dir(&path)? {
                let item = item?;
                let child = item.file_name().to_string_lossy().to_string();
                stack.push((item.path(), format!("{entry_name}/{child}")));
            }
        } else {
            writer.start_file(entry_name, options)?;
            let mut source = std::fs::File::open(&path)?;
            std::io::copy(&mut source, &mut writer)?;
        }
    }
    writer.finish()?.flush()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dir_size_reads_the_last_line_of_du() {
        assert_eq!(parse_dir_size("4096\n").unwrap(), 4096);
        // `du` peut précéder sa réponse d'un avertissement sur stdout selon
        // l'implémentation ; c'est la dernière ligne qui porte le total.
        assert_eq!(parse_dir_size("du: skipping\n12345\n").unwrap(), 12345);
        assert!(parse_dir_size("").is_err());
        assert!(parse_dir_size("pas un nombre").is_err());
    }

    #[test]
    fn a_plain_pattern_gets_wildcards_unless_it_has_them() {
        assert_eq!(globbed("nginx.conf"), "*nginx.conf*");
        assert_eq!(globbed("*.conf"), "*.conf");
        assert_eq!(globbed("  log  "), "*log*");
    }

    #[test]
    fn find_output_is_bounded_and_reports_it() {
        let outcome = parse_find_output("/etc/nginx\n/etc/nginx/nginx.conf\n\n");
        assert_eq!(outcome.paths, vec!["/etc/nginx", "/etc/nginx/nginx.conf"]);
        assert!(!outcome.truncated);

        let many = (0..FIND_LIMIT).map(|i| format!("/x/{i}")).collect::<Vec<_>>().join("\n");
        assert!(parse_find_output(&many).truncated, "la limite atteinte doit être signalée");
    }

    #[test]
    fn find_script_is_bounded() {
        let script = FIND_SCRIPT.replace("TIMEOUT", &FIND_TIMEOUT_SECS.to_string());
        assert!(script.contains("timeout 20"), "la durée est bornée : {script}");
        assert!(script.contains("-maxdepth"), "la profondeur est bornée");
        assert!(script.contains("head -n"), "le nombre de résultats est borné");
    }

    #[test]
    fn archive_name_gets_its_extension_once() {
        assert_eq!(archive_file_name("sauvegarde", ArchiveFormat::TarGz), "sauvegarde.tar.gz");
        assert_eq!(archive_file_name("sauvegarde.tar.gz", ArchiveFormat::TarGz), "sauvegarde.tar.gz");
        assert_eq!(archive_file_name("sauvegarde.TGZ", ArchiveFormat::TarGz), "sauvegarde.TGZ");
        assert_eq!(archive_file_name("sauvegarde", ArchiveFormat::Zip), "sauvegarde.zip");
        assert_eq!(archive_file_name("sauvegarde.zip", ArchiveFormat::Zip), "sauvegarde.zip");
        // Une extension d'un autre format n'en fait pas une archive du bon
        // type : elle est complétée, pas remplacée.
        assert_eq!(archive_file_name("sauvegarde.zip", ArchiveFormat::TarGz), "sauvegarde.zip.tar.gz");
    }

    /// Le nom de l'archive et les entrées viennent de l'interface, mais le
    /// listing d'où sortent les entrées vient du serveur : les mêmes règles
    /// que partout ailleurs (voir `sftp::ensure_safe_component`).
    #[tokio::test]
    async fn archive_refuses_a_traversing_name() {
        let dir = tempfile::tempdir().unwrap();
        let cwd = dir.path().to_string_lossy().to_string();
        std::fs::write(dir.path().join("a.txt"), b"x").unwrap();

        assert!(
            archive(&PaneExec::Local, &cwd, &["a.txt".into()], "../evasion.tar.gz", ArchiveFormat::TarGz)
                .await
                .is_err()
        );
        assert!(
            archive(&PaneExec::Local, &cwd, &["../secret".into()], "a.tar.gz", ArchiveFormat::TarGz)
                .await
                .is_err()
        );
        assert!(
            archive(&PaneExec::Local, &cwd, &[], "vide.tar.gz", ArchiveFormat::TarGz)
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn local_dir_size_sums_the_whole_tree() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.bin"), vec![0u8; 1000]).unwrap();
        std::fs::create_dir(dir.path().join("sous")).unwrap();
        std::fs::write(dir.path().join("sous/b.bin"), vec![0u8; 2345]).unwrap();

        let size = dir_size(&PaneExec::Local, &dir.path().to_string_lossy()).await.unwrap();
        assert_eq!(size, 3345, "le sous-dossier compte aussi");

        assert!(
            dir_size(&PaneExec::Local, &dir.path().join("absent").to_string_lossy()).await.is_err(),
            "un dossier inexistant doit remonter une erreur, pas une taille nulle"
        );
    }

    #[tokio::test]
    async fn local_find_matches_by_name_at_any_depth() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("etc/nginx")).unwrap();
        std::fs::write(dir.path().join("etc/nginx/NGINX.conf"), b"x").unwrap();
        std::fs::write(dir.path().join("etc/autre.txt"), b"x").unwrap();

        let outcome = find(&PaneExec::Local, &dir.path().to_string_lossy(), "nginx").await.unwrap();
        assert_eq!(outcome.paths.len(), 2, "le dossier et le fichier : {:?}", outcome.paths);
        assert!(outcome.paths.iter().any(|p| p.ends_with("NGINX.conf")), "la casse est ignorée");
        assert!(!outcome.truncated);

        assert!(
            find(&PaneExec::Local, &dir.path().to_string_lossy(), "  ").await.is_err(),
            "un motif vide n'est pas une recherche"
        );
    }

    /// Le pendant local du `timeout` du script distant : passé le budget, la
    /// recherche rend ce qu'elle a en le disant, au lieu de laisser
    /// l'interface sur « Recherche… » indéfiniment.
    #[test]
    fn local_find_stops_at_its_time_budget_and_says_so() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("a/b/c")).unwrap();
        std::fs::write(dir.path().join("a/b/c/nginx.conf"), b"x").unwrap();

        let outcome = local_find(dir.path(), "nginx", std::time::Duration::ZERO).unwrap();
        assert!(outcome.truncated, "un budget épuisé doit être signalé comme partiel");
        assert!(outcome.paths.is_empty());

        let complete = local_find(dir.path(), "nginx", std::time::Duration::from_secs(20)).unwrap();
        assert_eq!(complete.paths.len(), 1, "avec du temps, la même recherche trouve : {complete:?}");
        assert!(!complete.truncated);
    }

    #[tokio::test]
    async fn local_archive_writes_a_readable_tar_gz() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("projet")).unwrap();
        std::fs::write(dir.path().join("projet/a.txt"), b"bonjour").unwrap();
        std::fs::write(dir.path().join("seul.txt"), b"salut").unwrap();
        let cwd = dir.path().to_string_lossy().to_string();

        archive(
            &PaneExec::Local,
            &cwd,
            &["projet".into(), "seul.txt".into()],
            "tout.tar.gz",
            ArchiveFormat::TarGz,
        )
        .await
        .unwrap();

        let file = std::fs::File::open(dir.path().join("tout.tar.gz")).unwrap();
        let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(file));
        let names: Vec<String> = archive
            .entries()
            .unwrap()
            .map(|e| e.unwrap().path().unwrap().to_string_lossy().to_string())
            .collect();
        assert!(names.iter().any(|n| n == "seul.txt"), "obtenu : {names:?}");
        assert!(
            names.iter().any(|n| n.replace('\\', "/") == "projet/a.txt"),
            "le contenu du dossier est archivé, en chemin relatif : {names:?}"
        );
    }

    #[tokio::test]
    async fn local_archive_writes_a_readable_zip() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("projet")).unwrap();
        std::fs::write(dir.path().join("projet/a.txt"), b"bonjour").unwrap();
        let cwd = dir.path().to_string_lossy().to_string();

        archive(&PaneExec::Local, &cwd, &["projet".into()], "tout.zip", ArchiveFormat::Zip)
            .await
            .unwrap();

        let file = std::fs::File::open(dir.path().join("tout.zip")).unwrap();
        let mut zip = zip::ZipArchive::new(file).unwrap();
        let names: Vec<String> = (0..zip.len()).map(|i| zip.by_index(i).unwrap().name().to_string()).collect();
        assert!(names.iter().any(|n| n == "projet/a.txt"), "obtenu : {names:?}");
    }
}

/// Les scripts ci-dessus ne sont pas du Rust : rien dans la compilation ne dit
/// s'ils tournent. Ces tests les passent au `sh` de la machine (dash sous
/// Ubuntu, un POSIX strict — plus proche du `sh` d'un serveur ou d'un busybox
/// de conteneur que ne le serait bash) avec les mêmes paramètres positionnels
/// que [`ShellExec::run`], et comparent leur résultat à celui de
/// l'implémentation locale en Rust. Une faute de frappe de shell, une option
/// non portable ou un `$1` décalé échouent ici plutôt que chez l'utilisateur.
#[cfg(all(test, unix))]
mod shell_script_tests {
    use super::*;

    /// Même invocation que `docker_pane`/`k8s_pane` (`sh -c '<script>' sh
    /// <args...>`), lancée sur la machine de test.
    fn run(script: &str, args: &[&str]) -> (bool, String, String) {
        let output = std::process::Command::new("sh")
            .arg("-c")
            .arg(script)
            .arg("sh")
            .args(args)
            .output()
            .expect("sh doit exister sur une machine Unix");
        (
            output.status.success(),
            String::from_utf8_lossy(&output.stdout).into_owned(),
            String::from_utf8_lossy(&output.stderr).into_owned(),
        )
    }

    fn has(binary: &str) -> bool {
        std::process::Command::new("sh")
            .arg("-c")
            .arg(format!("command -v {binary} >/dev/null 2>&1"))
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }

    fn tree() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.bin"), vec![7u8; 4096]).unwrap();
        std::fs::create_dir(dir.path().join("projet")).unwrap();
        std::fs::write(dir.path().join("projet/nginx.conf"), vec![7u8; 8192]).unwrap();
        dir
    }

    #[test]
    fn dir_size_script_agrees_with_the_rust_walk() {
        let dir = tree();
        let (ok, stdout, stderr) = run(DIR_SIZE_SCRIPT, &[&dir.path().to_string_lossy()]);
        assert!(ok, "le script doit réussir — stderr : {stderr}");
        let from_shell = parse_dir_size(&stdout).expect("sortie lisible");
        let from_rust = local_dir_size(dir.path()).unwrap();
        // `du -sb` compte aussi les entrées de dossier elles-mêmes ; c'est la
        // taille des fichiers qui doit être là, pas l'égalité stricte.
        assert!(
            from_shell >= from_rust && from_shell < from_rust + 64 * 1024,
            "shell {from_shell} vs rust {from_rust}"
        );
    }

    #[test]
    fn dir_size_script_fails_on_a_missing_directory() {
        let dir = tempfile::tempdir().unwrap();
        let (ok, _, stderr) = run(DIR_SIZE_SCRIPT, &[&dir.path().join("absent").to_string_lossy()]);
        assert!(!ok, "un dossier inexistant ne doit pas rendre une taille");
        assert!(stderr.contains("impossible de calculer"), "message français attendu : {stderr}");
    }

    #[test]
    fn find_script_finds_at_depth_and_ignores_case() {
        let dir = tree();
        let script = FIND_SCRIPT.replace("TIMEOUT", &FIND_TIMEOUT_SECS.to_string());
        let (ok, stdout, stderr) = run(
            &script,
            &[
                &dir.path().to_string_lossy(),
                &globbed("NGINX"),
                &FIND_MAX_DEPTH.to_string(),
                &FIND_LIMIT.to_string(),
            ],
        );
        assert!(ok, "stderr : {stderr}");
        let outcome = parse_find_output(&stdout);
        assert_eq!(outcome.paths.len(), 1, "obtenu : {:?}", outcome.paths);
        assert!(outcome.paths[0].ends_with("projet/nginx.conf"));
        assert!(!outcome.truncated);
    }

    #[test]
    fn tar_gz_script_writes_an_archive_of_relative_paths() {
        let dir = tree();
        let out = dir.path().join("tout.tar.gz");
        let (ok, _, stderr) = run(
            TAR_GZ_SCRIPT,
            &[&out.to_string_lossy(), &dir.path().to_string_lossy(), "./projet", "./a.bin"],
        );
        assert!(ok, "stderr : {stderr}");

        let file = std::fs::File::open(&out).unwrap();
        let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(file));
        let names: Vec<String> = archive
            .entries()
            .unwrap()
            .map(|e| e.unwrap().path().unwrap().to_string_lossy().to_string())
            .collect();
        assert!(
            names.iter().any(|n| n.ends_with("projet/nginx.conf")),
            "chemins relatifs au dossier archivé attendus : {names:?}"
        );
        assert!(names.iter().any(|n| n.ends_with("a.bin")), "obtenu : {names:?}");
    }

    /// Un nom qui commence par un tiret : le vrai piège que le préfixe `./`
    /// de [`archive`] évite (sans lui, `tar` lit `-tricky` comme des options).
    #[test]
    fn tar_gz_script_handles_a_name_starting_with_a_dash() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("-tricky.txt"), b"x").unwrap();
        let out = dir.path().join("tout.tar.gz");
        let (ok, _, stderr) = run(
            TAR_GZ_SCRIPT,
            &[&out.to_string_lossy(), &dir.path().to_string_lossy(), "./-tricky.txt"],
        );
        assert!(ok, "stderr : {stderr}");
        assert!(out.exists());
    }

    #[test]
    fn zip_script_says_which_command_is_missing_when_it_is() {
        let dir = tree();
        let out = dir.path().join("tout.zip");
        let (ok, _, stderr) = run(
            ZIP_SCRIPT,
            &[&out.to_string_lossy(), &dir.path().to_string_lossy(), "./projet"],
        );
        if has("zip") {
            assert!(ok, "stderr : {stderr}");
            let file = std::fs::File::open(&out).unwrap();
            let mut zip = zip::ZipArchive::new(file).unwrap();
            let names: Vec<String> = (0..zip.len()).map(|i| zip.by_index(i).unwrap().name().to_string()).collect();
            assert!(names.iter().any(|n| n.ends_with("nginx.conf")), "obtenu : {names:?}");
        } else {
            assert!(!ok);
            assert!(
                stderr.contains("la commande zip n'est pas disponible"),
                "l'absence de `zip` doit se dire en français : {stderr}"
            );
        }
    }
}
