//! Recording a terminal session to disk as it happens.
//!
//! **Not the same thing as the existing scrollback export.** That one snapshots
//! whatever xterm still holds in memory, on demand: bounded by the scrollback
//! setting, with no timing, and gone if the app dies. This writes every byte
//! the session produces to a file as it arrives — so it survives the buffer
//! rolling over, survives a crash, and can be replayed at the speed it
//! actually happened. Those three properties are the whole point; if all you
//! want is "give me the text on screen", the export already does that.
//!
//! **Format: asciicast v2** (the format `asciinema` itself writes) — a JSON
//! header line, then one JSON array per output chunk: `[elapsed, "o", text]`.
//! Chosen over a hand-rolled format because it is already readable by
//! existing tooling (`asciinema play`/`cat`, the web player), which is what
//! makes a recording worth more than a bigger scrollback. Plain text remains
//! one `asciinema cat` away.
//!
//! Only *output* is recorded, never input (`"i"` events). A recording is for
//! showing what a machine did; capturing keystrokes would put every password
//! typed at an interactive prompt into a plain file on disk.
use std::io::Write;
use std::path::Path;
use std::time::Instant;

/// An open recording. Dropping it stops recording but does **not** guarantee
/// the tail reached disk — call [`finish`](SessionRecorder::finish).
pub struct SessionRecorder {
    writer: std::io::BufWriter<std::fs::File>,
    started: Instant,
    /// Where this is being written — kept so stopping can close the matching
    /// entry in [`crate::session_index`] without the caller having to hand the
    /// path back. The stop command only knows a terminal session id, and
    /// trusting the frontend to return the same path it passed at start would
    /// make the index silently wrong the day it didn't.
    path: std::path::PathBuf,
}

impl SessionRecorder {
    /// Creates `path` and writes the asciicast header.
    ///
    /// `cols`/`rows` are the terminal size at the moment recording starts —
    /// a player needs them to lay the replay out, and a session resized later
    /// is an accepted inaccuracy for a first version (asciicast can carry
    /// `"r"` resize events; nothing here emits them yet).
    pub fn create(path: &Path, cols: u16, rows: u16) -> std::io::Result<Self> {
        let file = std::fs::File::create(path)?;
        let mut writer = std::io::BufWriter::new(file);
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let header = serde_json::json!({
            "version": 2,
            "width": cols,
            "height": rows,
            "timestamp": timestamp,
            "env": { "TERM": "xterm-256color" },
        });
        writeln!(writer, "{header}")?;
        writer.flush()?;
        Ok(Self { writer, started: Instant::now(), path: path.to_path_buf() })
    }

    /// The file being written.
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Appends one output chunk.
    ///
    /// Invalid UTF-8 is replaced rather than dropped: a terminal stream can be
    /// cut mid-multi-byte-character at a chunk boundary, and losing the whole
    /// chunk over that would silently punch holes in the recording. The
    /// replacement character is what a player would render anyway.
    ///
    /// Flushed on every chunk — the buffer's job here is to coalesce the two
    /// `write` calls per event, not to hold data back. A recording that loses
    /// its last seconds to a crash would fail at exactly the moment it is most
    /// wanted.
    pub fn write_output(&mut self, bytes: &[u8]) -> std::io::Result<()> {
        let text = String::from_utf8_lossy(bytes);
        let elapsed = self.started.elapsed().as_secs_f64();
        // `serde_json` does the escaping — terminal output is full of control
        // bytes and quotes, and a hand-rolled escape here would be a
        // corrupt-file bug waiting to happen.
        let event = serde_json::json!([elapsed, "o", text]);
        writeln!(self.writer, "{event}")?;
        self.writer.flush()
    }

    pub fn finish(mut self) -> std::io::Result<()> {
        self.writer.flush()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines(path: &Path) -> Vec<String> {
        std::fs::read_to_string(path).unwrap().lines().map(str::to_string).collect()
    }

    #[test]
    fn writes_an_asciicast_header_then_one_event_per_chunk() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s.cast");
        let mut rec = SessionRecorder::create(&path, 120, 40).unwrap();
        rec.write_output(b"hello").unwrap();
        rec.write_output(b"world").unwrap();
        rec.finish().unwrap();

        let lines = lines(&path);
        assert_eq!(lines.len(), 3);
        let header: serde_json::Value = serde_json::from_str(&lines[0]).unwrap();
        assert_eq!(header["version"], 2);
        assert_eq!(header["width"], 120);
        assert_eq!(header["height"], 40);

        let first: serde_json::Value = serde_json::from_str(&lines[1]).unwrap();
        assert_eq!(first[1], "o");
        assert_eq!(first[2], "hello");
    }

    // Control characters and quotes are the normal case in terminal output,
    // not an edge case — the file has to stay parseable through them.
    #[test]
    fn escapes_control_bytes_and_quotes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s.cast");
        let mut rec = SessionRecorder::create(&path, 80, 24).unwrap();
        rec.write_output(b"\x1b[31m\"rouge\"\r\n").unwrap();
        rec.finish().unwrap();

        let lines = lines(&path);
        let event: serde_json::Value = serde_json::from_str(&lines[1]).expect("ligne JSON valide");
        assert_eq!(event[2], "\u{1b}[31m\"rouge\"\r\n");
    }

    // A chunk boundary can fall inside a multi-byte character; the recording
    // keeps going rather than losing the chunk.
    #[test]
    fn replaces_invalid_utf8_instead_of_dropping_the_chunk() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s.cast");
        let mut rec = SessionRecorder::create(&path, 80, 24).unwrap();
        rec.write_output(&[b'a', 0xE2, 0x82]).unwrap();
        rec.finish().unwrap();

        let event: serde_json::Value = serde_json::from_str(&lines(&path)[1]).unwrap();
        assert!(event[2].as_str().unwrap().starts_with('a'));
    }

    #[test]
    fn timestamps_are_monotonic_and_start_near_zero() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s.cast");
        let mut rec = SessionRecorder::create(&path, 80, 24).unwrap();
        rec.write_output(b"a").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        rec.write_output(b"b").unwrap();
        rec.finish().unwrap();

        let lines = lines(&path);
        let t0: f64 = serde_json::from_str::<serde_json::Value>(&lines[1]).unwrap()[0].as_f64().unwrap();
        let t1: f64 = serde_json::from_str::<serde_json::Value>(&lines[2]).unwrap()[0].as_f64().unwrap();
        assert!(t0 < 1.0, "premier événement à {t0}");
        assert!(t1 > t0, "{t1} devrait suivre {t0}");
    }
}
