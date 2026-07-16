# Adding RDP to a Rust SSH client, one process removed

*How [Guiterm](https://github.com/GulliGulli28/Guiterm) — a desktop
SSH/SFTP client built with Tauri and Rust — ended up shipping its RDP
viewer as an entirely separate process, and the three real bugs that only
showed up once it talked to an actual RDP server.*

## The problem: two exact-pinned versions of the same crate

Guiterm already had a solid SSH story built on
[`russh`](https://github.com/Eugeny/russh), a pure-Rust SSH implementation —
no shelling out to a system `ssh` binary, no OpenSSL. Adding an integrated
RDP viewer felt like the natural next step: instead of launching `mstsc.exe`
or `xfreerdp` as an external process and losing all control over the
window, render the remote desktop directly inside the app, the same way the
terminal tabs already render SSH output.

[IronRDP](https://github.com/Devolutions/IronRDP) is the obvious Rust
choice for the client side. So, naively:

```toml
[dependencies]
termius-core = { path = "../core" }   # already depends on russh
ironrdp = { version = "0.16", features = ["connector", "session", ...] }
```

`cargo check` never gets past dependency resolution:

```
error: failed to select a version for `ecdsa`.
  ... required by package `russh v0.61.0`
    ... which satisfies dependency `russh = "0.61"`
  versions that meet the requirements `=0.17.0-rc.18` are: 0.17.0-rc.18

  all possible versions conflict with previously selected packages.

  previously selected package `ecdsa v0.17.0-rc.22`
    ... which satisfies dependency `ecdsa = "=0.17.0-rc.22"`
      ... required by package `picky-asn1-x509`
        ... which satisfies dependency `picky-asn1-x509 = "..."`
          ... required by package `ironrdp-connector`
```

`russh` pins `ecdsa = "=0.17.0-rc.18"`. `ironrdp-connector`, via `picky`
(a crate it uses for X.509/certificate handling), pins
`ecdsa = "=0.17.0-rc.22"`. Both are **exact** pins (`=`), not a minimum
version — Cargo isn't refusing to look for a compatible version, there
isn't one. Two different exact prereleases of the same crate simply cannot
both be a dependency of one build.

This is the kind of error that's tempting to assume will fix itself: surely
one of these is a couple of weeks from bumping. It isn't. I checked both
the latest published release of `picky` and its `master` branch — still
pinned to `rc.22`, still misaligned with whatever `russh` happens to pin at
any given time. This isn't a "wait for the next release" problem, it's a
structural one: as long as both crates independently pin an exact
prerelease of a shared low-level dependency, any project that needs both
will hit this, regardless of when you try it.

## First attempt: a plain workspace member (didn't work)

The instinctive fix is to put the RDP code in its own crate and just not
depend on `termius-core`/`russh` from it:

```toml
# root Cargo.toml
[workspace]
members = ["core", "src-tauri", "rdp-sidecar"]
```

```toml
# rdp-sidecar/Cargo.toml — no path dependency on core at all
[dependencies]
ironrdp = { version = "0.16", features = [...] }
```

Still fails, with the exact same `ecdsa` error. The reason is easy to miss
if you haven't hit it before: **Cargo resolves one unified dependency graph
per workspace**, across every member, whether or not they depend on each
other. `rdp-sidecar` not depending on `core` doesn't matter — `core` is
still a workspace member, `russh` is still somewhere in that one shared
graph, and so is `ironrdp-connector` via `rdp-sidecar`. Same conflict,
just discovered one directory later.

## The actual fix: a genuinely separate Cargo workspace

The only real isolation boundary in Cargo is a **separate `[workspace]`
block with its own `Cargo.lock`**:

```toml
# rdp-sidecar/Cargo.toml
[workspace]
members = ["."]

[package]
name = "rdp-sidecar"
edition = "2024"

[dependencies]
rdp-ipc = { path = "../rdp-ipc" }
ironrdp = { version = "0.16", features = [...] }
# ...
```

`rdp-sidecar` is declared as its *own* workspace, deliberately left out of
the root workspace's `members`. Cargo resolves it completely independently
— its own lockfile, its own dependency graph, `ecdsa = "=0.17.0-rc.22"` and
`russh`'s `"=0.17.0-rc.18"` never have to coexist anywhere. The two halves
of the app are connected only through an ordinary `path` dependency to a
third, tiny crate — `rdp-ipc` — that has nothing risky in it (`tokio` +
`serde`/`serde_json`, nothing else), so sharing it between both workspaces
never reintroduces the conflict:

```
Cargo.toml (root workspace: core, src-tauri, rdp-ipc)
  └─ src-tauri depends on rdp-ipc (path) — never on rdp-sidecar
rdp-sidecar/Cargo.toml (separate [workspace], members = ["."])
  └─ depends on rdp-ipc (path) + ironrdp — never on core/russh
```

In practice this means the RDP viewer runs as a genuinely separate OS
process, spawned as a Tauri sidecar
(`tauri_plugin_shell`'s `Command::sidecar("rdp-sidecar")`), talking to the
main app over stdin/stdout with a small hand-rolled protocol (`rdp-ipc`):
JSON-lines for control messages going in (connect request, then a stream of
mouse/keyboard/wheel/resize events), and a tag-plus-length-prefixed binary
framing for frames coming out — plain newline-delimited JSON doesn't work
there since raw pixel data can contain any byte, including `\n`.

One consequence worth calling out explicitly for CI: the root workspace's
`cargo build --workspace` / `cargo clippy --workspace` **never touch**
`rdp-sidecar` at all, by design. If your CI only runs those, a warning or
even a compile error inside the sidecar crate passes silently. It needs its
own explicit `cargo clippy`/`cargo test` step, in its own directory, with
its own cache key — easy to forget once, since everything still looks green.

## Bug #1: the crypto provider panic

Compiling cleanly and *working* turned out to be two different questions,
which shouldn't be surprising but is easy to forget when clippy has been
green for a while. The very first real connection attempt — clicking
"integrated preview" against an actual RDP server — panicked immediately:

```
Could not automatically determine the process-level CryptoProvider
from Rustls crate features
```

`rustls` 0.23 has pluggable crypto backends (`ring`, `aws-lc-rs`). If more
than one ends up in the dependency graph — which happens here, because
`reqwest` and `ironrdp-tls` don't agree on a default — rustls refuses to
silently pick one for you; you have to install a default explicitly, once,
before any TLS handshake happens. Fix was one line at the very top of
`main()`:

```rust
rustls::crypto::ring::default_provider()
    .install_default()
    .expect("failed to install rustls crypto provider");
```

Small fix, but the only way to have found it was to actually run a
connection against a real server — nothing about the type signatures or
the clean compile hinted at it.

## Bug #2: a permanently black screen after resizing

The trickiest one. Dynamic resize (resize the app's tab, the remote desktop
resolution follows) worked by asking the server to renegotiate through
MS-RDPBCGR's Deactivation-Reactivation sequence — a mini replay of the
capability-exchange/finalization handshake that happens right after the
initial connection. The first version rebuilt the fast-path decoder
(including its bulk-compression decompressor) from scratch every time this
sequence ran, on the theory that a fresh reactivation should get a fresh
decoder state.

It didn't crash. It just went black — permanently, with no error — the
first time a resize happened during a real session, and stayed black for
the rest of the session.

The actual cause took a `RUST_LOG=ironrdp_session=debug` session (plumbed
through from the parent process specifically to debug this) to find:
compression here uses MPPC, a *stateful*, streaming compression scheme —
its dictionary/history has to stay continuous with what the server thinks
it's sent. Rebuilding the decompressor on every reactivation reset that
history to empty, while the server kept compressing against its own
continuous one. The resulting decompressed bytes came out the right
*length* — length only depends on the compressed bitstream itself, not on
decoder history — but the wrong *content*, and a few frames later something
downstream failed to parse a structurally invalid `BitmapData`. Compression
state doesn't get renegotiated by a Deactivation-Reactivation sequence;
only capabilities and the drawing surface do.

The fix was to stop rebuilding the fast-path processor at all across a
reactivation — leave the existing one (decompressor, pointer cache, palette,
all of it) exactly where it was, and only patch the two or three fields that
genuinely do change (the new share ID, the new desktop size) through the
setters the library already exposes for that. Less code than the "proper"
rebuild, and the actual correct behavior.

## Bug #3: a clipboard backend that needs its own message loop

Bidirectional clipboard sync (Windows-only — the underlying library has no
non-Windows backend) turned into a threading problem rather than a protocol
one. The Windows clipboard backend needs to receive `WM_CLIPBOARDUPDATE`
notifications, which only arrive at a real window that's pumping Win32
messages (`GetMessageW`/`DispatchMessageW`) — something a plain Tokio
process, with no window of its own, doesn't have anywhere. The reference
IronRDP client gets this for free because it already has an application
window (it's built on `winit`); a headless sidecar process doesn't.

The backend object itself also can't cross threads (it's tied to the
window/thread that created it). So: spawn one dedicated OS thread purely to
own the clipboard window and run its message loop forever, build the
platform-specific backend on that thread, and hand the *factory* it
produces back to the async side through a one-shot channel — that part
*can* cross threads, so the rest of the app just awaits it once at startup
like any other async value.

## What generalizes

A few things from this that seem useful beyond this one project:

- **An exact version pin (`=x.y.z`) two dependencies away from each other is
  a hard conflict, not a "wait for a release" problem.** Check whether it's
  actually moving before assuming it will resolve itself.
- **A workspace member that merely avoids a direct dependency doesn't
  isolate anything.** Cargo unifies resolution across every member of one
  workspace regardless of who depends on whom. Real isolation is a
  genuinely separate `[workspace]`, connected back only through an ordinary
  `path` dependency to something deliberately dependency-light.
- **A clean `cargo check`/`clippy` proves nothing about runtime behavior.**
  All three bugs above compiled without a single warning. Two of them
  (the crypto panic, the black screen) only existed under real, live network
  conditions no unit test reached — there's no substitute for actually
  running the thing against a real server once in a while.

The full protocol, the fast-path/clipboard code, and the rest of
Guiterm are on GitHub:
**[github.com/GulliGulli28/Guiterm](https://github.com/GulliGulli28/Guiterm)**
— MIT-licensed, contributions welcome.
