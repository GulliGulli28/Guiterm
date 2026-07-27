//! Kubernetes pod `exec` sessions (`kubectl exec -it` equivalent), via the
//! Kubernetes API server (`kube`) — authenticates through the user's own
//! kubeconfig (`$KUBECONFIG`, falling back to `~/.kube/config`), same as
//! `kubectl` itself. `Host::address` is the context name to load
//! ([`HostKind::K8sExec`]'s doc comment), `Host::username` the default
//! namespace a picker should start from — neither is a Guiterm-managed
//! secret: whatever auth the context's kubeconfig entry names (bearer token,
//! client cert, or an `exec:` credential plugin — e.g. `aws eks
//! get-token`/`gke-gcloud-auth-plugin`) is resolved by `kube` itself,
//! exactly like it would be for `kubectl`.
use crate::model::HostFacts;
use crate::ssh::{ShellInput, ShellSession};
use futures_util::SinkExt;
use k8s_openapi::api::core::v1::Pod;
use k8s_openapi::apimachinery::pkg::apis::meta::v1::Status;
use kube::api::{Api, AttachParams, ListParams, TerminalSize};
use kube::config::KubeConfigOptions;
use kube::{Client, Config};
use serde::Serialize;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::mpsc;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PodSummary {
    pub name: String,
    pub namespace: String,
    pub containers: Vec<String>,
    /// Kubernetes pod phase (`Running`, `Pending`, `Succeeded`, `Failed`, or
    /// `Unknown` when the API didn't report one at all).
    pub phase: String,
    /// All containers reporting ready, and at least one container present —
    /// an empty `container_statuses` (pod not yet scheduled) is not ready.
    pub ready: bool,
}

/// Lines of pod log fetched at once — same bound, and the same reasoning, as
/// [`crate::docker::MAX_LOG_LINES`].
pub const MAX_LOG_LINES: usize = 2000;

/// The last `tail` lines of a pod's log (a specific container's, when the pod
/// has several and one is named).
///
/// The `kubectl logs` equivalent, and like [`crate::docker::container_logs`]
/// it is a snapshot rather than a follow: `LogParams::follow` exists, but
/// streaming it to the frontend properly wants the binary `Channel` treatment
/// `terminal-data` gets, which isn't worth it until asked for.
pub async fn pod_logs(
    client: &Client,
    namespace: &str,
    pod_name: &str,
    container: Option<&str>,
    tail: usize,
) -> anyhow::Result<String> {
    let pods: Api<Pod> = Api::namespaced(client.clone(), namespace);
    let params = kube::api::LogParams {
        container: container.map(str::to_string),
        tail_lines: Some(tail.min(MAX_LOG_LINES) as i64),
        ..Default::default()
    };
    Ok(pods.logs(pod_name, &params).await?)
}

/// Connects to the cluster named by `context` in the user's kubeconfig — an
/// empty `context` uses the file's `current-context`, matching `kubectl`'s
/// own default when `--context` is omitted.
pub async fn connect(context: &str) -> anyhow::Result<Client> {
    let context = context.trim();
    let options = KubeConfigOptions {
        context: (!context.is_empty()).then(|| context.to_string()),
        cluster: None,
        user: None,
    };
    let config = Config::from_kubeconfig(&options).await?;
    Ok(Client::try_from(config)?)
}

/// Lists every pod in `namespace`, regardless of readiness — a connection
/// picker should still show (and let the user pick into) a not-yet-ready
/// container rather than silently hiding it, same spirit as
/// `docker::list_containers`'s `all: true`.
pub async fn list_pods(client: &Client, namespace: &str) -> anyhow::Result<Vec<PodSummary>> {
    let pods: Api<Pod> = Api::namespaced(client.clone(), namespace);
    let list = pods.list(&ListParams::default()).await?;
    Ok(list
        .into_iter()
        .map(|pod| {
            let name = pod.metadata.name.clone().unwrap_or_default();
            let containers = pod
                .spec
                .as_ref()
                .map(|s| s.containers.iter().map(|c| c.name.clone()).collect())
                .unwrap_or_default();
            let status = pod.status.as_ref();
            let phase = status.and_then(|s| s.phase.clone()).unwrap_or_else(|| "Unknown".to_string());
            let ready = status
                .and_then(|s| s.container_statuses.as_ref())
                .is_some_and(|statuses| !statuses.is_empty() && statuses.iter().all(|c| c.ready));
            PodSummary { name, namespace: namespace.to_string(), containers, phase, ready }
        })
        .collect())
}

fn attach_params(stdin: bool, stdout: bool, stderr: bool, tty: bool, container: Option<&str>) -> AttachParams {
    let mut ap = AttachParams::default().stdin(stdin).stdout(stdout).stderr(stderr).tty(tty);
    if let Some(c) = container {
        ap = ap.container(c);
    }
    ap
}

/// Opens an interactive TTY `exec` session in `pod_name` (`container`, or
/// the pod's only container if `None` and there's exactly one — the server
/// itself rejects an omitted `container` on a genuinely multi-container
/// pod), bridged onto the same plain byte-stream channels as
/// [`crate::ssh::open_shell`]/`docker::open_exec` so the terminal widget
/// never needs to know which backend it's talking to.
pub async fn open_exec(
    client: Client,
    namespace: &str,
    pod_name: &str,
    container: Option<&str>,
    cols: u16,
    rows: u16,
) -> anyhow::Result<ShellSession> {
    let pods: Api<Pod> = Api::namespaced(client, namespace);
    let ap = attach_params(true, true, false, true, container);

    // Same portability trick as `docker::open_exec` (see its doc comment for
    // why `command -v` first, not a bare `exec bash || exec sh`): BusyBox
    // `ash` (Alpine's default `/bin/sh`) treats `exec`ing a missing command
    // as fatal to the whole `sh -c` script, never reaching the `||` fallback.
    let command = vec![
        "sh".to_string(),
        "-c".to_string(),
        "command -v bash >/dev/null 2>&1 && exec bash || exec sh".to_string(),
    ];
    let mut attached = pods.exec(pod_name, command, &ap).await?;

    let mut stdin_writer = attached.stdin().ok_or_else(|| anyhow::anyhow!("stdin non attaché"))?;
    let mut stdout_reader = attached.stdout().ok_or_else(|| anyhow::anyhow!("stdout non attaché"))?;
    let mut terminal_size_tx = attached.terminal_size().ok_or_else(|| anyhow::anyhow!("canal de redimensionnement absent"))?;

    let _ = terminal_size_tx.send(TerminalSize { width: cols, height: rows }).await;

    let (input_tx, mut input_rx) = mpsc::channel::<ShellInput>(256);
    let (output_tx, output_rx) = mpsc::channel::<Vec<u8>>(256);

    tokio::spawn(async move {
        while let Some(msg) = input_rx.recv().await {
            match msg {
                ShellInput::Data(bytes) => {
                    if stdin_writer.write_all(&bytes).await.is_err() {
                        break;
                    }
                }
                ShellInput::Resize { cols, rows } => {
                    if terminal_size_tx.send(TerminalSize { width: cols, height: rows }).await.is_err() {
                        break;
                    }
                }
            }
        }
        // Keep `attached` (and the exec WebSocket it owns) alive for the
        // whole session, mirroring `docker::open_exec` keeping `docker`/
        // `exec` alive in its own input task — the connection is otherwise
        // driven entirely by a background task `AttachedProcess` itself
        // already spawned, this is just about not dropping our handle to it
        // early.
        drop(attached);
    });

    tokio::spawn(async move {
        let mut buf = [0u8; 4096];
        loop {
            match stdout_reader.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if output_tx.send(buf[..n].to_vec()).await.is_err() {
                        break;
                    }
                }
            }
        }
    });

    Ok(ShellSession { input: input_tx, output: output_rx })
}

/// Runs `cmd` inside `pod_name`/`container` to completion — non-interactive,
/// no TTY. Reads stdout/stderr concurrently with writing `stdin` (if any)
/// rather than sequentially: `AttachedProcess`'s internal duplex buffers are
/// tiny (1 KiB), so a command producing more output than that before this
/// side starts draining it would otherwise deadlock against the still-tiny
/// stdin buffer. Exit code comes from the exec subresource's status object,
/// not a "channel" of its own — success maps to `Some(0)`, a non-zero exit
/// carries a `NonZeroExitCode` reason with the actual code tucked into a
/// `StatusDetails` cause's `message` (verified against `k8s-openapi`'s
/// vendored `Status`/`StatusDetails`/`StatusCause` structs — this is
/// `client-go`'s own convention, not a Guiterm-specific parsing guess).
async fn exec_raw(
    client: &Client,
    namespace: &str,
    pod_name: &str,
    container: Option<&str>,
    cmd: Vec<String>,
    stdin: Option<Vec<u8>>,
) -> anyhow::Result<(Option<i32>, Vec<u8>, Vec<u8>)> {
    let pods: Api<Pod> = Api::namespaced(client.clone(), namespace);
    let ap = attach_params(stdin.is_some(), true, true, false, container);
    let mut attached = pods.exec(pod_name, cmd, &ap).await?;

    let mut stdout_reader = attached.stdout().ok_or_else(|| anyhow::anyhow!("stdout non attaché"))?;
    let mut stderr_reader = attached.stderr().ok_or_else(|| anyhow::anyhow!("stderr non attaché"))?;
    let status_fut = attached.take_status().ok_or_else(|| anyhow::anyhow!("statut déjà consommé"))?;

    let stdin_fut = async {
        if let Some(data) = stdin
            && let Some(mut writer) = attached.stdin()
        {
            let _ = writer.write_all(&data).await;
            let _ = writer.shutdown().await;
        }
    };

    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let (_, stdout_res, stderr_res) =
        tokio::join!(stdin_fut, stdout_reader.read_to_end(&mut stdout), stderr_reader.read_to_end(&mut stderr));
    stdout_res?;
    stderr_res?;

    let status = status_fut.await;
    let exit_code = exit_code_from_status(status.as_ref());

    let _ = attached.join().await;
    Ok((exit_code, stdout, stderr))
}

/// Pulled out of `exec_raw` as a pure function purely so it's unit-testable
/// without a live API server — see `exec_raw`'s doc comment for the
/// `client-go` convention this implements. Never observed against a real
/// cluster response, only against the vendored `k8s-openapi` struct
/// definitions and hand-built fixtures below.
fn exit_code_from_status(status: Option<&Status>) -> Option<i32> {
    match status.and_then(|s| s.status.as_deref()) {
        Some("Success") => Some(0),
        Some("Failure") => status
            .and_then(|s| s.details.as_ref())
            .and_then(|d| d.causes.as_ref())
            .and_then(|causes| causes.iter().find(|c| c.reason.as_deref() == Some("ExitCode")))
            .and_then(|c| c.message.as_deref())
            .and_then(|m| m.parse::<i32>().ok()),
        _ => None,
    }
}

/// Like [`exec_capture`], but stops draining stdout (and bails) as soon as
/// more than `cap_bytes` have arrived, rather than always reading to
/// completion first — used by [`crate::k8s_pane`]'s size-capped downloads so
/// a huge file doesn't have to be fully buffered in memory just to be
/// rejected for being too big, mirroring `docker_pane`'s own incremental cap
/// check against its streamed archive endpoint (`kube`'s `AttachedProcess`
/// has no such stream to lean on — this reads stdout by hand instead of
/// `read_to_end`, same primitive `open_exec`'s output-forwarding task above
/// already uses). No stdin support: the only caller (`tar cf -` for a
/// download) never needs it.
pub(crate) async fn exec_capped(
    client: &Client,
    namespace: &str,
    pod_name: &str,
    container: Option<&str>,
    cmd: Vec<String>,
    cap_bytes: u64,
) -> anyhow::Result<Vec<u8>> {
    let pods: Api<Pod> = Api::namespaced(client.clone(), namespace);
    let ap = attach_params(false, true, true, false, container);
    let mut attached = pods.exec(pod_name, cmd, &ap).await?;

    let mut stdout_reader = attached.stdout().ok_or_else(|| anyhow::anyhow!("stdout non attaché"))?;
    let mut stderr_reader = attached.stderr().ok_or_else(|| anyhow::anyhow!("stderr non attaché"))?;
    let status_fut = attached.take_status().ok_or_else(|| anyhow::anyhow!("statut déjà consommé"))?;

    // Both stdout and stderr must still be drained concurrently, same reason
    // as `exec_raw`: the duplex buffers backing them are tiny (1 KiB), so
    // leaving one undrained could stall the remote side mid-write on the
    // other. stderr isn't expected to carry meaningful volume for a `tar cf
    // -` download, so it's read to completion normally; only stdout bails
    // early once it crosses the cap.
    let mut stdout = Vec::new();
    let mut buf = [0u8; 8192];
    let stdout_fut = async {
        loop {
            let n = stdout_reader.read(&mut buf).await?;
            if n == 0 {
                break;
            }
            stdout.extend_from_slice(&buf[..n]);
            if stdout.len() as u64 > cap_bytes {
                anyhow::bail!("fichier trop volumineux (> {} Mo)", cap_bytes / (1024 * 1024));
            }
        }
        Ok::<(), anyhow::Error>(())
    };
    let mut stderr = Vec::new();
    let (stdout_res, stderr_res) = tokio::join!(stdout_fut, stderr_reader.read_to_end(&mut stderr));
    stderr_res?;
    stdout_res?;

    let status = status_fut.await;
    let exit_code = exit_code_from_status(status.as_ref());
    let _ = attached.join().await;
    if exit_code != Some(0) {
        let detail = String::from_utf8_lossy(&stderr).trim().to_string();
        anyhow::bail!(
            "commande distante en échec (code {:?}){}",
            exit_code,
            if detail.is_empty() { String::new() } else { format!(" : {detail}") }
        );
    }
    Ok(stdout)
}

/// Errors on a non-zero (or undetermined) exit code, with stderr folded into
/// the message — used by [`crate::k8s_pane`] for the shell/`tar`-based pod
/// operations that have no Kubernetes API equivalent, same policy as
/// `docker::exec_capture`.
pub(crate) async fn exec_capture(
    client: &Client,
    namespace: &str,
    pod_name: &str,
    container: Option<&str>,
    cmd: Vec<String>,
    stdin: Option<Vec<u8>>,
) -> anyhow::Result<Vec<u8>> {
    let (exit_code, stdout, stderr) = exec_raw(client, namespace, pod_name, container, cmd, stdin).await?;
    if exit_code != Some(0) {
        let detail = String::from_utf8_lossy(&stderr).trim().to_string();
        anyhow::bail!(
            "commande distante en échec (code {:?}){}",
            exit_code,
            if detail.is_empty() { String::new() } else { format!(" : {detail}") }
        );
    }
    Ok(stdout)
}

/// Like [`exec_capture`], but never bails on a non-zero exit — returns it
/// instead, the same "ran but failed" vs. "couldn't run at all" distinction
/// `docker::exec_with_exit_code` makes. Used by `fleet::execute`'s K8s exec
/// target.
pub async fn exec_with_exit_code(
    client: &Client,
    namespace: &str,
    pod_name: &str,
    container: Option<&str>,
    cmd: Vec<String>,
) -> anyhow::Result<(Option<i32>, String, String)> {
    let (exit_code, stdout, stderr) = exec_raw(client, namespace, pod_name, container, cmd, None).await?;
    Ok((exit_code, String::from_utf8_lossy(&stdout).into_owned(), String::from_utf8_lossy(&stderr).into_owned()))
}

/// Probes `pod_name`/`container` for the same facts SSH/local terminals/
/// Docker exec collect — used by the adaptive snippet engine. `None` on any
/// failure (unreachable API server, no shell in the container, non-zero
/// exit) — collapses to "facts unknown", same as `docker::probe_container_facts`.
pub async fn probe_pod_facts(client: &Client, namespace: &str, pod_name: &str, container: Option<&str>) -> Option<HostFacts> {
    let cmd = vec!["sh".to_string(), "-c".to_string(), crate::facts::PROBE.to_string()];
    let stdout = exec_capture(client, namespace, pod_name, container, cmd, None).await.ok()?;
    Some(crate::facts::parse_facts(&String::from_utf8_lossy(&stdout)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use k8s_openapi::apimachinery::pkg::apis::meta::v1::{StatusCause, StatusDetails};

    fn failure_status(details: Option<StatusDetails>) -> Status {
        Status { status: Some("Failure".to_string()), details, ..Default::default() }
    }

    fn exit_code_cause(code: &str) -> StatusCause {
        StatusCause { reason: Some("ExitCode".to_string()), message: Some(code.to_string()), ..Default::default() }
    }

    #[test]
    fn success_status_is_exit_code_zero_regardless_of_details() {
        let status = Status { status: Some("Success".to_string()), ..Default::default() };
        assert_eq!(exit_code_from_status(Some(&status)), Some(0));
    }

    #[test]
    fn failure_status_extracts_the_exit_code_cause_message() {
        let details = StatusDetails { causes: Some(vec![exit_code_cause("3")]), ..Default::default() };
        let status = failure_status(Some(details));
        assert_eq!(exit_code_from_status(Some(&status)), Some(3));
    }

    #[test]
    fn failure_status_finds_the_exit_code_cause_among_several() {
        let other = StatusCause { reason: Some("SomethingElse".to_string()), message: Some("ignored".to_string()), ..Default::default() };
        let details = StatusDetails { causes: Some(vec![other, exit_code_cause("42")]), ..Default::default() };
        let status = failure_status(Some(details));
        assert_eq!(exit_code_from_status(Some(&status)), Some(42));
    }

    #[test]
    fn failure_status_without_details_is_undetermined() {
        let status = failure_status(None);
        assert_eq!(exit_code_from_status(Some(&status)), None);
    }

    #[test]
    fn failure_status_with_causes_but_no_exit_code_reason_is_undetermined() {
        let other = StatusCause { reason: Some("SomethingElse".to_string()), message: Some("ignored".to_string()), ..Default::default() };
        let details = StatusDetails { causes: Some(vec![other]), ..Default::default() };
        let status = failure_status(Some(details));
        assert_eq!(exit_code_from_status(Some(&status)), None);
    }

    #[test]
    fn failure_status_with_a_non_numeric_exit_code_message_is_undetermined() {
        let details = StatusDetails { causes: Some(vec![exit_code_cause("not-a-number")]), ..Default::default() };
        let status = failure_status(Some(details));
        assert_eq!(exit_code_from_status(Some(&status)), None);
    }

    #[test]
    fn missing_status_object_is_undetermined() {
        assert_eq!(exit_code_from_status(None), None);
    }

    #[test]
    fn unrecognized_status_value_is_undetermined() {
        let status = Status { status: Some("Unknown".to_string()), ..Default::default() };
        assert_eq!(exit_code_from_status(Some(&status)), None);
    }
}
