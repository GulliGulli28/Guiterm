import { useEffect, useRef, useState } from "react";
import type { Snippet, SnippetId, Workspace } from "../lib/types";
import { extractVariables, fillVariables } from "../lib/snippets";
import { DSL_CONDITION_FIELDS, DSL_FUNCTIONS } from "../lib/operations";
import { IconPlay, IconTrash, IconPlus, IconClose, IconEdit, IconFlash } from "./ui-icons";
import { TerminalTargetPicker } from "./TerminalTargetPicker";

interface SnippetsPanelProps {
  workspace: Workspace;
  onAddSnippet: (name: string, command: string) => void;
  onUpdateSnippet: (id: SnippetId, name: string, command: string) => void;
  onDeleteSnippet: (id: SnippetId) => void;
  onRunSnippet: (command: string, targetTabIds?: string[]) => void;
  /** Runs an adaptive snippet's DSL program on the given (or active) terminal
   * tab(s) — resolved *per host*, translated into the actual shell command
   * for that host's detected OS, not run as literal DSL text. Parallel to
   * `onRunSnippet`, same target-tab-ids convention. */
  onRunAdaptiveSnippet: (programText: string, targetTabIds?: string[]) => void;
  /** Creates (`id: null`) or updates an adaptive snippet — `command` is the
   * DSL program text, written by hand here or generated/extended by AI from
   * `FleetTab.tsx`'s language mode; either way this is the same save path.
   * May contain `{{variables}}`, filled in the same way as classic snippets
   * before use. */
  onSaveAdaptiveSnippet: (id: SnippetId | null, name: string, command: string) => void;
  openTerminals: { id: string; label: string }[];
}

type Mode = "snippet" | "script" | "adaptive";

function DslCheatSheet() {
  return (
    <details className="text-[11px] text-[var(--c-text-faint)]">
      <summary className="cursor-pointer select-none hover:text-[var(--c-text-muted)]">Aide-mémoire de la syntaxe</summary>
      <div className="mt-1.5 space-y-1 rounded-md border border-[var(--c-border)] bg-[var(--c-bg3)] p-2">
        <p>Un bloc = conditions/options facultatives, puis une commande. Blocs séparés par une ligne vide.</p>
        <ul className="list-inside list-disc space-y-0.5">
          {DSL_CONDITION_FIELDS.map((c) => (
            <li key={c.field}><code className="font-mono">{c.example}</code></li>
          ))}
          <li><code className="font-mono">&amp;&amp;</code> (ET) / <code className="font-mono">||</code> (OU) — combine plusieurs <code className="font-mono">target</code> sur une ligne, ex. <code className="font-mono">target os: debian || target os: ubuntu</code> (<code className="font-mono">&amp;&amp;</code> prioritaire sur <code className="font-mono">||</code>)</li>
          <li><code className="font-mono">sudo: true</code> — exécute la commande du bloc avec sudo</li>
        </ul>
        <p className="pt-1">Commandes disponibles :</p>
        <ul className="grid grid-cols-2 gap-x-2 gap-y-0.5">
          {DSL_FUNCTIONS.map((f) => (
            <li key={f.name}><code className="font-mono">{f.name} {f.args}</code></li>
          ))}
        </ul>
      </div>
    </details>
  );
}

function SnippetForm({
  initialName = "",
  initialCommand = "",
  initialAdaptive = false,
  submitLabel,
  onSubmit,
  onSubmitAdaptive,
  onCancel,
}: {
  initialName?: string;
  initialCommand?: string;
  initialAdaptive?: boolean;
  submitLabel: string;
  onSubmit: (name: string, command: string) => void;
  onSubmitAdaptive: (name: string, command: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initialName);
  const [command, setCommand] = useState(initialCommand);
  const [mode, setMode] = useState<Mode>(initialAdaptive ? "adaptive" : initialCommand.includes("\n") ? "script" : "snippet");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el || mode === "snippet") return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [command, mode]);

  const switchMode = (next: Mode) => {
    setMode(next);
    if (next === "snippet") setCommand(command.split("\n")[0] ?? "");
  };

  const submit = () => {
    if (!name.trim() || !command.trim()) return;
    if (mode === "adaptive") { onSubmitAdaptive(name.trim(), command.trim()); return; }
    onSubmit(name.trim(), command.trim());
  };

  return (
    <div className="space-y-1.5">
      {/* Mode toggle */}
      <div className="flex rounded-md bg-[var(--c-bg2)] p-0.5">
        {(["snippet", "script", "adaptive"] as Mode[]).map((m) => (
          <button
            key={m}
            onClick={() => switchMode(m)}
            className={`flex-1 rounded py-1 text-xs font-medium transition-colors ${
              mode === m ? "bg-[var(--c-accent)] text-white" : "text-[var(--c-text-secondary)] hover:text-[var(--c-text)]"
            }`}
          >
            {m === "snippet" ? "Snippet" : m === "script" ? "Script" : "Adaptatif"}
          </button>
        ))}
      </div>

      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Nom"
        autoFocus
        className={inputClass}
      />

      {mode === "snippet" ? (
        <input
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
          placeholder="Commande (Entrée pour valider)"
          className={`${inputClass} font-mono`}
        />
      ) : mode === "script" ? (
        <div className="overflow-hidden rounded-md bg-[var(--c-bg2)] focus-within:ring-1 focus-within:ring-[var(--c-accent)]">
          <div className="flex items-center gap-2 border-b border-[var(--c-border)] px-2.5 py-1">
            <span className="font-mono text-[10px] text-[var(--c-text-muted)]">bash</span>
            <span className="ml-auto text-[10px] text-[var(--c-text-faint)]">Ctrl+Entrée pour valider</span>
          </div>
          <textarea
            ref={textareaRef}
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) submit(); }}
            placeholder={"#!/bin/bash\n\n# Votre script ici…"}
            rows={6}
            className="w-full resize-none overflow-hidden bg-transparent px-2.5 py-2 font-mono text-xs text-[var(--c-text)] placeholder:text-[var(--c-text-faint)] focus:outline-none"
          />
        </div>
      ) : (
        <div className="space-y-1.5">
          <div className="overflow-hidden rounded-md bg-[var(--c-bg2)] focus-within:ring-1 focus-within:ring-[var(--c-accent)]">
            <div className="flex items-center gap-2 border-b border-[var(--c-border)] px-2.5 py-1">
              <IconFlash size={11} className="text-sky-400" />
              <span className="font-mono text-[10px] text-[var(--c-text-muted)]">langage adaptatif</span>
              <span className="ml-auto text-[10px] text-[var(--c-text-faint)]">Ctrl+Entrée pour valider</span>
            </div>
            <textarea
              ref={textareaRef}
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) submit(); }}
              placeholder={"install-package nginx\n\ntarget ram: > 80\nrestart-service nginx"}
              rows={6}
              className="w-full resize-none overflow-hidden bg-transparent px-2.5 py-2 font-mono text-xs text-[var(--c-text)] placeholder:text-[var(--c-text-faint)] focus:outline-none"
            />
          </div>
          <DslCheatSheet />
        </div>
      )}

      <div className="flex gap-1.5">
        <button
          onClick={submit}
          className="accent-surface flex-1 rounded-md border py-1.5 text-xs font-medium"
        >
          {submitLabel}
        </button>
        <button
          onClick={onCancel}
          className="flex items-center justify-center rounded-md bg-[var(--c-bg2)] px-2.5 py-1.5 text-xs text-[var(--c-text-secondary)] hover:bg-white/5"
        >
          <IconClose size={12} />
        </button>
      </div>
    </div>
  );
}

function SnippetCard({
  snippet,
  openTerminals,
  onRun,
  onRunAdaptive,
  onUpdate,
  onUpdateAdaptive,
  onDelete,
}: {
  snippet: Snippet;
  openTerminals: { id: string; label: string }[];
  onRun: (command: string, targetTabIds?: string[]) => void;
  onRunAdaptive: (programText: string, targetTabIds?: string[]) => void;
  onUpdate: (name: string, command: string) => void;
  onUpdateAdaptive: (name: string, command: string) => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [promptValues, setPromptValues] = useState<Record<string, string> | null>(null);
  const [targets, setTargets] = useState<Set<string>>(new Set());
  const isScript = snippet.command.includes("\n");
  const variables = extractVariables(snippet.command);
  const targetIds = Array.from(targets);
  const run = snippet.adaptive ? onRunAdaptive : onRun;

  const handleRunClick = () => {
    if (variables.length === 0) { run(snippet.command, targetIds); return; }
    setPromptValues(Object.fromEntries(variables.map((v) => [v, ""])));
  };

  const deleteButton = confirmDelete ? (
    <button
      onClick={() => { setConfirmDelete(false); onDelete(); }}
      className="flex flex-1 basis-[68px] items-center justify-center gap-1 rounded-md bg-rose-700 px-1 py-1.5 text-xs text-white hover:bg-rose-600"
    >
      Confirmer
    </button>
  ) : (
    <button
      onClick={() => setConfirmDelete(true)}
      className="flex flex-1 basis-[68px] items-center justify-center gap-1 rounded-md bg-[var(--c-bg2)] px-1 py-1.5 text-xs text-rose-400 hover:bg-rose-900/60"
    >
      <IconTrash size={11} />
    </button>
  );
  const cancelDeleteButton = confirmDelete && (
    <button
      onClick={() => setConfirmDelete(false)}
      className="mt-1 w-full rounded-md py-1 text-xs text-[var(--c-text-muted)] hover:text-[var(--c-text-secondary)]"
    >
      Annuler la suppression
    </button>
  );

  if (editing) {
    return (
      <div className="rounded-xl bg-[var(--c-bg3)] p-2.5 ring-1 ring-[var(--c-accent)]/40">
        <SnippetForm
          initialName={snippet.name}
          initialCommand={snippet.command}
          initialAdaptive={snippet.adaptive}
          submitLabel="Enregistrer"
          onSubmit={(name, command) => { onUpdate(name, command); setEditing(false); }}
          onSubmitAdaptive={(name, command) => { onUpdateAdaptive(name, command); setEditing(false); }}
          onCancel={() => setEditing(false)}
        />
      </div>
    );
  }

  if (promptValues) {
    const submit = () => { run(fillVariables(snippet.command, promptValues), targetIds); setPromptValues(null); };
    return (
      <div className="rounded-xl bg-[var(--c-bg3)] p-2.5 ring-1 ring-[var(--c-accent)]/40">
        <p className="mb-1.5 truncate text-[14px] font-medium text-[var(--c-text)]">{snippet.name}</p>
        <div className="space-y-1.5">
          {variables.map((name) => (
            <input
              key={name}
              value={promptValues[name]}
              onChange={(e) => setPromptValues({ ...promptValues, [name]: e.target.value })}
              onKeyDown={(e) => { if (e.key === "Enter") submit(); if (e.key === "Escape") setPromptValues(null); }}
              placeholder={name}
              autoFocus={name === variables[0]}
              className={`${inputClass} font-mono`}
            />
          ))}
          <div className="flex gap-1.5">
            <button onClick={submit} className="accent-surface flex flex-1 items-center justify-center gap-1 rounded-md border py-1.5 text-xs font-medium">
              <IconPlay size={11} /> Exécuter
            </button>
            <button onClick={() => setPromptValues(null)} className="flex items-center justify-center rounded-md bg-[var(--c-bg2)] px-2.5 py-1.5 text-xs text-[var(--c-text-secondary)] hover:bg-white/5">
              <IconClose size={12} />
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-transparent bg-[var(--c-bg3)] p-2.5 transition-all hover:border-white/15">
      <div className="flex items-start justify-between gap-2">
        <p className="truncate text-[14px] font-medium text-[var(--c-text)]">{snippet.name}</p>
        <div className="flex shrink-0 gap-1">
          {variables.length > 0 && (
            <span title={`Variables : ${variables.join(", ")}`} className="rounded bg-sky-900/50 px-1.5 py-0.5 text-[10px] font-medium text-sky-300">
              {"{{}}"} {variables.length}
            </span>
          )}
          <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
            snippet.adaptive
              ? "bg-emerald-900/50 text-emerald-300"
              : isScript
                ? "bg-violet-900/50 text-violet-300"
                : "bg-[var(--c-bg2)] text-[var(--c-text-secondary)]"
          }`}>
            {snippet.adaptive ? "adaptatif" : isScript ? "script" : "snippet"}
          </span>
        </div>
      </div>
      <pre className="mt-1 line-clamp-3 whitespace-pre-wrap font-mono text-xs text-[var(--c-text-muted)]">
        {snippet.command}
      </pre>

      {snippet.adaptive && (
        <p className="mt-2 text-[10px] text-[var(--c-text-faint)]">Traduit selon l'OS détecté de chaque hôte ciblé (hôtes SSH avec état collecté) — aussi utilisable depuis Opérations de flotte.</p>
      )}
      <div className="mt-2">
        <TerminalTargetPicker terminals={openTerminals} selected={targets} onChange={setTargets} emptyLabel="Onglet actif" />
      </div>

      <div className="mt-1.5 flex flex-wrap gap-1">
        <button
          onClick={handleRunClick}
          className="accent-surface flex flex-1 basis-[68px] items-center justify-center gap-1 rounded-md border px-1 py-1.5 text-xs"
        >
          <IconPlay size={11} /> Exécuter{targetIds.length > 0 ? ` (${targetIds.length})` : ""}
        </button>
        <button
          onClick={() => setEditing(true)}
          className="flex flex-1 basis-[68px] items-center justify-center gap-1 rounded-md bg-[var(--c-bg2)] px-1 py-1.5 text-xs text-[var(--c-text-secondary)] hover:bg-white/5"
        >
          <IconEdit size={11} /> Éditer
        </button>
        {deleteButton}
      </div>
      {cancelDeleteButton}
    </div>
  );
}

export function SnippetsPanel({ workspace, onAddSnippet, onUpdateSnippet, onDeleteSnippet, onRunSnippet, onRunAdaptiveSnippet, onSaveAdaptiveSnippet, openTerminals }: SnippetsPanelProps) {
  const [showForm, setShowForm] = useState(false);

  return (
    <div className="flex h-full min-w-0 flex-col">
      {/* Everything in a single scroll container — ensures add button and cards have identical width */}
      <div className="sidebar-scroll min-h-0 min-w-0 flex-1 space-y-2 overflow-y-auto pb-2 pl-2 pt-2">
        {/* Add button always at top */}
        <div>
          <button
            onClick={() => setShowForm((v) => !v)}
            className={`accent-surface flex w-full items-center justify-center gap-1.5 rounded-xl border py-2 text-xs font-semibold transition-all ${
              showForm ? "ring-2 ring-white/25" : ""
            }`}
          >
            <IconPlus size={13} /> Ajouter
          </button>
          {showForm && (
            <div className="mt-2 rounded-xl bg-[var(--c-bg3)] p-2.5">
              <SnippetForm
                submitLabel="Enregistrer"
                onSubmit={(name, command) => { onAddSnippet(name, command); setShowForm(false); }}
                onSubmitAdaptive={(name, command) => { onSaveAdaptiveSnippet(null, name, command); setShowForm(false); }}
                onCancel={() => setShowForm(false)}
              />
            </div>
          )}
        </div>

        {workspace.snippets.map((snippet) => (
          <SnippetCard
            key={snippet.id}
            snippet={snippet}
            openTerminals={openTerminals}
            onRun={onRunSnippet}
            onRunAdaptive={onRunAdaptiveSnippet}
            onUpdate={(name, command) => onUpdateSnippet(snippet.id, name, command)}
            onUpdateAdaptive={(name, command) => onSaveAdaptiveSnippet(snippet.id, name, command)}
            onDelete={() => onDeleteSnippet(snippet.id)}
          />
        ))}
        {workspace.snippets.length === 0 && !showForm && (
          <p className="px-1 py-4 text-center text-[13px] text-[var(--c-text-muted)]">Aucun snippet</p>
        )}
      </div>
    </div>
  );
}

const inputClass = "w-full rounded-md bg-[var(--c-bg2)] px-2 py-1.5 text-[13px] text-[var(--c-text)] placeholder:text-[var(--c-text-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--c-accent)]";
