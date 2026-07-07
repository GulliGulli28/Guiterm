use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub type HostId = Uuid;
pub type GroupId = Uuid;
pub type SnippetId = Uuid;
pub type PortForwardId = Uuid;
pub type KeyId = Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct EnvVar {
    pub key: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum AuthMethod {
    #[default]
    Password,
    PrivateKey {
        path: String,
        /// If set, the passphrase is stored in the vault under this key's ID
        /// rather than under the host's ID.
        #[serde(default)]
        key_id: Option<KeyId>,
    },
    Agent,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrivateKey {
    pub id: KeyId,
    pub name: String,
    pub path: String,
    /// PEM content of the key file, read at import time so the original file is no longer required.
    #[serde(default)]
    pub content: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomIcon {
    pub id: String,
    pub name: String,
    pub data_url: String,
}

/// Deserialises `jumpVia` from old configs that stored a single UUID (or null)
/// as well as the new array format.
fn deser_jump_via<'de, D>(d: D) -> Result<Vec<HostId>, D::Error>
where D: serde::Deserializer<'de>
{
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Compat { One(HostId), Many(Vec<HostId>) }
    Ok(match Option::<Compat>::deserialize(d)? {
        None => Vec::new(),
        Some(Compat::One(id)) => vec![id],
        Some(Compat::Many(ids)) => ids,
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Host {
    pub id: HostId,
    pub label: String,
    pub address: String,
    pub port: u16,
    pub username: String,
    pub auth: AuthMethod,
    pub group_id: Option<GroupId>,
    /// Ordered list of bastion / jump hosts to traverse before reaching this host.
    /// `jump_via[0]` is the first hop, `jump_via[n-1]` is the last before the target.
    #[serde(default, deserialize_with = "deser_jump_via")]
    pub jump_via: Vec<HostId>,
    pub tags: Vec<String>,
    /// Snippets to execute automatically right after the shell opens, in order.
    #[serde(default)]
    pub startup_snippets: Vec<SnippetId>,
    /// Environment variables exported into the shell at startup.
    #[serde(default)]
    pub env_vars: Vec<EnvVar>,
    #[serde(default)]
    pub icon: Option<String>,
    /// SSH keepalive interval in seconds (`None` or `0` disables it). Sent as
    /// `keepalive@openssh.com` channel requests by the underlying `russh` client
    /// to keep idle connections (e.g. behind NAT/firewalls) from being dropped.
    #[serde(default)]
    pub keepalive_interval_secs: Option<u32>,
    /// Forwards the local SSH agent to this host so it can, in turn, authenticate
    /// onward (e.g. to a Git server or another bastion) using local keys, without
    /// those keys ever leaving the client. Security-sensitive: only enable for
    /// hosts you trust, since a compromised remote could abuse the forwarded
    /// agent for as long as the session is open. Unix-only, requires `auth: Agent`.
    #[serde(default)]
    pub agent_forward: bool,
}

impl Host {
    pub fn new(label: impl Into<String>, address: impl Into<String>, username: impl Into<String>) -> Self {
        Self {
            id: Uuid::new_v4(),
            label: label.into(),
            address: address.into(),
            port: 22,
            username: username.into(),
            auth: AuthMethod::Agent,
            group_id: None,
            jump_via: Vec::new(),
            tags: Vec::new(),
            startup_snippets: Vec::new(),
            env_vars: Vec::new(),
            icon: None,
            keepalive_interval_secs: None,
            agent_forward: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Group {
    pub id: GroupId,
    pub name: String,
    pub parent_id: Option<GroupId>,
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub color: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snippet {
    pub id: SnippetId,
    pub name: String,
    pub command: String,
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PortForwardKind {
    /// Listen locally, forward into the remote network.
    Local,
    /// Listen remotely, forward into the local network.
    Remote,
}

impl std::fmt::Display for PortForwardKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            PortForwardKind::Local => "Local (-L)",
            PortForwardKind::Remote => "Distant (-R)",
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortForward {
    pub id: PortForwardId,
    pub host_id: HostId,
    pub kind: PortForwardKind,
    pub bind_address: String,
    pub bind_port: u16,
    pub dest_address: String,
    pub dest_port: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub groups: Vec<Group>,
    pub hosts: Vec<Host>,
    pub snippets: Vec<Snippet>,
    pub port_forwards: Vec<PortForward>,
    #[serde(default)]
    pub keychain: Vec<PrivateKey>,
    #[serde(default)]
    pub custom_icons: Vec<CustomIcon>,
}

impl Workspace {
    pub fn host(&self, id: HostId) -> Option<&Host> {
        self.hosts.iter().find(|h| h.id == id)
    }

    /// Resolves the bastion chain for a host: bastions first (in order), target last.
    pub fn jump_chain(&self, id: HostId) -> anyhow::Result<Vec<&Host>> {
        let target = self.host(id).ok_or_else(|| anyhow::anyhow!("host {id} not found"))?;
        let mut chain: Vec<&Host> = Vec::with_capacity(target.jump_via.len() + 1);
        let mut seen = std::collections::HashSet::new();
        seen.insert(id);
        for &jid in &target.jump_via {
            if !seen.insert(jid) {
                anyhow::bail!("duplicate bastion in chain");
            }
            chain.push(self.host(jid).ok_or_else(|| anyhow::anyhow!("bastion {jid} not found"))?);
        }
        chain.push(target);
        Ok(chain)
    }
}
