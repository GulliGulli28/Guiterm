import { useEffect, useState } from "react";
import type { DockerContainer, HostId, Workspace } from "../lib/types";
import type { AppPreferences } from "../lib/preferences";
import { api } from "../lib/api";
import { hostKindMeta } from "../lib/hostKinds";
import { LocalTerminalTab } from "./LocalTerminalTab";
import { TerminalTab, type TerminalTabHandle } from "./TerminalTab";
import { RdpTab } from "./RdpTab";
import { ConnectionPickerModal } from "./ConnectionPickerModal";

type SplitSource = "local" | HostId;

interface SplitPaneProps {
  workspace: Workspace;
  preferences: AppPreferences;
  source: SplitSource;
  onSourceChange: (source: SplitSource) => void;
  onRef: (handle: TerminalTabHandle | null) => void;
  onInputData: (data: string) => void;
}

export function SplitPane({ workspace, preferences, source, onSourceChange, onRef, onInputData }: SplitPaneProps) {
  const host = source !== "local"
    ? workspace.hosts.find((h) => h.id === source)
    : undefined;
  const kind = host?.kind ?? "ssh";

  // Docker exec repurposes a saved host as a daemon entry point, not a
  // single connectable thing — same as the sidebar's own connect flow
  // (`HostsPanel.tsx`'s `openDockerPicker`), a live container has to be
  // picked before a shell can open. Reset whenever `source` changes so
  // switching to a different host (or away and back) re-prompts instead of
  // reusing a stale container id.
  const [dockerContainerId, setDockerContainerId] = useState<string | null>(null);
  const [dockerContainers, setDockerContainers] = useState<DockerContainer[] | null>(null);
  const [dockerPickerError, setDockerPickerError] = useState<string | null>(null);
  useEffect(() => {
    setDockerContainerId(null);
    setDockerContainers(null);
    setDockerPickerError(null);
    if (host && (host.kind ?? "ssh") === "dockerExec") {
      api.listDockerContainers(host.id).then(setDockerContainers).catch((e) => setDockerPickerError(String(e)));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source]);

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--c-border)] bg-[var(--c-bg2)] px-2 py-1.5">
        <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wider text-[var(--c-text-muted)]">Panneau 2</span>
        <select
          value={source}
          onChange={(e) => onSourceChange(e.target.value as SplitSource)}
          className="flex-1 rounded-md bg-[var(--c-bg3)] px-2 py-1 text-sm text-[var(--c-text)] focus:outline-none focus:ring-1 focus:ring-[var(--c-accent-hover)]"
        >
          <option value="local">Terminal local</option>
          {workspace.hosts.map((h) => (
            <option key={h.id} value={h.id}>
              {h.label}{(h.kind ?? "ssh") !== "ssh" ? ` (${hostKindMeta(h.kind).label})` : ""}
            </option>
          ))}
        </select>
      </div>
      <div className="relative min-h-0 flex-1">
        <div className="absolute inset-0 flex flex-col">
          {source === "local" ? (
            <LocalTerminalTab key={source} isActive={true} preferences={preferences} onInputData={onInputData} ref={onRef} />
          ) : !host ? (
            <div className="flex flex-1 items-center justify-center text-sm text-[var(--c-text-muted)]">Hôte introuvable</div>
          ) : kind === "k8sExec" ? (
            <div className="flex flex-1 items-center justify-center px-8 text-center text-sm text-[var(--c-text-muted)]">
              Kubernetes exec n'a pas encore de backend.
            </div>
          ) : kind === "rdp" ? (
            <RdpTab key={source} host={host} isActive={true} preferences={preferences} onDisconnect={() => onSourceChange("local")} ref={onRef} />
          ) : kind === "dockerExec" ? (
            dockerContainerId ? (
              <TerminalTab
                key={`${source}:${dockerContainerId}`}
                host={host}
                dockerContainerId={dockerContainerId}
                isActive={true}
                preferences={preferences}
                onInputData={onInputData}
                ref={onRef}
              />
            ) : (
              <ConnectionPickerModal
                title={`Conteneurs Docker — ${host.label}`}
                loading={dockerContainers === null && !dockerPickerError}
                error={dockerPickerError}
                items={(dockerContainers ?? []).map((c) => ({ id: c.id, name: c.name || c.id.slice(0, 12), meta: `${c.image} · ${c.status}`, up: c.state === "running" }))}
                onPick={(id) => setDockerContainerId(id)}
                onClose={() => onSourceChange("local")}
              />
            )
          ) : (
            <TerminalTab key={source} host={host} isActive={true} preferences={preferences} onInputData={onInputData} ref={onRef} />
          )}
        </div>
      </div>
    </div>
  );
}
