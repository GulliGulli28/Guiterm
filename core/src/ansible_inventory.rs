//! Importing hosts from an Ansible inventory — a file, with no API behind it.
//!
//! **Why not reuse the EC2 matching rule.** An EC2 import matches an existing
//! host on its address, because there the address *is* the instance id: a
//! globally unique, immutable name for one machine. Ansible has no equivalent.
//! Its address is `ansible_host`, which is exactly the field an inventory edits
//! when a machine moves — matching on it would create a duplicate every time
//! someone re-IPs a server. The stable identity is the **inventory name**, the
//! thing playbooks target, so that is what a host records in
//! [`crate::model::HostSource`] and what a re-import matches on.
//!
//! The accepted cost: renaming an entry *in the inventory* creates a second
//! host and orphans the first. Without an identifier at the machine level that
//! is unavoidable, and it fails in the visible direction — two hosts you can
//! see, rather than the wrong host silently overwritten.
//!
//! **Both syntaxes**, because real inventories use both: the INI-ish one and
//! the YAML one. They parse into the same [`InventoryHost`], so everything
//! downstream is unaware of which file it came from.

use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, HashMap};

/// One host as the inventory describes it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryHost {
    /// The inventory name — the identity a re-import matches on, and what
    /// playbooks use. Not necessarily reachable: `ansible_host` overrides it.
    pub name: String,
    /// Where to actually connect, from `ansible_host` when it is set,
    /// otherwise the name itself.
    pub address: String,
    /// `ansible_user`, when the inventory says. `None` leaves the choice to
    /// the import form, which applies one login to the batch.
    pub username: Option<String>,
    /// `ansible_port`, when the inventory says.
    pub port: Option<u16>,
    /// Every group this host belongs to, parents included. Imported as *tags*
    /// rather than as a Guiterm group: `target tag: webservers` already exists
    /// in the adaptive language, so the import makes the fleet targetable by
    /// role straight away — which is most of the point of importing it.
    pub groups: Vec<String>,
}

/// What one inventory file yielded.
#[derive(Debug, Clone, PartialEq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Inventory {
    pub hosts: Vec<InventoryHost>,
    /// Entries deliberately not imported, with the reason — listed rather than
    /// dropped, so a file that half-imported says so instead of looking
    /// complete. Same rule as the EC2 panel listing unreachable instances.
    pub skipped: Vec<SkippedEntry>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkippedEntry {
    pub entry: String,
    pub reason: String,
}

/// Parses an inventory, choosing the syntax by content rather than by file
/// name — inventories are routinely called `hosts`, `inventory`, `prod`, with
/// no extension at all, so an extension check would fail on the common case.
pub fn parse(content: &str) -> Inventory {
    if looks_like_yaml(content) {
        parse_yaml(content)
    } else {
        parse_ini(content)
    }
}

/// YAML inventories are a mapping of group names; the INI form is either bare
/// host lines or `[section]` headers. A line ending in `:` at the top level is
/// the giveaway, and `---` settles the ambiguous case of an empty file.
fn looks_like_yaml(content: &str) -> bool {
    content.lines().any(|line| {
        let trimmed = line.trim_end();
        trimmed == "---"
            || (!trimmed.starts_with('#')
                && !trimmed.starts_with('[')
                && trimmed.ends_with(':')
                && !line.starts_with(' ')
                && trimmed.len() > 1)
    })
}

// ─── INI ─────────────────────────────────────────────────────────────────

/// Accumulates a host across the several sections it can appear in.
#[derive(Default)]
struct Building {
    address: Option<String>,
    username: Option<String>,
    port: Option<u16>,
    groups: BTreeSet<String>,
}

pub fn parse_ini(content: &str) -> Inventory {
    let mut hosts: HashMap<String, Building> = HashMap::new();
    let mut order: Vec<String> = Vec::new();
    let mut skipped = Vec::new();
    // Group name → its `[group:vars]`, applied after every host is known so a
    // vars section may appear before or after the hosts it covers.
    let mut group_vars: HashMap<String, HashMap<String, String>> = HashMap::new();
    // Group name → its `[group:children]`, resolved at the end so a child may
    // be declared after its parent.
    let mut group_children: HashMap<String, Vec<String>> = HashMap::new();

    // Hosts before any `[section]` belong to the implicit `ungrouped` group,
    // exactly as Ansible treats them.
    let mut current = "ungrouped".to_string();
    let mut mode = Section::Hosts;

    for raw in content.lines() {
        let line = strip_comment(raw);
        if line.is_empty() {
            continue;
        }
        if let Some(header) = line.strip_prefix('[').and_then(|l| l.strip_suffix(']')) {
            let header = header.trim();
            let (name, kind) = match header.split_once(':') {
                Some((name, "vars")) => (name.trim(), Section::Vars),
                Some((name, "children")) => (name.trim(), Section::Children),
                // `[group:something-else]` is not a form Ansible defines;
                // treating it as a plain group is friendlier than dropping it.
                _ => (header, Section::Hosts),
            };
            current = name.to_string();
            mode = kind;
            continue;
        }

        match mode {
            Section::Vars => {
                if let Some((key, value)) = line.split_once('=') {
                    group_vars
                        .entry(current.clone())
                        .or_default()
                        .insert(key.trim().to_string(), value.trim().to_string());
                }
            }
            Section::Children => {
                group_children.entry(current.clone()).or_default().push(line.to_string());
            }
            Section::Hosts => {
                let mut fields = line.split_whitespace();
                let Some(pattern) = fields.next() else { continue };
                let names = match expand_pattern(pattern) {
                    Ok(names) => names,
                    Err(reason) => {
                        skipped.push(SkippedEntry { entry: pattern.to_string(), reason });
                        continue;
                    }
                };
                let inline: Vec<(String, String)> = fields
                    .filter_map(|field| field.split_once('='))
                    .map(|(k, v)| (k.trim().to_string(), v.trim().to_string()))
                    .collect();

                for name in names {
                    if !hosts.contains_key(&name) {
                        order.push(name.clone());
                    }
                    let entry = hosts.entry(name).or_default();
                    entry.groups.insert(current.clone());
                    for (key, value) in &inline {
                        apply_var(entry, key, value);
                    }
                }
            }
        }
    }

    // `[parent:children]` — a host in a child group also belongs to the
    // parent, which is what makes `target tag: prod` reach the web *and* db
    // machines. Repeated to a fixed point so a chain of parents resolves
    // whatever order the file declares it in.
    for _ in 0..8 {
        let mut changed = false;
        for (parent, children) in &group_children {
            for child in children {
                for building in hosts.values_mut() {
                    if building.groups.contains(child) && !building.groups.contains(parent) {
                        building.groups.insert(parent.clone());
                        changed = true;
                    }
                }
            }
        }
        if !changed {
            break;
        }
    }

    // Group vars last, and never over an inline value: `foo ansible_port=2222`
    // on the host line is more specific than the group's default, and Ansible
    // resolves it the same way.
    for (group, vars) in &group_vars {
        for building in hosts.values_mut() {
            if group != "all" && !building.groups.contains(group) {
                continue;
            }
            for (key, value) in vars {
                if !has_var(building, key) {
                    apply_var(building, key, value);
                }
            }
        }
    }

    Inventory {
        hosts: order
            .into_iter()
            .filter_map(|name| {
                let building = hosts.remove(&name)?;
                Some(finish(name, building))
            })
            .collect(),
        skipped,
    }
}

enum Section {
    Hosts,
    Vars,
    Children,
}

fn strip_comment(line: &str) -> &str {
    let line = line.split('#').next().unwrap_or("");
    line.split(';').next().unwrap_or("").trim()
}

fn apply_var(building: &mut Building, key: &str, value: &str) {
    match key {
        "ansible_host" | "ansible_ssh_host" => building.address = Some(value.to_string()),
        "ansible_user" | "ansible_ssh_user" => building.username = Some(value.to_string()),
        "ansible_port" | "ansible_ssh_port" => building.port = value.parse().ok(),
        _ => {}
    }
}

fn has_var(building: &Building, key: &str) -> bool {
    match key {
        "ansible_host" | "ansible_ssh_host" => building.address.is_some(),
        "ansible_user" | "ansible_ssh_user" => building.username.is_some(),
        "ansible_port" | "ansible_ssh_port" => building.port.is_some(),
        _ => true,
    }
}

fn finish(name: String, building: Building) -> InventoryHost {
    InventoryHost {
        address: building.address.unwrap_or_else(|| name.clone()),
        name,
        username: building.username,
        port: building.port,
        groups: building.groups.into_iter().collect(),
    }
}

/// Expands `web[01:03].example.com` into the three names it stands for.
///
/// One inventory line routinely means dozens of machines, so importing the
/// literal bracket string would create a single host nothing can connect to.
/// Zero-padding is preserved (`01` → `01`, `02`…), since that is what the
/// names actually are.
///
/// Only numeric ranges: the alphabetic form (`[a:d]`) is rare enough that
/// guessing at it is worse than saying it wasn't imported.
fn expand_pattern(pattern: &str) -> Result<Vec<String>, String> {
    let Some(open) = pattern.find('[') else {
        return Ok(vec![pattern.to_string()]);
    };
    let Some(close) = pattern[open..].find(']').map(|i| i + open) else {
        return Err("crochet ouvrant sans fermant".to_string());
    };
    let inside = &pattern[open + 1..close];
    let Some((from, to)) = inside.split_once(':') else {
        return Err(format!("motif « {inside} » non reconnu (attendu « début:fin »)"));
    };
    let (Ok(start), Ok(end)) = (from.parse::<u32>(), to.parse::<u32>()) else {
        return Err(format!("plage « {inside} » non numérique — non développée"));
    };
    if end < start || end - start > 1000 {
        return Err(format!("plage « {inside} » invalide ou trop large"));
    }
    let width = from.len();
    let (prefix, suffix) = (&pattern[..open], &pattern[close + 1..]);
    Ok((start..=end)
        .map(|n| format!("{prefix}{n:0width$}{suffix}"))
        .collect())
}

// ─── YAML ────────────────────────────────────────────────────────────────

pub fn parse_yaml(content: &str) -> Inventory {
    let parsed: serde_yaml::Value = match serde_yaml::from_str(content) {
        Ok(value) => value,
        Err(e) => {
            return Inventory {
                hosts: Vec::new(),
                skipped: vec![SkippedEntry {
                    entry: "(fichier)".to_string(),
                    reason: format!("YAML illisible : {e}"),
                }],
            };
        }
    };

    let mut hosts: HashMap<String, Building> = HashMap::new();
    let mut order: Vec<String> = Vec::new();
    if let Some(mapping) = parsed.as_mapping() {
        for (group, body) in mapping {
            let Some(group) = group.as_str() else { continue };
            walk_group(group, body, &HashMap::new(), &[], &mut hosts, &mut order);
        }
    }

    Inventory {
        hosts: order
            .into_iter()
            .filter_map(|name| {
                let building = hosts.remove(&name)?;
                Some(finish(name, building))
            })
            .collect(),
        skipped: Vec::new(),
    }
}

/// Walks one group, carrying down the vars and group names it inherits.
///
/// `all` is not recorded as a tag: every host is in it, so it would tag
/// everything with a word that distinguishes nothing.
fn walk_group(
    group: &str,
    body: &serde_yaml::Value,
    inherited_vars: &HashMap<String, String>,
    inherited_groups: &[String],
    hosts: &mut HashMap<String, Building>,
    order: &mut Vec<String>,
) {
    let mut groups: Vec<String> = inherited_groups.to_vec();
    if group != "all" {
        groups.push(group.to_string());
    }

    let mut vars = inherited_vars.clone();
    if let Some(map) = body.get("vars").and_then(|v| v.as_mapping()) {
        for (key, value) in map {
            if let (Some(key), Some(value)) = (key.as_str(), scalar(value)) {
                vars.insert(key.to_string(), value);
            }
        }
    }

    if let Some(map) = body.get("hosts").and_then(|v| v.as_mapping()) {
        for (name, host_vars) in map {
            let Some(name) = name.as_str() else { continue };
            if !hosts.contains_key(name) {
                order.push(name.to_string());
            }
            let entry = hosts.entry(name.to_string()).or_default();
            for group in &groups {
                entry.groups.insert(group.clone());
            }
            // The host's own vars win over the group's, so they go on first
            // and `has_var` keeps the group from overwriting them.
            if let Some(own) = host_vars.as_mapping() {
                for (key, value) in own {
                    if let (Some(key), Some(value)) = (key.as_str(), scalar(value)) {
                        apply_var(entry, key, &value);
                    }
                }
            }
            for (key, value) in &vars {
                if !has_var(entry, key) {
                    apply_var(entry, key, value);
                }
            }
        }
    }

    if let Some(children) = body.get("children").and_then(|v| v.as_mapping()) {
        for (child, child_body) in children {
            let Some(child) = child.as_str() else { continue };
            walk_group(child, child_body, &vars, &groups, hosts, order);
        }
    }
}

/// A YAML scalar as text — inventories write ports as numbers and addresses as
/// strings, and both have to reach [`apply_var`] the same way.
fn scalar(value: &serde_yaml::Value) -> Option<String> {
    match value {
        serde_yaml::Value::String(s) => Some(s.clone()),
        serde_yaml::Value::Number(n) => Some(n.to_string()),
        serde_yaml::Value::Bool(b) => Some(b.to_string()),
        _ => None,
    }
}

pub use crate::model::HostSource;

/// One host the user ticked in the import panel.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InventorySelection {
    pub name: String,
    pub label: String,
    pub address: String,
    pub username: String,
    pub port: u16,
    pub group_id: Option<crate::model::GroupId>,
    #[serde(default)]
    pub tags: Vec<String>,
}

/// Creates the hosts of one inventory import, refreshing the ones already
/// there.
///
/// **Not shared with [`crate::aws_inventory::apply_import`], on purpose.** The
/// two match on different things for a reason that isn't cosmetic: EC2 hosts
/// imported before provenance existed carry no [`HostSource`], so making AWS
/// match on it would duplicate every instance already in a user's workspace on
/// their next re-import. Factoring the two together would mean either that
/// breakage or a function whose body is one big `if source`.
///
/// Only what the inventory owns is refreshed — the address, the port and the
/// tags. The label, the login, the group and the credentials are the user's
/// decisions, and a re-import that undid an edit would make the feature
/// unusable on a curated list. Same rule as the EC2 path.
pub fn apply_import(
    workspace: &mut crate::model::Workspace,
    selections: Vec<InventorySelection>,
    auth: &crate::model::AuthMethod,
) -> crate::aws_inventory::ImportOutcome {
    let mut outcome = crate::aws_inventory::ImportOutcome::default();
    for selection in selections {
        let source = HostSource::ansible(&selection.name);
        if let Some(existing) = workspace
            .hosts
            .iter_mut()
            .find(|host| host.source.as_ref() == Some(&source))
        {
            existing.address = selection.address;
            existing.port = selection.port;
            existing.tags = selection.tags;
            outcome.updated.push(existing.id);
            continue;
        }
        let mut host =
            crate::model::Host::new(selection.label, selection.address, selection.username);
        host.port = selection.port;
        host.group_id = selection.group_id;
        host.tags = selection.tags;
        host.auth = auth.clone();
        host.source = Some(source);
        outcome.added.push(host.id);
        workspace.hosts.push(host);
    }
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;

    fn host<'a>(inventory: &'a Inventory, name: &str) -> &'a InventoryHost {
        inventory
            .hosts
            .iter()
            .find(|h| h.name == name)
            .unwrap_or_else(|| panic!("hôte « {name} » absent de {:?}", inventory.hosts))
    }

    const INI: &str = "\
# Un inventaire ordinaire
mail.example.com

[webservers]
foo.example.com
bar.example.com ansible_host=10.0.0.2 ansible_port=2222 ansible_user=deploy

[dbservers]
one.example.com

[prod:children]
webservers
dbservers

[prod:vars]
ansible_user=ubuntu

[webservers:vars]
ansible_port=22
";

    #[test]
    fn reads_inline_variables_from_a_host_line() {
        let inventory = parse_ini(INI);
        let bar = host(&inventory, "bar.example.com");
        assert_eq!(bar.address, "10.0.0.2");
        assert_eq!(bar.username.as_deref(), Some("deploy"));
        assert_eq!(bar.port, Some(2222));
    }

    /// No `ansible_host` means the inventory name *is* the address — the
    /// ordinary case, and getting it wrong would import unreachable hosts.
    #[test]
    fn a_host_without_ansible_host_connects_by_its_own_name() {
        let inventory = parse_ini(INI);
        assert_eq!(host(&inventory, "foo.example.com").address, "foo.example.com");
    }

    #[test]
    fn a_host_outside_any_section_lands_in_ungrouped() {
        let inventory = parse_ini(INI);
        assert_eq!(host(&inventory, "mail.example.com").groups, vec!["ungrouped".to_string()]);
    }

    /// `[parent:children]` is what makes `target tag: prod` reach both the web
    /// and the db machines — the whole reason groups are imported as tags.
    #[test]
    fn a_child_group_membership_reaches_the_parent() {
        let inventory = parse_ini(INI);
        assert!(host(&inventory, "foo.example.com").groups.contains(&"prod".to_string()));
        assert!(host(&inventory, "one.example.com").groups.contains(&"prod".to_string()));
        assert!(!host(&inventory, "mail.example.com").groups.contains(&"prod".to_string()));
    }

    /// Ansible resolves the most specific value; so must this, or a host with
    /// a deliberate exception would silently get the group's default.
    #[test]
    fn an_inline_value_wins_over_the_group_default() {
        let inventory = parse_ini(INI);
        // `bar` sets 2222 on its own line; `[webservers:vars]` says 22.
        assert_eq!(host(&inventory, "bar.example.com").port, Some(2222));
        assert_eq!(host(&inventory, "foo.example.com").port, Some(22));
        // ...and `bar` keeps its own user against `[prod:vars]`.
        assert_eq!(host(&inventory, "bar.example.com").username.as_deref(), Some("deploy"));
        assert_eq!(host(&inventory, "foo.example.com").username.as_deref(), Some("ubuntu"));
    }

    #[test]
    fn comments_and_blank_lines_are_ignored() {
        let inventory = parse_ini("# rien\n\n; rien non plus\nweb.example.com  # en fin de ligne\n");
        assert_eq!(inventory.hosts.len(), 1);
        assert_eq!(inventory.hosts[0].name, "web.example.com");
    }

    /// One line standing for fifty machines is normal in an inventory;
    /// importing the literal bracket string would create a single host nothing
    /// can reach.
    #[test]
    fn a_numeric_range_expands_and_keeps_its_padding() {
        let inventory = parse_ini("[web]\nweb[01:03].example.com\n");
        let names: Vec<&str> = inventory.hosts.iter().map(|h| h.name.as_str()).collect();
        assert_eq!(names, vec!["web01.example.com", "web02.example.com", "web03.example.com"]);
    }

    /// Not expanded, and *said* rather than dropped: a file that half-imported
    /// must not look complete.
    #[test]
    fn an_unsupported_pattern_is_reported_instead_of_silently_dropped() {
        let inventory = parse_ini("[web]\nweb[a:d].example.com\n");
        assert!(inventory.hosts.is_empty());
        assert_eq!(inventory.skipped.len(), 1);
        assert!(inventory.skipped[0].reason.contains("non numérique"));
    }

    const YAML: &str = "\
all:
  vars:
    ansible_user: ubuntu
  hosts:
    mail.example.com:
  children:
    webservers:
      vars:
        ansible_port: 2222
      hosts:
        foo.example.com:
        bar.example.com:
          ansible_host: 10.0.0.2
          ansible_user: deploy
    prod:
      children:
        dbservers:
          hosts:
            one.example.com:
";

    #[test]
    fn the_yaml_form_reads_hosts_and_their_variables() {
        let inventory = parse_yaml(YAML);
        let bar = host(&inventory, "bar.example.com");
        assert_eq!(bar.address, "10.0.0.2");
        assert_eq!(bar.username.as_deref(), Some("deploy"), "la var de l'hôte l'emporte");
        assert_eq!(bar.port, Some(2222), "héritée du groupe");
        assert_eq!(host(&inventory, "foo.example.com").username.as_deref(), Some("ubuntu"));
    }

    #[test]
    fn the_yaml_form_carries_nested_group_names_down() {
        let inventory = parse_yaml(YAML);
        let one = host(&inventory, "one.example.com");
        assert!(one.groups.contains(&"prod".to_string()));
        assert!(one.groups.contains(&"dbservers".to_string()));
        // `all` tags nothing: every host is in it, so it distinguishes nothing.
        assert!(!one.groups.contains(&"all".to_string()));
    }

    /// Inventories are routinely named `hosts`, `inventory` or `prod` with no
    /// extension, so the syntax has to be recognised from the content.
    #[test]
    fn the_syntax_is_chosen_by_content_not_by_file_name() {
        assert_eq!(parse(YAML).hosts.len(), 4, "forme YAML");
        assert_eq!(parse(INI).hosts.len(), 4, "forme INI");
    }

    #[test]
    fn an_unreadable_yaml_says_so_rather_than_returning_nothing() {
        let inventory = parse_yaml("all:\n  hosts:\n   - [unbalanced\n");
        assert!(inventory.hosts.is_empty());
        assert_eq!(inventory.skipped.len(), 1);
    }

    // ── apply_import ──────────────────────────────────────────────────────

    use crate::model::{AuthMethod, Workspace};

    fn selection(name: &str, address: &str) -> InventorySelection {
        InventorySelection {
            name: name.to_string(),
            label: name.to_string(),
            address: address.to_string(),
            username: "ubuntu".to_string(),
            port: 22,
            group_id: None,
            tags: vec!["webservers".to_string()],
        }
    }

    /// The rule the matching decision exists for: an inventory that moved a
    /// machine must refresh it, not add a second one.
    #[test]
    fn reimporting_a_host_whose_address_changed_updates_it() {
        let mut workspace = Workspace::default();
        apply_import(&mut workspace, vec![selection("web1", "10.0.0.1")], &AuthMethod::Agent);
        assert_eq!(workspace.hosts.len(), 1);

        let outcome = apply_import(&mut workspace, vec![selection("web1", "10.0.0.9")], &AuthMethod::Agent);
        assert_eq!(workspace.hosts.len(), 1, "l'adresse a changé, pas la machine");
        assert_eq!(outcome.updated.len(), 1);
        assert_eq!(workspace.hosts[0].address, "10.0.0.9");
    }

    /// The accepted limitation, asserted rather than left to be discovered:
    /// renaming the *inventory entry* looks like a new machine. Fails visibly
    /// (two hosts) rather than silently overwriting the wrong one.
    #[test]
    fn renaming_the_inventory_entry_creates_a_second_host() {
        let mut workspace = Workspace::default();
        apply_import(&mut workspace, vec![selection("web1", "10.0.0.1")], &AuthMethod::Agent);
        apply_import(&mut workspace, vec![selection("web-01", "10.0.0.1")], &AuthMethod::Agent);
        assert_eq!(workspace.hosts.len(), 2);
    }

    /// A re-import must not undo what the user curated afterwards — the thing
    /// that decides whether the feature is usable on a real list.
    #[test]
    fn a_reimport_leaves_the_users_own_edits_alone() {
        let mut workspace = Workspace::default();
        apply_import(&mut workspace, vec![selection("web1", "10.0.0.1")], &AuthMethod::Agent);
        workspace.hosts[0].label = "Prod — front".to_string();
        workspace.hosts[0].username = "glorin".to_string();
        workspace.hosts[0].auth = AuthMethod::Password;

        apply_import(&mut workspace, vec![selection("web1", "10.0.0.1")], &AuthMethod::Agent);
        assert_eq!(workspace.hosts[0].label, "Prod — front");
        assert_eq!(workspace.hosts[0].username, "glorin");
        assert_eq!(workspace.hosts[0].auth, AuthMethod::Password);
    }

    /// An EC2 host carries no source, so an inventory re-import must not adopt
    /// it — matching would be on `None == None` if the comparison were sloppy.
    #[test]
    fn a_host_from_another_source_is_never_matched() {
        let mut workspace = Workspace::default();
        workspace.hosts.push(crate::model::Host::new("i-0123", "i-0123", "ec2-user"));

        apply_import(&mut workspace, vec![selection("web1", "10.0.0.1")], &AuthMethod::Agent);
        assert_eq!(workspace.hosts.len(), 2);
    }
}
