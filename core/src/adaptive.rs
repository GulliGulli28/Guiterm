//! Adaptive snippet engine: a small text DSL for infrastructure operations,
//! plus a hand-written, unit-tested table that renders each operation into a
//! shell command per platform. A *program* in this language is the single
//! artifact the rest of the engine works with — written by hand, written or
//! extended by an LLM from an English description, or both interchangeably;
//! either way the exact same parser and deterministic evaluator apply, and
//! the LLM's output is validated against that same parser before it's ever
//! shown to the user. The LLM never runs anything and never writes shell
//! syntax directly — it only ever writes DSL text.
//!
//! # Grammar
//!
//! A program is one or more **blocks** separated by a blank line. A block is
//! zero or more condition/option lines, followed by exactly one operation
//! line:
//!
//! ```text
//! target os: debian
//! sudo: true
//! install-package nginx
//!
//! target ram: > 80
//! restart-service nginx
//!
//! target os: debian || target os: ubuntu
//! target ram: > 80 && target cpu: >= 4
//! update-packages
//! ```
//!
//! - `target <field>: <value>` — a condition *atom*. `field` is one of `os`,
//!   `name`, `tag`, `profile`, `ram`, `cpu`, `load`, `uptime`. For `os`, `value` is free
//!   text matched case-insensitively against the host's `HostFacts::os_id`/
//!   `os_name` (substring). For `name`, `value` is free text matched
//!   case-insensitively against the target's display name (substring) — an
//!   SSH/Docker host's `label`, or a local terminal's shell name (e.g.
//!   `wsl`, `powershell`); a local terminal never matches `os` (it isn't
//!   probed for that context) but does match `name`. For `tag`, `value` is
//!   matched case-insensitively against the target's tags (exact match, not
//!   substring — an SSH/Docker host's `Host::tags`; always empty, so never
//!   matching, for a local terminal). For `profile` (synonym: `account`),
//!   `value` is matched case-insensitively and exactly against the AWS profile
//!   the target's proxy command pins — the account-shaped cut, which targeting
//!   by tag can't express: `target profile: prod-admin`. Never matches a
//!   target reached without a proxy command. For the numeric fields, `value` is an
//!   optional comparison operator (`>`, `>=`, `<`, `<=`, `=`; defaults to
//!   `=`) followed by a number (`ram`/`cpu`/`load`/`uptime` map to
//!   `mem_used_pct`/`cpus`/`load1`/`uptime_secs` respectively — `uptime`'s
//!   number is in days). Several atoms can be combined on one line with
//!   `&&` (AND) and `||`
//!   (OR) — e.g. `target os: debian || target os: ubuntu` — with `&&`
//!   binding tighter than `||`, same precedence as most languages. A block
//!   can also have several condition *lines*; those still combine with AND
//!   regardless of what each line's own expression contains, so
//!   `target os: debian` then `target ram: > 80` on two separate lines is
//!   exactly equivalent to `target os: debian && target ram: > 80` on one.
//!   A block with no condition line applies to every host.
//! - `sudo: true` (or bare `sudo`) — runs this block's command with `sudo `
//!   prefixed.
//! - The operation line names one of the known functions, with an argument
//!   for every one except `update-packages` and `reboot`:
//!   - Package/service lifecycle: `install-package`, `remove-package`,
//!     `update-packages` (package name; none for `update-packages`),
//!     `start-service`, `stop-service`, `restart-service`, `enable-service`,
//!     `disable-service`, `service-logs` (service name — `service-logs`
//!     prints the service's recent logs; best-effort on Windows, see
//!     [`render_command`]'s doc comment).
//!   - Files: `create-directory`, `remove-directory` (path).
//!   - Users: `create-user`, `remove-user` (username).
//!   - System: `reboot` (no argument — reboots the target immediately),
//!     `set-hostname` (hostname).
//!   - Firewall: `open-port`, `close-port` (port number) — only covered for
//!     Debian/Ubuntu (`ufw`), RHEL/Fedora/openSUSE (`firewalld`), and
//!     Windows (`netsh`); Arch/Alpine have no single default firewall
//!     manager and are left unsupported rather than guessed at.
//!
//! Evaluating a program against a host runs every block whose conditions
//! match, in order, joining their rendered commands with newlines — so a
//! host can end up running several of a program's blocks, not just one. The
//! joined script is prefixed with a "stop on first failure" guard (`set -e`
//! on POSIX, `$ErrorActionPreference = 'Stop'` on Windows — see
//! [`compose_for_host`]) so a failure in an earlier block can't be masked
//! by a later block still running and reporting its own (successful) exit
//! code.

use crate::model::{HostFacts, HostId, Workspace};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

const ANTHROPIC_API_URL: &str = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION: &str = "2023-06-01";
// Haiku: writing a handful of short, tightly-specified DSL lines is not
// worth a slower/pricier model.
const MODEL: &str = "claude-haiku-4-5-20251001";

// ─── The language ────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum CmpOp {
    Gt,
    Gte,
    Lt,
    Lte,
    Eq,
}

impl CmpOp {
    fn matches(self, actual: f64, expected: f64) -> bool {
        match self {
            CmpOp::Gt => actual > expected,
            CmpOp::Gte => actual >= expected,
            CmpOp::Lt => actual < expected,
            CmpOp::Lte => actual <= expected,
            CmpOp::Eq => (actual - expected).abs() < f64::EPSILON,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum Condition {
    /// Case-insensitive substring match against `os_id` or `os_name`.
    Os(String),
    /// Case-insensitive substring match against [`HostContext::name`].
    Name(String),
    /// Case-insensitive exact match against one of [`HostContext::tags`].
    Tag(String),
    /// Case-insensitive exact match against [`HostContext::profile`] — the
    /// AWS profile the target's proxy command pins.
    Profile(String),
    Ram { op: CmpOp, value: f64 },
    Cpu { op: CmpOp, value: f64 },
    Load { op: CmpOp, value: f64 },
    /// `value` is in days; compared against `uptime_secs / 86400`.
    UptimeDays { op: CmpOp, value: f64 },
}

/// Everything a condition might need to know about the target it's being
/// evaluated against: probed [`HostFacts`] for `os`/`ram`/`cpu`/`load`/
/// `uptime`, plus a static display name/tag list for [`Condition::Name`]/
/// [`Condition::Tag`] — the latter two don't depend on `facts` being `Some`
/// at all, unlike every other field (see [`condition_matches`]). Every
/// caller provides one, even when parts of it are trivially empty (a local
/// terminal has no tags — see `compose_adaptive_for_local` in
/// `src-tauri/src/commands/adaptive.rs`).
#[derive(Debug, Clone, Copy, Default)]
pub struct HostContext<'a> {
    pub facts: Option<&'a HostFacts>,
    pub name: &'a str,
    pub tags: &'a [String],
    /// The AWS profile this target is reached through, read out of its proxy
    /// command (see `aws_inventory::profile_in_command`) rather than stored in
    /// a field of its own — that command *is* where an imported host carries
    /// it. `None` for anything not reached through one, which is most targets:
    /// a local terminal, a hand-made host, a Docker/K8s target on a host with
    /// no proxy command.
    pub profile: Option<&'a str>,
}

impl<'a> HostContext<'a> {
    /// Convenience for callers that only ever have `HostFacts` to offer
    /// (mainly tests) — `name`/`tags`/`profile` are left empty, so
    /// `Condition::Name`/`Condition::Tag`/`Condition::Profile` never match.
    pub fn facts_only(facts: Option<&'a HostFacts>) -> Self {
        Self { facts, name: "", tags: &[], profile: None }
    }
}

/// A condition *line*'s parsed boolean expression — one or more
/// [`Condition`] atoms combined with `&&`/`||` (see the module grammar
/// docs). A [`Statement`] holds one of these per condition line, and those
/// lines still combine with AND, same as before this existed.
#[derive(Debug, Clone, PartialEq)]
pub enum ConditionExpr {
    Atom(Condition),
    And(Box<ConditionExpr>, Box<ConditionExpr>),
    Or(Box<ConditionExpr>, Box<ConditionExpr>),
}

#[derive(Debug, Clone, PartialEq)]
pub enum Operation {
    InstallPackage { name: String },
    RemovePackage { name: String },
    UpdatePackages,
    StartService { name: String },
    StopService { name: String },
    RestartService { name: String },
    EnableService { name: String },
    DisableService { name: String },
    /// Prints a service's most recent logs — best-effort, see
    /// [`render_command`]'s doc comment (especially the Windows path).
    ServiceLogs { name: String },
    CreateDirectory { path: String },
    RemoveDirectory { path: String },
    CreateUser { name: String },
    RemoveUser { name: String },
    /// No argument — reboots the target immediately.
    Reboot,
    SetHostname { name: String },
    OpenPort { port: String },
    ClosePort { port: String },
}

#[derive(Debug, Clone, PartialEq)]
pub struct Statement {
    /// One entry per condition *line* in the block — each entry may itself
    /// be a `&&`/`||` expression of several atoms. Entries combine with AND.
    pub conditions: Vec<ConditionExpr>,
    pub sudo: bool,
    pub operation: Operation,
}

pub type Program = Vec<Statement>;

fn function_name(op: &Operation) -> &'static str {
    match op {
        Operation::InstallPackage { .. } => "install-package",
        Operation::RemovePackage { .. } => "remove-package",
        Operation::UpdatePackages => "update-packages",
        Operation::StartService { .. } => "start-service",
        Operation::StopService { .. } => "stop-service",
        Operation::RestartService { .. } => "restart-service",
        Operation::EnableService { .. } => "enable-service",
        Operation::DisableService { .. } => "disable-service",
        Operation::ServiceLogs { .. } => "service-logs",
        Operation::CreateDirectory { .. } => "create-directory",
        Operation::RemoveDirectory { .. } => "remove-directory",
        Operation::CreateUser { .. } => "create-user",
        Operation::RemoveUser { .. } => "remove-user",
        Operation::Reboot => "reboot",
        Operation::SetHostname { .. } => "set-hostname",
        Operation::OpenPort { .. } => "open-port",
        Operation::ClosePort { .. } => "close-port",
    }
}

// ─── Undoing (scoped rollback) ───────────────────────────────────────────

/// What undoing one operation would take.
///
/// Three cases, not two, and conflating the middle one with either neighbour
/// is the mistake this enum exists to prevent: an operation that *changed
/// nothing* has nothing to undo, which is a completely different thing from
/// one whose effect cannot be undone. Warning about `service-logs` would teach
/// the user to skim past the warning that matters, on `remove-user`.
#[derive(Debug, Clone, PartialEq)]
pub enum Reversibility {
    /// Run this to put the target back as it was.
    Inverse(Operation),
    /// The operation is read-only or leaves no persistent state, so a rollback
    /// simply skips it — silently, because there is nothing to report.
    NothingToUndo,
    /// The effect is real and cannot be undone from what we know. Carries the
    /// reason, because "cannot be undone" without a why reads as a limitation
    /// of the app rather than of the world.
    Irreversible { reason: &'static str },
}

/// The inverse of one operation, or why there isn't one.
///
/// **A total `match` on purpose.** Adding a function to the DSL without
/// deciding what undoing it means becomes a compile error here — the same
/// guarantee `assertNever` gives the frontend, and the reason a scoped
/// rollback can be trusted at all: the operation list is closed, so this table
/// is exhaustive by construction rather than by vigilance.
///
/// `previous_hostname` is the one piece of captured before-state a rollback
/// carries (see [`invert_program`]); everything else here is decidable from
/// the operation alone.
pub fn inverse(op: &Operation, previous_hostname: Option<&str>) -> Reversibility {
    use Operation::*;
    match op {
        InstallPackage { name } => Reversibility::Inverse(RemovePackage { name: name.clone() }),
        // The package comes back, its version does not: nothing here recorded
        // which one was removed. Said out loud rather than pretended away.
        RemovePackage { name } => Reversibility::Inverse(InstallPackage { name: name.clone() }),
        StartService { name } => Reversibility::Inverse(StopService { name: name.clone() }),
        StopService { name } => Reversibility::Inverse(StartService { name: name.clone() }),
        EnableService { name } => Reversibility::Inverse(DisableService { name: name.clone() }),
        DisableService { name } => Reversibility::Inverse(EnableService { name: name.clone() }),
        CreateDirectory { path } => Reversibility::Inverse(RemoveDirectory { path: path.clone() }),
        CreateUser { name } => Reversibility::Inverse(RemoveUser { name: name.clone() }),
        OpenPort { port } => Reversibility::Inverse(ClosePort { port: port.clone() }),
        ClosePort { port } => Reversibility::Inverse(OpenPort { port: port.clone() }),
        // Only invertible because the hostname was collected before the run —
        // without that snapshot there is nothing to put back.
        SetHostname { .. } => match previous_hostname {
            Some(previous) => Reversibility::Inverse(SetHostname { name: previous.to_string() }),
            None => Reversibility::Irreversible {
                reason: "le nom d'hôte précédent n'a pas été relevé avant ce run",
            },
        },

        // Read-only, and a reboot leaves no configuration behind: skipping
        // them is correct, not a compromise.
        ServiceLogs { .. } => Reversibility::NothingToUndo,
        Reboot => Reversibility::NothingToUndo,

        UpdatePackages => Reversibility::Irreversible {
            reason: "revenir aux versions précédentes n'est pas exprimable dans ce langage",
        },
        RestartService { .. } => Reversibility::Irreversible {
            reason: "« dé-redémarrer » un service ne veut rien dire",
        },
        RemoveDirectory { .. } => Reversibility::Irreversible {
            reason: "le contenu du dossier est perdu, le recréer vide ne le restaure pas",
        },
        RemoveUser { .. } => Reversibility::Irreversible {
            reason: "le compte, son dossier personnel et ses groupes sont perdus",
        },
    }
}

/// Writes a program back out as DSL text.
///
/// The inverse of [`parse_program`], and it exists for the rollback: showing
/// someone the shell their rollback will run answers "what will this do" much
/// worse than showing them `remove-package nginx`. Round-trips through the
/// parser, which is what [`a_rendered_program_parses_back_to_itself`] pins
/// down — text this produces has to be text the user could have typed, or the
/// preview would be showing something the engine wouldn't accept.
pub fn render_program(program: &Program) -> String {
    program
        .iter()
        .map(|statement| {
            let mut lines: Vec<String> = statement
                .conditions
                .iter()
                .map(|expr| format!("target {}", render_condition_expr(expr)))
                .collect();
            if statement.sudo {
                lines.push("sudo: true".to_string());
            }
            lines.push(render_operation(&statement.operation));
            lines.join("\n")
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

fn render_operation(op: &Operation) -> String {
    let name = function_name(op);
    match op {
        Operation::UpdatePackages | Operation::Reboot => name.to_string(),
        Operation::InstallPackage { name: arg }
        | Operation::RemovePackage { name: arg }
        | Operation::StartService { name: arg }
        | Operation::StopService { name: arg }
        | Operation::RestartService { name: arg }
        | Operation::EnableService { name: arg }
        | Operation::DisableService { name: arg }
        | Operation::ServiceLogs { name: arg }
        | Operation::CreateUser { name: arg }
        | Operation::RemoveUser { name: arg }
        | Operation::SetHostname { name: arg } => format!("{name} {arg}"),
        Operation::CreateDirectory { path } | Operation::RemoveDirectory { path } => {
            format!("{name} {path}")
        }
        Operation::OpenPort { port } | Operation::ClosePort { port } => format!("{name} {port}"),
    }
}

/// Renders one condition line's expression. `&&` binds tighter than `||`, and
/// the parser has no parentheses — so the tree this came from is always
/// writable without them.
fn render_condition_expr(expr: &ConditionExpr) -> String {
    match expr {
        ConditionExpr::Atom(cond) => render_condition(cond),
        ConditionExpr::And(lhs, rhs) => {
            format!("{} && target {}", render_condition_expr(lhs), render_condition_expr(rhs))
        }
        ConditionExpr::Or(lhs, rhs) => {
            format!("{} || target {}", render_condition_expr(lhs), render_condition_expr(rhs))
        }
    }
}

fn render_condition(cond: &Condition) -> String {
    let numeric = |field: &str, op: &CmpOp, value: &f64| {
        let symbol = match op {
            CmpOp::Gt => ">",
            CmpOp::Gte => ">=",
            CmpOp::Lt => "<",
            CmpOp::Lte => "<=",
            CmpOp::Eq => "=",
        };
        format!("{field}: {symbol} {value}")
    };
    match cond {
        Condition::Os(text) => format!("os: {text}"),
        Condition::Name(text) => format!("name: {text}"),
        Condition::Tag(text) => format!("tag: {text}"),
        Condition::Profile(text) => format!("profile: {text}"),
        Condition::Ram { op, value } => numeric("ram", op, value),
        Condition::Cpu { op, value } => numeric("cpu", op, value),
        Condition::Load { op, value } => numeric("load", op, value),
        Condition::UptimeDays { op, value } => numeric("uptime", op, value),
    }
}

/// One operation of a run that a rollback will *not* undo, with its reason.
#[derive(Debug, Clone, PartialEq)]
pub struct Unreversed {
    /// The DSL function name, as the user wrote it.
    pub function: String,
    pub reason: &'static str,
}

/// A run's rollback: the program to run, and what it will leave behind.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct InverseProgram {
    pub program: Program,
    /// Everything the rollback can't put back. Presented before it runs — a
    /// partial rollback shown as a complete one is worse than none at all.
    pub unreversed: Vec<Unreversed>,
}

/// Builds the rollback of `program`.
///
/// **Reverse order**, which is not cosmetic: a program that creates a
/// directory and then a user inside it has to remove the user before the
/// directory, or the second half fails on a target that is already half
/// undone. Undoing is a stack, not a set.
///
/// Conditions and `sudo` ride along unchanged: the inverse of "on Debian
/// hosts, with sudo, install nginx" is "on Debian hosts, with sudo, remove
/// nginx" — dropping the condition would widen the rollback to hosts the
/// original never touched, which is the worst thing a rollback can do.
pub fn invert_program(program: &Program, previous_hostname: Option<&str>) -> InverseProgram {
    let mut inverted = InverseProgram::default();
    for statement in program.iter().rev() {
        match inverse(&statement.operation, previous_hostname) {
            Reversibility::Inverse(operation) => inverted.program.push(Statement {
                conditions: statement.conditions.clone(),
                sudo: statement.sudo,
                operation,
            }),
            Reversibility::NothingToUndo => {}
            Reversibility::Irreversible { reason } => inverted.unreversed.push(Unreversed {
                function: function_name(&statement.operation).to_string(),
                reason,
            }),
        }
    }
    inverted
}

// ─── Parsing ─────────────────────────────────────────────────────────────

fn split_blocks(text: &str) -> Vec<String> {
    let mut blocks = Vec::new();
    let mut current: Vec<&str> = Vec::new();
    for line in text.lines() {
        if line.trim().is_empty() {
            if !current.is_empty() {
                blocks.push(current.join("\n"));
                current.clear();
            }
        } else {
            current.push(line);
        }
    }
    if !current.is_empty() {
        blocks.push(current.join("\n"));
    }
    blocks
}

fn is_sudo_line(line: &str) -> bool {
    matches!(line.trim().to_lowercase().as_str(), "sudo" | "sudo: true" | "sudo:true" | "sudo: yes")
}

fn parse_numeric_condition(value: &str) -> Result<(CmpOp, f64), String> {
    let value = value.trim();
    let (op, rest) = if let Some(r) = value.strip_prefix(">=") {
        (CmpOp::Gte, r)
    } else if let Some(r) = value.strip_prefix("<=") {
        (CmpOp::Lte, r)
    } else if let Some(r) = value.strip_prefix('>') {
        (CmpOp::Gt, r)
    } else if let Some(r) = value.strip_prefix('<') {
        (CmpOp::Lt, r)
    } else if let Some(r) = value.strip_prefix('=') {
        (CmpOp::Eq, r)
    } else {
        (CmpOp::Eq, value)
    };
    let rest = rest.trim().trim_end_matches('%').trim();
    let number: f64 = rest
        .parse()
        .map_err(|_| format!("valeur numérique invalide : « {value} »"))?;
    Ok((op, number))
}

fn parse_condition(rest: &str) -> Result<Condition, String> {
    let rest = rest.trim();
    let (field, value) = rest
        .split_once(':')
        .ok_or_else(|| format!("condition mal formée : « target {rest} » (attendu « target <champ>: <valeur> »)"))?;
    let field = field.trim().to_lowercase();
    let value = value.trim();
    match field.as_str() {
        "os" => Ok(Condition::Os(value.to_string())),
        "name" => Ok(Condition::Name(value.to_string())),
        "tag" => Ok(Condition::Tag(value.to_string())),
        // `account` accepted as a synonym: what a person means by "le compte
        // prod" is the profile that reaches it, and the account *number* is
        // nowhere on the host to match against.
        "profile" | "account" => Ok(Condition::Profile(value.to_string())),
        "ram" => parse_numeric_condition(value).map(|(op, value)| Condition::Ram { op, value }),
        "cpu" => parse_numeric_condition(value).map(|(op, value)| Condition::Cpu { op, value }),
        "load" => parse_numeric_condition(value).map(|(op, value)| Condition::Load { op, value }),
        "uptime" => parse_numeric_condition(value).map(|(op, value)| Condition::UptimeDays { op, value }),
        other => Err(format!("champ de condition inconnu : « {other} » (attendu os, name, tag, profile, ram, cpu, load ou uptime)")),
    }
}

/// Whether `line` looks like the start of a condition line — i.e. `target`
/// as a whole word, not a prefix of some other word like "targeting". Only
/// checks the line's first atom; routes `parse_program`'s per-line dispatch
/// (condition vs. `sudo` vs. unexpected). Each atom past the first `&&`/`||`
/// is validated the same way inside [`parse_condition_atom`].
fn looks_like_condition_line(line: &str) -> bool {
    match line.trim().strip_prefix("target") {
        Some(rest) => rest.is_empty() || rest.starts_with(char::is_whitespace),
        None => false,
    }
}

/// One `target <field>: <value>` atom out of a `&&`/`||`-combined condition
/// line — same "target" word-boundary check as [`looks_like_condition_line`],
/// applied per atom rather than just the line's first one.
fn parse_condition_atom(atom: &str) -> Result<Condition, String> {
    let atom = atom.trim();
    let rest = atom
        .strip_prefix("target")
        .filter(|rest| rest.is_empty() || rest.starts_with(char::is_whitespace))
        .ok_or_else(|| format!("condition mal formée : « {atom} » (attendu « target <champ>: <valeur> »)"))?;
    parse_condition(rest)
}

/// Parses a full condition line into a boolean expression tree of
/// `target …` atoms — see the module grammar docs for `&&`/`||` precedence.
/// `str::split` on a non-empty pattern always yields at least one part, so
/// both inner accumulators are guaranteed `Some` by the time they're used.
fn parse_condition_expr(line: &str) -> Result<ConditionExpr, String> {
    let mut or_expr: Option<ConditionExpr> = None;
    for or_part in line.split("||") {
        let mut and_expr: Option<ConditionExpr> = None;
        for atom in or_part.split("&&") {
            let next = ConditionExpr::Atom(parse_condition_atom(atom)?);
            and_expr = Some(match and_expr {
                None => next,
                Some(acc) => ConditionExpr::And(Box::new(acc), Box::new(next)),
            });
        }
        let and_expr = and_expr.expect("str::split never yields zero parts");
        or_expr = Some(match or_expr {
            None => and_expr,
            Some(acc) => ConditionExpr::Or(Box::new(acc), Box::new(and_expr)),
        });
    }
    Ok(or_expr.expect("str::split never yields zero parts"))
}

fn parse_operation_line(line: &str) -> Result<Operation, String> {
    let mut parts = line.splitn(2, char::is_whitespace);
    let name = parts.next().unwrap_or("").trim().to_lowercase();
    let arg = parts.next().unwrap_or("").trim().to_string();
    let need_arg = |fn_name: &str, what: &str| -> Result<String, String> {
        if arg.is_empty() {
            Err(format!("« {fn_name} » nécessite un argument ({what})"))
        } else {
            Ok(arg.clone())
        }
    };
    match name.as_str() {
        "install-package" => Ok(Operation::InstallPackage { name: need_arg(&name, "nom de paquet")? }),
        "remove-package" => Ok(Operation::RemovePackage { name: need_arg(&name, "nom de paquet")? }),
        "update-packages" => Ok(Operation::UpdatePackages),
        "start-service" => Ok(Operation::StartService { name: need_arg(&name, "nom de service")? }),
        "stop-service" => Ok(Operation::StopService { name: need_arg(&name, "nom de service")? }),
        "restart-service" => Ok(Operation::RestartService { name: need_arg(&name, "nom de service")? }),
        "enable-service" => Ok(Operation::EnableService { name: need_arg(&name, "nom de service")? }),
        "disable-service" => Ok(Operation::DisableService { name: need_arg(&name, "nom de service")? }),
        "service-logs" => Ok(Operation::ServiceLogs { name: need_arg(&name, "nom de service")? }),
        "create-directory" => Ok(Operation::CreateDirectory { path: need_arg(&name, "chemin")? }),
        "remove-directory" => Ok(Operation::RemoveDirectory { path: need_arg(&name, "chemin")? }),
        "create-user" => Ok(Operation::CreateUser { name: need_arg(&name, "nom d'utilisateur")? }),
        "remove-user" => Ok(Operation::RemoveUser { name: need_arg(&name, "nom d'utilisateur")? }),
        "reboot" => Ok(Operation::Reboot),
        "set-hostname" => Ok(Operation::SetHostname { name: need_arg(&name, "nom d'hôte")? }),
        "open-port" => Ok(Operation::OpenPort { port: need_arg(&name, "port")? }),
        "close-port" => Ok(Operation::ClosePort { port: need_arg(&name, "port")? }),
        other => Err(format!(
            "fonction inconnue : « {other} » (attendu : install-package, remove-package, update-packages, \
start-service, stop-service, restart-service, enable-service, disable-service, service-logs, \
create-directory, remove-directory, create-user, remove-user, reboot, set-hostname, open-port, close-port)"
        )),
    }
}

/// Parses `text` into a [`Program`] — pure, no I/O, so both manual input
/// and the AI's output go through the exact same validation.
pub fn parse_program(text: &str) -> Result<Program, String> {
    let mut statements = Vec::new();
    for (idx, block) in split_blocks(text).into_iter().enumerate() {
        let lines: Vec<&str> = block.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
        if lines.is_empty() {
            continue;
        }
        let (head, tail) = lines.split_at(lines.len() - 1);
        let mut conditions = Vec::new();
        let mut sudo = false;
        for line in head {
            if looks_like_condition_line(line) {
                conditions.push(parse_condition_expr(line.trim()).map_err(|e| format!("bloc {} : {}", idx + 1, e))?);
            } else if is_sudo_line(line) {
                sudo = true;
            } else {
                return Err(format!(
                    "bloc {} : ligne inattendue « {} » (attendu une condition « target … », « sudo », ou une commande)",
                    idx + 1,
                    line
                ));
            }
        }
        let operation = parse_operation_line(tail[0]).map_err(|e| format!("bloc {} : {}", idx + 1, e))?;
        statements.push(Statement { conditions, sudo, operation });
    }
    if statements.is_empty() {
        return Err("aucune commande reconnue".to_string());
    }
    Ok(statements)
}

// ─── Evaluation ──────────────────────────────────────────────────────────

pub fn condition_matches(cond: &Condition, ctx: HostContext) -> bool {
    match cond {
        Condition::Os(text) => {
            let needle = text.to_lowercase();
            ctx.facts.is_some_and(|f| {
                f.os_id.as_deref().is_some_and(|v| v.to_lowercase().contains(&needle))
                    || f.os_name.as_deref().is_some_and(|v| v.to_lowercase().contains(&needle))
            })
        }
        Condition::Name(text) => ctx.name.to_lowercase().contains(&text.to_lowercase()),
        Condition::Tag(text) => ctx.tags.iter().any(|t| t.eq_ignore_ascii_case(text)),
        Condition::Profile(text) => ctx.profile.is_some_and(|p| p.eq_ignore_ascii_case(text)),
        Condition::Ram { op, value } => ctx.facts.and_then(|f| f.mem_used_pct).is_some_and(|v| op.matches(v, *value)),
        Condition::Cpu { op, value } => ctx.facts.and_then(|f| f.cpus).is_some_and(|v| op.matches(v as f64, *value)),
        Condition::Load { op, value } => ctx.facts.and_then(|f| f.load1).is_some_and(|v| op.matches(v, *value)),
        Condition::UptimeDays { op, value } => {
            ctx.facts.and_then(|f| f.uptime_secs).is_some_and(|v| op.matches(v as f64 / 86400.0, *value))
        }
    }
}

/// Evaluates a condition line's `&&`/`||` expression tree — `&&`/`||`
/// short-circuit the same way they would in the rendered shell.
pub fn condition_expr_matches(expr: &ConditionExpr, ctx: HostContext) -> bool {
    match expr {
        ConditionExpr::Atom(cond) => condition_matches(cond, ctx),
        ConditionExpr::And(lhs, rhs) => condition_expr_matches(lhs, ctx) && condition_expr_matches(rhs, ctx),
        ConditionExpr::Or(lhs, rhs) => condition_expr_matches(lhs, ctx) || condition_expr_matches(rhs, ctx),
    }
}

/// A statement's condition *lines* still combine with AND, unchanged by
/// `&&`/`||` existing within each line (see [`condition_expr_matches`]).
pub fn statement_applies(stmt: &Statement, ctx: HostContext) -> bool {
    stmt.conditions.iter().all(|e| condition_expr_matches(e, ctx))
}

/// Renders one statement's operation for `platform_key`, prefixing `sudo `
/// if the statement calls for it. `None` if the operation isn't (yet)
/// covered for that platform.
pub fn render_statement(stmt: &Statement, platform_key: &str) -> Option<String> {
    let base = render_command(&stmt.operation, platform_key)?;
    Some(if stmt.sudo { format!("sudo {base}") } else { base })
}

/// What a single host would run: the composed command (every matching
/// block's rendered command, joined by newlines, in program order, prefixed
/// with a "stop on first failure" guard — see [`compose_for_host`]) and an
/// explanatory note — set when nothing matched, or when a matching block
/// couldn't render for this platform. `Serialize`d directly to the frontend
/// by the single-target commands (`compose_adaptive_for_local`/`_docker`) —
/// unlike SSH's `preview`, there's only ever one target, so no grouping.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComposeResult {
    pub command: Option<String>,
    pub note: Option<String>,
}

pub fn compose_for_host(program: &Program, platform_key: &str, ctx: HostContext) -> ComposeResult {
    let mut lines = Vec::new();
    let mut unsupported = Vec::new();
    for stmt in program {
        if !statement_applies(stmt, ctx) {
            continue;
        }
        match render_statement(stmt, platform_key) {
            Some(cmd) => lines.push(cmd),
            None => unsupported.push(function_name(&stmt.operation)),
        }
    }
    // Without this, a failure in an earlier block wouldn't stop a later one
    // from running, and the exit code reported for the whole host would be
    // whichever command happened to run *last* — silently masking a real
    // failure earlier in the sequence. `set -e`/`$ErrorActionPreference =
    // 'Stop'` make the composed script stop at the first failing command,
    // so the reported exit code/output always reflects the actual first
    // failure. Chosen by `os_family` rather than always defaulting to the
    // POSIX guard — `$ErrorActionPreference` would be nonsense on a POSIX
    // shell, and `set -e` is a syntax error on `fish` (rare as a login
    // shell, not specially handled) but at least a no-op-safe default
    // everywhere else. `os_family` returning `None` here shouldn't happen
    // in practice (`lines` non-empty implies `platform_key` was recognized
    // by `service_family`, which every family table here derives from —
    // see its doc comment) but falls back to the POSIX guard rather than
    // panicking if it ever does.
    let command = if lines.is_empty() {
        None
    } else {
        let guard = if os_family(platform_key) == Some("windows") { "$ErrorActionPreference = 'Stop'" } else { "set -e" };
        Some(format!("{guard}\n{}", lines.join("\n")))
    };
    let note = if !unsupported.is_empty() {
        Some(format!("non pris en charge pour cette plateforme : {}", unsupported.join(", ")))
    } else if command.is_none() {
        Some("aucune condition ne correspond à cet hôte".to_string())
    } else {
        None
    };
    ComposeResult { command, note }
}

/// One group of hosts that would all run the exact same thing (or all hit
/// the exact same "nothing to do" outcome) — see [`preview`].
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionGroup {
    pub command: Option<String>,
    pub host_ids: Vec<HostId>,
    pub note: Option<String>,
}

/// Evaluates `program` against every host in `host_ids` (using each host's
/// last collected facts — see `crate::facts::collect`), grouping hosts by
/// the exact command they'd end up running. Purely deterministic, no
/// network/AI call.
pub fn preview(workspace: &Workspace, host_ids: &[HostId], program: &Program) -> Vec<ExecutionGroup> {
    let mut groups: HashMap<(Option<String>, Option<String>), Vec<HostId>> = HashMap::new();
    for &id in host_ids {
        let host = workspace.host(id);
        let facts = host.and_then(|h| h.last_facts.as_ref());
        let platform_key = facts.and_then(|f| f.os_id.clone()).unwrap_or_else(|| "unknown".to_string());
        let ctx = HostContext {
            facts,
            name: host.map(|h| h.label.as_str()).unwrap_or(""),
            tags: host.map(|h| h.tags.as_slice()).unwrap_or(&[]),
            profile: host
                .and_then(|h| h.proxy_command.as_deref())
                .and_then(crate::aws_inventory::profile_in_command),
        };
        let result = compose_for_host(program, &platform_key, ctx);
        groups.entry((result.command, result.note)).or_default().push(id);
    }
    groups
        .into_iter()
        .map(|((command, note), host_ids)| ExecutionGroup { command, host_ids, note })
        .collect()
}

// ─── LLM-assisted authoring (writes/extends DSL text, never shell) ──────────

const SYSTEM_PROMPT: &str = "You write programs in a small domain-specific language for infrastructure \
operations. Output ONLY the program text — no explanation, no markdown code fences, no commentary.\n\n\
Grammar:\n\
- A program is one or more blocks separated by a blank line.\n\
- A block is zero or more condition/option lines, followed by exactly one operation line.\n\
- Condition line: \"target <field>: <value>\" where <field> is one of: os, name, tag, profile, ram, cpu, load, uptime.\n\
  - For os: <value> is free text matched case-insensitively against the host's OS name or id, \
e.g. \"target os: debian\".\n\
  - For name: <value> is free text matched case-insensitively against the target's display name \
(substring), e.g. \"target name: web-\".\n\
  - For tag: <value> is matched case-insensitively against the target's tags (exact match, not \
substring), e.g. \"target tag: production\".\n\
  - For profile (synonym: account): <value> is matched case-insensitively and exactly against the \
AWS profile the target is reached through, e.g. \"target profile: prod-admin\". This is the \
per-AWS-account cut — use it when the user asks for \"the machines of account X\" or \"everything on \
the prod account\". It never matches a target that is not reached through an AWS profile.\n\
  - For ram, cpu, load, uptime: <value> is a comparison operator (>, >=, <, <=, =) followed by a \
number, e.g. \"target ram: > 80\". ram is a percentage, load is the 1-minute load average, uptime is \
in days.\n\
  - Several \"target ...\" atoms can be combined on the same line with && (AND) and || (OR), e.g. \
\"target os: debian || target os: ubuntu\". && binds tighter than ||, same precedence as most \
languages — use parentheses-free grouping by writing your ANDs adjacent within an OR group if needed.\n\
  - A block can have multiple condition lines; those combine with AND regardless of what each line's \
own && / || expression contains — so two separate \"target ...\" lines are equivalent to joining them \
with && on one line.\n\
  - Omitting all condition lines means the operation applies to every host.\n\
- Option line: \"sudo: true\" — runs this block's operation with sudo.\n\
- Operation line (exactly one, always last in its block) — one of:\n\
  install-package <name>\n\
  remove-package <name>\n\
  update-packages\n\
  start-service <name>\n\
  stop-service <name>\n\
  restart-service <name>\n\
  enable-service <name>\n\
  disable-service <name>\n\
  service-logs <name>  (prints the service's recent logs)\n\
  create-directory <path>\n\
  remove-directory <path>\n\
  create-user <username>\n\
  remove-user <username>\n\
  reboot  (no argument)\n\
  set-hostname <hostname>\n\
  open-port <port>\n\
  close-port <port>\n\n\
If given an existing program, output the complete updated program (existing blocks plus whatever the \
new instruction adds or changes), not just the new part.";

fn strip_markdown_fence(text: &str) -> String {
    let trimmed = text.trim();
    let Some(inner) = trimmed.strip_prefix("```") else {
        return trimmed.to_string();
    };
    let Some(without_end) = inner.strip_suffix("```") else {
        return trimmed.to_string();
    };
    let without_end = without_end.trim_start();
    let after_tag = match without_end.find('\n') {
        Some(i) if without_end[..i].chars().all(|c| c.is_alphanumeric()) => &without_end[i + 1..],
        _ => without_end,
    };
    after_tag.trim().to_string()
}

#[derive(Serialize)]
struct MessagesRequest<'a> {
    model: &'a str,
    max_tokens: u32,
    system: &'a str,
    messages: Vec<Message<'a>>,
}

#[derive(Serialize)]
struct Message<'a> {
    role: &'a str,
    content: &'a str,
}

#[derive(Deserialize)]
struct MessagesResponse {
    #[serde(default)]
    content: Vec<ContentBlock>,
}

#[derive(Deserialize)]
struct ContentBlock {
    #[serde(rename = "type", default)]
    kind: String,
    #[serde(default)]
    text: String,
}

/// Asks the AI to write (`existing_text` empty) or extend (non-empty) DSL
/// text implementing `intent`. The response is parsed with the exact same
/// [`parse_program`] manual input goes through — an AI response that
/// doesn't parse is returned as an error, never silently accepted.
pub async fn generate_program(existing_text: &str, intent: &str) -> anyhow::Result<String> {
    let api_key = crate::vault::load_anthropic_api_key()?
        .ok_or_else(|| anyhow::anyhow!("aucune clé API Anthropic configurée — Paramètres → Sécurité"))?;

    let user_message = if existing_text.trim().is_empty() {
        format!("Instruction : {intent}")
    } else {
        format!("Programme existant :\n{existing_text}\n\nInstruction : {intent}")
    };

    let client = reqwest::Client::new();
    let response = client
        .post(ANTHROPIC_API_URL)
        .header("x-api-key", &api_key)
        .header("anthropic-version", ANTHROPIC_VERSION)
        .json(&MessagesRequest {
            model: MODEL,
            max_tokens: 1024,
            system: SYSTEM_PROMPT,
            messages: vec![Message { role: "user", content: &user_message }],
        })
        .send()
        .await?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        anyhow::bail!("l'API Anthropic a répondu {status} : {body}");
    }

    let parsed: MessagesResponse = response.json().await?;
    let text = parsed
        .content
        .into_iter()
        .filter(|b| b.kind == "text")
        .map(|b| b.text)
        .collect::<Vec<_>>()
        .join("");
    let cleaned = strip_markdown_fence(&text);
    parse_program(&cleaned).map_err(|e| anyhow::anyhow!("réponse de l'IA invalide : {e}"))?;
    Ok(cleaned)
}

// ─── Deterministic rendering table (Operation × platform → shell command) ───

/// Package/service names are interpolated directly into a shell command
/// template — restrict to a conservative safe charset so an argument (from
/// the LLM, ultimately derived from free-form user text, or typed by hand)
/// can never break out of the intended single shell token.
fn is_safe_token(s: &str) -> bool {
    !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '+'))
}

/// Allowed charset for a filesystem path argument — broader than
/// [`is_safe_token`] (allows `/`, `\`, `:`, spaces, `~`, since real paths
/// need them) but still excludes `'`: the rendered command always wraps the
/// path in single quotes (see `directory_cmd`), so as long as the path
/// itself can't contain one, it can never break out of that quoting (POSIX
/// single quotes disable all expansion; PowerShell single-quoted strings
/// are equally literal).
fn is_safe_path(s: &str) -> bool {
    !s.is_empty()
        && !s.contains('\'')
        && s.chars().all(|c| c.is_alphanumeric() || matches!(c, '-' | '_' | '.' | '+' | '/' | '\\' | ':' | ' ' | '~'))
}

/// A port argument must be a plain, in-range number — never interpolated
/// through [`is_safe_token`]'s charset alone, since e.g. `firewall_cmd`
/// embeds it unquoted in a rule name (`netsh`) where any non-digit could
/// still carry meaning.
fn is_valid_port(s: &str) -> bool {
    s.parse::<u16>().is_ok_and(|p| p != 0)
}

/// Package-manager family for a platform key (`HostFacts::os_id`) — several
/// distros share one, so this collapses e.g. "rhel"/"rocky"/"almalinux"/
/// "fedora" to a single rendering path rather than listing each
/// individually against every operation.
fn package_family(platform_key: &str) -> Option<&'static str> {
    match platform_key {
        "ubuntu" | "debian" | "raspbian" | "linuxmint" | "pop" => Some("apt"),
        "centos" | "rhel" | "rocky" | "almalinux" | "fedora" | "amzn" => Some("dnf"),
        "alpine" => Some("apk"),
        "arch" | "manjaro" => Some("pacman"),
        "opensuse" | "opensuse-leap" | "sles" => Some("zypper"),
        // Synthesized for a local terminal on a native Windows shell — see
        // `local_shell::is_windows_native_shell` — never comes from an SSH
        // probe (`facts::PROBE` is POSIX-only).
        "windows" => Some("winget"),
        _ => None,
    }
}

/// Service-manager family for a platform key — every POSIX family here
/// besides Alpine's OpenRC uses systemd; Windows has its own family of
/// PowerShell service cmdlets.
fn service_family(platform_key: &str) -> Option<&'static str> {
    match platform_key {
        "alpine" => Some("openrc"),
        "ubuntu" | "debian" | "raspbian" | "linuxmint" | "pop" | "centos" | "rhel" | "rocky"
        | "almalinux" | "fedora" | "amzn" | "arch" | "manjaro" | "opensuse" | "opensuse-leap" | "sles" => {
            Some("systemd")
        }
        "windows" => Some("pwsh-service"),
        _ => None,
    }
}

/// Broad POSIX-vs-Windows split for operations that don't depend on the
/// package/service manager (directories, reboot) — derived from
/// [`service_family`] so the list of covered distros lives in one place.
fn os_family(platform_key: &str) -> Option<&'static str> {
    match service_family(platform_key)? {
        "systemd" | "openrc" => Some("posix"),
        "pwsh-service" => Some("windows"),
        _ => None,
    }
}

/// User-management family: shadow-utils (`useradd`/`userdel`, every
/// systemd distro here) vs BusyBox (`adduser`/`deluser`, Alpine) vs Windows
/// (`New-LocalUser`/`Remove-LocalUser`) — derived from [`service_family`]
/// for the same reason as [`os_family`].
fn user_family(platform_key: &str) -> Option<&'static str> {
    match service_family(platform_key)? {
        "systemd" => Some("shadow"),
        "openrc" => Some("busybox"),
        "pwsh-service" => Some("windows"),
        _ => None,
    }
}

/// Firewall family — only the distros that ship a unified firewall manager
/// by default are covered (`ufw` on Debian/Ubuntu, `firewalld` on
/// RHEL/Fedora/openSUSE, `netsh` on Windows). Arch/Alpine have no single
/// default (commonly hand-rolled iptables/nftables) and are left
/// unsupported (`None`) rather than guessed at.
fn firewall_family(platform_key: &str) -> Option<&'static str> {
    match package_family(platform_key)? {
        "apt" => Some("ufw"),
        "dnf" | "zypper" => Some("firewalld"),
        "winget" => Some("windows"),
        _ => None,
    }
}

fn package_cmd(platform_key: &str, action: &str, name: &str) -> Option<String> {
    if !is_safe_token(name) {
        return None;
    }
    Some(match (package_family(platform_key)?, action) {
        ("apt", "install") => format!("apt-get install -y {name}"),
        ("apt", "remove") => format!("apt-get remove -y {name}"),
        ("dnf", "install") => format!("dnf install -y {name}"),
        ("dnf", "remove") => format!("dnf remove -y {name}"),
        ("apk", "install") => format!("apk add {name}"),
        ("apk", "remove") => format!("apk del {name}"),
        ("pacman", "install") => format!("pacman -S --noconfirm {name}"),
        ("pacman", "remove") => format!("pacman -R --noconfirm {name}"),
        ("zypper", "install") => format!("zypper install -y {name}"),
        ("zypper", "remove") => format!("zypper remove -y {name}"),
        ("winget", "install") => format!("winget install {name} --accept-package-agreements --accept-source-agreements"),
        ("winget", "remove") => format!("winget uninstall {name}"),
        _ => return None,
    })
}

fn update_cmd(platform_key: &str) -> Option<String> {
    Some(match package_family(platform_key)? {
        "apt" => "apt-get update && apt-get upgrade -y".to_string(),
        "dnf" => "dnf upgrade -y".to_string(),
        "apk" => "apk update && apk upgrade".to_string(),
        "pacman" => "pacman -Syu --noconfirm".to_string(),
        "zypper" => "zypper update -y".to_string(),
        "winget" => "winget upgrade --all --accept-package-agreements --accept-source-agreements".to_string(),
        _ => return None,
    })
}

fn service_cmd(platform_key: &str, action: &str, name: &str) -> Option<String> {
    if !is_safe_token(name) {
        return None;
    }
    Some(match (service_family(platform_key)?, action) {
        ("systemd", "start") => format!("systemctl start {name}"),
        ("systemd", "stop") => format!("systemctl stop {name}"),
        ("systemd", "restart") => format!("systemctl restart {name}"),
        ("systemd", "enable") => format!("systemctl enable {name}"),
        ("systemd", "disable") => format!("systemctl disable {name}"),
        ("openrc", "start") => format!("rc-service {name} start"),
        ("openrc", "stop") => format!("rc-service {name} stop"),
        ("openrc", "restart") => format!("rc-service {name} restart"),
        ("openrc", "enable") => format!("rc-update add {name} default"),
        ("openrc", "disable") => format!("rc-update del {name} default"),
        ("pwsh-service", "start") => format!("Start-Service -Name {name}"),
        ("pwsh-service", "stop") => format!("Stop-Service -Name {name}"),
        ("pwsh-service", "restart") => format!("Restart-Service -Name {name}"),
        ("pwsh-service", "enable") => format!("Set-Service -Name {name} -StartupType Automatic"),
        ("pwsh-service", "disable") => format!("Set-Service -Name {name} -StartupType Disabled"),
        _ => return None,
    })
}

/// Best-effort — especially on Windows, where a service's log "provider
/// name" doesn't always match its service name (no generic, reliable
/// mapping exists between the two), so this may still return nothing, or
/// print nothing, even for a real running service.
fn service_logs_cmd(platform_key: &str, name: &str) -> Option<String> {
    if !is_safe_token(name) {
        return None;
    }
    Some(match service_family(platform_key)? {
        "systemd" => format!("journalctl -u {name} -n 100 --no-pager"),
        "pwsh-service" => format!(
            "Get-WinEvent -FilterHashtable @{{LogName='Application';ProviderName='{name}'}} -MaxEvents 100 \
-ErrorAction SilentlyContinue | Format-Table -AutoSize TimeCreated,Message"
        ),
        // No centrally standardized log location on OpenRC/Alpine.
        _ => return None,
    })
}

fn directory_cmd(platform_key: &str, action: &str, path: &str) -> Option<String> {
    if !is_safe_path(path) {
        return None;
    }
    Some(match (os_family(platform_key)?, action) {
        ("posix", "create") => format!("mkdir -p '{path}'"),
        ("posix", "remove") => format!("rm -rf '{path}'"),
        ("windows", "create") => format!("New-Item -ItemType Directory -Force -Path '{path}' | Out-Null"),
        // Unlike `rm -rf`, `Remove-Item` throws if `path` is already absent
        // even with `-Force` (that flag only means "remove read-only/hidden
        // items", not "ignore a missing path") — guarded with `Test-Path` so
        // re-running this block against a host that already converged
        // doesn't report a spurious failure.
        ("windows", "remove") => format!("if (Test-Path '{path}') {{ Remove-Item -Recurse -Force -Path '{path}' }}"),
        _ => return None,
    })
}

// `useradd`/`userdel` (and their BusyBox/Windows equivalents) aren't
// idempotent on their own — creating an already-existing user or deleting a
// missing one is a hard failure, not a no-op. Every branch below guards
// with an existence check first, so re-running a `create-user`/
// `remove-user` block against a fleet where some hosts already converged
// doesn't report a spurious failure on those hosts. `id -u`'s exit code
// inside an `if` condition (POSIX) and `-ErrorAction SilentlyContinue` on
// `Get-LocalUser` (Windows, overriding the `$ErrorActionPreference = 'Stop'`
// guard `compose_for_host` prefixes multi-block output with) are both
// exempt from tripping their respective "stop on error" mechanism — only a
// genuine failure of the mutating command itself does.
fn user_cmd(platform_key: &str, action: &str, name: &str) -> Option<String> {
    if !is_safe_token(name) {
        return None;
    }
    Some(match (user_family(platform_key)?, action) {
        ("shadow", "create") => format!("if ! id -u {name} >/dev/null 2>&1; then useradd -m {name}; fi"),
        ("shadow", "remove") => format!("if id -u {name} >/dev/null 2>&1; then userdel -r {name}; fi"),
        ("busybox", "create") => format!("if ! id -u {name} >/dev/null 2>&1; then adduser -D {name}; fi"),
        ("busybox", "remove") => format!("if id -u {name} >/dev/null 2>&1; then deluser --remove-home {name}; fi"),
        ("windows", "create") => format!(
            "if (-not (Get-LocalUser -Name {name} -ErrorAction SilentlyContinue)) {{ New-LocalUser -Name {name} -NoPassword }}"
        ),
        ("windows", "remove") => format!(
            "if (Get-LocalUser -Name {name} -ErrorAction SilentlyContinue) {{ Remove-LocalUser -Name {name} }}"
        ),
        _ => return None,
    })
}

fn reboot_cmd(platform_key: &str) -> Option<String> {
    Some(match os_family(platform_key)? {
        "posix" => "reboot".to_string(),
        "windows" => "Restart-Computer -Force".to_string(),
        _ => return None,
    })
}

fn hostname_cmd(platform_key: &str, name: &str) -> Option<String> {
    if !is_safe_token(name) {
        return None;
    }
    Some(match service_family(platform_key)? {
        "systemd" => format!("hostnamectl set-hostname {name}"),
        "openrc" => format!("hostname {name} && echo {name} > /etc/hostname"),
        "pwsh-service" => format!("Rename-Computer -NewName {name} -Force"),
        _ => return None,
    })
}

fn firewall_cmd(platform_key: &str, action: &str, port: &str) -> Option<String> {
    if !is_valid_port(port) {
        return None;
    }
    Some(match (firewall_family(platform_key)?, action) {
        ("ufw", "open") => format!("ufw allow {port}"),
        ("ufw", "close") => format!("ufw deny {port}"),
        ("firewalld", "open") => format!("firewall-cmd --permanent --add-port={port}/tcp && firewall-cmd --reload"),
        ("firewalld", "close") => format!("firewall-cmd --permanent --remove-port={port}/tcp && firewall-cmd --reload"),
        ("windows", "open") => format!(
            "netsh advfirewall firewall add rule name=\"Guiterm-{port}\" dir=in action=allow protocol=TCP localport={port}"
        ),
        ("windows", "close") => format!("netsh advfirewall firewall delete rule name=\"Guiterm-{port}\""),
        _ => return None,
    })
}

/// Renders `op` into a shell command for `platform_key`, or `None` if that
/// platform isn't (yet) covered for this operation.
pub fn render_command(op: &Operation, platform_key: &str) -> Option<String> {
    match op {
        Operation::InstallPackage { name } => package_cmd(platform_key, "install", name),
        Operation::RemovePackage { name } => package_cmd(platform_key, "remove", name),
        Operation::UpdatePackages => update_cmd(platform_key),
        Operation::StartService { name } => service_cmd(platform_key, "start", name),
        Operation::StopService { name } => service_cmd(platform_key, "stop", name),
        Operation::RestartService { name } => service_cmd(platform_key, "restart", name),
        Operation::EnableService { name } => service_cmd(platform_key, "enable", name),
        Operation::DisableService { name } => service_cmd(platform_key, "disable", name),
        Operation::ServiceLogs { name } => service_logs_cmd(platform_key, name),
        Operation::CreateDirectory { path } => directory_cmd(platform_key, "create", path),
        Operation::RemoveDirectory { path } => directory_cmd(platform_key, "remove", path),
        Operation::CreateUser { name } => user_cmd(platform_key, "create", name),
        Operation::RemoveUser { name } => user_cmd(platform_key, "remove", name),
        Operation::Reboot => reboot_cmd(platform_key),
        Operation::SetHostname { name } => hostname_cmd(platform_key, name),
        Operation::OpenPort { port } => firewall_cmd(platform_key, "open", port),
        Operation::ClosePort { port } => firewall_cmd(platform_key, "close", port),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Host;

    // ── render_command (unchanged table, re-verified) ──────────────────────

    #[test]
    fn renders_install_package_per_family() {
        let op = Operation::InstallPackage { name: "nginx".into() };
        assert_eq!(render_command(&op, "ubuntu").as_deref(), Some("apt-get install -y nginx"));
        assert_eq!(render_command(&op, "centos").as_deref(), Some("dnf install -y nginx"));
        assert_eq!(render_command(&op, "alpine").as_deref(), Some("apk add nginx"));
        assert_eq!(render_command(&op, "arch").as_deref(), Some("pacman -S --noconfirm nginx"));
        assert_eq!(render_command(&op, "opensuse").as_deref(), Some("zypper install -y nginx"));
    }

    #[test]
    fn renders_service_ops_systemd_vs_openrc() {
        let op = Operation::RestartService { name: "nginx".into() };
        assert_eq!(render_command(&op, "ubuntu").as_deref(), Some("systemctl restart nginx"));
        assert_eq!(render_command(&op, "alpine").as_deref(), Some("rc-service nginx restart"));
    }

    // ── render_command: windows (winget + PowerShell service cmdlets) ───────

    #[test]
    fn renders_package_ops_via_winget() {
        assert_eq!(
            render_command(&Operation::InstallPackage { name: "Nginx".into() }, "windows").as_deref(),
            Some("winget install Nginx --accept-package-agreements --accept-source-agreements")
        );
        assert_eq!(
            render_command(&Operation::RemovePackage { name: "Nginx".into() }, "windows").as_deref(),
            Some("winget uninstall Nginx")
        );
        assert_eq!(
            render_command(&Operation::UpdatePackages, "windows").as_deref(),
            Some("winget upgrade --all --accept-package-agreements --accept-source-agreements")
        );
    }

    #[test]
    fn renders_service_ops_via_powershell_cmdlets() {
        assert_eq!(
            render_command(&Operation::StartService { name: "Spooler".into() }, "windows").as_deref(),
            Some("Start-Service -Name Spooler")
        );
        assert_eq!(
            render_command(&Operation::RestartService { name: "Spooler".into() }, "windows").as_deref(),
            Some("Restart-Service -Name Spooler")
        );
        assert_eq!(
            render_command(&Operation::EnableService { name: "Spooler".into() }, "windows").as_deref(),
            Some("Set-Service -Name Spooler -StartupType Automatic")
        );
        assert_eq!(
            render_command(&Operation::DisableService { name: "Spooler".into() }, "windows").as_deref(),
            Some("Set-Service -Name Spooler -StartupType Disabled")
        );
    }

    #[test]
    fn unsupported_platform_returns_none() {
        let op = Operation::InstallPackage { name: "nginx".into() };
        assert_eq!(render_command(&op, "freebsd"), None);
        assert_eq!(render_command(&op, "unknown"), None);
    }

    #[test]
    fn rejects_a_name_with_shell_metacharacters() {
        let op = Operation::InstallPackage { name: "nginx; rm -rf /".into() };
        assert_eq!(render_command(&op, "ubuntu"), None);
    }

    // ── render_command: service-logs ────────────────────────────────────────

    #[test]
    fn renders_service_logs_via_journalctl_on_systemd() {
        let op = Operation::ServiceLogs { name: "nginx".into() };
        assert_eq!(render_command(&op, "ubuntu").as_deref(), Some("journalctl -u nginx -n 100 --no-pager"));
    }

    #[test]
    fn service_logs_unsupported_on_openrc() {
        let op = Operation::ServiceLogs { name: "nginx".into() };
        assert_eq!(render_command(&op, "alpine"), None);
    }

    #[test]
    fn renders_service_logs_via_get_winevent_on_windows() {
        let op = Operation::ServiceLogs { name: "Spooler".into() };
        let rendered = render_command(&op, "windows").unwrap();
        assert!(rendered.contains("ProviderName='Spooler'"));
        assert!(rendered.starts_with("Get-WinEvent"));
    }

    // ── render_command: directories ─────────────────────────────────────────

    #[test]
    fn renders_directory_ops_posix_vs_windows() {
        assert_eq!(
            render_command(&Operation::CreateDirectory { path: "/opt/app".into() }, "ubuntu").as_deref(),
            Some("mkdir -p '/opt/app'")
        );
        assert_eq!(
            render_command(&Operation::RemoveDirectory { path: "/opt/app".into() }, "ubuntu").as_deref(),
            Some("rm -rf '/opt/app'")
        );
        assert_eq!(
            render_command(&Operation::CreateDirectory { path: "C:\\Temp\\app".into() }, "windows").as_deref(),
            Some("New-Item -ItemType Directory -Force -Path 'C:\\Temp\\app' | Out-Null")
        );
        assert_eq!(
            render_command(&Operation::RemoveDirectory { path: "C:\\Temp\\app".into() }, "windows").as_deref(),
            Some("if (Test-Path 'C:\\Temp\\app') { Remove-Item -Recurse -Force -Path 'C:\\Temp\\app' }")
        );
    }

    #[test]
    fn directory_path_allows_spaces_but_rejects_a_single_quote() {
        let with_space = Operation::CreateDirectory { path: "/opt/my app".into() };
        assert_eq!(render_command(&with_space, "ubuntu").as_deref(), Some("mkdir -p '/opt/my app'"));
        let with_quote = Operation::CreateDirectory { path: "/opt/'; rm -rf /".into() };
        assert_eq!(render_command(&with_quote, "ubuntu"), None);
    }

    // ── render_command: users ───────────────────────────────────────────────

    #[test]
    fn renders_user_ops_shadow_vs_busybox_vs_windows() {
        assert_eq!(
            render_command(&Operation::CreateUser { name: "deploy".into() }, "ubuntu").as_deref(),
            Some("if ! id -u deploy >/dev/null 2>&1; then useradd -m deploy; fi")
        );
        assert_eq!(
            render_command(&Operation::RemoveUser { name: "deploy".into() }, "ubuntu").as_deref(),
            Some("if id -u deploy >/dev/null 2>&1; then userdel -r deploy; fi")
        );
        assert_eq!(
            render_command(&Operation::CreateUser { name: "deploy".into() }, "alpine").as_deref(),
            Some("if ! id -u deploy >/dev/null 2>&1; then adduser -D deploy; fi")
        );
        assert_eq!(
            render_command(&Operation::RemoveUser { name: "deploy".into() }, "alpine").as_deref(),
            Some("if id -u deploy >/dev/null 2>&1; then deluser --remove-home deploy; fi")
        );
        assert_eq!(
            render_command(&Operation::CreateUser { name: "deploy".into() }, "windows").as_deref(),
            Some("if (-not (Get-LocalUser -Name deploy -ErrorAction SilentlyContinue)) { New-LocalUser -Name deploy -NoPassword }")
        );
        assert_eq!(
            render_command(&Operation::RemoveUser { name: "deploy".into() }, "windows").as_deref(),
            Some("if (Get-LocalUser -Name deploy -ErrorAction SilentlyContinue) { Remove-LocalUser -Name deploy }")
        );
    }

    #[test]
    fn user_create_and_remove_are_idempotent_shell_snippets() {
        // Not a real-host test (no fleet in this environment) — just checks
        // the guard shape survives for a couple more platforms, since a
        // silent regression back to a bare `useradd`/`userdel` here would
        // reintroduce the exact "fails on an already-converged host" bug
        // this fix addresses.
        assert!(render_command(&Operation::CreateUser { name: "svc".into() }, "centos").unwrap().starts_with("if ! id -u svc"));
        assert!(render_command(&Operation::RemoveUser { name: "svc".into() }, "centos").unwrap().starts_with("if id -u svc"));
    }

    // ── render_command: system (reboot / hostname) ──────────────────────────

    #[test]
    fn renders_reboot_posix_vs_windows() {
        assert_eq!(render_command(&Operation::Reboot, "ubuntu").as_deref(), Some("reboot"));
        assert_eq!(render_command(&Operation::Reboot, "alpine").as_deref(), Some("reboot"));
        assert_eq!(render_command(&Operation::Reboot, "windows").as_deref(), Some("Restart-Computer -Force"));
    }

    #[test]
    fn renders_set_hostname_per_family() {
        let op = Operation::SetHostname { name: "web-01".into() };
        assert_eq!(render_command(&op, "ubuntu").as_deref(), Some("hostnamectl set-hostname web-01"));
        assert_eq!(render_command(&op, "alpine").as_deref(), Some("hostname web-01 && echo web-01 > /etc/hostname"));
        assert_eq!(render_command(&op, "windows").as_deref(), Some("Rename-Computer -NewName web-01 -Force"));
    }

    // ── render_command: firewall ────────────────────────────────────────────

    #[test]
    fn renders_firewall_ops_ufw_vs_firewalld_vs_windows() {
        assert_eq!(render_command(&Operation::OpenPort { port: "8080".into() }, "ubuntu").as_deref(), Some("ufw allow 8080"));
        assert_eq!(render_command(&Operation::ClosePort { port: "8080".into() }, "ubuntu").as_deref(), Some("ufw deny 8080"));
        assert_eq!(
            render_command(&Operation::OpenPort { port: "8080".into() }, "centos").as_deref(),
            Some("firewall-cmd --permanent --add-port=8080/tcp && firewall-cmd --reload")
        );
        assert_eq!(
            render_command(&Operation::ClosePort { port: "8080".into() }, "centos").as_deref(),
            Some("firewall-cmd --permanent --remove-port=8080/tcp && firewall-cmd --reload")
        );
        assert_eq!(
            render_command(&Operation::OpenPort { port: "8080".into() }, "windows").as_deref(),
            Some("netsh advfirewall firewall add rule name=\"Guiterm-8080\" dir=in action=allow protocol=TCP localport=8080")
        );
        assert_eq!(
            render_command(&Operation::ClosePort { port: "8080".into() }, "windows").as_deref(),
            Some("netsh advfirewall firewall delete rule name=\"Guiterm-8080\"")
        );
    }

    #[test]
    fn firewall_unsupported_on_arch_and_alpine() {
        let op = Operation::OpenPort { port: "8080".into() };
        assert_eq!(render_command(&op, "arch"), None);
        assert_eq!(render_command(&op, "alpine"), None);
    }

    #[test]
    fn rejects_an_out_of_range_or_non_numeric_port() {
        assert_eq!(render_command(&Operation::OpenPort { port: "0".into() }, "ubuntu"), None);
        assert_eq!(render_command(&Operation::OpenPort { port: "99999".into() }, "ubuntu"), None);
        assert_eq!(render_command(&Operation::OpenPort { port: "80; rm -rf /".into() }, "ubuntu"), None);
    }

    // ── strip_markdown_fence ────────────────────────────────────────────────

    #[test]
    fn strips_a_fence_with_language_tag() {
        assert_eq!(strip_markdown_fence("```text\ninstall-package nginx\n```"), "install-package nginx");
    }

    #[test]
    fn leaves_plain_text_untouched() {
        assert_eq!(strip_markdown_fence("install-package nginx"), "install-package nginx");
    }

    // ── parse_program: happy paths ─────────────────────────────────────────

    #[test]
    fn parses_a_single_unconditioned_statement() {
        let program = parse_program("install-package nginx").unwrap();
        assert_eq!(
            program,
            vec![Statement { conditions: vec![], sudo: false, operation: Operation::InstallPackage { name: "nginx".into() } }]
        );
    }

    #[test]
    fn parses_update_packages_with_no_argument() {
        let program = parse_program("update-packages").unwrap();
        assert_eq!(program[0].operation, Operation::UpdatePackages);
    }

    #[test]
    fn parses_reboot_with_no_argument() {
        let program = parse_program("reboot").unwrap();
        assert_eq!(program[0].operation, Operation::Reboot);
    }

    #[test]
    fn parses_every_new_operation_with_its_argument() {
        assert_eq!(
            parse_program("service-logs nginx").unwrap()[0].operation,
            Operation::ServiceLogs { name: "nginx".into() }
        );
        assert_eq!(
            parse_program("create-directory /opt/app").unwrap()[0].operation,
            Operation::CreateDirectory { path: "/opt/app".into() }
        );
        assert_eq!(
            parse_program("remove-directory /opt/app").unwrap()[0].operation,
            Operation::RemoveDirectory { path: "/opt/app".into() }
        );
        assert_eq!(
            parse_program("create-user deploy").unwrap()[0].operation,
            Operation::CreateUser { name: "deploy".into() }
        );
        assert_eq!(
            parse_program("remove-user deploy").unwrap()[0].operation,
            Operation::RemoveUser { name: "deploy".into() }
        );
        assert_eq!(
            parse_program("set-hostname web-01").unwrap()[0].operation,
            Operation::SetHostname { name: "web-01".into() }
        );
        assert_eq!(
            parse_program("open-port 8080").unwrap()[0].operation,
            Operation::OpenPort { port: "8080".into() }
        );
        assert_eq!(
            parse_program("close-port 8080").unwrap()[0].operation,
            Operation::ClosePort { port: "8080".into() }
        );
    }

    #[test]
    fn rejects_a_new_operation_missing_its_argument() {
        assert!(parse_program("create-directory").is_err());
        assert!(parse_program("open-port").is_err());
    }

    #[test]
    fn parses_a_condition_and_sudo_before_the_operation() {
        let program = parse_program("target os: debian\nsudo: true\ninstall-package nginx").unwrap();
        assert_eq!(program.len(), 1);
        assert!(program[0].sudo);
        assert_eq!(program[0].conditions, vec![ConditionExpr::Atom(Condition::Os("debian".into()))]);
    }

    #[test]
    fn parses_a_numeric_condition_with_operator_and_percent_sign() {
        let program = parse_program("target ram: > 80%\nrestart-service nginx").unwrap();
        assert_eq!(program[0].conditions, vec![ConditionExpr::Atom(Condition::Ram { op: CmpOp::Gt, value: 80.0 })]);
    }

    #[test]
    fn parses_multiple_blocks_separated_by_blank_lines() {
        let program = parse_program("install-package nginx\n\ntarget os: centos\nremove-package apache2").unwrap();
        assert_eq!(program.len(), 2);
        assert_eq!(program[1].conditions, vec![ConditionExpr::Atom(Condition::Os("centos".into()))]);
    }

    #[test]
    fn parses_multiple_conditions_in_one_block_as_and() {
        let program = parse_program("target os: ubuntu\ntarget ram: > 80\nrestart-service nginx").unwrap();
        assert_eq!(program[0].conditions.len(), 2);
    }

    // ── &&/|| within a condition line ────────────────────────────────────────

    #[test]
    fn parses_and_operator_within_one_line() {
        let program = parse_program("target os: debian && target ram: > 80\ninstall-package nginx").unwrap();
        assert_eq!(
            program[0].conditions,
            vec![ConditionExpr::And(
                Box::new(ConditionExpr::Atom(Condition::Os("debian".into()))),
                Box::new(ConditionExpr::Atom(Condition::Ram { op: CmpOp::Gt, value: 80.0 })),
            )]
        );
    }

    #[test]
    fn parses_or_operator_within_one_line() {
        let program = parse_program("target os: debian || target os: ubuntu\ninstall-package nginx").unwrap();
        assert_eq!(
            program[0].conditions,
            vec![ConditionExpr::Or(
                Box::new(ConditionExpr::Atom(Condition::Os("debian".into()))),
                Box::new(ConditionExpr::Atom(Condition::Os("ubuntu".into()))),
            )]
        );
    }

    #[test]
    fn and_binds_tighter_than_or() {
        let program = parse_program("target os: debian && target ram: > 80 || target os: centos\ninstall-package nginx").unwrap();
        let expected = ConditionExpr::Or(
            Box::new(ConditionExpr::And(
                Box::new(ConditionExpr::Atom(Condition::Os("debian".into()))),
                Box::new(ConditionExpr::Atom(Condition::Ram { op: CmpOp::Gt, value: 80.0 })),
            )),
            Box::new(ConditionExpr::Atom(Condition::Os("centos".into()))),
        );
        assert_eq!(program[0].conditions, vec![expected]);
    }

    #[test]
    fn one_line_and_is_equivalent_to_two_separate_lines() {
        let one_line = parse_program("target os: ubuntu && target ram: > 80\nrestart-service nginx").unwrap();
        let two_lines = parse_program("target os: ubuntu\ntarget ram: > 80\nrestart-service nginx").unwrap();
        let high_ram_ubuntu = facts_with("ubuntu", 90.0);
        let low_ram_ubuntu = facts_with("ubuntu", 10.0);
        let high_ctx = HostContext::facts_only(Some(&high_ram_ubuntu));
        let low_ctx = HostContext::facts_only(Some(&low_ram_ubuntu));
        assert_eq!(statement_applies(&one_line[0], high_ctx), statement_applies(&two_lines[0], high_ctx));
        assert_eq!(statement_applies(&one_line[0], low_ctx), statement_applies(&two_lines[0], low_ctx));
        assert!(statement_applies(&one_line[0], high_ctx));
        assert!(!statement_applies(&one_line[0], low_ctx));
    }

    #[test]
    fn or_condition_matches_when_either_side_matches() {
        let program = parse_program("target os: debian || target os: centos\ninstall-package nginx").unwrap();
        assert!(statement_applies(&program[0], HostContext::facts_only(Some(&facts_with("debian", 0.0)))));
        assert!(statement_applies(&program[0], HostContext::facts_only(Some(&facts_with("centos", 0.0)))));
        assert!(!statement_applies(&program[0], HostContext::facts_only(Some(&facts_with("ubuntu", 0.0)))));
    }

    #[test]
    fn rejects_a_trailing_dangling_operator() {
        assert!(parse_program("target os: debian &&\ninstall-package nginx").is_err());
    }

    // ── parse_program: error paths ──────────────────────────────────────────

    #[test]
    fn rejects_an_unknown_function_name() {
        assert!(parse_program("delete-everything nginx").is_err());
    }

    #[test]
    fn rejects_a_missing_argument() {
        assert!(parse_program("install-package").is_err());
    }

    #[test]
    fn rejects_an_unknown_condition_field() {
        assert!(parse_program("target disk: > 80\ninstall-package nginx").is_err());
    }

    #[test]
    fn parses_a_name_condition() {
        let program = parse_program("target name: web-\ninstall-package nginx").unwrap();
        assert_eq!(program[0].conditions, vec![ConditionExpr::Atom(Condition::Name("web-".into()))]);
    }

    #[test]
    fn parses_a_tag_condition() {
        let program = parse_program("target tag: production\ninstall-package nginx").unwrap();
        assert_eq!(program[0].conditions, vec![ConditionExpr::Atom(Condition::Tag("production".into()))]);
    }

    #[test]
    fn rejects_empty_input() {
        assert!(parse_program("   \n\n  ").is_err());
    }

    // ── condition_matches / statement_applies ───────────────────────────────

    fn facts_with(os_id: &str, mem_used_pct: f64) -> HostFacts {
        HostFacts { os_id: Some(os_id.into()), mem_used_pct: Some(mem_used_pct), ..Default::default() }
    }

    #[test]
    fn os_condition_matches_case_insensitively() {
        let cond = Condition::Os("Debian".into());
        assert!(condition_matches(&cond, HostContext::facts_only(Some(&facts_with("debian", 0.0)))));
    }

    #[test]
    fn no_conditions_always_applies_even_without_facts() {
        let stmt = Statement { conditions: vec![], sudo: false, operation: Operation::UpdatePackages };
        assert!(statement_applies(&stmt, HostContext::facts_only(None)));
    }

    #[test]
    fn a_condition_never_matches_a_host_with_no_facts() {
        let stmt = Statement {
            conditions: vec![ConditionExpr::Atom(Condition::Os("debian".into()))],
            sudo: false,
            operation: Operation::UpdatePackages,
        };
        assert!(!statement_applies(&stmt, HostContext::facts_only(None)));
    }

    #[test]
    fn ram_condition_respects_the_comparison_operator() {
        let cond = Condition::Ram { op: CmpOp::Gt, value: 80.0 };
        assert!(condition_matches(&cond, HostContext::facts_only(Some(&facts_with("ubuntu", 85.0)))));
        assert!(!condition_matches(&cond, HostContext::facts_only(Some(&facts_with("ubuntu", 50.0)))));
    }

    // ── name / tag conditions ────────────────────────────────────────────────

    #[test]
    fn name_condition_matches_a_case_insensitive_substring() {
        let cond = Condition::Name("Web-".into());
        let ctx = HostContext { facts: None, name: "web-01", tags: &[], profile: None };
        assert!(condition_matches(&cond, ctx));
        assert!(!condition_matches(&cond, HostContext { facts: None, name: "db-01", tags: &[], profile: None }));
    }

    #[test]
    fn name_condition_never_needs_facts() {
        // Unlike os/ram/cpu/load/uptime, `name` matches even when `facts` is
        // `None` (e.g. a local terminal whose shell couldn't be probed) —
        // the name comes from `HostContext::name`, not from `HostFacts`.
        let cond = Condition::Name("wsl".into());
        assert!(condition_matches(&cond, HostContext { facts: None, name: "wsl", tags: &[], profile: None }));
    }

    #[test]
    fn tag_condition_matches_case_insensitively_but_not_by_substring() {
        let tags = vec!["Production".to_string(), "web".to_string()];
        let ctx = HostContext { facts: None, name: "", tags: &tags, profile: None };
        assert!(condition_matches(&Condition::Tag("production".into()), ctx));
        assert!(!condition_matches(&Condition::Tag("prod".into()), ctx));
    }

    #[test]
    fn tag_condition_never_matches_when_the_target_has_no_tags() {
        let cond = Condition::Tag("production".into());
        assert!(!condition_matches(&cond, HostContext { facts: None, name: "", tags: &[], profile: None }));
    }

    // ── rollback (table d'inverses) ──────────────────────────────────────────

    /// Every operation the DSL has, one assertion each.
    ///
    /// Exhaustive on purpose rather than "a few representative ones": this
    /// table is the whole trustworthiness of the rollback, and a variant with
    /// the wrong inverse would silently do the opposite of what the user asked
    /// on real machines. The compiler forces `inverse` itself to cover every
    /// variant; this forces someone to have *thought* about each one.
    #[test]
    fn every_operation_has_a_decided_reversibility() {
        use Operation::*;
        let pkg = |n: &str| n.to_string();

        let cases: Vec<(Operation, Reversibility)> = vec![
            (InstallPackage { name: pkg("nginx") }, Reversibility::Inverse(RemovePackage { name: pkg("nginx") })),
            (RemovePackage { name: pkg("nginx") }, Reversibility::Inverse(InstallPackage { name: pkg("nginx") })),
            (StartService { name: pkg("nginx") }, Reversibility::Inverse(StopService { name: pkg("nginx") })),
            (StopService { name: pkg("nginx") }, Reversibility::Inverse(StartService { name: pkg("nginx") })),
            (EnableService { name: pkg("nginx") }, Reversibility::Inverse(DisableService { name: pkg("nginx") })),
            (DisableService { name: pkg("nginx") }, Reversibility::Inverse(EnableService { name: pkg("nginx") })),
            (CreateDirectory { path: pkg("/srv/app") }, Reversibility::Inverse(RemoveDirectory { path: pkg("/srv/app") })),
            (CreateUser { name: pkg("deploy") }, Reversibility::Inverse(RemoveUser { name: pkg("deploy") })),
            (OpenPort { port: pkg("443") }, Reversibility::Inverse(ClosePort { port: pkg("443") })),
            (ClosePort { port: pkg("443") }, Reversibility::Inverse(OpenPort { port: pkg("443") })),
            // Changed nothing — skipped in silence, never warned about.
            (ServiceLogs { name: pkg("nginx") }, Reversibility::NothingToUndo),
            (Reboot, Reversibility::NothingToUndo),
        ];
        for (operation, expected) in cases {
            assert_eq!(inverse(&operation, None), expected, "inverse de {operation:?}");
        }

        // The four whose effect is real and unrecoverable. Asserted as a group
        // because what matters is the category, and each carries its own why.
        for operation in [
            UpdatePackages,
            RestartService { name: pkg("nginx") },
            RemoveDirectory { path: pkg("/srv/app") },
            RemoveUser { name: pkg("deploy") },
        ] {
            match inverse(&operation, None) {
                Reversibility::Irreversible { reason } => {
                    assert!(!reason.is_empty(), "{operation:?} doit dire pourquoi");
                }
                other => panic!("{operation:?} devrait être irréversible, obtenu {other:?}"),
            }
        }
    }

    /// The rollback preview shows DSL, not shell — so what `render_program`
    /// writes has to be text the parser accepts, and that produces the same
    /// program. Anything else and the preview would show something the engine
    /// wouldn't run.
    #[test]
    fn a_rendered_program_parses_back_to_itself() {
        let source = "target os: debian && target ram: > 80\ntarget tag: production\nsudo: true\n\
                      install-package nginx\n\n\
                      target profile: prod-admin || target name: web-\ncreate-directory /srv/app\n\n\
                      update-packages\n\nopen-port 443\n\nreboot";
        let program = parse_program(source).unwrap();

        let rendered = render_program(&program);
        let reparsed = parse_program(&rendered)
            .unwrap_or_else(|e| panic!("le texte rendu doit se reparser ({e}) :\n{rendered}"));
        assert_eq!(reparsed, program, "rendu :\n{rendered}");
    }

    /// The one operation that depends on captured before-state. Without the
    /// snapshot it must refuse rather than invent a hostname.
    #[test]
    fn set_hostname_is_reversible_only_with_the_previous_name() {
        let operation = Operation::SetHostname { name: "web-02".into() };
        assert_eq!(
            inverse(&operation, Some("web-01")),
            Reversibility::Inverse(Operation::SetHostname { name: "web-01".into() })
        );
        assert!(matches!(inverse(&operation, None), Reversibility::Irreversible { .. }));
    }

    /// Undoing is a stack: the user was created *inside* the directory, so it
    /// has to go before the directory does. Undo them in program order and the
    /// second half fails on a target already half undone.
    #[test]
    fn a_rollback_undoes_in_reverse_order() {
        let program = parse_program(
            "create-directory /srv/app\n\ncreate-user deploy\n\ninstall-package nginx",
        )
        .unwrap();
        let inverted = invert_program(&program, None);

        let functions: Vec<&'static str> =
            inverted.program.iter().map(|s| function_name(&s.operation)).collect();
        assert_eq!(functions, vec!["remove-package", "remove-user", "remove-directory"]);
        assert!(inverted.unreversed.is_empty());
    }

    /// The rollback must not reach hosts the original run never touched, so
    /// the conditions come along untouched — and `sudo` with them, since a
    /// rollback needs the same rights the change did.
    #[test]
    fn a_rollback_keeps_the_conditions_and_the_sudo_of_what_it_undoes() {
        let program = parse_program("target os: debian\nsudo: true\ninstall-package nginx").unwrap();
        let inverted = invert_program(&program, None);

        assert_eq!(inverted.program.len(), 1);
        assert!(inverted.program[0].sudo, "un rollback a besoin des mêmes droits");
        assert_eq!(inverted.program[0].conditions, program[0].conditions);
    }

    /// What can't be undone has to come back named, so the UI can say it
    /// before running anything. Silently dropping it would present a partial
    /// rollback as a complete one.
    #[test]
    fn what_cannot_be_undone_is_reported_rather_than_dropped() {
        let program = parse_program(
            "install-package nginx\n\nupdate-packages\n\nremove-user ancien\n\nservice-logs nginx",
        )
        .unwrap();
        let inverted = invert_program(&program, None);

        // Only the install is undoable; `service-logs` vanishes without a word.
        let functions: Vec<&'static str> =
            inverted.program.iter().map(|s| function_name(&s.operation)).collect();
        assert_eq!(functions, vec!["remove-package"]);

        let reported: Vec<&str> = inverted.unreversed.iter().map(|u| u.function.as_str()).collect();
        assert_eq!(reported, vec!["remove-user", "update-packages"]);
        assert!(
            inverted.unreversed.iter().all(|u| !u.reason.is_empty()),
            "chaque irréversible doit porter sa raison"
        );
    }

    // ── profile / account ────────────────────────────────────────────────────

    #[test]
    fn the_profile_field_parses_under_both_of_its_names() {
        assert_eq!(parse_condition("profile: prod-admin"), Ok(Condition::Profile("prod-admin".into())));
        // "le compte prod" is what a person says; it means the profile that
        // reaches it.
        assert_eq!(parse_condition("account: prod-admin"), Ok(Condition::Profile("prod-admin".into())));
    }

    /// The parser is also the validator for what the LLM writes, so an
    /// invented field has to be refused rather than silently ignored — and the
    /// message has to list the field that now exists, or nobody discovers it.
    #[test]
    fn an_unknown_field_is_still_refused_and_names_the_real_ones() {
        let error = parse_condition("compte: 1670").unwrap_err();
        assert!(error.contains("compte"), "l'erreur doit citer le champ fautif : {error}");
        assert!(error.contains("profile"), "l'erreur doit lister profile : {error}");
    }

    #[test]
    fn profile_condition_matches_exactly_and_case_insensitively() {
        let ctx = HostContext { facts: None, name: "", tags: &[], profile: Some("Prod-Admin") };
        assert!(condition_matches(&Condition::Profile("prod-admin".into()), ctx));
        // Exact, like `tag` and unlike `name`: "prod" must not sweep in
        // "prod-admin" *and* "prod-readonly" when someone meant one of them.
        assert!(!condition_matches(&Condition::Profile("prod".into()), ctx));
    }

    /// Most targets are reached without a proxy command — a hand-made host, a
    /// local terminal. Matching them on an AWS profile they don't have would
    /// silently widen every account-scoped program.
    #[test]
    fn profile_condition_never_matches_a_target_reached_without_one() {
        let cond = Condition::Profile("prod-admin".into());
        assert!(!condition_matches(&cond, HostContext { facts: None, name: "", tags: &[], profile: None }));
    }

    /// The whole point of the item: the profile is read out of the proxy
    /// command, which is where an imported host actually carries it — nothing
    /// else on `Host` names an AWS account.
    #[test]
    fn preview_reads_the_profile_out_of_each_host_proxy_command() {
        let mut workspace = Workspace::default();
        let mut host = |label: &str, proxy: Option<&str>| {
            let mut h = crate::model::Host::new(label, "i-0123", "ec2-user");
            h.proxy_command = proxy.map(str::to_string);
            // Probed, so the operation has a platform to render for — an
            // unprobed host renders nothing whatever its profile, which would
            // make this test pass for the wrong reason.
            h.last_facts = Some(facts_with("ubuntu", 10.0));
            let id = h.id;
            workspace.hosts.push(h);
            id
        };
        let prod = host("PROD-1", Some("aws ssm start-session --profile prod-admin --region eu-west-3 --target %h"));
        let dev = host("DEV-1", Some("aws ssm start-session --profile dev-admin --region eu-west-3 --target %h"));
        let manual = host("BARE-METAL", None);

        let program = parse_program("target profile: prod-admin\ninstall-package nginx").unwrap();
        let groups = preview(&workspace, &[prod, dev, manual], &program);

        let installing = groups
            .iter()
            .find(|group| group.command.is_some())
            .expect("le bloc doit s'appliquer à au moins un hôte");
        assert_eq!(installing.host_ids, vec![prod]);
        // And the other two land in the "nothing to do" group rather than
        // being quietly swept in.
        let idle: Vec<_> = groups.iter().filter(|g| g.command.is_none()).flat_map(|g| g.host_ids.clone()).collect();
        assert_eq!(idle.len(), 2);
        assert!(idle.contains(&dev) && idle.contains(&manual));
    }

    // ── render_statement (sudo prefix) ──────────────────────────────────────

    #[test]
    fn render_statement_prefixes_sudo_when_set() {
        let stmt = Statement { conditions: vec![], sudo: true, operation: Operation::InstallPackage { name: "nginx".into() } };
        assert_eq!(render_statement(&stmt, "ubuntu").as_deref(), Some("sudo apt-get install -y nginx"));
    }

    #[test]
    fn render_statement_no_sudo_prefix_by_default() {
        let stmt = Statement { conditions: vec![], sudo: false, operation: Operation::InstallPackage { name: "nginx".into() } };
        assert_eq!(render_statement(&stmt, "ubuntu").as_deref(), Some("apt-get install -y nginx"));
    }

    // ── compose_for_host ─────────────────────────────────────────────────────

    #[test]
    fn compose_joins_every_matching_block_in_order() {
        let program = parse_program("install-package nginx\n\nrestart-service nginx").unwrap();
        let facts = facts_with("ubuntu", 0.0);
        let result = compose_for_host(&program, "ubuntu", HostContext::facts_only(Some(&facts)));
        assert_eq!(result.command.as_deref(), Some("set -e\napt-get install -y nginx\nsystemctl restart nginx"));
        assert_eq!(result.note, None);
    }

    #[test]
    fn compose_skips_blocks_whose_condition_does_not_match() {
        let program = parse_program("target os: centos\ninstall-package nginx").unwrap();
        let facts = facts_with("ubuntu", 0.0);
        let result = compose_for_host(&program, "ubuntu", HostContext::facts_only(Some(&facts)));
        assert_eq!(result.command, None);
        assert!(result.note.unwrap().contains("aucune condition"));
    }

    #[test]
    fn compose_notes_an_unsupported_platform_for_a_matching_block() {
        let program = parse_program("install-package nginx").unwrap();
        let result = compose_for_host(&program, "freebsd", HostContext::facts_only(None));
        assert_eq!(result.command, None);
        assert!(result.note.unwrap().contains("install-package"));
    }

    #[test]
    fn compose_matches_a_block_by_target_name_alone() {
        let program = parse_program("target name: web-\ninstall-package nginx").unwrap();
        let ctx = HostContext { facts: None, name: "web-01", tags: &[], profile: None };
        let result = compose_for_host(&program, "ubuntu", ctx);
        assert_eq!(result.command.as_deref(), Some("set -e\napt-get install -y nginx"));
    }

    #[test]
    fn compose_matches_a_block_by_target_tag_alone() {
        let program = parse_program("target tag: web\ninstall-package nginx").unwrap();
        let tags = vec!["web".to_string()];
        let ctx = HostContext { facts: None, name: "", tags: &tags, profile: None };
        let result = compose_for_host(&program, "ubuntu", ctx);
        assert_eq!(result.command.as_deref(), Some("set -e\napt-get install -y nginx"));
    }

    #[test]
    fn compose_prefixes_posix_output_with_set_dash_e() {
        // See `compose_for_host`'s doc comment: without this, an earlier
        // block's failure could be silently masked by a later block still
        // running and reporting its own successful exit code.
        let program = parse_program("install-package nginx").unwrap();
        let result = compose_for_host(&program, "ubuntu", HostContext::facts_only(None));
        assert_eq!(result.command.as_deref(), Some("set -e\napt-get install -y nginx"));
    }

    #[test]
    fn compose_prefixes_windows_output_with_stop_error_preference() {
        let program = parse_program("install-package Nginx").unwrap();
        let result = compose_for_host(&program, "windows", HostContext::facts_only(None));
        assert_eq!(
            result.command.as_deref(),
            Some("$ErrorActionPreference = 'Stop'\nwinget install Nginx --accept-package-agreements --accept-source-agreements")
        );
    }

    // ── preview: groups hosts by resulting command ──────────────────────────

    #[test]
    fn preview_groups_hosts_by_identical_resulting_command() {
        let mut workspace = Workspace::default();
        let mut ubuntu_host = Host::new("web-1", "10.0.0.1", "root");
        ubuntu_host.last_facts = Some(facts_with("ubuntu", 0.0));
        let mut debian_host = Host::new("web-2", "10.0.0.2", "root");
        debian_host.last_facts = Some(facts_with("debian", 0.0));
        let mut centos_host = Host::new("web-3", "10.0.0.3", "root");
        centos_host.last_facts = Some(facts_with("centos", 0.0));
        let (ubuntu_id, debian_id, centos_id) = (ubuntu_host.id, debian_host.id, centos_host.id);
        workspace.hosts.push(ubuntu_host);
        workspace.hosts.push(debian_host);
        workspace.hosts.push(centos_host);

        let program = parse_program("restart-service nginx").unwrap();
        let groups = preview(&workspace, &[ubuntu_id, debian_id, centos_id], &program);

        // ubuntu and debian are both "apt" family but restart-service renders
        // identically (systemd) regardless of package family — so all three
        // land in ONE group despite two distinct os_ids under the systemd path,
        // while a fourth, distinct rendering would be its own group.
        assert_eq!(groups.len(), 1);
        let mut ids = groups[0].host_ids.clone();
        ids.sort();
        let mut expected = vec![ubuntu_id, debian_id, centos_id];
        expected.sort();
        assert_eq!(ids, expected);
        assert_eq!(groups[0].command.as_deref(), Some("set -e\nsystemctl restart nginx"));
    }

    #[test]
    fn preview_separates_hosts_with_a_condition_based_split() {
        let mut workspace = Workspace::default();
        let mut high_ram = Host::new("web-1", "10.0.0.1", "root");
        high_ram.last_facts = Some(facts_with("ubuntu", 90.0));
        let mut low_ram = Host::new("web-2", "10.0.0.2", "root");
        low_ram.last_facts = Some(facts_with("ubuntu", 10.0));
        let (high_id, low_id) = (high_ram.id, low_ram.id);
        workspace.hosts.push(high_ram);
        workspace.hosts.push(low_ram);

        let program = parse_program("target ram: > 80\nrestart-service nginx").unwrap();
        let groups = preview(&workspace, &[high_id, low_id], &program);

        assert_eq!(groups.len(), 2);
        let with_command = groups.iter().find(|g| g.command.is_some()).unwrap();
        let without_command = groups.iter().find(|g| g.command.is_none()).unwrap();
        assert_eq!(with_command.host_ids, vec![high_id]);
        assert_eq!(without_command.host_ids, vec![low_id]);
    }

    #[test]
    fn preview_matches_by_host_label_and_tags() {
        let mut workspace = Workspace::default();
        let mut web_host = Host::new("web-01", "10.0.0.1", "root");
        web_host.last_facts = Some(facts_with("ubuntu", 0.0));
        web_host.tags = vec!["production".to_string()];
        let mut db_host = Host::new("db-01", "10.0.0.2", "root");
        db_host.last_facts = Some(facts_with("ubuntu", 0.0));
        db_host.tags = vec!["staging".to_string()];
        let (web_id, db_id) = (web_host.id, db_host.id);
        workspace.hosts.push(web_host);
        workspace.hosts.push(db_host);

        let program = parse_program("target name: web- && target tag: production\ninstall-package nginx").unwrap();
        let groups = preview(&workspace, &[web_id, db_id], &program);

        assert_eq!(groups.len(), 2);
        let matched = groups.iter().find(|g| g.command.is_some()).unwrap();
        let unmatched = groups.iter().find(|g| g.command.is_none()).unwrap();
        assert_eq!(matched.host_ids, vec![web_id]);
        assert_eq!(unmatched.host_ids, vec![db_id]);
    }
}
