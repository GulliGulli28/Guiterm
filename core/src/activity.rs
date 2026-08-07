//! Reading the three activity trails as one timeline: what was done, where,
//! and when.
//!
//! **Merged at read time, never on disk.** `fleet_history.json`,
//! `local_history.json`/`ssh_history.json` and `session_recordings.json` keep
//! their own formats, their own caps and their own writers — this only reads
//! them and puts the results in one order. Writing a fourth combined file
//! would mean every event existing twice, two writers to keep in agreement,
//! and a migration the day one of them changes.
//!
//! **Deliberately not a database.** Retention is whatever each source already
//! enforces (50 fleet runs, 1000 commands, 500 recordings), so the total is
//! bounded by construction and there is no separate policy to configure, no
//! index to rebuild, no vacuum. A journal that outgrew that would be a
//! different product decision, not a bigger `Vec`.
//!
//! **What this is honest about.** A command entry stands for the *most recent*
//! run of that command, not every run — that is the shape of the ghost-text
//! data it reads (see [`crate::command_history`]), and pretending otherwise
//! would inflate an audit trail with invocations it cannot actually account
//! for. Entries written before timestamps existed have no date at all and say
//! so. Both facts travel with the events rather than living in a footnote.

use crate::command_history::{self, CommandEntry};
use crate::fleet::FleetTarget;
use crate::fleet_history::{self, FleetRun};
use crate::model::{Host, HostId};
use crate::session_index::{self, RecordingEntry};
use serde::{Deserialize, Serialize};

/// Which trail an event came from — also the filter the UI offers, hence
/// `Deserialize` as well: it travels back from the frontend inside a filter.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ActivityKind {
    FleetRun,
    Command,
    Recording,
}

/// One entry in the unified timeline.
///
/// A flat struct rather than an enum: every consumer (the table, the filters,
/// the CSV export) wants the same five columns, and the per-kind extras are
/// few enough to sit in `detail`. An enum would push a `match` into all three.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityEvent {
    pub kind: ActivityKind,
    /// Unix epoch milliseconds. `None` only for command entries migrated from
    /// the pre-timestamp format — the UI shows "date inconnue" rather than
    /// placing them at the epoch, which would bury them under everything else
    /// while looking like a real date.
    pub at_ms: Option<u64>,
    /// What happened: the command, or the recording's file name.
    pub summary: String,
    /// Where: a host label, "cette machine" for the local terminal, or a
    /// count for a fleet run spanning several targets.
    pub target: String,
    /// The hosts this event touched, for filtering by host. Empty for events
    /// with no host (a local command, a fleet run on the local machine).
    pub host_ids: Vec<HostId>,
    /// Per-kind extra: a fleet run's success/failure tally, a recording's
    /// path and whether it still exists, a command's host.
    pub detail: String,
    /// Whether this event needs attention — a failed fleet run, a recording
    /// whose file has gone. Surfaced so the table can mark them without the
    /// frontend re-deriving each kind's notion of failure.
    pub failed: bool,
}

/// What to include. Every field is optional; `Filter::default()` is
/// "everything", which is what the tab opens on.
#[derive(Debug, Clone, Default)]
pub struct Filter {
    /// Keep only these kinds. Empty means all of them.
    pub kinds: Vec<ActivityKind>,
    /// Keep only events at or after this instant.
    pub since_ms: Option<u64>,
    /// Keep only events at or before this instant.
    pub until_ms: Option<u64>,
    /// Keep only events touching this host.
    pub host_id: Option<HostId>,
    /// Case-insensitive substring of the summary.
    pub search: Option<String>,
}

impl Filter {
    fn wants(&self, kind: ActivityKind) -> bool {
        self.kinds.is_empty() || self.kinds.contains(&kind)
    }

    /// Whether `event` survives the time/host/search filters.
    ///
    /// A dateless event passes any time filter rather than being hidden by
    /// one: it is not known to be outside the window, and silently dropping
    /// it would make "no results" mean two different things.
    fn keeps(&self, event: &ActivityEvent) -> bool {
        if let Some(since) = self.since_ms
            && event.at_ms.is_some_and(|at| at < since)
        {
            return false;
        }
        if let Some(until) = self.until_ms
            && event.at_ms.is_some_and(|at| at > until)
        {
            return false;
        }
        if let Some(host_id) = self.host_id
            && !event.host_ids.contains(&host_id)
        {
            return false;
        }
        if let Some(search) = self.search.as_deref().map(str::trim).filter(|s| !s.is_empty())
            && !event.summary.to_lowercase().contains(&search.to_lowercase())
        {
            return false;
        }
        true
    }
}

/// Reads every trail and returns the merged timeline, most recent first.
///
/// A source that fails to load is skipped rather than failing the whole read:
/// a corrupt `fleet_history.json` should not make the commands unreadable too.
/// Being unable to show one trail is worth degrading for; showing none is not.
pub fn collect(hosts: &[Host], filter: &Filter) -> Vec<ActivityEvent> {
    let mut events = Vec::new();

    if filter.wants(ActivityKind::FleetRun) {
        for run in fleet_history::load().unwrap_or_default() {
            events.push(fleet_event(&run, hosts));
        }
    }
    if filter.wants(ActivityKind::Command) {
        for entry in command_history::load("ssh_history.json").unwrap_or_default() {
            events.push(command_event(&entry, hosts, false));
        }
        for entry in command_history::load("local_history.json").unwrap_or_default() {
            events.push(command_event(&entry, hosts, true));
        }
    }
    if filter.wants(ActivityKind::Recording) {
        for entry in session_index::load().unwrap_or_default() {
            events.push(recording_event(&entry, hosts));
        }
    }

    events.retain(|event| filter.keeps(event));
    events.sort_by(by_recency);
    events
}

/// Most recent first, dateless entries last.
///
/// A named function rather than a closure inside [`collect`] so a test can
/// exercise *this* ordering instead of a copy of it — a copied comparator
/// agrees with itself no matter what `collect` actually does.
///
/// Dateless last rather than treated as 0: they carry no claim about when they
/// happened, and sorting them as the epoch would both bury a thousand migrated
/// commands and assert they ran in 1970.
fn by_recency(a: &ActivityEvent, b: &ActivityEvent) -> std::cmp::Ordering {
    match (a.at_ms, b.at_ms) {
        (Some(x), Some(y)) => y.cmp(&x),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => std::cmp::Ordering::Equal,
    }
}

fn host_label(hosts: &[Host], id: HostId) -> String {
    hosts.iter().find(|h| h.id == id).map(|h| h.label.clone()).unwrap_or_else(|| "hôte supprimé".to_string())
}

fn target_host_id(target: &FleetTarget) -> Option<HostId> {
    match target {
        FleetTarget::Ssh { host_id } => Some(*host_id),
        FleetTarget::Docker { host_id, .. } => Some(*host_id),
        FleetTarget::K8s { host_id, .. } => Some(*host_id),
        FleetTarget::Local => None,
    }
}

fn fleet_event(run: &FleetRun, hosts: &[Host]) -> ActivityEvent {
    let host_ids: Vec<HostId> = run.targets.iter().filter_map(target_host_id).collect();
    // A run's own record of failure: a target that never ran (`error`), or one
    // that ran and returned non-zero. `Some(0)` with no error is the success.
    let failures = run
        .outcomes
        .iter()
        .filter(|o| o.error.is_some() || o.exit_code.is_some_and(|c| c != 0))
        .count();

    let target = match host_ids.len() {
        0 => "cette machine".to_string(),
        1 => host_label(hosts, host_ids[0]),
        n => format!("{n} cibles"),
    };
    let detail = if run.outcomes.is_empty() {
        "aucun résultat enregistré".to_string()
    } else if failures == 0 {
        format!("{} réussite(s)", run.outcomes.len())
    } else {
        format!("{failures} échec(s) sur {}", run.outcomes.len())
    };

    ActivityEvent {
        kind: ActivityKind::FleetRun,
        at_ms: Some(run.started_at_ms),
        summary: run.command.clone(),
        target,
        host_ids,
        detail,
        failed: failures > 0,
    }
}

fn command_event(entry: &CommandEntry, hosts: &[Host], local: bool) -> ActivityEvent {
    // The SSH history stores a host *label*, not an id (it is written from the
    // terminal, which has the host in hand, and the label is what survives the
    // host being deleted). Resolved back to an id here so the host filter
    // works; unresolvable is fine and simply means that filter won't match.
    let host_ids: Vec<HostId> = entry
        .host
        .as_deref()
        .and_then(|label| hosts.iter().find(|h| h.label == label))
        .map(|h| h.id)
        .into_iter()
        .collect();

    ActivityEvent {
        kind: ActivityKind::Command,
        at_ms: entry.at_ms,
        summary: entry.command.clone(),
        target: if local { "cette machine".to_string() } else { entry.host.clone().unwrap_or_else(|| "hôte inconnu".to_string()) },
        host_ids,
        detail: if entry.at_ms.is_none() {
            "dernière utilisation, date inconnue (entrée antérieure au journal)".to_string()
        } else {
            "dernière utilisation".to_string()
        },
        failed: false,
    }
}

fn recording_event(entry: &RecordingEntry, hosts: &[Host]) -> ActivityEvent {
    let host_ids: Vec<HostId> = entry
        .host
        .as_deref()
        .and_then(|label| hosts.iter().find(|h| h.label == label))
        .map(|h| h.id)
        .into_iter()
        .collect();
    let missing = !entry.exists();
    let name = std::path::Path::new(&entry.path)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| entry.path.clone());

    let detail = if missing {
        format!("fichier introuvable — {}", entry.path)
    } else if entry.stopped_at_ms.is_none() {
        format!("enregistrement non clôturé — {}", entry.path)
    } else {
        entry.path.clone()
    };

    ActivityEvent {
        kind: ActivityKind::Recording,
        at_ms: Some(entry.started_at_ms),
        summary: format!("Enregistrement de session : {name}"),
        target: entry.host.clone().unwrap_or_else(|| "cette machine".to_string()),
        host_ids,
        detail,
        failed: missing,
    }
}

/// The timeline as CSV, one event per line.
///
/// RFC 4180 quoting, applied to every field rather than only the ones that
/// look like they need it: a command is arbitrary user text and deciding
/// per-field whether it contains a comma, a quote or a newline is exactly
/// where hand-rolled CSV writers break. Multi-line output stays multi-line
/// inside its quoted field, which is valid CSV and what a spreadsheet expects.
pub fn to_csv(events: &[ActivityEvent]) -> String {
    let mut out = String::from("horodatage,type,resume,cible,detail,echec\n");
    for event in events {
        let row = [
            event.at_ms.map(|ms| ms.to_string()).unwrap_or_default(),
            kind_label(event.kind).to_string(),
            event.summary.clone(),
            event.target.clone(),
            event.detail.clone(),
            if event.failed { "oui" } else { "non" }.to_string(),
        ];
        out.push_str(&row.iter().map(|f| csv_field(f)).collect::<Vec<_>>().join(","));
        out.push('\n');
    }
    out
}

fn csv_field(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

pub fn kind_label(kind: ActivityKind) -> &'static str {
    match kind {
        ActivityKind::FleetRun => "flotte",
        ActivityKind::Command => "commande",
        ActivityKind::Recording => "enregistrement",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event(kind: ActivityKind, at_ms: Option<u64>, summary: &str) -> ActivityEvent {
        ActivityEvent {
            kind,
            at_ms,
            summary: summary.to_string(),
            target: "web-01".to_string(),
            host_ids: Vec::new(),
            detail: String::new(),
            failed: false,
        }
    }

    /// Most recent first, and dateless entries last rather than first.
    /// Sorting `None` as 0 would bury a thousand migrated commands under
    /// everything else *and* claim they happened in 1970 — the sort is where
    /// that lie would enter.
    #[test]
    fn sorts_newest_first_with_dateless_entries_at_the_end() {
        // `by_recency` itself, the one `collect` uses — not a copy of it.
        let mut events = [
            event(ActivityKind::Command, None, "sans date"),
            event(ActivityKind::Command, Some(100), "ancien"),
            event(ActivityKind::FleetRun, Some(300), "récent"),
            event(ActivityKind::Command, Some(200), "milieu"),
        ];
        events.sort_by(by_recency);

        let order: Vec<&str> = events.iter().map(|e| e.summary.as_str()).collect();
        assert_eq!(order, vec!["récent", "milieu", "ancien", "sans date"]);
    }

    /// A dateless event survives a time filter instead of being hidden by it.
    /// Hiding it would make an empty result mean either "nothing happened
    /// then" or "something happened but we don't know when" — two different
    /// answers a journal must not conflate.
    #[test]
    fn a_time_filter_does_not_hide_events_with_no_date() {
        let filter = Filter { since_ms: Some(200), until_ms: Some(400), ..Filter::default() };

        assert!(filter.keeps(&event(ActivityKind::Command, None, "sans date")));
        assert!(filter.keeps(&event(ActivityKind::Command, Some(300), "dedans")));
        assert!(!filter.keeps(&event(ActivityKind::Command, Some(100), "avant")));
        assert!(!filter.keeps(&event(ActivityKind::Command, Some(500), "après")));
    }

    #[test]
    fn filters_by_kind_host_and_search() {
        let all = Filter::default();
        assert!(all.wants(ActivityKind::FleetRun) && all.wants(ActivityKind::Command) && all.wants(ActivityKind::Recording));

        let only_runs = Filter { kinds: vec![ActivityKind::FleetRun], ..Filter::default() };
        assert!(only_runs.wants(ActivityKind::FleetRun));
        assert!(!only_runs.wants(ActivityKind::Command));

        let host = uuid::Uuid::new_v4();
        let by_host = Filter { host_id: Some(host), ..Filter::default() };
        let mut touching = event(ActivityKind::Command, Some(1), "ls");
        touching.host_ids = vec![host];
        assert!(by_host.keeps(&touching));
        assert!(!by_host.keeps(&event(ActivityKind::Command, Some(1), "ls")));

        let search = Filter { search: Some("  DOCKER ".to_string()), ..Filter::default() };
        assert!(search.keeps(&event(ActivityKind::Command, Some(1), "docker ps")), "insensible à la casse et aux espaces");
        assert!(!search.keeps(&event(ActivityKind::Command, Some(1), "ls -la")));
    }

    /// CSV quoting against the values that actually break hand-rolled
    /// writers — a comma, an embedded quote, a newline. All three occur in
    /// real commands, and a broken row shifts every column after it.
    #[test]
    fn csv_quotes_commas_quotes_and_newlines() {
        let mut with_comma = event(ActivityKind::Command, Some(1), "awk -F, '{print $1}'");
        with_comma.detail = "il a dit \"non\"".to_string();
        let multiline = event(ActivityKind::FleetRun, Some(2), "ligne1\nligne2");

        let csv = to_csv(&[with_comma, multiline]);
        let lines: Vec<&str> = csv.lines().collect();

        assert_eq!(lines[0], "horodatage,type,resume,cible,detail,echec");
        assert!(lines[1].contains("\"awk -F, '{print $1}'\""), "la virgule reste dans son champ : {}", lines[1]);
        assert!(lines[1].contains("\"il a dit \"\"non\"\"\""), "les guillemets sont doublés : {}", lines[1]);
        // The newline stays inside the quoted field: the record spans two
        // physical lines, which is valid CSV — so a naive `lines()` count is
        // *expected* to exceed the event count.
        assert!(csv.contains("\"ligne1\nligne2\""), "le saut de ligne reste dans le champ : {csv}");
    }

    #[test]
    fn csv_writes_an_empty_cell_for_a_dateless_event() {
        let csv = to_csv(&[event(ActivityKind::Command, None, "ls")]);
        assert!(csv.lines().nth(1).unwrap().starts_with("\"\","), "pas de 0 inventé : {csv}");
    }
}
