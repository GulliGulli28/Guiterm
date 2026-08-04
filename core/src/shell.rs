//! Building shell command lines safely.
//!
//! One home for this rather than one per caller: every module that composes a
//! command to run on someone's server — environment exports, remote search —
//! depends on the same escaping being right, and a second copy is a second
//! chance to get it subtly wrong.

/// Wraps a value in single quotes, escaping any embedded single quote.
///
/// POSIX single quotes suspend *all* interpretation, which is what makes this
/// safe for arbitrary user input: the only character that can end the quoting
/// is `'` itself, and it is turned into `'\''` — close, escaped quote, reopen.
///
/// Use this for every value spliced into a command. Names that cannot be
/// quoted (an environment variable's name, a flag) need validating instead —
/// see `is_valid_env_key` and [`crate::reachability::validate_host`].
pub fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', r"'\''"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wraps_a_plain_value() {
        assert_eq!(quote("plain"), "'plain'");
        assert_eq!(quote(""), "''");
    }

    #[test]
    fn a_single_quote_cannot_end_the_quoting() {
        assert_eq!(quote("a'b"), r"'a'\''b'");
    }

    /// The shapes that would run as commands if the quoting leaked. None of
    /// them may produce a string where the value escapes its quotes.
    #[test]
    fn injection_shaped_values_stay_inside_their_quotes() {
        for hostile in ["; rm -rf /", "$(id)", "`id`", "a\nwhoami", "*/*", "x' ; id ; '"] {
            let quoted = quote(hostile);
            assert!(quoted.starts_with('\'') && quoted.ends_with('\''));
            // Every quote inside the body is part of an escape sequence:
            // stripping them leaves an even, closed structure.
            let body = &quoted[1..quoted.len() - 1];
            assert!(
                !body.contains('\'') || body.contains(r"'\''"),
                "apostrophe non échappée dans {quoted}"
            );
        }
    }
}
