//! Local filesystem browsing, sharing the same [`crate::sftp::Entry`] shape
//! as the SFTP client so a local tree and a remote tree can be rendered and
//! navigated identically side by side.
use crate::sftp::Entry;

/// Cheap non-cryptographic content hash (`SipHash` via `DefaultHasher`) —
/// only ever used to detect incidental change vs. no change on files this app
/// fetched itself, never anything security-sensitive, so collision-resistance
/// against a deliberate adversary doesn't matter here.
///
/// Shared by the two features that keep a local temp copy of a remote file
/// and have to decide whether it is worth pushing back: `crate::sql`'s
/// remote-hosted SQLite database and `crate::remote_edit`'s
/// edit-in-your-own-editor flow.
pub(crate) async fn content_hash(path: &std::path::Path) -> std::io::Result<u64> {
    use std::hash::{Hash, Hasher};
    let bytes = tokio::fs::read(path).await?;
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    bytes.hash(&mut hasher);
    Ok(hasher.finish())
}

pub fn home_dir() -> String {
    directories::UserDirs::new()
        .map(|d| d.home_dir().to_string_lossy().to_string())
        .unwrap_or_else(|| "/".to_string())
}

pub fn list(path: &str) -> anyhow::Result<Vec<Entry>> {
    let mut entries = Vec::new();
    for item in std::fs::read_dir(path)? {
        let item = item?;
        let metadata = item.metadata()?;
        let modified = metadata
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs());
        entries.push(Entry {
            name: item.file_name().to_string_lossy().to_string(),
            is_dir: metadata.is_dir(),
            is_symlink: metadata.is_symlink(),
            size: metadata.len(),
            modified,
            permissions: None,
        });
    }
    Ok(entries)
}
