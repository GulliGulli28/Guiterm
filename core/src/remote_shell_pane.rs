//! Helpers shared by [`crate::docker_pane`] and [`crate::k8s_pane`] —
//! both implement [`crate::sftp::RemoteFileClient`] over a container/pod's
//! own `sh`/coreutils via a non-interactive `exec`, since neither Docker nor
//! Kubernetes exposes a real SFTP-equivalent subsystem. Split out once both
//! callers needed byte-identical logic, rather than two copies drifting
//! apart: a directory-listing script + its tab-delimited output parser, and
//! single-file tar archive build/read (Docker's container-archive endpoints
//! speak tar directly; Kubernetes has no such endpoint, so `k8s_pane` runs
//! `tar` inside the pod via `exec` instead — the same approach `kubectl cp`
//! itself uses client-side).

/// Lists a directory's entries as tab-delimited lines — run inside a
/// container/pod's shell via a non-interactive `exec`, parsed by
/// [`parse_listing`]. Passed `path` as a real positional parameter (`$1`,
/// via a `sh -c '<script>' sh "$1"` invocation), never string-interpolated.
pub const LIST_SCRIPT: &str = r#"
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

/// `touch` avec une date d'époque, dans les deux dialectes.
///
/// GNU et busybox comprennent `-d @secondes` ; BSD (donc macOS) ne connaît
/// que `-t [[CC]YY]MMDDhhmm.SS`, que seul son propre `date -r` sait produire
/// à partir d'une époque. D'où l'essai puis le repli — la même fracture que
/// `stat` dans `pane_ops::INVENTORY_SCRIPT`.
///
/// Reste best-effort : si les deux échouent, `transfer` traite ça comme
/// « date non reportée » plutôt que comme un échec de copie — le fichier est
/// là, c'est sa date qui manque, et ce qui se dégrade alors est la
/// comparaison d'arborescences, pas la copie.
pub const SET_MTIME_SCRIPT: &str = r#"
touch -d "@$2" -- "$1" 2>/dev/null && exit 0
stamp=$(date -r "$2" '+%Y%m%d%H%M.%S' 2>/dev/null) || exit 1
touch -t "$stamp" -- "$1"
"#;

/// Parses [`LIST_SCRIPT`]'s tab-delimited output. Splits each line into at
/// most 6 fields (`splitn`), so a filename containing a literal tab is still
/// captured intact in the final field rather than shifting every column
/// after it — a filename containing a literal newline still breaks parsing
/// (read line-by-line, same as a real terminal's `ls` would visually split
/// it), an accepted, rare edge case for what is inherently text-based
/// plumbing rather than a real framed protocol like SFTP.
pub fn parse_listing(output: &[u8]) -> Vec<crate::sftp::Entry> {
    let text = String::from_utf8_lossy(output);
    let mut entries = Vec::new();
    for line in text.lines() {
        let mut parts = line.splitn(6, '\t');
        let (Some(sym), Some(isdir), Some(size), Some(mtime), Some(perm), Some(name)) =
            (parts.next(), parts.next(), parts.next(), parts.next(), parts.next(), parts.next())
        else {
            continue;
        };
        entries.push(crate::sftp::Entry {
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

/// Splits a POSIX remote path into its parent directory and final
/// component — both callers' "extract a tar into a directory" primitive
/// (Docker's `upload_to_container`, K8s's `tar xf - -C <dir>`) names a
/// *directory* to extract into, so the tar's own entry only ever needs the
/// bare filename, not the full path.
pub fn split_parent_and_name(path: &str) -> anyhow::Result<(String, String)> {
    let trimmed = path.trim_end_matches('/');
    match trimmed.rfind('/') {
        Some(0) => Ok(("/".to_string(), trimmed[1..].to_string())),
        Some(idx) => Ok((trimmed[..idx].to_string(), trimmed[idx + 1..].to_string())),
        None => anyhow::bail!("chemin distant invalide : {path:?}"),
    }
}

pub fn build_single_file_tar(name: &str, content: &[u8]) -> anyhow::Result<Vec<u8>> {
    let mut header = tar::Header::new_gnu();
    header.set_size(content.len() as u64);
    header.set_mode(0o644);
    header.set_mtime(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0));
    let mut builder = tar::Builder::new(Vec::new());
    builder.append_data(&mut header, name, content)?;
    Ok(builder.into_inner()?)
}

/// Reads `local_path` fully into memory in fixed-size chunks, checking
/// `cancel` and reporting `on_progress(bytes_so_far, total)` after each one
/// — the read side of both callers' `upload()` (Docker's Engine API upload
/// endpoint, K8s's `tar xf -` over `exec`), neither of which can stream a
/// local file straight into their own upload call, so both buffer it here
/// first. Progress is therefore only approximate: it reflects reading the
/// file locally, not how much has actually reached the container/pod.
pub async fn read_local_file_chunked(
    local_path: &std::path::Path,
    cancel: &std::sync::atomic::AtomicBool,
    on_progress: &mut (dyn FnMut(u64, u64) + Send),
) -> anyhow::Result<Vec<u8>> {
    use std::sync::atomic::Ordering;
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
    Ok(content)
}

/// Extracts the first regular-file entry's content from a tar archive —
/// both callers' single-file download always produces an archive with
/// exactly one meaningful entry (named by the requested path's basename,
/// not the full path), so there's nothing to match against by name.
pub fn extract_single_file(tar_bytes: &[u8]) -> anyhow::Result<Vec<u8>> {
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

/// [`SET_MTIME_SCRIPT`] passé au `sh` de la machine.
///
/// L'intérêt est dans la matrice d'intégration continue : le runner Linux
/// exerce la branche GNU (`touch -d @secondes`), le runner macOS la branche
/// BSD (`date -r` puis `touch -t`). C'est l'absence d'un tel test qui avait
/// laissé passer la même fracture sur `stat` dans `pane_ops`, où la
/// comparaison d'arborescences rendait silencieusement une liste vide contre
/// un serveur BSD.
#[cfg(all(test, unix))]
mod set_mtime_shell_test {
    use super::*;

    #[test]
    fn the_script_sets_a_date_on_this_platforms_touch() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("daté.txt");
        std::fs::write(&file, b"x").unwrap();
        // Une date nettement dans le passé, qu'on ne peut pas confondre avec
        // l'heure du test.
        let target = 1_600_000_000u64;

        let output = std::process::Command::new("sh")
            .arg("-c")
            .arg(SET_MTIME_SCRIPT)
            .arg("sh")
            .arg(file.to_string_lossy().as_ref())
            .arg(target.to_string())
            .output()
            .expect("sh doit exister sur une machine Unix");
        assert!(
            output.status.success(),
            "aucune des deux formes de `touch` n'a fonctionné — stderr : {}",
            String::from_utf8_lossy(&output.stderr)
        );

        let seen = std::fs::metadata(&file)
            .unwrap()
            .modified()
            .unwrap()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        assert_eq!(seen, target, "la date demandée doit être celle du fichier");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_parent_and_name() {
        assert_eq!(split_parent_and_name("/etc/hosts").unwrap(), ("/etc".to_string(), "hosts".to_string()));
        assert_eq!(split_parent_and_name("/notes.txt").unwrap(), ("/".to_string(), "notes.txt".to_string()));
        assert!(split_parent_and_name("no-slash").is_err());
    }

    #[test]
    fn tar_roundtrips_a_single_file() {
        let tar_bytes = build_single_file_tar("hello.txt", b"bonjour").unwrap();
        let extracted = extract_single_file(&tar_bytes).unwrap();
        assert_eq!(extracted, b"bonjour");
    }

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
}
