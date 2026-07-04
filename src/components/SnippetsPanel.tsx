import { useEffect, useRef, useState } from "react";
import type { Snippet, SnippetId, Workspace } from "../lib/types";
import { IconPlay, IconTrash, IconPlus, IconClose, IconEdit } from "./ui-icons";

interface SnippetsPanelProps {
  workspace: Workspace;
  onAddSnippet: (name: string, command: string) => void;
  onUpdateSnippet: (id: SnippetId, name: string, command: string) => void;
  onDeleteSnippet: (id: SnippetId) => void;
  onRunSnippet: (command: string) => void;
}

type Mode = "snippet" | "script";

const VARIABLE_PATTERN = /\{\{\s*([a-zA-Z_][\w]*)\s*\}\}/g;

function extractVariables(command: string): string[] {
  const seen = new Set<string>();
  for (const match of command.matchAll(VARIABLE_PATTERN)) seen.add(match[1]);
  return Array.from(seen);
}

function fillVariables(command: string, values: Record<string, string>): string {
  return command.replace(VARIABLE_PATTERN, (_, name) => values[name] ?? "");
}

function SnippetForm({
  initialName = "",
  initialCommand = "",
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initialName?: string;
  initialCommand?: string;
  submitLabel: string;
  onSubmit: (name: string, command: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initialName);
  const [command, setCommand] = useState(initialCommand);
  const [mode, setMode] = useState<Mode>(initialCommand.includes("\n") ? "script" : "snippet");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el || mode !== "script") return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [command, mode]);

  const switchMode = (next: Mode) => {
    setMode(next);
    if (next === "snippet") setCommand(command.split("\n")[0] ?? "");
  };

  const submit = () => {
    if (!name.trim() || !command.trim()) return;
    onSubmit(name.trim(), command.trim());
  };

  return (
    <div className="space-y-1.5">
      {/* Mode toggle */}
      <div className="flex rounded-md bg-[var(--c-bg2)] p-0.5">
        {(["snippet", "script"] as Mode[]).map((m) => (
          <button
            key={m}
            onClick={() => switchMode(m)}
            className={`flex-1 rounded py-1 text-xs font-medium transition-colors ${
              mode === m ? "bg-[var(--c-accent)] text-white" : "text-[var(--c-text-secondary)] hover:text-[var(--c-text)]"
            }`}
          >
            {m === "snippet" ? "Snippet" : "Script"}
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
      ) : (
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
      )}

      <div className="flex gap-1.5">
        <button
          onClick={submit}
          className="flex-1 rounded-md bg-[var(--c-accent)] py-1.5 text-xs font-medium text-white hover:bg-[var(--c-accent-hover)]"
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
  onRun,
  onUpdate,
  onDelete,
}: {
  snippet: Snippet;
  onRun: (command: string) => void;
  onUpdate: (name: string, command: string) => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [promptValues, setPromptValues] = useState<Record<string, string> | null>(null);
  const isScript = snippet.command.includes("\n");
  const variables = extractVariables(snippet.command);

  const handleRunClick = () => {
    if (variables.length === 0) { onRun(snippet.command); return; }
    setPromptValues(Object.fromEntries(variables.map((v) => [v, ""])));
  };

  if (editing) {
    return (
      <div className="rounded-lg bg-[var(--c-bg3)] p-2.5 ring-1 ring-[var(--c-accent)]/40">
        <SnippetForm
          initialName={snippet.name}
          initialCommand={snippet.command}
          submitLabel="Enregistrer"
          onSubmit={(name, command) => { onUpdate(name, command); setEditing(false); }}
          onCancel={() => setEditing(false)}
        />
      </div>
    );
  }

  if (promptValues) {
    const submit = () => { onRun(fillVariables(snippet.command, promptValues)); setPromptValues(null); };
    return (
      <div className="rounded-lg bg-[var(--c-bg3)] p-2.5 ring-1 ring-[var(--c-accent)]/40">
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
            <button onClick={submit} className="flex flex-1 items-center justify-center gap-1 rounded-md bg-[var(--c-accent)] py-1.5 text-xs font-medium text-white hover:bg-[var(--c-accent-hover)]">
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
    <div className="rounded-lg bg-[var(--c-bg3)]/40 p-2.5 transition-colors hover:bg-[var(--c-bg3)]">
      <div className="flex items-start justify-between gap-2">
        <p className="truncate text-[14px] font-medium text-[var(--c-text)]">{snippet.name}</p>
        <div className="flex shrink-0 gap-1">
          {variables.length > 0 && (
            <span title={`Variables : ${variables.join(", ")}`} className="rounded bg-sky-900/50 px-1.5 py-0.5 text-[10px] font-medium text-sky-300">
              {"{{}}"} {variables.length}
            </span>
          )}
          <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
            isScript ? "bg-violet-900/50 text-violet-300" : "bg-[var(--c-bg2)] text-[var(--c-text-secondary)]"
          }`}>
            {isScript ? "script" : "snippet"}
          </span>
        </div>
      </div>
      <pre className="mt-1 line-clamp-3 whitespace-pre-wrap font-mono text-xs text-[var(--c-text-muted)]">
        {snippet.command}
      </pre>

      <div className="mt-2 flex flex-wrap gap-1">
        <button
          onClick={handleRunClick}
          className="flex flex-1 basis-[68px] items-center justify-center gap-1 rounded-md bg-[var(--c-accent)] px-1 py-1.5 text-xs text-white hover:bg-[var(--c-accent-hover)]"
        >
          <IconPlay size={11} /> Exécuter
        </button>
        <button
          onClick={() => setEditing(true)}
          className="flex flex-1 basis-[68px] items-center justify-center gap-1 rounded-md bg-[var(--c-bg2)] px-1 py-1.5 text-xs text-[var(--c-text-secondary)] hover:bg-white/5"
        >
          <IconEdit size={11} /> Éditer
        </button>
        {confirmDelete ? (
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
        )}
      </div>
      {confirmDelete && (
        <button
          onClick={() => setConfirmDelete(false)}
          className="mt-1 w-full rounded-md py-1 text-xs text-[var(--c-text-muted)] hover:text-[var(--c-text-secondary)]"
        >
          Annuler la suppression
        </button>
      )}
    </div>
  );
}

export function SnippetsPanel({ workspace, onAddSnippet, onUpdateSnippet, onDeleteSnippet, onRunSnippet }: SnippetsPanelProps) {
  const [showForm, setShowForm] = useState(false);

  return (
    <div className="flex h-full min-w-0 flex-col">
      {/* Everything in a single scroll container — ensures add button and cards have identical width */}
      <div className="sidebar-scroll min-h-0 min-w-0 flex-1 space-y-2 overflow-y-auto">
        {/* Add button always at top */}
        <div>
          <button
            onClick={() => setShowForm((v) => !v)}
            className={`flex w-full items-center justify-center gap-1.5 rounded-md border py-1.5 text-xs font-medium transition-colors ${
              showForm
                ? "border-[var(--c-accent)] bg-[var(--c-accent-dim)] text-[var(--c-accent-text)]"
                : "border-dashed border-[var(--c-border)] text-[var(--c-text-muted)] hover:border-[var(--c-accent)] hover:text-[var(--c-accent-text)]"
            }`}
          >
            <IconPlus size={13} /> Ajouter
          </button>
          {showForm && (
            <div className="mt-2 rounded-lg bg-[var(--c-bg3)]/40 p-2.5">
              <SnippetForm
                submitLabel="Enregistrer"
                onSubmit={(name, command) => { onAddSnippet(name, command); setShowForm(false); }}
                onCancel={() => setShowForm(false)}
              />
            </div>
          )}
        </div>

        {workspace.snippets.map((snippet) => (
          <SnippetCard
            key={snippet.id}
            snippet={snippet}
            onRun={onRunSnippet}
            onUpdate={(name, command) => onUpdateSnippet(snippet.id, name, command)}
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
