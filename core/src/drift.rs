//! Configuration drift: which hosts no longer match the state you described.
//!
//! **The wanted state is an ordinary DSL program**, read as assertions instead
//! of actions — `install-package nginx` says nginx *should be* installed,
//! `remove-package telnet` says it should not. No second language: the text
//! that describes a fleet is the same text that repairs it, so a drift found
//! here is fixed by running what was already written (and, since the rollback
//! landed, undone the same way).
//!
//! **Three verdicts, never two.** Conforme, écart, and *indéterminé* — the
//! last one covering operations that assert nothing persistent, platforms the
//! probe doesn't speak, and checks that would need privileges we don't have.
//! Folding "couldn't look" into "conforme" is the failure this module is
//! shaped to avoid: a fleet reported as compliant because nobody could
//! actually check is worse than no report at all.
//!
//! **One round trip per host, not per operation.** Every check a host needs is
//! composed into a single `sh` script that prints one `CHECK<i>=` line each,
//! parsed back here — the same shape as [`crate::facts::PROBE`]. A fifty-host
//! fleet with eight operations is fifty commands, not four hundred.
//!
//! **On demand only.** Nothing here runs on a timer: a desktop app quietly
//! probing fifty machines in the background is a nuisance to the network it is
//! supposed to help you manage. Whether that ever becomes periodic is a
//! question to answer with measurements, not upfront.

use crate::adaptive::{Assertion, HostContext, Program, check_command, render_operation, statement_applies};
use crate::fleet::{self, HostOutcome};
use crate::model::{HostId, Workspace};
use serde::Serialize;
use std::sync::Arc;

/// What one check found.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Verdict {
    /// The wanted state already holds.
    Matches,
    /// It doesn't — this is the drift.
    Drifted,
    /// Nobody could tell, and why. Never silently counted as either.
    Unknown { reason: String },
}

/// One line of the wanted state, and what the host had to say about it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckOutcome {
    /// The DSL line as written, e.g. `install-package nginx` — what the user
    /// recognises, rather than the shell it was turned into.
    pub operation: String,
    pub verdict: Verdict,
}

/// One host's answer to the whole program.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostDrift {
    pub host_id: HostId,
    pub checks: Vec<CheckOutcome>,
    /// Set when the host couldn't be reached or the probe failed outright, in
    /// which case `checks` is whatever was decided locally (unobservable ones).
    pub error: Option<String>,
}

impl HostDrift {
    /// Whether this host needs fixing. Unknown verdicts deliberately don't
    /// count: "we couldn't check" must not put a host on the list of things to
    /// repair, nor take it off.
    pub fn has_drifted(&self) -> bool {
        self.checks.iter().any(|c| c.verdict == Verdict::Drifted)
    }
}

/// One statement's check, resolved against a platform before anything runs.
struct Planned {
    operation: String,
    /// `None` when the verdict is already known locally (nothing to assert, or
    /// unobservable) — such a check costs no round trip.
    remote: Option<String>,
    local_verdict: Option<Verdict>,
}

/// Builds the probe script for one host, plus the verdicts already decided
/// without asking it.
///
/// Only statements whose conditions match this host are considered: a program
/// scoped to Debian says nothing about an Alpine host, and reporting the
/// latter as drifted would make every mixed fleet look broken.
fn plan_for_host(program: &Program, platform_key: &str, ctx: HostContext) -> Vec<Planned> {
    program
        .iter()
        .filter(|statement| statement_applies(statement, ctx))
        .map(|statement| {
            let operation = render_operation(&statement.operation);
            match check_command(&statement.operation, platform_key) {
                Assertion::Check(check) => Planned { operation, remote: Some(check), local_verdict: None },
                Assertion::NothingToAssert => Planned {
                    operation,
                    remote: None,
                    local_verdict: Some(Verdict::Unknown {
                        reason: "cette opération ne laisse pas d'état à comparer".to_string(),
                    }),
                },
                Assertion::Unobservable { reason } => Planned {
                    operation,
                    remote: None,
                    local_verdict: Some(Verdict::Unknown { reason: reason.to_string() }),
                },
            }
        })
        .collect()
}

/// The single script a host runs: one `CHECK<i>=ok|ko` line per remote check.
///
/// Indexed rather than named because a program may assert the same operation
/// twice, and because an operation's text could otherwise collide with the
/// parser's own syntax. `set -e` is deliberately *not* used: a check that
/// exits non-zero is an answer, not a failure to abort on.
fn build_script(planned: &[Planned]) -> String {
    let mut lines = Vec::new();
    for (index, item) in planned.iter().enumerate() {
        if let Some(check) = &item.remote {
            lines.push(format!(
                "if {check}; then echo 'CHECK{index}=ok'; else echo 'CHECK{index}=ko'; fi"
            ));
        }
    }
    lines.join("; ")
}

/// Reads the probe's stdout back into one verdict per planned check.
///
/// A remote check whose line never arrived is `Unknown`, not `Drifted`:
/// truncated output, a shell that swallowed it, a host that died mid-probe —
/// none of those are evidence about the machine's state, and calling them
/// drift would send someone repairing something that may be fine.
fn read_verdicts(planned: Vec<Planned>, stdout: &str) -> Vec<CheckOutcome> {
    let mut answers = std::collections::HashMap::new();
    for line in stdout.lines() {
        let line = line.trim();
        let Some(rest) = line.strip_prefix("CHECK") else { continue };
        let Some((index, value)) = rest.split_once('=') else { continue };
        let Ok(index) = index.parse::<usize>() else { continue };
        answers.insert(index, value.trim().to_string());
    }

    planned
        .into_iter()
        .enumerate()
        .map(|(index, item)| {
            let verdict = match item.local_verdict {
                Some(verdict) => verdict,
                None => match answers.get(&index).map(String::as_str) {
                    Some("ok") => Verdict::Matches,
                    Some("ko") => Verdict::Drifted,
                    _ => Verdict::Unknown {
                        reason: "la sonde n'a pas rendu de réponse pour cette ligne".to_string(),
                    },
                },
            };
            CheckOutcome { operation: item.operation, verdict }
        })
        .collect()
}

/// Checks `program` against every host in `host_ids`.
///
/// SSH only, same gate as the fleet executor and for the same reason: the
/// per-host evaluation needs the persisted facts only SSH hosts carry.
pub async fn check(
    workspace: Arc<Workspace>,
    host_ids: Vec<HostId>,
    program: &Program,
    concurrency: usize,
) -> Vec<HostDrift> {
    let mut plans: std::collections::HashMap<HostId, Vec<Planned>> = std::collections::HashMap::new();
    let mut commands: std::collections::HashMap<fleet::FleetTarget, String> = std::collections::HashMap::new();
    let mut decided_locally: Vec<HostDrift> = Vec::new();

    for host_id in host_ids {
        let host = workspace.host(host_id);
        let facts = host.and_then(|h| h.last_facts.as_ref());
        let platform_key = facts
            .and_then(|f| f.os_id.clone())
            .unwrap_or_else(|| "unknown".to_string());
        let ctx = HostContext {
            facts,
            name: host.map(|h| h.label.as_str()).unwrap_or(""),
            tags: host.map(|h| h.tags.as_slice()).unwrap_or(&[]),
            profile: host
                .and_then(|h| h.proxy_command.as_deref())
                .and_then(crate::aws_inventory::profile_in_command),
        };

        let planned = plan_for_host(program, &platform_key, ctx);
        let script = build_script(&planned);
        if script.is_empty() {
            // Nothing to ask this host — every applicable check was decided
            // here. Skipping the connection entirely is the point: an
            // unprobeable host shouldn't cost an SSH handshake to learn that.
            decided_locally.push(HostDrift {
                host_id,
                checks: read_verdicts(planned, ""),
                error: None,
            });
            continue;
        }
        commands.insert(fleet::FleetTarget::Ssh { host_id }, script);
        plans.insert(host_id, planned);
    }

    if commands.is_empty() {
        return decided_locally;
    }

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<HostOutcome>();
    fleet::run_on_hosts(workspace, commands, concurrency, tx).await;

    let mut out = decided_locally;
    while let Some(outcome) = rx.recv().await {
        let fleet::FleetTarget::Ssh { host_id } = outcome.target else {
            continue;
        };
        let Some(planned) = plans.remove(&host_id) else { continue };
        // A failed probe still reports the checks decided locally, so an
        // unreachable host doesn't lose the "nothing to assert" lines it would
        // have had anyway.
        let error = outcome.error.clone();
        out.push(HostDrift {
            host_id,
            checks: read_verdicts(planned, &outcome.stdout),
            error,
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adaptive::parse_program;

    fn plan(source: &str, platform: &str) -> Vec<Planned> {
        let program = parse_program(source).unwrap();
        plan_for_host(&program, platform, HostContext::default())
    }

    #[test]
    fn a_matching_check_reads_as_conforme_and_a_failing_one_as_drift() {
        let planned = plan("install-package nginx\n\ncreate-directory /srv/app", "debian");
        let outcomes = read_verdicts(planned, "CHECK0=ok\nCHECK1=ko\n");

        assert_eq!(outcomes[0].verdict, Verdict::Matches);
        assert_eq!(outcomes[1].verdict, Verdict::Drifted);
        assert_eq!(outcomes[1].operation, "create-directory /srv/app");
    }

    /// The rule the module exists for: an operation that asserts nothing must
    /// not be reported as compliant. "We didn't look" and "it's fine" are
    /// different answers.
    #[test]
    fn an_operation_with_nothing_to_assert_is_unknown_not_conforme() {
        let planned = plan("update-packages\n\nreboot\n\nrestart-service nginx", "debian");
        let outcomes = read_verdicts(planned, "");

        assert_eq!(outcomes.len(), 3);
        for outcome in &outcomes {
            assert!(
                matches!(outcome.verdict, Verdict::Unknown { .. }),
                "{} devrait être indéterminé, obtenu {:?}",
                outcome.operation,
                outcome.verdict
            );
        }
    }

    /// Reading the firewall needs root, so a verdict would be a guess. Same
    /// reasoning as above: better indéterminé than confidently wrong.
    #[test]
    fn a_check_needing_privileges_is_unknown_rather_than_attempted() {
        let planned = plan("open-port 443", "debian");
        assert!(planned[0].remote.is_none(), "aucune commande ne doit partir sur l'hôte");
        let outcomes = read_verdicts(planned, "");
        match &outcomes[0].verdict {
            Verdict::Unknown { reason } => assert!(reason.contains("privilèges"), "{reason}"),
            other => panic!("attendu indéterminé, obtenu {other:?}"),
        }
    }

    /// A platform the probe doesn't speak reports as unknown — never as
    /// compliant, which would declare a Windows host in order because nothing
    /// could be run on it.
    #[test]
    fn a_platform_the_probe_does_not_speak_is_unknown() {
        let planned = plan("install-package nginx", "windows");
        let outcomes = read_verdicts(planned, "");
        assert!(matches!(outcomes[0].verdict, Verdict::Unknown { .. }));
    }

    /// Missing output is not evidence of drift. Truncation, a dead host, a
    /// shell that ate the line — repairing on that basis would change a machine
    /// nobody looked at.
    #[test]
    fn a_check_with_no_answer_is_unknown_not_drifted() {
        let planned = plan("install-package nginx\n\ninstall-package curl", "debian");
        let outcomes = read_verdicts(planned, "CHECK0=ok\n");

        assert_eq!(outcomes[0].verdict, Verdict::Matches);
        assert!(matches!(outcomes[1].verdict, Verdict::Unknown { .. }));
    }

    /// A program scoped to Debian says nothing about an Alpine host; counting
    /// it would make every mixed fleet look broken.
    #[test]
    fn a_statement_whose_conditions_exclude_the_host_is_not_checked() {
        let program = parse_program("target os: debian\ninstall-package nginx").unwrap();
        let facts = crate::model::HostFacts {
            os_id: Some("alpine".to_string()),
            ..Default::default()
        };
        let planned = plan_for_host(&program, "alpine", HostContext::facts_only(Some(&facts)));
        assert!(planned.is_empty());
    }

    #[test]
    fn the_negative_form_asserts_the_opposite() {
        let installed = plan("install-package nginx", "debian");
        let removed = plan("remove-package nginx", "debian");

        let yes = installed[0].remote.clone().unwrap();
        let no = removed[0].remote.clone().unwrap();
        assert!(no.contains(&yes), "la forme négative doit envelopper la positive : {no}");
        assert!(no.starts_with("! "), "{no}");
    }

    /// One script, not one per operation — the difference between fifty SSH
    /// commands and four hundred.
    #[test]
    fn every_check_of_a_host_travels_in_a_single_script() {
        let planned = plan("install-package nginx\n\ncreate-user deploy\n\ncreate-directory /srv/app", "debian");
        let script = build_script(&planned);

        assert_eq!(script.matches("CHECK").count(), 6, "deux echo par check : {script}");
        assert!(!script.contains('\n'), "une seule ligne, exécutable telle quelle : {script}");
    }

    /// Nothing to ask means nothing to connect for.
    #[test]
    fn a_program_with_only_local_verdicts_needs_no_script() {
        assert_eq!(build_script(&plan("update-packages\n\nreboot", "debian")), "");
    }

    #[test]
    fn has_drifted_ignores_what_could_not_be_checked() {
        let host_id = uuid::Uuid::new_v4();
        let unknown = HostDrift {
            host_id,
            checks: vec![CheckOutcome {
                operation: "reboot".to_string(),
                verdict: Verdict::Unknown { reason: "x".to_string() },
            }],
            error: None,
        };
        assert!(!unknown.has_drifted(), "un indéterminé n'est pas un écart");

        let drifted = HostDrift {
            host_id,
            checks: vec![CheckOutcome {
                operation: "install-package nginx".to_string(),
                verdict: Verdict::Drifted,
            }],
            error: None,
        };
        assert!(drifted.has_drifted());
    }

    /// Same trap as everywhere else in this repo: `rename_all` on an
    /// internally-tagged enum leaves struct-variant fields alone.
    #[test]
    fn the_json_verdict_carries_the_camel_cased_fields_the_frontend_reads() {
        let json = serde_json::to_value(Verdict::Unknown { reason: "parce que".to_string() }).unwrap();
        assert_eq!(json["kind"], "unknown");
        assert_eq!(json["reason"], "parce que");
        assert_eq!(serde_json::to_value(Verdict::Matches).unwrap()["kind"], "matches");
        assert_eq!(serde_json::to_value(Verdict::Drifted).unwrap()["kind"], "drifted");
    }
}
