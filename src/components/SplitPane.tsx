import { useState } from "react";
import type { HostId, Workspace } from "../lib/types";
import type { AppPreferences } from "../lib/preferences";
import { LocalTerminalTab } from "./LocalTerminalTab";
import { TerminalTab } from "./TerminalTab";

type SplitSource = "local" | HostId;

interface SplitPaneProps {
  workspace: Workspace;
  preferences: AppPreferences;
}

export function SplitPane({ workspace, preferences }: SplitPaneProps) {
  const [source, setSource] = useState<SplitSource>("local");

  const host = source !== "local"
    ? workspace.hosts.find((h) => h.id === source)
    : undefined;

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--c-border)] bg-[var(--c-bg2)] px-2 py-1.5">
        <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wider text-[var(--c-text-muted)]">Panneau 2</span>
        <select
          value={source}
          onChange={(e) => setSource(e.target.value as SplitSource)}
          className="flex-1 rounded-md bg-[var(--c-bg3)] px-2 py-1 text-sm text-[var(--c-text)] focus:outline-none focus:ring-1 focus:ring-[var(--c-accent-hover)]"
        >
          <option value="local">Terminal local</option>
          {workspace.hosts.map((h) => (
            <option key={h.id} value={h.id}>{h.label}</option>
          ))}
        </select>
      </div>
      <div className="relative min-h-0 flex-1">
        <div className="absolute inset-0 flex flex-col">
          {source === "local" ? (
            <LocalTerminalTab key={source} isActive={true} preferences={preferences} />
          ) : host ? (
            <TerminalTab key={source} host={host} isActive={true} preferences={preferences} />
          ) : (
            <div className="flex flex-1 items-center justify-center text-sm text-[var(--c-text-muted)]">Hôte introuvable</div>
          )}
        </div>
      </div>
    </div>
  );
}
