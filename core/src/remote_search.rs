//! Finding files on a host: by name, or by what's inside them.
//!
//! `find` and `grep -rn` are what everyone types, and then copies the path out
//! of by hand to do anything with it. This runs them and gives back structured
//! hits, so a result can be opened rather than re-typed.
//!
//! **Bounded on purpose, and visibly.** A recursive grep from `/` on a loaded
//! machine is an attack on yourself; every search carries a depth, a result
//! limit and a `timeout`, and the outcome says when it was cut short — a
//! truncated list presented as a complete one is worse than no search at all.
//!
//! Both halves are pure: [`search_command`] builds the line, [`parse_hits`]
//! reads what came back. The interesting failures — a path containing a colon,
//! a match containing one — are then testable without a server.

use crate::shell::quote;
use serde::{Deserialize, Serialize};

/// How long the remote command may run before being killed, in seconds.
///
/// Generous, because the useful searches are the slow ones (`/var/log`,
/// `/etc`), and partial results are reported as partial rather than lost.
pub const SEARCH_TIMEOUT_SECS: u8 = 20;

/// How deep `find` descends. Six levels reaches essentially everything anyone
/// looks for under `/etc`, `/opt` or a home directory, without walking a
/// mounted filesystem to its floor.
pub const MAX_DEPTH: u8 = 6;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SearchMode {
    /// Match on the file name.
    Name,
    /// Match on the contents, one hit per file.
    Content,
}

/// One result. `line`/`excerpt` are only set for a content search.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub path: String,
    pub line: Option<u32>,
    pub excerpt: Option<String>,
}

/// A search's result, plus whether what came back is the whole story.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchOutcome {
    pub hits: Vec<SearchHit>,
    /// The limit was reached — there are more matches than these.
    pub truncated: bool,
    /// The search was still running when its time ran out. What is here is
    /// real, but nothing says the rest doesn't exist.
    pub timed_out: bool,
}

/// Longest excerpt kept for a match. A minified JS file is one line of half a
/// megabyte, and shipping it back to render it in a 300px list helps nobody.
const MAX_EXCERPT: usize = 200;

pub fn validate_pattern(pattern: &str) -> Result<(), String> {
    let pattern = pattern.trim();
    if pattern.is_empty() {
        return Err("Indiquer ce qu'il faut chercher.".to_string());
    }
    // Everything else is single-quoted, so the only characters that cannot be
    // passed through are the ones that break the line-based protocol itself.
    if pattern.contains('\n') || pattern.contains('\0') {
        return Err("Le motif ne peut pas contenir de saut de ligne.".to_string());
    }
    Ok(())
}

pub fn validate_root(root: &str) -> Result<(), String> {
    let root = root.trim();
    if root.is_empty() {
        return Err("Indiquer un dossier de départ.".to_string());
    }
    if !root.starts_with('/') && !root.starts_with('~') {
        return Err("Le dossier de départ doit être un chemin absolu.".to_string());
    }
    if root.contains('\n') || root.contains('\0') {
        return Err("Chemin invalide.".to_string());
    }
    Ok(())
}

/// The command run on the host.
///
/// `timeout` is used when present and simply skipped when not: the result
/// limit still bounds the output, and refusing to search on a machine without
/// `timeout` would be a worse trade than searching without a stopwatch. The
/// exit status of `timeout` (124) is what [`parse_outcome`] reads to know the
/// answer is partial.
///
/// A name pattern is wrapped in `*` unless it already carries a wildcard —
/// people type `nginx.conf`, not `*nginx.conf*`, and an exact-match-only search
/// finds nothing on the first try, every time.
pub fn search_command(mode: SearchMode, root: &str, pattern: &str, limit: usize) -> String {
    let root = root.trim();
    let pattern = pattern.trim();
    let inner = match mode {
        SearchMode::Name => {
            let globbed = if pattern.contains(['*', '?', '[']) {
                pattern.to_string()
            } else {
                format!("*{pattern}*")
            };
            format!(
                "find {} -maxdepth {MAX_DEPTH} \\( -type f -o -type l \\) -iname {} -print 2>/dev/null",
                quote(root),
                quote(&globbed)
            )
        }
        // `-I` skips binaries (a match inside a .so is noise), `-m 1` keeps one
        // line per file so a single busy log can't fill the whole result list,
        // and `.git` is excluded because searching a checkout otherwise returns
        // the same content twice — once in the tree, once in the object store.
        SearchMode::Content => format!(
            "grep -rnI -m 1 --exclude-dir=.git -e {} -- {} 2>/dev/null",
            quote(pattern),
            quote(root)
        ),
    };
    format!(
        "sh -c {}",
        quote(&format!(
            "if command -v timeout >/dev/null 2>&1; then timeout {SEARCH_TIMEOUT_SECS} sh -c {}; \
             else sh -c {}; fi | head -n {limit}",
            quote(&inner),
            quote(&inner)
        ))
    )
}

/// Reads the hits, and whether the list is the whole story.
///
/// `exit_code` is the pipeline's — with `head` at the end it is `head`'s, so it
/// says nothing about `timeout`; the caller passes what it has and a `124`
/// anywhere in the chain is treated as "cut short".
pub fn parse_outcome(mode: SearchMode, stdout: &str, exit_code: Option<i32>, limit: usize) -> SearchOutcome {
    let hits = parse_hits(mode, stdout);
    SearchOutcome {
        truncated: hits.len() >= limit,
        timed_out: exit_code == Some(124),
        hits,
    }
}

pub fn parse_hits(mode: SearchMode, stdout: &str) -> Vec<SearchHit> {
    stdout
        .lines()
        .filter(|line| !line.trim().is_empty())
        .filter_map(|line| match mode {
            SearchMode::Name => Some(SearchHit {
                path: line.trim_end().to_string(),
                line: None,
                excerpt: None,
            }),
            SearchMode::Content => parse_content_line(line),
        })
        .collect()
}

/// Splits `path:line:content`.
///
/// Not on the first colon: a remote path may perfectly well contain one
/// (`/var/log/app:2/current`), and splitting there yields a path that doesn't
/// exist and a line number that isn't one. The separator is the first
/// `:<digits>:` — which is what `grep -n` guarantees is there.
fn parse_content_line(line: &str) -> Option<SearchHit> {
    let mut from = 0;
    while let Some(offset) = line[from..].find(':') {
        let colon = from + offset;
        let rest = &line[colon + 1..];
        let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
        if !digits.is_empty() && rest[digits.len()..].starts_with(':') {
            let mut excerpt = rest[digits.len() + 1..].trim().to_string();
            if excerpt.chars().count() > MAX_EXCERPT {
                excerpt = excerpt.chars().take(MAX_EXCERPT).collect::<String>() + "…";
            }
            return Some(SearchHit {
                path: line[..colon].to_string(),
                line: digits.parse().ok(),
                excerpt: Some(excerpt),
            });
        }
        from = colon + 1;
    }
    None
}

/// Directory part of a hit's path, for opening it in a file panel.
pub fn parent_of(path: &str) -> &str {
    match path.rfind('/') {
        Some(0) => "/",
        Some(index) => &path[..index],
        None => "/",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The pattern is user input spliced into a command that runs on a server.
    /// It is quoted rather than restricted — someone searching for `it's` is
    /// not an attacker — so the test is that the quoting holds.
    #[test]
    fn a_hostile_pattern_stays_data() {
        let command = search_command(SearchMode::Content, "/etc", "'; rm -rf / ;'", 50);
        assert!(!command.contains("rm -rf / ;'\n"), "obtenu : {command}");
        // The dangerous text survives, escaped, instead of being dropped: a
        // search for that string is a legitimate thing to do.
        assert!(command.contains("rm -rf"), "le motif doit rester cherchable : {command}");
    }

    #[test]
    fn a_name_pattern_gets_wildcards_unless_it_has_them() {
        let plain = search_command(SearchMode::Name, "/etc", "nginx.conf", 50);
        assert!(plain.contains("*nginx.conf*"), "obtenu : {plain}");
        let globbed = search_command(SearchMode::Name, "/etc", "*.conf", 50);
        assert!(!globbed.contains("**.conf*"), "un motif déjà générique est laissé tel quel : {globbed}");
    }

    #[test]
    fn every_search_is_bounded() {
        let command = search_command(SearchMode::Content, "/", "erreur", 50);
        assert!(command.contains("head -n 50"), "le nombre de résultats est borné");
        assert!(command.contains(&format!("timeout {SEARCH_TIMEOUT_SECS}")), "la durée est bornée");
        let name = search_command(SearchMode::Name, "/", "x", 50);
        assert!(name.contains(&format!("-maxdepth {MAX_DEPTH}")), "la profondeur est bornée");
    }

    #[test]
    fn refuses_a_root_that_is_not_absolute() {
        assert!(validate_root("etc").is_err());
        assert!(validate_root("").is_err());
        assert!(validate_root("/etc").is_ok());
        assert!(validate_root("~/projets").is_ok());
    }

    #[test]
    fn reads_a_name_search() {
        let hits = parse_hits(SearchMode::Name, "/etc/nginx/nginx.conf\n/etc/nginx/sites/default.conf\n");
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].path, "/etc/nginx/nginx.conf");
        assert_eq!(hits[0].line, None);
    }

    #[test]
    fn reads_a_content_search() {
        let hits = parse_hits(SearchMode::Content, "/etc/nginx/nginx.conf:42:    server_name example.com;\n");
        assert_eq!(hits[0].path, "/etc/nginx/nginx.conf");
        assert_eq!(hits[0].line, Some(42));
        assert_eq!(hits[0].excerpt.as_deref(), Some("server_name example.com;"));
    }

    /// The case that breaks a naive split: a path with a colon in it, and a
    /// match with colons in it. Splitting on the first colon would report a
    /// file that doesn't exist; splitting on the last would swallow the match.
    #[test]
    fn a_colon_in_the_path_or_in_the_match_does_not_confuse_the_split() {
        let hits = parse_hits(
            SearchMode::Content,
            "/var/log/app:2/current:17:12:30:01 erreur : délai dépassé\n",
        );
        assert_eq!(hits[0].path, "/var/log/app:2/current");
        assert_eq!(hits[0].line, Some(17));
        assert_eq!(hits[0].excerpt.as_deref(), Some("12:30:01 erreur : délai dépassé"));
    }

    /// One minified line can be half a megabyte. Sending it back to render it
    /// in a narrow list helps nobody and costs the whole result set.
    #[test]
    fn a_very_long_match_is_cut_down() {
        let long = "x".repeat(5_000);
        let hits = parse_hits(SearchMode::Content, &format!("/app/bundle.js:1:{long}\n"));
        let excerpt = hits[0].excerpt.as_deref().unwrap();
        assert!(excerpt.chars().count() <= MAX_EXCERPT + 1, "obtenu {} caractères", excerpt.chars().count());
    }

    /// A partial list presented as a complete one is worse than no search: the
    /// answer "it isn't there" would be wrong.
    #[test]
    fn a_cut_short_search_says_so() {
        let outcome = parse_outcome(SearchMode::Name, "/a\n/b\n", Some(124), 50);
        assert!(outcome.timed_out);
        assert!(!outcome.truncated);
        let full = parse_outcome(SearchMode::Name, "/a\n/b\n", Some(0), 2);
        assert!(full.truncated, "autant de résultats que la limite = il y en a d'autres");
        assert!(!full.timed_out);
    }

    #[test]
    fn a_line_grep_could_not_have_produced_is_skipped() {
        assert!(parse_hits(SearchMode::Content, "grep: /root: Permission denied\n").is_empty());
    }

    #[test]
    fn finds_the_directory_to_open() {
        assert_eq!(parent_of("/etc/nginx/nginx.conf"), "/etc/nginx");
        assert_eq!(parent_of("/etc"), "/");
        assert_eq!(parent_of("relatif"), "/");
    }
}
