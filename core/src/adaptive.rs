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
//!   `ram`, `cpu`, `load`, `uptime`. For `os`, `value` is free text matched
//!   case-insensitively against the host's `HostFacts::os_id`/`os_name`
//!   (substring). For the numeric fields, `value` is an optional comparison
//!   operator (`>`, `>=`, `<`, `<=`, `=`; defaults to `=`) followed by a
//!   number (`ram`/`cpu`/`load`/`uptime` map to `mem_used_pct`/`cpus`/
//!   `load1`/`uptime_secs` respectively — `uptime`'s number is in days).
//!   Several atoms can be combined on one line with `&&` (AND) and `||`
//!   (OR) — e.g. `target os: debian || target os: ubuntu` — with `&&`
//!   binding tighter than `||`, same precedence as most languages. A block
//!   can also have several condition *lines*; those still combine with AND
//!   regardless of what each line's own expression contains, so
//!   `target os: debian` then `target ram: > 80` on two separate lines is
//!   exactly equivalent to `target os: debian && target ram: > 80` on one.
//!   A block with no condition line applies to every host.
//! - `sudo: true` (or bare `sudo`) — runs this block's command with `sudo `
//!   prefixed.
//! - The operation line names one of the eight known functions —
//!   `install-package`, `remove-package`, `update-packages`,
//!   `start-service`, `stop-service`, `restart-service`, `enable-service`,
//!   `disable-service` — with an argument (package/service name) for every
//!   one except `update-packages`.
//!
//! Evaluating a program against a host runs every block whose conditions
//! match, in order, joining their rendered commands with newlines — so a
//! host can end up running several of a program's blocks, not just one.

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
    Ram { op: CmpOp, value: f64 },
    Cpu { op: CmpOp, value: f64 },
    Load { op: CmpOp, value: f64 },
    /// `value` is in days; compared against `uptime_secs / 86400`.
    UptimeDays { op: CmpOp, value: f64 },
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
    }
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
        "ram" => parse_numeric_condition(value).map(|(op, value)| Condition::Ram { op, value }),
        "cpu" => parse_numeric_condition(value).map(|(op, value)| Condition::Cpu { op, value }),
        "load" => parse_numeric_condition(value).map(|(op, value)| Condition::Load { op, value }),
        "uptime" => parse_numeric_condition(value).map(|(op, value)| Condition::UptimeDays { op, value }),
        other => Err(format!("champ de condition inconnu : « {other} » (attendu os, ram, cpu, load ou uptime)")),
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
    let need_arg = |name: &str| -> Result<String, String> {
        if arg.is_empty() {
            Err(format!("« {name} » nécessite un argument (nom de paquet ou de service)"))
        } else {
            Ok(arg.clone())
        }
    };
    match name.as_str() {
        "install-package" => Ok(Operation::InstallPackage { name: need_arg(&name)? }),
        "remove-package" => Ok(Operation::RemovePackage { name: need_arg(&name)? }),
        "update-packages" => Ok(Operation::UpdatePackages),
        "start-service" => Ok(Operation::StartService { name: need_arg(&name)? }),
        "stop-service" => Ok(Operation::StopService { name: need_arg(&name)? }),
        "restart-service" => Ok(Operation::RestartService { name: need_arg(&name)? }),
        "enable-service" => Ok(Operation::EnableService { name: need_arg(&name)? }),
        "disable-service" => Ok(Operation::DisableService { name: need_arg(&name)? }),
        other => Err(format!(
            "fonction inconnue : « {other} » (attendu : install-package, remove-package, update-packages, \
start-service, stop-service, restart-service, enable-service, disable-service)"
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

pub fn condition_matches(cond: &Condition, facts: Option<&HostFacts>) -> bool {
    let Some(facts) = facts else { return false };
    match cond {
        Condition::Os(text) => {
            let needle = text.to_lowercase();
            facts.os_id.as_deref().is_some_and(|v| v.to_lowercase().contains(&needle))
                || facts.os_name.as_deref().is_some_and(|v| v.to_lowercase().contains(&needle))
        }
        Condition::Ram { op, value } => facts.mem_used_pct.is_some_and(|v| op.matches(v, *value)),
        Condition::Cpu { op, value } => facts.cpus.is_some_and(|v| op.matches(v as f64, *value)),
        Condition::Load { op, value } => facts.load1.is_some_and(|v| op.matches(v, *value)),
        Condition::UptimeDays { op, value } => facts.uptime_secs.is_some_and(|v| op.matches(v as f64 / 86400.0, *value)),
    }
}

/// Evaluates a condition line's `&&`/`||` expression tree — `&&`/`||`
/// short-circuit the same way they would in the rendered shell.
pub fn condition_expr_matches(expr: &ConditionExpr, facts: Option<&HostFacts>) -> bool {
    match expr {
        ConditionExpr::Atom(cond) => condition_matches(cond, facts),
        ConditionExpr::And(lhs, rhs) => condition_expr_matches(lhs, facts) && condition_expr_matches(rhs, facts),
        ConditionExpr::Or(lhs, rhs) => condition_expr_matches(lhs, facts) || condition_expr_matches(rhs, facts),
    }
}

/// A statement's condition *lines* still combine with AND, unchanged by
/// `&&`/`||` existing within each line (see [`condition_expr_matches`]).
pub fn statement_applies(stmt: &Statement, facts: Option<&HostFacts>) -> bool {
    stmt.conditions.iter().all(|e| condition_expr_matches(e, facts))
}

/// Renders one statement's operation for `platform_key`, prefixing `sudo `
/// if the statement calls for it. `None` if the operation isn't (yet)
/// covered for that platform.
pub fn render_statement(stmt: &Statement, platform_key: &str) -> Option<String> {
    let base = render_command(&stmt.operation, platform_key)?;
    Some(if stmt.sudo { format!("sudo {base}") } else { base })
}

/// What a single host would run: the composed command (every matching
/// block's rendered command, joined by newlines, in program order) and an
/// explanatory note — set when nothing matched, or when a matching block
/// couldn't render for this platform.
#[derive(Debug, Clone, PartialEq)]
pub struct ComposeResult {
    pub command: Option<String>,
    pub note: Option<String>,
}

pub fn compose_for_host(program: &Program, platform_key: &str, facts: Option<&HostFacts>) -> ComposeResult {
    let mut lines = Vec::new();
    let mut unsupported = Vec::new();
    for stmt in program {
        if !statement_applies(stmt, facts) {
            continue;
        }
        match render_statement(stmt, platform_key) {
            Some(cmd) => lines.push(cmd),
            None => unsupported.push(function_name(&stmt.operation)),
        }
    }
    let command = if lines.is_empty() { None } else { Some(lines.join("\n")) };
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
        let facts = workspace.host(id).and_then(|h| h.last_facts.as_ref());
        let platform_key = facts.and_then(|f| f.os_id.clone()).unwrap_or_else(|| "unknown".to_string());
        let result = compose_for_host(program, &platform_key, facts);
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
- Condition line: \"target <field>: <value>\" where <field> is one of: os, ram, cpu, load, uptime.\n\
  - For os: <value> is free text matched case-insensitively against the host's OS name or id, \
e.g. \"target os: debian\".\n\
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
  disable-service <name>\n\n\
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
        _ => None,
    }
}

/// Service-manager family for a platform key — every family here besides
/// Alpine's OpenRC uses systemd.
fn service_family(platform_key: &str) -> Option<&'static str> {
    match platform_key {
        "alpine" => Some("openrc"),
        "ubuntu" | "debian" | "raspbian" | "linuxmint" | "pop" | "centos" | "rhel" | "rocky"
        | "almalinux" | "fedora" | "amzn" | "arch" | "manjaro" | "opensuse" | "opensuse-leap" | "sles" => {
            Some("systemd")
        }
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

    #[test]
    fn unsupported_platform_returns_none() {
        let op = Operation::InstallPackage { name: "nginx".into() };
        assert_eq!(render_command(&op, "windows"), None);
        assert_eq!(render_command(&op, "unknown"), None);
    }

    #[test]
    fn rejects_a_name_with_shell_metacharacters() {
        let op = Operation::InstallPackage { name: "nginx; rm -rf /".into() };
        assert_eq!(render_command(&op, "ubuntu"), None);
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
        assert_eq!(statement_applies(&one_line[0], Some(&high_ram_ubuntu)), statement_applies(&two_lines[0], Some(&high_ram_ubuntu)));
        assert_eq!(statement_applies(&one_line[0], Some(&low_ram_ubuntu)), statement_applies(&two_lines[0], Some(&low_ram_ubuntu)));
        assert!(statement_applies(&one_line[0], Some(&high_ram_ubuntu)));
        assert!(!statement_applies(&one_line[0], Some(&low_ram_ubuntu)));
    }

    #[test]
    fn or_condition_matches_when_either_side_matches() {
        let program = parse_program("target os: debian || target os: centos\ninstall-package nginx").unwrap();
        assert!(statement_applies(&program[0], Some(&facts_with("debian", 0.0))));
        assert!(statement_applies(&program[0], Some(&facts_with("centos", 0.0))));
        assert!(!statement_applies(&program[0], Some(&facts_with("ubuntu", 0.0))));
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
        assert!(condition_matches(&cond, Some(&facts_with("debian", 0.0))));
    }

    #[test]
    fn no_conditions_always_applies_even_without_facts() {
        let stmt = Statement { conditions: vec![], sudo: false, operation: Operation::UpdatePackages };
        assert!(statement_applies(&stmt, None));
    }

    #[test]
    fn a_condition_never_matches_a_host_with_no_facts() {
        let stmt = Statement {
            conditions: vec![ConditionExpr::Atom(Condition::Os("debian".into()))],
            sudo: false,
            operation: Operation::UpdatePackages,
        };
        assert!(!statement_applies(&stmt, None));
    }

    #[test]
    fn ram_condition_respects_the_comparison_operator() {
        let cond = Condition::Ram { op: CmpOp::Gt, value: 80.0 };
        assert!(condition_matches(&cond, Some(&facts_with("ubuntu", 85.0))));
        assert!(!condition_matches(&cond, Some(&facts_with("ubuntu", 50.0))));
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
        let result = compose_for_host(&program, "ubuntu", Some(&facts));
        assert_eq!(result.command.as_deref(), Some("apt-get install -y nginx\nsystemctl restart nginx"));
        assert_eq!(result.note, None);
    }

    #[test]
    fn compose_skips_blocks_whose_condition_does_not_match() {
        let program = parse_program("target os: centos\ninstall-package nginx").unwrap();
        let facts = facts_with("ubuntu", 0.0);
        let result = compose_for_host(&program, "ubuntu", Some(&facts));
        assert_eq!(result.command, None);
        assert!(result.note.unwrap().contains("aucune condition"));
    }

    #[test]
    fn compose_notes_an_unsupported_platform_for_a_matching_block() {
        let program = parse_program("install-package nginx").unwrap();
        let result = compose_for_host(&program, "windows", None);
        assert_eq!(result.command, None);
        assert!(result.note.unwrap().contains("install-package"));
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
        assert_eq!(groups[0].command.as_deref(), Some("systemctl restart nginx"));
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
}
