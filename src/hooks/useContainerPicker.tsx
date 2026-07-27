import { useState } from "react";
import { api } from "../lib/api";
import type { DockerContainer, DockerContainerAction, Host, K8sPod } from "../lib/types";

/** Lines fetched when showing a log. Below the backend's own cap
 * (`termius_core::docker::MAX_LOG_LINES`) — this is a "what just happened"
 * panel, not a log viewer. */
const LOG_TAIL = 500;
import { parsePodPickerId, podPickerId } from "../lib/types";
import { ConnectionPickerModal } from "../components/ConnectionPickerModal";

export interface UseContainerPickerResult {
  /** The host a Docker/K8s picker is currently open for, if any — exposed
   * (not just hidden inside `pickerModal`) because some callers need it for
   * more than rendering the modal itself (e.g. `TransferTab.tsx` keeps its
   * source dropdown showing the host being picked into, not the
   * still-unchanged prior selection, until something's actually picked). */
  dockerPickerHost: Host | null;
  k8sPickerHost: Host | null;
  openDockerPicker: (host: Host) => void;
  openK8sPicker: (host: Host) => void;
  /** Render this inline wherever the picker modal(s) should appear — renders
   * nothing when neither picker is open. */
  pickerModal: React.ReactNode;
}

/** Docker container / Kubernetes pod picker: opens on a menu click, fetches
 * the live list, and lets the caller decide what "picked" means
 * (`onPickDocker`/`onPickK8s` — connect a terminal, open a transfer pane,
 * whatever this call site needs). Previously three near-identical copies of
 * the same state+fetch+modal JSX (`HostsPanel`/`TransferTab`/`SftpPanel`).
 *
 * `SplitPane.tsx` isn't a fourth copy of this: it fetches eagerly as soon as
 * its single `source` changes rather than on an explicit "open" trigger, and
 * has no separate close action (reverting to the local terminal instead) —
 * different enough in shape/lifecycle that folding it in here would cost
 * more than it'd save, so it's left with its own inline state. */
export function useContainerPicker(
  onPickDocker: (host: Host, containerId: string) => void,
  onPickK8s: (host: Host, podName: string, containerName: string | null) => void,
): UseContainerPickerResult {
  const [dockerPickerHost, setDockerPickerHost] = useState<Host | null>(null);
  const [dockerContainers, setDockerContainers] = useState<DockerContainer[] | null>(null);
  const [dockerPickerError, setDockerPickerError] = useState<string | null>(null);
  const [k8sPickerHost, setK8sPickerHost] = useState<Host | null>(null);
  const [k8sPods, setK8sPods] = useState<K8sPod[] | null>(null);
  const [k8sPickerError, setK8sPickerError] = useState<string | null>(null);

  const openDockerPicker = (host: Host) => {
    setDockerPickerHost(host);
    setDockerContainers(null);
    setDockerPickerError(null);
    api.listDockerContainers(host.id).then(setDockerContainers).catch((e) => setDockerPickerError(String(e)));
  };

  const openK8sPicker = (host: Host) => {
    setK8sPickerHost(host);
    setK8sPods(null);
    setK8sPickerError(null);
    api.listK8sPods(host.id).then(setK8sPods).catch((e) => setK8sPickerError(String(e)));
  };

  // Logs are shown over the picker rather than in a tab: reading them is
  // usually the step *before* deciding to exec into something, so closing the
  // picker to look would be backwards.
  const [logs, setLogs] = useState<{ title: string; body: string | null; error: string | null } | null>(null);

  const showDockerLogs = (host: Host, containerId: string, name: string) => {
    setLogs({ title: `Logs — ${name}`, body: null, error: null });
    api.dockerContainerLogs(host.id, containerId, LOG_TAIL)
      .then((body) => setLogs({ title: `Logs — ${name}`, body, error: null }))
      .catch((e) => setLogs({ title: `Logs — ${name}`, body: null, error: String(e) }));
  };

  const showK8sLogs = (host: Host, podName: string, containerName: string | null, title: string) => {
    setLogs({ title: `Logs — ${title}`, body: null, error: null });
    api.k8sPodLogs(host.id, podName, containerName, LOG_TAIL)
      .then((body) => setLogs({ title: `Logs — ${title}`, body, error: null }))
      .catch((e) => setLogs({ title: `Logs — ${title}`, body: null, error: String(e) }));
  };

  const runDockerAction = (host: Host, containerId: string, action: DockerContainerAction) => {
    setDockerContainers(null);
    api.dockerContainerAction(host.id, containerId, action)
      .then(setDockerContainers)
      .catch((e) => setDockerPickerError(String(e)));
  };

  const pickerModal = (
    <>
      {dockerPickerHost && (
        <ConnectionPickerModal
          title={`Conteneurs Docker — ${dockerPickerHost.label}`}
          loading={dockerContainers === null && !dockerPickerError}
          error={dockerPickerError}
          items={(dockerContainers ?? []).map((c) => {
            const name = c.name || c.id.slice(0, 12);
            const running = c.state === "running";
            return {
              id: c.id,
              name,
              meta: `${c.image} · ${c.status}`,
              up: running,
              actions: [
                { label: "Logs", title: "Voir la fin du journal", run: () => showDockerLogs(dockerPickerHost, c.id, name) },
                running
                  ? { label: "Arrêter", title: "Arrêter le conteneur", run: () => runDockerAction(dockerPickerHost, c.id, "stop") }
                  : { label: "Démarrer", title: "Démarrer le conteneur", run: () => runDockerAction(dockerPickerHost, c.id, "start") },
                { label: "Redémarrer", title: "Redémarrer le conteneur", run: () => runDockerAction(dockerPickerHost, c.id, "restart") },
              ],
            };
          })}
          onPick={(containerId) => { onPickDocker(dockerPickerHost, containerId); setDockerPickerHost(null); }}
          onClose={() => setDockerPickerHost(null)}
        />
      )}
      {k8sPickerHost && (
        <ConnectionPickerModal
          title={`Pods Kubernetes — ${k8sPickerHost.label}`}
          loading={k8sPods === null && !k8sPickerError}
          error={k8sPickerError}
          items={(k8sPods ?? []).flatMap((pod) =>
            pod.containers.length > 1
              ? pod.containers.map((c) => ({
                  id: podPickerId(pod.name, c),
                  name: `${pod.name} › ${c}`,
                  meta: `${pod.namespace} · ${pod.phase}`,
                  up: pod.ready,
                  actions: [{ label: "Logs", title: "Voir la fin du journal", run: () => showK8sLogs(k8sPickerHost, pod.name, c, `${pod.name} › ${c}`) }],
                }))
              : [{
                  id: podPickerId(pod.name),
                  name: pod.name,
                  meta: `${pod.namespace} · ${pod.phase}`,
                  up: pod.ready,
                  actions: [{ label: "Logs", title: "Voir la fin du journal", run: () => showK8sLogs(k8sPickerHost, pod.name, null, pod.name) }],
                }],
          )}
          onPick={(id) => {
            const { podName, containerName } = parsePodPickerId(id);
            onPickK8s(k8sPickerHost, podName, containerName);
            setK8sPickerHost(null);
          }}
          onClose={() => setK8sPickerHost(null)}
        />
      )}
      {logs && (
        <>
          <div className="fixed inset-0 z-40 bg-black/50" onClick={() => setLogs(null)} />
          <div className="fixed left-1/2 top-1/2 z-50 flex h-[70vh] w-[720px] max-w-[92vw] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-lg bg-[var(--c-bg2)] shadow-[var(--shadow-lg)]">
            <div className="shrink-0 border-b border-[var(--c-border)] px-4 py-3">
              <p className="truncate text-[14px] font-medium text-[var(--c-text)]">{logs.title}</p>
              <p className="mt-0.5 text-[11px] text-[var(--c-text-muted)]">
                {LOG_TAIL} dernières lignes — instantané, pas un suivi en direct.
              </p>
            </div>
            <div className="min-h-0 flex-1 overflow-auto p-3">
              {logs.error ? (
                <p className="whitespace-pre-wrap text-[12px] text-rose-300">{logs.error}</p>
              ) : logs.body === null ? (
                <p className="text-[12px] text-[var(--c-text-muted)]">Chargement…</p>
              ) : logs.body.trim() === "" ? (
                <p className="text-[12px] text-[var(--c-text-muted)]">Journal vide.</p>
              ) : (
                <pre className="whitespace-pre-wrap break-all font-mono text-[11.5px] leading-relaxed text-[var(--c-text-secondary)]">{logs.body}</pre>
              )}
            </div>
            <div className="shrink-0 border-t border-[var(--c-border)] p-2">
              <button onClick={() => setLogs(null)} className="w-full rounded-md bg-[var(--c-bg3)] py-1.5 text-center text-[12px] text-[var(--c-text-secondary)] hover:bg-white/5">
                Fermer
              </button>
            </div>
          </div>
        </>
      )}
    </>
  );

  return { dockerPickerHost, k8sPickerHost, openDockerPicker, openK8sPicker, pickerModal };
}
