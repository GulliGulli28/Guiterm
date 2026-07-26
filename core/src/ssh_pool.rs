//! Reuse of live SSH connections across everything that needs one.
//!
//! **The problem.** Every feature that talks SSH used to call
//! [`ssh::connect`] for itself: a terminal tab, a transfer pane, a tunnel, a
//! tunnelled SQL/Redis/MongoDB session, a fleet run, a facts collection, a key
//! deployment. Opening a terminal, a transfer pane and a tunnel on one host
//! therefore meant three TCP connections, three key exchanges, three
//! authentications and three `known_hosts` checks against the same server —
//! and three times that again for a host reached through two bastions, since
//! every hop is redialled. This is what OpenSSH's `ControlMaster` exists to
//! avoid: SSH multiplexes channels over one connection natively, so the extra
//! handshakes buy nothing.
//!
//! **The shape.** [`acquire`] hands out an [`SshLease`], which derefs to a
//! [`Connection`]. Leases for the same host share one connection until it is
//! carrying [`MAX_LEASES_PER_CONNECTION`] of them, at which point the next
//! caller gets a second connection (and so on).
//!
//! **Why an overflow limit rather than strictly one connection per host.**
//! `sshd`'s `MaxSessions` (10 by default) caps how many shell/exec/subsystem
//! channels a *single* connection may carry. Multiplexing without a limit
//! would turn "the 11th tab on this host" from something that just worked
//! (11 connections, one channel each) into a hard failure — a regression for
//! exactly the heaviest users. Overflowing to a second connection keeps the
//! saving in the common case with no ceiling. The limit is deliberately below
//! `MaxSessions`: port forwards are leased here too but open `direct-tcpip`
//! channels, which `MaxSessions` does *not* count, so the headroom absorbs
//! that approximation.
//!
//! **Lifetime.** The pool holds only [`Weak`] references. A connection stays
//! alive exactly as long as at least one lease for it does, and closes when
//! the last one drops — the same lifetime a directly-opened connection had
//! before, so closing every tab on a host still closes its connection rather
//! than leaving an idle one parked in a cache.
use crate::model::{HostId, Workspace};
use crate::ssh::{self, Connection};
use crate::sync_ext::MutexExt;
use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, LazyLock, Mutex, Weak};

/// Leases one connection may carry before the next caller opens another. See
/// the module docs for why this sits below `sshd`'s default `MaxSessions`.
const MAX_LEASES_PER_CONNECTION: usize = 8;

/// A pooled connection plus its live lease count.
struct Pooled {
    connection: Arc<Connection>,
    leases: AtomicUsize,
}

/// Claims a lease slot on `leases` if the connection has room, reporting
/// whether it got one.
///
/// `fetch_update` rather than load-then-store: two tasks reaching the same
/// connection concurrently must not both be handed the last free slot.
fn try_claim_lease(leases: &AtomicUsize) -> bool {
    leases
        .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |n| {
            (n < MAX_LEASES_PER_CONNECTION).then_some(n + 1)
        })
        .is_ok()
}

/// A borrowed connection. Derefs to [`Connection`], so callers use it exactly
/// as they used the owned connection they had before.
///
/// **Hold it for as long as you use the connection.** Dropping the last lease
/// on a connection closes it — a caller that keeps a bare
/// `Arc<Connection>` from [`SshLease::connection`] but drops the lease has a
/// connection nothing accounts for. Anything long-lived (a shell session, a
/// pane, a tunnel) stores the lease alongside whatever it opened.
pub struct SshLease {
    pooled: Arc<Pooled>,
}

impl SshLease {
    /// The underlying connection as a shared handle, for the APIs that take
    /// `Arc<Connection>` (e.g. `port_forward::start`). The lease must outlive
    /// any clone of this — see the type's doc comment.
    pub fn connection(&self) -> Arc<Connection> {
        self.pooled.connection.clone()
    }
}

impl std::ops::Deref for SshLease {
    type Target = Connection;

    fn deref(&self) -> &Connection {
        &self.pooled.connection
    }
}

impl Drop for SshLease {
    fn drop(&mut self) {
        self.pooled.leases.fetch_sub(1, Ordering::Relaxed);
    }
}

/// Per-host connection list. The outer map is guarded by a `std::sync::Mutex`
/// held only for the lookup; the inner `tokio::sync::Mutex` is held across the
/// actual (async) connect, so two callers racing for the same host produce one
/// connection instead of two — while different hosts still connect in
/// parallel, which a single global async lock would have serialised (fleet
/// runs dial dozens of hosts at once).
type HostSlot = Arc<tokio::sync::Mutex<Vec<Weak<Pooled>>>>;

#[derive(Default)]
struct SshPool {
    hosts: Mutex<HashMap<HostId, HostSlot>>,
}

static POOL: LazyLock<SshPool> = LazyLock::new(SshPool::default);

/// Returns a lease on a connection to `host_id`, reusing a live one when there
/// is room on it and opening a new one otherwise.
pub async fn acquire(workspace: &Workspace, host_id: HostId) -> anyhow::Result<SshLease> {
    let slot: HostSlot = {
        let mut hosts = POOL.hosts.lock_recover();
        hosts.entry(host_id).or_default().clone()
    };
    let mut connections = slot.lock().await;

    // Drop entries whose last lease has gone (the `Weak` no longer upgrades)
    // and any connection the server or the network has since closed — reusing
    // a dead one would fail on channel open instead of reconnecting.
    connections.retain(|weak| weak.upgrade().is_some_and(|p| p.connection.is_alive()));

    for weak in connections.iter() {
        let Some(pooled) = weak.upgrade() else { continue };
        if try_claim_lease(&pooled.leases) {
            tracing::debug!(host = %host_id, "connexion SSH réutilisée depuis le pool");
            return Ok(SshLease { pooled });
        }
    }

    let pooled = Arc::new(Pooled {
        connection: Arc::new(ssh::connect(workspace, host_id).await?),
        leases: AtomicUsize::new(1),
    });
    connections.push(Arc::downgrade(&pooled));
    Ok(SshLease { pooled })
}

#[cfg(test)]
mod tests {
    use super::*;

    // The lease accounting is what decides reuse vs. overflow, and it's the
    // part that would silently regress into either a `MaxSessions` failure or
    // a connection-per-caller. Tested against the counter directly: building a
    // real `Connection` needs a live server, and there is no honest way to
    // fake one (it owns `russh` session handles). `acquire`'s connect path is
    // covered end to end by `core/tests/ssh_integration.rs` against a real
    // sshd.

    #[test]
    fn a_connection_accepts_up_to_the_limit_then_refuses() {
        let leases = AtomicUsize::new(0);
        for i in 0..MAX_LEASES_PER_CONNECTION {
            assert!(try_claim_lease(&leases), "lease {i} should fit");
        }
        assert!(!try_claim_lease(&leases), "the limit must trigger an overflow connection");
    }

    #[test]
    fn releasing_a_lease_frees_a_slot() {
        let leases = AtomicUsize::new(0);
        for _ in 0..MAX_LEASES_PER_CONNECTION {
            assert!(try_claim_lease(&leases));
        }
        // What `SshLease::drop` does.
        leases.fetch_sub(1, Ordering::Relaxed);
        assert!(try_claim_lease(&leases), "a released slot must be reusable");
    }

    #[test]
    fn concurrent_claims_never_exceed_the_limit() {
        // The whole point of `fetch_update` over load-then-store: hammer one
        // counter from several threads and check the cap held exactly.
        let leases = Arc::new(AtomicUsize::new(0));
        let granted = Arc::new(AtomicUsize::new(0));
        std::thread::scope(|scope| {
            for _ in 0..8 {
                let leases = leases.clone();
                let granted = granted.clone();
                scope.spawn(move || {
                    for _ in 0..50 {
                        if try_claim_lease(&leases) {
                            granted.fetch_add(1, Ordering::Relaxed);
                        }
                    }
                });
            }
        });
        assert_eq!(granted.load(Ordering::Relaxed), MAX_LEASES_PER_CONNECTION);
        assert_eq!(leases.load(Ordering::Relaxed), MAX_LEASES_PER_CONNECTION);
    }
}
