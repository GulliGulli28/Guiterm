import { useMemo, type ReactNode } from "react";
import type { AuthMethod, CloudInstance, GroupId, InventoryDiff, KeyId, Workspace } from "../lib/types";
import type { DescribedFailure } from "../lib/cloudFailure";
import { GroupTreePicker } from "./GroupTreePicker";

/**
 * The pieces Azure and GCP import panels share.
 *
 * **Atoms, not a generalised panel.** Each provider keeps its own panel — its
 * own scope picker, its own wording, its own columns — because that is what
 * lets one diverge without untangling a component full of `provider ===`
 * branches. What is shared here is what is genuinely identical: how a failure
 * reads, how one row of a tick list looks, and the batch credential form,
 * which is the same set of SSH decisions no matter where the machine lives.
 */

export const cloudInputClass =
  "w-full rounded-md bg-[var(--c-bg3)] px-2 py-1.5 text-sm text-[var(--c-text)] focus:outline-none focus:ring-1 focus:ring-[var(--c-accent-hover)]";

export type AuthKind = "agent" | "password" | "privateKey";

/** What the whole batch is created with. Applies only to hosts an import
 * *creates* — a refresh never overwrites a credential set afterwards. */
export interface BatchAuth {
  kind: AuthKind;
  username: string;
  keyId: KeyId | null;
  keyPath: string;
  secret: string;
  groupId: GroupId | null;
}

export const emptyBatchAuth: BatchAuth = {
  kind: "agent",
  username: "",
  keyId: null,
  keyPath: "",
  secret: "",
  groupId: null,
};

/** Filtering and ticking a list of cloud instances.
 *
 * A hook rather than a shared panel: each provider keeps its own component, as
 * decided — this only removes the forty lines both had copied, which is where
 * the two would otherwise drift apart. The filter matches every term against
 * the whole row, so "prod west" narrows the way people expect.
 *
 * `selectable` exists because a machine with no address at all can't become a
 * usable host: its checkbox is disabled, and "select all" has to agree with
 * that or it would tick rows the import then refuses. */
export function useCloudSelection(instances: CloudInstance[] | null, filter: string) {
  const shown = useMemo(() => {
    const terms = filter.toLowerCase().split(/\s+/).filter(Boolean);
    if (!instances) return [];
    if (terms.length === 0) return instances;
    return instances.filter((vm) => {
      const haystack = [
        vm.name, vm.publicIp, vm.privateIp, vm.location, vm.scope, vm.osType, vm.state,
        ...vm.tags.map(([k, v]) => (v ? `${k}=${v}` : k)),
      ].filter(Boolean).join(" ").toLowerCase();
      return terms.every((term) => haystack.includes(term));
    });
  }, [instances, filter]);

  const selectable = useMemo(() => shown.filter((vm) => vm.publicIp || vm.privateIp), [shown]);
  return { shown, selectable };
}

/** Toggling one id in a tick set — the same three lines in both panels. */
export function toggleIn(set: Set<string>, id: string): Set<string> {
  const next = new Set(set);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/** A failure with its remedy, and nothing invented when there isn't one.
 *
 * `action` is where a remedy the app can actually *perform* goes — signing in,
 * typically. Without it the notice can only quote a command to run elsewhere,
 * which is a dead end dressed up as help. Absent for refusals nothing here can
 * fix, deliberately: offering a button that cannot work is worse than none. */
export function CloudFailureNotice({
  failure,
  action,
}: {
  failure: DescribedFailure;
  action?: ReactNode;
}) {
  return (
    <div className="shrink-0 border-b border-[var(--c-border)] bg-rose-950/30 px-4 py-2">
      <p className="whitespace-pre-wrap break-words text-[11px] text-rose-200">{failure.message}</p>
      {failure.remedy && (
        <p className="mt-1 text-[11px] font-medium text-rose-100">→ {failure.remedy}</p>
      )}
      {action && <div className="mt-1.5">{action}</div>}
    </div>
  );
}

/** What a listing says about what has drifted since the last import.
 *
 * The half the import never had: it refreshed what was still there and added
 * what was new, but nothing ever noticed what *disappeared*. A destroyed VM
 * stayed in the host list forever.
 *
 * Deliberately reports rather than acts. Deleting a host is the user's call —
 * an instance can be missing because it was destroyed, but also because a
 * permission changed or the listing was partial, and a panel that tidied up on
 * its own would eventually delete something real. */
export function InventoryDriftNotice({
  diff,
  scopeLabel,
  onSelectNew,
}: {
  diff: InventoryDiff;
  /** "abonnement", "projet" — what this provider calls the scope. */
  scopeLabel: string;
  onSelectNew: () => void;
}) {
  if (diff.gone.length === 0 && diff.notImported.length === 0) return null;
  return (
    <div className="shrink-0 space-y-1 border-b border-[var(--c-border)] bg-amber-950/25 px-4 py-2">
      {diff.gone.length > 0 && (
        <p className="text-[11px] text-amber-200">
          <span className="font-medium">{diff.gone.length} hôte(s)</span> de cet {scopeLabel}{" "}
          n'existent plus côté fournisseur :{" "}
          <span className="text-amber-100">{diff.gone.map(([, label]) => label).join(", ")}</span>.
          {" "}À supprimer depuis la liste des hôtes si c'est bien voulu.
        </p>
      )}
      {diff.notImported.length > 0 && (
        <p className="text-[11px] text-amber-200">
          <span className="font-medium">{diff.notImported.length} instance(s)</span> ne sont pas
          encore importées.{" "}
          <button onClick={onSelectNew} className="underline hover:text-amber-100">
            Les cocher
          </button>
        </p>
      )}
      {diff.unattributed > 0 && (
        <p className="text-[10px] text-amber-200/70">
          {diff.unattributed} hôte(s) de ce fournisseur viennent d'un autre {scopeLabel} ou d'un
          import antérieur : ce listing ne dit rien sur eux.
        </p>
      )}
    </div>
  );
}

/** One instance in the tick list. */
export function CloudInstanceRow({
  instance,
  checked,
  known,
  onToggle,
}: {
  instance: CloudInstance;
  checked: boolean;
  known: boolean;
  onToggle: () => void;
}) {
  const address = instance.publicIp || instance.privateIp;
  const details = [
    address ?? "aucune adresse",
    instance.publicIp && instance.privateIp ? `privée ${instance.privateIp}` : null,
    instance.location || null,
    instance.scope || null,
    instance.osType,
    instance.username ? `user ${instance.username}` : null,
    instance.tags.map(([k, v]) => (v ? `${k}=${v}` : k)).join(", ") || null,
  ].filter(Boolean);

  return (
    <li>
      <label className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 hover:bg-[var(--c-bg3)]">
        <input
          type="checkbox"
          checked={checked}
          onChange={onToggle}
          // A machine with no address at all can't become a usable host.
          disabled={!address}
          className="accent-[var(--c-accent)] disabled:opacity-30"
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[13px] text-[var(--c-text)]">{instance.name}</span>
            {/* Stopped machines are listed, not hidden — they're worth
                importing, and hiding them would make the list look wrong. */}
            {!instance.running && (
              <span className="shrink-0 rounded bg-[var(--c-bg)] px-1.5 py-0.5 text-[10px] text-[var(--c-text-muted)]">
                {instance.state}
              </span>
            )}
            {/* Says "this one will be refreshed, not added twice" — the
                question anyone re-importing has. */}
            {known && (
              <span className="shrink-0 rounded bg-[var(--c-bg)] px-1.5 py-0.5 text-[10px] text-[var(--c-text-muted)]">
                déjà importé
              </span>
            )}
          </div>
          <p className="truncate text-[10px] text-[var(--c-text-muted)]">{details.join(" · ")}</p>
        </div>
      </label>
    </li>
  );
}

/** The SSH decisions applied to everything ticked. */
export function CloudBatchCredentials({
  workspace,
  auth,
  onChange,
  usernameHint,
}: {
  workspace: Workspace;
  auth: BatchAuth;
  onChange: (next: BatchAuth) => void;
  usernameHint: string;
}) {
  const set = <K extends keyof BatchAuth>(key: K, value: BatchAuth[K]) =>
    onChange({ ...auth, [key]: value });

  return (
    <>
      <div className="flex gap-2">
        <label className="block flex-1 space-y-1">
          <span className="text-xs font-medium text-[var(--c-text-muted)]">Utilisateur par défaut</span>
          <input
            value={auth.username}
            onChange={(e) => set("username", e.target.value)}
            placeholder="ubuntu"
            className={cloudInputClass}
          />
          <span className="block text-[10px] text-[var(--c-text-faint)]">{usernameHint}</span>
        </label>
        <label className="block flex-1 space-y-1">
          <span className="text-xs font-medium text-[var(--c-text-muted)]">Authentification</span>
          <select
            value={auth.kind}
            onChange={(e) => set("kind", e.target.value as AuthKind)}
            className={cloudInputClass}
          >
            <option value="agent">Agent SSH</option>
            <option value="password">Mot de passe</option>
            <option value="privateKey">Clé privée</option>
          </select>
        </label>
      </div>

      {auth.kind === "privateKey" && (
        <div className="flex gap-2">
          {workspace.keychain.length > 0 && (
            <select
              value={auth.keyId ?? ""}
              onChange={(e) => onChange({ ...auth, keyId: (e.target.value as KeyId) || null, keyPath: "" })}
              className={`${cloudInputClass} flex-1`}
            >
              <option value="">(saisir un chemin)</option>
              {workspace.keychain.map((k) => (
                <option key={k.id} value={k.id}>{k.name}</option>
              ))}
            </select>
          )}
          {!auth.keyId && (
            <input
              value={auth.keyPath}
              onChange={(e) => set("keyPath", e.target.value)}
              placeholder="~/.ssh/id_ed25519"
              className={`${cloudInputClass} flex-1 font-mono`}
            />
          )}
        </div>
      )}

      {(auth.kind === "password" || (auth.kind === "privateKey" && !auth.keyId)) && (
        <input
          type="password"
          value={auth.secret}
          onChange={(e) => set("secret", e.target.value)}
          placeholder={auth.kind === "password" ? "Mot de passe" : "Passphrase (optionnelle)"}
          className={cloudInputClass}
        />
      )}

      <label className="block space-y-1">
        <span className="text-xs font-medium text-[var(--c-text-muted)]">Groupe de destination</span>
        <GroupTreePicker
          groups={workspace.groups}
          value={auth.groupId}
          onChange={(groupId) => set("groupId", groupId)}
          customIcons={workspace.customIcons ?? []}
        />
      </label>
    </>
  );
}

/** The `AuthMethod` the batch form describes.
 *
 * Typed as `AuthMethod` rather than inferred: both callers used to launder the
 * result through `as AuthMethod`, which would have silently accepted a shape
 * the backend can't deserialise. Now a mismatch is a `tsc` error here, once,
 * instead of a cast at every call site. */
export function batchAuthMethod(workspace: Workspace, auth: BatchAuth): AuthMethod {
  if (auth.kind !== "privateKey") return auth.kind;
  const fromKeychain = workspace.keychain.find((key) => key.id === auth.keyId);
  return {
    privateKey: {
      path: fromKeychain?.path ?? auth.keyPath.trim(),
      keyId: auth.keyId || null,
      // Not offered for a batch: a certificate is per-key and short-lived, and
      // one applied to a whole subscription would be wrong for most of it.
      certPath: null,
    },
  };
}
