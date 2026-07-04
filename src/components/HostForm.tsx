import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { api } from "../lib/api";
import { IconTrash } from "./ui-icons";
import type { AuthMethod, EnvVar, GroupId, Host, HostId, KeyId, SnippetId, Workspace } from "../lib/types";
import { HostIcon } from "./icons";
import { IconPicker } from "./IconPicker";
import { GroupTreePicker } from "./GroupTreePicker";

interface HostFormProps {
  workspace: Workspace;
  host: Host | null;
  defaultGroupId?: GroupId | null;
  onCancel: () => void;
  onSave: (input: {
    id: HostId | null;
    label: string;
    address: string;
    port: number;
    username: string;
    auth: AuthMethod;
    jumpVia: HostId[];
    groupId: GroupId | null;
    tags: string[];
    startupSnippets: SnippetId[];
    envVars: EnvVar[];
    icon: string | null;
    secret: string | null;
    keepaliveIntervalSecs: number | null;
    agentForward: boolean;
  }) => void;
  onDeleteHost?: (id: HostId) => void;
  onWorkspaceUpdate?: (ws: Workspace) => void;
}

type AuthKind = "agent" | "password" | "privateKey";

function authKindOf(auth: AuthMethod): AuthKind {
  if (auth === "password") return "password";
  if (auth === "agent") return "agent";
  return "privateKey";
}

function jumpChoices(workspace: Workspace, editingId: HostId | null, chain: HostId[]): Host[] {
  return workspace.hosts.filter((h) => h.id !== editingId && !chain.includes(h.id));
}


export function HostForm({ workspace, host, defaultGroupId, onCancel, onSave, onDeleteHost, onWorkspaceUpdate }: HostFormProps) {
  const [label, setLabel] = useState(host?.label ?? "");
  const [address, setAddress] = useState(host?.address ?? "");
  const [port, setPort] = useState(String(host?.port ?? 22));
  const [username, setUsername] = useState(host?.username ?? "");
  const [authKind, setAuthKind] = useState<AuthKind>(host ? authKindOf(host.auth) : "agent");
  const initialKeyAuth = host && typeof host.auth === "object" && "privateKey" in host.auth ? host.auth.privateKey : null;
  const [keyPath, setKeyPath] = useState(initialKeyAuth?.path ?? "");
  const [keyId, setKeyId] = useState<KeyId | null>(initialKeyAuth?.keyId ?? null);
  const [secret, setSecret] = useState("");
  const [jumpVia, setJumpVia] = useState<HostId[]>(host?.jumpVia ?? []);
  const [groupId, setGroupId] = useState<GroupId | "">(host?.groupId ?? defaultGroupId ?? "");
  const [tags, setTags] = useState<string[]>(host?.tags ?? []);
  const [tagInput, setTagInput] = useState("");
  const [startupSnippets, setStartupSnippets] = useState<SnippetId[]>(host?.startupSnippets ?? []);
  const [envVars, setEnvVars] = useState<EnvVar[]>(host?.envVars ?? []);
  const [keepalive, setKeepalive] = useState(String(host?.keepaliveIntervalSecs ?? 0));
  const [agentForward, setAgentForward] = useState(host?.agentForward ?? false);
  const [icon, setIcon] = useState<string | null>(host?.icon ?? null);
  const [showIconPicker, setShowIconPicker] = useState(false);
  const [keyPrompt, setKeyPrompt] = useState<{ path: string } | null>(null);
  const [keyPromptName, setKeyPromptName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const choices = jumpChoices(workspace, host?.id ?? null, jumpVia);
  const snippetChoices = workspace.snippets.filter((s) => !startupSnippets.includes(s.id));

  const addStartupSnippet = (id: string) => { if (id) setStartupSnippets((prev) => [...prev, id]); };
  const removeStartupSnippet = (i: number) => setStartupSnippets((prev) => prev.filter((_, idx) => idx !== i));
  const moveSnippetUp = (i: number) => setStartupSnippets((prev) => { const a = [...prev]; [a[i - 1], a[i]] = [a[i], a[i - 1]]; return a; });
  const moveSnippetDown = (i: number) => setStartupSnippets((prev) => { const a = [...prev]; [a[i], a[i + 1]] = [a[i + 1], a[i]]; return a; });

  const addEnvVar = () => setEnvVars((prev) => [...prev, { key: "", value: "" }]);
  const removeEnvVar = (i: number) => setEnvVars((prev) => prev.filter((_, idx) => idx !== i));
  const setEnvKey = (i: number, key: string) => setEnvVars((prev) => prev.map((v, idx) => idx === i ? { ...v, key } : v));
  const setEnvValue = (i: number, value: string) => setEnvVars((prev) => prev.map((v, idx) => idx === i ? { ...v, value } : v));

  const browseKey = async () => {
    const selected = await open({ title: "Sélectionner une clé privée SSH", multiple: false, directory: false });
    if (!selected || typeof selected !== "string") return;
    setKeyPath(selected);

    const existing = workspace.keychain.find((k) => k.path === selected);
    if (existing) {
      setKeyId(existing.id);
      setKeyPrompt(null);
    } else {
      setKeyId(null);
      const fileName = selected.replace(/\\/g, "/").split("/").pop() ?? "";
      setKeyPromptName(fileName);
      setKeyPrompt({ path: selected });
    }
  };

  const confirmSaveKeyToKeychain = async () => {
    if (!keyPrompt) return;
    try {
      const ws = await api.addPrivateKey(keyPromptName.trim() || "Nouvelle clé", keyPrompt.path, null);
      const newKey = ws.keychain.find((k) => k.path === keyPrompt.path);
      if (newKey) setKeyId(newKey.id);
      onWorkspaceUpdate?.(ws);
    } catch (_e) { /* ignore */ }
    setKeyPrompt(null);
  };

  const pickKeychainKey = (kid: string) => {
    const k = workspace.keychain.find((k) => k.id === kid);
    if (k) { setKeyPath(k.path); setKeyId(k.id); }
    else { setKeyId(null); }
  };

  const addJump = (id: string) => { if (id) setJumpVia((prev) => [...prev, id]); };
  const removeJump = (i: number) => setJumpVia((prev) => prev.filter((_, idx) => idx !== i));
  const moveUp = (i: number) => setJumpVia((prev) => { const a = [...prev]; [a[i - 1], a[i]] = [a[i], a[i - 1]]; return a; });
  const moveDown = (i: number) => setJumpVia((prev) => { const a = [...prev]; [a[i], a[i + 1]] = [a[i + 1], a[i]]; return a; });
  const addTag = () => {
    const value = tagInput.trim();
    if (value && !tags.includes(value)) setTags([...tags, value]);
    setTagInput("");
  };

  const submit = () => {
    if (!label.trim() || !address.trim() || !username.trim()) {
      setError("Nom, adresse et utilisateur sont requis");
      return;
    }
    const portNum = Number(port);
    if (!Number.isInteger(portNum) || portNum <= 0 || portNum > 65535) {
      setError("Port invalide");
      return;
    }
    if (authKind === "privateKey" && !keyPath.trim()) {
      setError("Le chemin de la clé privée est requis");
      return;
    }

    const auth: AuthMethod = authKind === "agent" ? "agent" : authKind === "password" ? "password" : { privateKey: { path: keyPath.trim(), keyId } };
    const keepaliveNum = Number(keepalive);

    onSave({
      id: host?.id ?? null,
      label: label.trim(),
      address: address.trim(),
      port: portNum,
      username: username.trim(),
      auth,
      jumpVia,
      groupId: groupId || null,
      tags,
      startupSnippets,
      envVars: envVars.filter((v) => v.key.trim()),
      icon,
      secret: secret || null,
      keepaliveIntervalSecs: Number.isInteger(keepaliveNum) && keepaliveNum > 0 ? keepaliveNum : null,
      agentForward: authKind === "agent" && agentForward,
    });
  };

  return (
    <div className="flex flex-1 flex-col overflow-y-auto p-4">
      <div className="w-full space-y-4 rounded-xl bg-[var(--c-bg2)] p-5 shadow-[var(--shadow-md)]">
        <h2 className="text-[16px] font-semibold text-[var(--c-text)]">{host ? "Modifier l'hôte" : "Nouvel hôte"}</h2>

        {error && <p className="rounded-md bg-rose-950 px-3 py-2 text-sm text-rose-300">{error}</p>}

        <Field label="Nom">
          <input value={label} onChange={(e) => setLabel(e.target.value)} className={inputClass} />
        </Field>

        <Field label="Icône">
          <div className="relative">
            <div className="flex items-center gap-2">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-[var(--c-bg3)]">
                {icon ? (
                  <HostIcon iconId={icon} customIcons={workspace.customIcons} size={24} />
                ) : (
                  <span className="text-lg text-[var(--c-text-muted)]">🖥</span>
                )}
              </div>
              <button
                type="button"
                onClick={() => setShowIconPicker((v) => !v)}
                className="rounded-md bg-[var(--c-bg3)] px-3 py-2 text-xs text-[var(--c-text-secondary)] hover:bg-white/5"
              >
                {icon ? "Changer l'icône" : "Choisir une icône"}
              </button>
              {icon && (
                <button
                  type="button"
                  onClick={() => setIcon(null)}
                  className="rounded-md px-2 py-2 text-xs text-rose-400 hover:bg-rose-900/30"
                >
                  ✕
                </button>
              )}
            </div>
            {showIconPicker && (
              <IconPicker
                value={icon}
                customIcons={workspace.customIcons}
                onSelect={(id) => { setIcon(id); setShowIconPicker(false); }}
                onWorkspaceUpdate={(ws) => onWorkspaceUpdate?.(ws)}
                onClose={() => setShowIconPicker(false)}
              />
            )}
          </div>
        </Field>

        <Field label="Adresse">
          <input value={address} onChange={(e) => setAddress(e.target.value)} className={`${inputClass} font-mono`} />
        </Field>
        <Field label="Port">
          <input value={port} onChange={(e) => setPort(e.target.value)} inputMode="numeric" className={`${inputClass} font-mono`} />
        </Field>
        <Field label="Utilisateur">
          <input value={username} onChange={(e) => setUsername(e.target.value)} className={inputClass} />
        </Field>

        <Field label="Keepalive (secondes, 0 = désactivé)">
          <input value={keepalive} onChange={(e) => setKeepalive(e.target.value)} inputMode="numeric" className={inputClass} />
        </Field>

        <Field label="Authentification">
          <select value={authKind} onChange={(e) => setAuthKind(e.target.value as AuthKind)} className={inputClass}>
            <option value="agent">Agent SSH</option>
            <option value="password">Mot de passe</option>
            <option value="privateKey">Clé privée</option>
          </select>
        </Field>

        {authKind === "agent" && (
          <label className="flex items-start gap-2 rounded-md bg-[var(--c-bg3)]/60 p-2.5">
            <input
              type="checkbox"
              checked={agentForward}
              onChange={(e) => setAgentForward(e.target.checked)}
              className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--c-accent)]"
            />
            <span className="text-xs text-[var(--c-text-muted)]">
              <span className="font-medium text-[var(--c-text-secondary)]">Transférer l'agent SSH vers cet hôte</span>
              <br />
              L'hôte distant pourra utiliser vos clés locales pour rebondir ailleurs (ex. un autre bastion, un dépôt Git),
              sans qu'elles ne quittent votre machine. N'activez que pour des hôtes de confiance : un hôte compromis
              pourrait abuser de l'agent transféré pendant toute la durée de la session.
            </span>
          </label>
        )}

        {authKind === "privateKey" && (
          <>
            {workspace.keychain.length > 0 && (
              <Field label="Clé du trousseau">
                <select
                  value={keyId ?? ""}
                  onChange={(e) => { if (e.target.value) pickKeychainKey(e.target.value); else { setKeyId(null); setKeyPath(""); } }}
                  className={inputClass}
                >
                  <option value="">(saisir un chemin manuellement)</option>
                  {workspace.keychain.map((k) => (
                    <option key={k.id} value={k.id}>{k.name}</option>
                  ))}
                </select>
              </Field>
            )}
            <Field label="Chemin de la clé privée">
              <div className="flex gap-1.5">
                <input
                  value={keyPath}
                  onChange={(e) => { setKeyPath(e.target.value); setKeyId(null); setKeyPrompt(null); }}
                  className={`${inputClass} flex-1 font-mono`}
                  placeholder="~/.ssh/id_ed25519"
                />
                <button
                  type="button"
                  onClick={browseKey}
                  title="Parcourir le système de fichiers"
                  className="shrink-0 rounded-md bg-[var(--c-bg3)] px-2.5 py-2 text-sm text-[var(--c-text-secondary)] hover:bg-white/5"
                >
                  📂
                </button>
              </div>
              {keyId && !keyPrompt && (
                <p className="mt-1 text-[10px] text-[var(--c-accent-text)]">
                  🔑 Lié au trousseau : {workspace.keychain.find((k) => k.id === keyId)?.name ?? keyId}
                </p>
              )}
              {keyPrompt && (
                <div className="mt-2 space-y-2 rounded-md bg-[var(--c-accent-dim)] p-2.5">
                  <p className="text-xs text-[var(--c-accent-text)]">Enregistrer cette clé dans le trousseau ?</p>
                  <input
                    value={keyPromptName}
                    onChange={(e) => setKeyPromptName(e.target.value)}
                    placeholder="Nom de la clé"
                    className="w-full rounded-md bg-[var(--c-bg3)] px-2 py-1.5 text-sm text-[var(--c-text)] placeholder:text-[var(--c-text-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--c-accent-hover)]"
                  />
                  <div className="flex gap-1.5">
                    <button
                      type="button"
                      onClick={confirmSaveKeyToKeychain}
                      className="flex-1 rounded-md bg-[var(--c-accent)] px-2 py-1.5 text-xs font-medium text-white hover:bg-[var(--c-accent-hover)]"
                    >
                      Enregistrer dans le trousseau
                    </button>
                    <button
                      type="button"
                      onClick={() => setKeyPrompt(null)}
                      className="rounded-md bg-[var(--c-bg3)] px-2 py-1.5 text-xs text-[var(--c-text-secondary)] hover:bg-white/5"
                    >
                      Sans enregistrer
                    </button>
                  </div>
                </div>
              )}
            </Field>
          </>
        )}
        {(authKind === "password" || authKind === "privateKey") && (
          <Field label={authKind === "password" ? "Mot de passe" : "Passphrase (optionnelle)"}>
            <input value={secret} onChange={(e) => setSecret(e.target.value)} type="password" className={inputClass} />
          </Field>
        )}

        <Field label="Chaîne de bastions">
          <div className="space-y-1 rounded-md bg-[var(--c-bg3)] p-2">
            {jumpVia.length === 0 && <p className="py-0.5 text-xs text-[var(--c-text-muted)]">Connexion directe (aucun bastion)</p>}
            {jumpVia.map((id, i) => {
              const h = workspace.hosts.find((host) => host.id === id);
              return (
                <div key={id} className="flex items-center gap-1.5 rounded bg-[var(--c-bg2)] px-2 py-1">
                  <span className="w-4 shrink-0 text-center text-[10px] text-[var(--c-text-muted)]">{i + 1}</span>
                  <span className="min-w-0 flex-1 truncate text-sm text-[var(--c-text)]">{h?.label ?? id}</span>
                  <button type="button" onClick={() => moveUp(i)} disabled={i === 0} className="px-0.5 text-[var(--c-text-secondary)] disabled:opacity-20 hover:text-[var(--c-text)]">↑</button>
                  <button type="button" onClick={() => moveDown(i)} disabled={i === jumpVia.length - 1} className="px-0.5 text-[var(--c-text-secondary)] disabled:opacity-20 hover:text-[var(--c-text)]">↓</button>
                  <button type="button" onClick={() => removeJump(i)} className="px-0.5 text-rose-400 hover:text-rose-200">✕</button>
                </div>
              );
            })}
            {choices.length > 0 && (
              <select value="" onChange={(e) => addJump(e.target.value)} className="mt-1 w-full rounded-md bg-[var(--c-bg2)] px-2 py-1.5 text-sm text-[var(--c-text-secondary)] focus:outline-none focus:ring-1 focus:ring-[var(--c-accent-hover)]">
                <option value="" disabled>+ Ajouter un bastion…</option>
                {choices.map((h) => (
                  <option key={h.id} value={h.id}>{h.label}</option>
                ))}
              </select>
            )}
          </div>
        </Field>

        <Field label="Dossier">
          <GroupTreePicker
            groups={workspace.groups}
            value={groupId || null}
            onChange={(id) => setGroupId(id ?? "")}
            customIcons={workspace.customIcons}
          />
        </Field>

        <Field label="Snippets au démarrage">
          <div className="space-y-1 rounded-md bg-[var(--c-bg3)] p-2">
            {startupSnippets.length === 0 && <p className="py-0.5 text-xs text-[var(--c-text-muted)]">Aucun snippet au démarrage</p>}
            {startupSnippets.map((id, i) => {
              const s = workspace.snippets.find((sn) => sn.id === id);
              return (
                <div key={id} className="flex items-center gap-1.5 rounded bg-[var(--c-bg2)] px-2 py-1">
                  <span className="w-4 shrink-0 text-center text-[10px] text-[var(--c-text-muted)]">{i + 1}</span>
                  <span className="min-w-0 flex-1 truncate text-sm text-[var(--c-text)]">{s?.name ?? id}</span>
                  <button type="button" onClick={() => moveSnippetUp(i)} disabled={i === 0} className="px-0.5 text-[var(--c-text-secondary)] disabled:opacity-20 hover:text-[var(--c-text)]">↑</button>
                  <button type="button" onClick={() => moveSnippetDown(i)} disabled={i === startupSnippets.length - 1} className="px-0.5 text-[var(--c-text-secondary)] disabled:opacity-20 hover:text-[var(--c-text)]">↓</button>
                  <button type="button" onClick={() => removeStartupSnippet(i)} className="px-0.5 text-rose-400 hover:text-rose-200">✕</button>
                </div>
              );
            })}
            {snippetChoices.length > 0 && (
              <select value="" onChange={(e) => addStartupSnippet(e.target.value)} className="mt-1 w-full rounded-md bg-[var(--c-bg2)] px-2 py-1.5 text-sm text-[var(--c-text-secondary)] focus:outline-none focus:ring-1 focus:ring-[var(--c-accent-hover)]">
                <option value="" disabled>+ Ajouter un snippet…</option>
                {snippetChoices.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            )}
          </div>
        </Field>

        <Field label="Variables d'environnement">
          <div className="space-y-1.5 rounded-md bg-[var(--c-bg3)] p-2">
            {envVars.length === 0 && <p className="py-0.5 text-xs text-[var(--c-text-muted)]">Aucune variable définie</p>}
            {envVars.map((v, i) => (
              <div key={i} className="flex gap-1.5">
                <input
                  value={v.key}
                  onChange={(e) => setEnvKey(i, e.target.value)}
                  placeholder="NOM"
                  className="w-28 shrink-0 rounded-md bg-[var(--c-bg2)] px-2 py-1.5 font-mono text-xs text-[var(--c-text)] placeholder:font-sans placeholder:text-[var(--c-text-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--c-accent-hover)]"
                />
                <input
                  value={v.value}
                  onChange={(e) => setEnvValue(i, e.target.value)}
                  placeholder="valeur"
                  className="min-w-0 flex-1 rounded-md bg-[var(--c-bg2)] px-2 py-1.5 font-mono text-xs text-[var(--c-text)] placeholder:font-sans placeholder:text-[var(--c-text-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--c-accent-hover)]"
                />
                <button type="button" onClick={() => removeEnvVar(i)} className="shrink-0 px-1.5 text-rose-400 hover:text-rose-200">✕</button>
              </div>
            ))}
            <button type="button" onClick={addEnvVar} className="mt-0.5 w-full rounded-md bg-[var(--c-bg2)]/60 py-1 text-xs text-[var(--c-text-muted)] hover:bg-[var(--c-bg2)] hover:text-[var(--c-text-secondary)]">
              + Ajouter une variable
            </button>
          </div>
        </Field>

        <Field label="Étiquettes">
          <div className="flex flex-wrap gap-1.5 rounded-md bg-[var(--c-bg3)] p-2">
            {tags.map((tag) => (
              <span key={tag} className="flex items-center gap-1 rounded-full bg-[var(--c-accent-dim)] px-2 py-0.5 text-xs text-[var(--c-accent-text)]">
                {tag}
                <button onClick={() => setTags(tags.filter((t) => t !== tag))} className="text-[var(--c-accent-text)] hover:text-white">
                  ✕
                </button>
              </span>
            ))}
            <input
              value={tagInput}
              onChange={(e) => setTagInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === ",") {
                  e.preventDefault();
                  addTag();
                }
              }}
              onBlur={addTag}
              placeholder="Ajouter une étiquette…"
              className="min-w-[8rem] flex-1 bg-transparent text-sm text-[var(--c-text)] placeholder:text-[var(--c-text-muted)] focus:outline-none"
            />
          </div>
        </Field>

        <div className="flex gap-2 pt-2">
          <button onClick={submit} className="flex-1 rounded-md bg-[var(--c-accent)] px-3 py-2 text-sm font-medium text-white hover:bg-[var(--c-accent-hover)]">
            Enregistrer
          </button>
          <button onClick={onCancel} className="flex-1 rounded-md bg-[var(--c-bg3)] px-3 py-2 text-sm font-medium text-[var(--c-text-secondary)] hover:bg-white/5">
            Annuler
          </button>
        </div>

        {host && onDeleteHost && (
          <div className="pt-3">
            {confirmDelete ? (
              <div className="space-y-2 rounded-lg bg-rose-950/30 p-3">
                <p className="text-sm text-rose-300">Supprimer cet hôte définitivement ?</p>
                <div className="flex gap-2">
                  <button
                    onClick={() => onDeleteHost(host.id)}
                    className="flex-1 rounded-md bg-rose-700 px-3 py-2 text-sm font-medium text-white hover:bg-rose-600"
                  >
                    Oui, supprimer
                  </button>
                  <button
                    onClick={() => setConfirmDelete(false)}
                    className="flex-1 rounded-md bg-[var(--c-bg3)] px-3 py-2 text-sm font-medium text-[var(--c-text-secondary)] hover:bg-white/5"
                  >
                    Annuler
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => setConfirmDelete(true)}
                className="flex w-full items-center justify-center gap-2 rounded-md py-2 text-sm text-rose-400 hover:bg-rose-950/40 hover:text-rose-300"
              >
                <IconTrash size={13} /> Supprimer cet hôte
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

const inputClass = "w-full rounded-md bg-[var(--c-bg3)] px-3 py-2 text-sm text-[var(--c-text)] placeholder:text-[var(--c-text-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--c-accent-hover)]";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium text-[var(--c-text-muted)]">{label}</span>
      {children}
    </label>
  );
}
