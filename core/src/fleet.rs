//! Structured fan-out execution: run one command across many targets at once
//! and capture a per-target result (exit code, stdout, stderr, duration)
//! instead of streaming bytes into an interactive terminal. This is the
//! "control plane" primitive the terminal path deliberately lacks — and the
//! foundation the facts-collection and declarative-intent layers build on.
//!
//! A target is an SSH host, a specific Docker exec container, a specific
//! K8s exec pod/container, or the local machine ([`FleetTarget`]) — RDP has
//! no shell, so it isn't representable here at all; the UI simply never
//! offers it.

use crate::model::{HostId, HostKind, Workspace};
use crate::{docker, k8s, local_shell, ssh};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;
use tokio::sync::{mpsc, Semaphore};

/// Default number of targets a single fleet run connects to concurrently.
pub const DEFAULT_CONCURRENCY: usize = 10;

/// A single fleet run target. `Ssh` (an SSH host, identified the same way
/// every other SSH-only feature already does) is still the common case;
/// `Docker`/`Local` generalize the same run/results/history machinery to a
/// specific Docker exec container and the local machine respectively.
/// `Eq`/`Hash` so it can key [`run_on_hosts`]'s per-target command map.
// `rename_all` alone only renames the `kind` tag's *values* (`Ssh` ->
// "ssh") for an internally-tagged enum — it does NOT rename struct-variant
// field names (`host_id` would stay `host_id` on the wire, not become
// `hostId`). Already bit this project three times elsewhere (`rdp_ipc`'s
// `deltaY`, `PaneSource::Docker`'s `containerId`) — `rename_all_fields`
// (serde >= 1.0.145) is the fix that actually covers every variant's
// fields, so a fourth variant added here later can't silently regress.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum FleetTarget {
    Ssh { host_id: HostId },
    /// A specific container of a `dockerExec` host — `host_id` identifies
    /// the daemon (for `docker::connect_for_host`), `container_id` the live
    /// container to run in. Never persisted on `Host` itself: a
    /// `dockerExec` host isn't tied to one container (see
    /// `HostKind::DockerExec`'s doc comment) — the caller supplies it fresh
    /// each time (a live container list, in the UI's case).
    Docker { host_id: HostId, container_id: String },
    /// A specific pod (and, if the pod has more than one, container) of a
    /// `k8sExec` host — `host_id` identifies the kubeconfig context
    /// (`k8s::connect`) and default namespace (`Host::username`, per
    /// `HostKind::K8sExec`'s doc comment); `pod_name`/`container_name` the
    /// live pod to run in, supplied fresh each time (a live pod list, in the
    /// UI's case) — same reasoning as `Docker`'s `container_id`, a
    /// `k8sExec` host isn't tied to one pod either.
    K8s { host_id: HostId, pod_name: String, container_name: Option<String> },
    /// The machine Guiterm itself runs on — no host lookup, no connection.
    Local,
}

/// Result of running a command on one target in a fleet run.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostOutcome {
    pub target: FleetTarget,
    /// Exit code when the command actually ran to completion; `None` means it
    /// never ran — see `error`. `Some(0)` with `error: None` is the success case.
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub duration_ms: u64,
    /// Set when the target couldn't be reached / the command couldn't be
    /// started at all (connection, auth, unsupported host kind…), as
    /// distinct from a command that ran and returned a non-zero `exit_code`.
    pub error: Option<String>,
}

/// Runs, for every `(target, command)` pair in `commands`, that target's own
/// command — concurrently, bounded by `concurrency` — sending each
/// [`HostOutcome`] on `tx` as soon as that target finishes. Returns once
/// every target has reported; dropping the last `tx` clone (which happens
/// when this returns) lets the receiver observe completion.
///
/// Every target runs *its own* command rather than one shared string so this
/// same primitive serves both a classic fleet run (every target maps to the
/// same command — see [`uniform_commands`]) and an adaptive run (each target
/// maps to whatever its platform group compiled to — see `crate::adaptive`,
/// SSH-only for now).
pub async fn run_on_hosts(
    workspace: Arc<Workspace>,
    commands: HashMap<FleetTarget, String>,
    concurrency: usize,
    tx: mpsc::UnboundedSender<HostOutcome>,
) {
    let semaphore = Arc::new(Semaphore::new(concurrency.max(1)));
    let mut handles = Vec::with_capacity(commands.len());
    for (target, command) in commands {
        let workspace = workspace.clone();
        let semaphore = semaphore.clone();
        let tx = tx.clone();
        handles.push(tokio::spawn(async move {
            // Held for the whole per-target run so no more than `concurrency`
            // targets are connected at once; released when this task ends.
            let _permit = semaphore.acquire().await;
            let outcome = run_one(&workspace, target, &command).await;
            let _ = tx.send(outcome);
        }));
    }
    for handle in handles {
        let _ = handle.await;
    }
}

/// Builds the `commands` map for the common case: the same `command` run on
/// every target in `targets`.
pub fn uniform_commands(targets: &[FleetTarget], command: &str) -> HashMap<FleetTarget, String> {
    targets.iter().cloned().map(|t| (t, command.to_string())).collect()
}

async fn run_one(workspace: &Workspace, target: FleetTarget, command: &str) -> HostOutcome {
    let started = Instant::now();
    let result = execute(workspace, &target, command).await;
    let duration_ms = started.elapsed().as_millis() as u64;
    match result {
        Ok(output) => HostOutcome {
            target,
            exit_code: output.exit_code,
            stdout: output.stdout,
            stderr: output.stderr,
            duration_ms,
            error: None,
        },
        Err(e) => HostOutcome {
            target,
            exit_code: None,
            stdout: String::new(),
            stderr: String::new(),
            duration_ms,
            error: Some(e.to_string()),
        },
    }
}

/// Runs `command` against `target`. The return type (`ssh::CommandOutput`)
/// is reused as a generic exit-code/stdout/stderr triple for all three
/// target kinds despite its name — introducing a second identical struct
/// just to rename it isn't worth it.
async fn execute(
    workspace: &Workspace,
    target: &FleetTarget,
    command: &str,
) -> anyhow::Result<ssh::CommandOutput> {
    match target {
        FleetTarget::Ssh { host_id } => {
            let host = workspace
                .host(*host_id)
                .ok_or_else(|| anyhow::anyhow!("hôte inconnu"))?;
            if host.kind != HostKind::Ssh {
                anyhow::bail!("cet hôte n'est pas un hôte SSH");
            }
            let mut connection = ssh::connect(workspace, *host_id).await?;
            let output = ssh::run_command_capture(&connection, command).await;
            connection.disconnect().await;
            output
        }
        FleetTarget::Docker { host_id, container_id } => {
            let host = workspace
                .host(*host_id)
                .ok_or_else(|| anyhow::anyhow!("hôte Docker inconnu"))?;
            if host.kind != HostKind::DockerExec {
                anyhow::bail!("cet hôte n'est pas un hôte Docker exec");
            }
            let docker_client = docker::connect_for_host(workspace, host).await?;
            let (exit_code, stdout, stderr) = docker::exec_with_exit_code(
                &docker_client,
                container_id,
                vec!["sh".to_string(), "-c".to_string(), command.to_string()],
            )
            .await?;
            Ok(ssh::CommandOutput { exit_code, stdout, stderr })
        }
        FleetTarget::K8s { host_id, pod_name, container_name } => {
            let host = workspace
                .host(*host_id)
                .ok_or_else(|| anyhow::anyhow!("hôte Kubernetes inconnu"))?;
            if host.kind != HostKind::K8sExec {
                anyhow::bail!("cet hôte n'est pas un hôte Kubernetes exec");
            }
            let client = k8s::connect(&host.address).await?;
            let (exit_code, stdout, stderr) = k8s::exec_with_exit_code(
                &client,
                &host.username,
                pod_name,
                container_name.as_deref(),
                vec!["sh".to_string(), "-c".to_string(), command.to_string()],
            )
            .await?;
            Ok(ssh::CommandOutput { exit_code, stdout, stderr })
        }
        FleetTarget::Local => {
            let shell = local_shell::default_local_shell();
            let script = command.to_string();
            let outcome = tokio::task::spawn_blocking(move || local_shell::run_capture(&shell, &script))
                .await
                .map_err(|e| anyhow::anyhow!("échec de la tâche locale : {e}"))?
                .map_err(|e| anyhow::anyhow!("échec de l'exécution locale : {e}"))?;
            Ok(ssh::CommandOutput { exit_code: outcome.exit_code, stdout: outcome.stdout, stderr: outcome.stderr })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // A Rust->Rust roundtrip (`serde_json::to_string` then `from_str`) would
    // stay green even if `host_id`/`container_id` never got renamed at all —
    // both sides would agree on the same (wrong) wire shape. The frontend
    // sends genuinely camelCase JSON (`hostId`/`containerId`, see
    // `src/lib/types.ts`'s `FleetTarget`), so only a hand-written JSON
    // literal actually exercises the case that broke the live fleet-run
    // view: `fleet-run-outcome`'s `outcome.target` came back with
    // `host_id`/`container_id` still snake_case, so the frontend's
    // `fleetTargetKey(outcome.target)` read `undefined` for those fields and
    // could never match the key it had seeded `pending` with — rows spun
    // forever even though the run had actually finished (and was recorded
    // correctly server-side, since the history file round-trips in Rust
    // alone). Same pitfall class as `rdp_ipc`'s `deltaY` and
    // `PaneSource::Docker`'s `containerId`.
    #[test]
    fn deserializes_camel_case_field_names_from_the_frontend() {
        let ssh: FleetTarget = serde_json::from_str(
            r#"{"kind":"ssh","hostId":"11111111-1111-1111-1111-111111111111"}"#,
        )
        .unwrap();
        assert!(matches!(ssh, FleetTarget::Ssh { .. }));

        let docker: FleetTarget = serde_json::from_str(
            r#"{"kind":"docker","hostId":"11111111-1111-1111-1111-111111111111","containerId":"c1"}"#,
        )
        .unwrap();
        assert!(matches!(docker, FleetTarget::Docker { .. }));

        let k8s: FleetTarget = serde_json::from_str(
            r#"{"kind":"k8s","hostId":"11111111-1111-1111-1111-111111111111","podName":"api-7d9f8b6c-x2kq9","containerName":"api"}"#,
        )
        .unwrap();
        assert!(matches!(k8s, FleetTarget::K8s { .. }));
    }

    #[test]
    fn serializes_field_names_as_camel_case_for_the_frontend() {
        let docker = FleetTarget::Docker {
            host_id: uuid::Uuid::nil(),
            container_id: "c1".to_string(),
        };
        let json = serde_json::to_string(&docker).unwrap();
        assert!(json.contains("\"hostId\""), "expected hostId in {json}");
        assert!(json.contains("\"containerId\""), "expected containerId in {json}");
        assert!(!json.contains("host_id"), "must not contain snake_case host_id in {json}");
        assert!(!json.contains("container_id"), "must not contain snake_case container_id in {json}");

        let k8s = FleetTarget::K8s {
            host_id: uuid::Uuid::nil(),
            pod_name: "api-7d9f8b6c-x2kq9".to_string(),
            container_name: Some("api".to_string()),
        };
        let json = serde_json::to_string(&k8s).unwrap();
        assert!(json.contains("\"hostId\""), "expected hostId in {json}");
        assert!(json.contains("\"podName\""), "expected podName in {json}");
        assert!(json.contains("\"containerName\""), "expected containerName in {json}");
        assert!(!json.contains("pod_name"), "must not contain snake_case pod_name in {json}");
        assert!(!json.contains("container_name"), "must not contain snake_case container_name in {json}");
    }
}
