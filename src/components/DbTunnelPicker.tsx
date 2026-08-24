import { useState } from "react";
import { api } from "../lib/api";
import { assertNever } from "../lib/exhaustive";
import type { DbTunnel, HostId, SsmProbe, Workspace } from "../lib/types";
import { HostTreePicker } from "./HostTreePicker";

/** The address a probe would dial *from the far end* of the tunnel. `null`
 * when the form can't tell yet (an empty address, a MongoDB URI that doesn't
 * parse) — the "Tester" button is disabled rather than guessing. */
export interface ProbeTarget {
  address: string;
  port: number;
}

interface DbTunnelPickerProps {
  workspace: Workspace;
  value: DbTunnel;
  onChange: (tunnel: DbTunnel) => void;
  /** Enables the "Tester" button for the SSM mode. */
  probeTarget: ProbeTarget | null;
  /** Prefills the SSM profile/region for a caller that already knows them —
   * the AWS import panel, where the user has just picked both to discover the
   * databases. Read once, at mount: pass a changing `key` to re-seed. */
  ssmDefaults?: { profile?: string; region?: string };
}

/** Picks how a database connection reaches its server, for both the connection
 * form and the AWS import panel.
 *
 * **Why the per-mode fields are local state.** The parent only ever sees the
 * `DbTunnel` currently chosen, but switching Direct → SSM → Direct → SSM must
 * not lose the instance id already typed. Keeping one slot per mode here does
 * that without making every caller carry five fields it doesn't care about.
 */
export function DbTunnelPicker({ workspace, value, onChange, probeTarget, ssmDefaults }: DbTunnelPickerProps) {
  const [sshHostId, setSshHostId] = useState<HostId | "">(value.kind === "sshHost" ? value.hostId : "");
  const [target, setTarget] = useState(value.kind === "ssm" ? value.target : "");
  const [profile, setProfile] = useState(value.kind === "ssm" ? (value.profile ?? "") : (ssmDefaults?.profile ?? ""));
  const [region, setRegion] = useState(value.kind === "ssm" ? (value.region ?? "") : (ssmDefaults?.region ?? ""));
  const [probe, setProbe] = useState<SsmProbe | null>(null);
  const [probing, setProbing] = useState(false);

  const sshHosts = workspace.hosts.filter((h) => (h.kind ?? "ssh") === "ssh");

  const emitSsm = (next: { target?: string; profile?: string; region?: string }) => {
    onChange({
      kind: "ssm",
      target: next.target ?? target,
      profile: (next.profile ?? profile).trim() || null,
      region: (next.region ?? region).trim() || null,
    });
  };

  const onModeChange = (mode: DbTunnel["kind"]) => {
    setProbe(null);
    switch (mode) {
      case "direct":
        onChange({ kind: "direct" });
        return;
      case "sshHost":
        // Falls back to the first SSH host rather than emitting a tunnel with
        // no host, which the backend would reject on connect.
        onChange(sshHostId || sshHosts[0] ? { kind: "sshHost", hostId: (sshHostId || sshHosts[0].id) as HostId } : { kind: "direct" });
        return;
      case "ssm":
        emitSsm({});
        return;
      default:
        assertNever(mode, "mode de tunnel");
    }
  };

  const runProbe = async () => {
    if (!probeTarget) return;
    setProbing(true);
    setProbe(null);
    try {
      setProbe(await api.testSsmTunnel(target.trim(), profile.trim() || null, region.trim() || null, probeTarget.address, probeTarget.port));
    } catch (e) {
      setProbe({ kind: "failed", message: String(e), hint: null });
    } finally {
      setProbing(false);
    }
  };

  return (
    <div className="space-y-1">
      <span className="text-xs font-medium text-[var(--c-text-secondary)]">Tunnel</span>
      <select value={value.kind} onChange={(e) => onModeChange(e.target.value as DbTunnel["kind"])} className={selectClass}>
        <option value="direct">Connexion directe (pas de tunnel)</option>
        <option value="sshHost" disabled={sshHosts.length === 0}>
          Tunnel SSH via un hôte enregistré{sshHosts.length === 0 ? " (aucun hôte SSH)" : ""}
        </option>
        <option value="ssm">Tunnel AWS SSM (sans bastion SSH)</option>
      </select>

      {value.kind === "sshHost" && (
        <>
          <HostTreePicker
            hosts={sshHosts}
            groups={workspace.groups}
            customIcons={workspace.customIcons}
            value={sshHostId}
            onChange={(v) => {
              if (!v) return;
              setSshHostId(v as HostId);
              onChange({ kind: "sshHost", hostId: v as HostId });
            }}
            placeholder="Choisir un hôte SSH…"
            className={`${selectClass} flex items-center justify-between gap-2 text-left`}
          />
          <p className="px-0.5 text-[11px] leading-relaxed text-[var(--c-text-muted)]">
            L'adresse de la base doit être joignable <em>depuis</em> cet hôte — souvent 127.0.0.1 si
            la base n'écoute qu'en local sur le serveur.
          </p>
        </>
      )}

      {value.kind === "ssm" && (
        <>
          <input
            value={target}
            onChange={(e) => {
              setTarget(e.target.value);
              emitSsm({ target: e.target.value });
            }}
            placeholder="Instance SSM (i-0abc123… ou mi-…)"
            spellCheck={false}
            className={`${inputClass} w-full font-mono`}
          />
          <div className="flex gap-1.5">
            <input
              value={profile}
              onChange={(e) => {
                setProfile(e.target.value);
                emitSsm({ profile: e.target.value });
              }}
              placeholder="Profil AWS (optionnel)"
              spellCheck={false}
              className={`${inputClass} min-w-0 flex-1 font-mono`}
            />
            <input
              value={region}
              onChange={(e) => {
                setRegion(e.target.value);
                emitSsm({ region: e.target.value });
              }}
              placeholder="Région (optionnel)"
              spellCheck={false}
              className={`${inputClass} min-w-0 flex-1 font-mono`}
            />
          </div>
          {/* Said plainly because it is the thing people get wrong about SSM:
              it is not "no machine in the middle", it is "no SSH on the
              machine in the middle". */}
          <p className="px-0.5 text-[11px] leading-relaxed text-[var(--c-text-muted)]">
            Le trafic passe par cette instance, mais elle n'a besoin ni de serveur SSH, ni de clé, ni
            de port ouvert en entrée — seulement de l'agent SSM et des droits IAM. L'adresse de la
            base est celle que <em>l'instance</em> résout, généralement le point de terminaison AWS.
          </p>
          <div className="flex items-center gap-2 pt-0.5">
            <button
              type="button"
              onClick={runProbe}
              disabled={probing || !target.trim() || !probeTarget}
              className="rounded-md bg-[var(--c-bg3)] px-3 py-1.5 text-xs text-[var(--c-text)] hover:bg-[var(--c-bg4)] disabled:opacity-40"
            >
              {probing ? "Test en cours…" : "Tester le tunnel"}
            </button>
            {!probeTarget && (
              <span className="text-[11px] text-[var(--c-text-muted)]">Renseigner l'adresse de la base pour tester.</span>
            )}
          </div>
          {probe && <SsmProbeResult probe={probe} />}
        </>
      )}
    </div>
  );
}

/** Renders a probe outcome. The three cases are deliberately styled apart:
 * "opened" is a *partial* success and telling the user to go re-check their
 * AWS credentials over it would send them to the one thing that just proved
 * itself. */
function SsmProbeResult({ probe }: { probe: SsmProbe }) {
  switch (probe.kind) {
    case "reached":
      return (
        <p className="rounded-md bg-emerald-950 px-3 py-2 text-[11px] leading-relaxed text-emerald-300">
          Tunnel ouvert (port local {probe.localPort}) et la base répond. Rien d'autre à configurer.
        </p>
      );
    case "opened":
      return (
        <p className="rounded-md bg-amber-950 px-3 py-2 text-[11px] leading-relaxed text-amber-300">
          Le tunnel s'ouvre (AWS, IAM et l'agent SSM sont donc bons), mais l'instance n'atteint pas la
          base. À vérifier : l'adresse et le port de la base, et le groupe de sécurité qui autorise
          l'instance à s'y connecter.
          <span className="mt-1 block whitespace-pre-wrap font-mono text-[10px] opacity-80">{probe.detail}</span>
        </p>
      );
    case "failed":
      return (
        <p className="rounded-md bg-rose-950 px-3 py-2 text-[11px] leading-relaxed text-rose-300">
          <span className="whitespace-pre-wrap font-mono text-[10px]">{probe.message}</span>
          {probe.hint && <span className="mt-1.5 block font-sans">{probe.hint}</span>}
        </p>
      );
    default:
      return assertNever(probe, "résultat du test SSM");
  }
}

const inputClass =
  "rounded-md bg-[var(--c-bg3)] px-3 py-2 text-sm text-[var(--c-text)] placeholder:text-[var(--c-text-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--c-accent-hover)]";
const selectClass =
  "w-full rounded-md bg-[var(--c-bg3)] px-3 py-2 text-sm text-[var(--c-text)] focus:outline-none focus:ring-1 focus:ring-[var(--c-accent-hover)]";
