import { useEffect, useRef, useState } from "react";
import type { Snippet, SnippetId, Workspace } from "../lib/types";
import { extractVariables, fillVariables } from "../lib/snippets";
import { AdaptiveComposer } from "./AdaptiveComposer";
import { DSL_CONDITION_FIELDS, DSL_FUNCTIONS } from "../lib/operations";
import { IconPlay, IconTrash, IconPlus, IconEdit, IconFlash } from "./ui-icons";
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
   * DSL program text, written by hand or generated/extended from French by
   * `AdaptiveComposer` — ici comme dans `FleetTab`, depuis le 2026-08-18 ;
   * dans tous les cas c'est le même chemin d'enregistrement.
   * May contain `{{variables}}`, filled in the same way as classic snippets
   * before use. */
  onSaveAdaptiveSnippet: (id: SnippetId | null, name: string, command: string) => void;
  openTerminals: { id: string; label: string }[];
  /** Une génération qui échoue (pas de clé API, modèle injoignable) doit se
   * dire ici, pas dans la console. */
  onError: (message: string) => void;
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
  onError,
}: {
  initialName?: string;
  initialCommand?: string;
  initialAdaptive?: boolean;
  submitLabel: string;
  onSubmit: (name: string, command: string) => void;
  onSubmitAdaptive: (name: string, command: string) => void;
  onCancel: () => void;
  onError: (message: string) => void;
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
      <div className="segmented flex w-full">
        {(["snippet", "script", "adaptive"] as Mode[]).map((m) => (
          <button
            key={m}
            onClick={() => switchMode(m)}
            data-active={mode === m ? "true" : undefined}
            className="flex-1"
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
        <div className="overflow-hidden rounded-md border border-[var(--c-border)] bg-[var(--c-input-bg)] focus-within:border-[var(--c-accent)]">
          <div className="flex items-center gap-2 border-b border-[var(--c-border)] px-2.5 py-1">
            <span className="font-mono text-[10.5px] text-[var(--c-text-muted)]">bash</span>
            <span className="ml-auto text-[10.5px] text-[var(--c-text-faint)]">Ctrl+Entrée pour valider</span>
          </div>
          <textarea
            ref={textareaRef}
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) submit(); }}
            placeholder={"#!/bin/bash\n\n# Votre script ici…"}
            rows={6}
            className="w-full resize-none overflow-hidden bg-transparent px-2.5 py-2 font-mono text-[12px] text-[var(--c-text)] outline-none placeholder:text-[var(--c-text-faint)]"
          />
        </div>
      ) : (
        <div className="space-y-1.5">
          <div className="overflow-hidden rounded-md border border-[var(--c-border)] bg-[var(--c-input-bg)] focus-within:border-[var(--c-accent)]">
            <div className="flex items-center gap-2 border-b border-[var(--c-border)] px-2.5 py-1">
              <IconFlash size={11} className="text-[var(--c-accent-text)]" />
              <span className="font-mono text-[10.5px] text-[var(--c-text-muted)]">langage adaptatif</span>
              <span className="ml-auto text-[10.5px] text-[var(--c-text-faint)]">Ctrl+Entrée pour valider</span>
            </div>
            <textarea
              ref={textareaRef}
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) submit(); }}
              placeholder={"install-package nginx\n\ntarget ram: > 80\nrestart-service nginx"}
              rows={6}
              className="w-full resize-none overflow-hidden bg-transparent px-2.5 py-2 font-mono text-[12px] text-[var(--c-text)] outline-none placeholder:text-[var(--c-text-faint)]"
            />
          </div>
          {/* La génération depuis le français vivait uniquement dans l'onglet
              Flotte : créer un snippet adaptatif obligeait donc à connaître la
              grammaire par cœur, alors que ce qui la rend abordable existait
              déjà à un onglet de distance. */}
          <AdaptiveComposer programText={command} onGenerated={setCommand} onError={onError} />
          <DslCheatSheet />
        </div>
      )}

      <div className="flex justify-end gap-1.5 pt-1">
        <button aria-label="Annuler la saisie" onClick={onCancel} className="btn btn-ghost">Annuler</button>
        <button onClick={submit} className="btn btn-primary">{submitLabel}</button>
      </div>
    </div>
  );
}

function SnippetCard({
  snippet,
  openTerminals,
  onError,
  onRun,
  onRunAdaptive,
  onUpdate,
  onUpdateAdaptive,
  onDelete,
}: {
  snippet: Snippet;
  openTerminals: { id: string; label: string }[];
  onError: (message: string) => void;
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
    <button onClick={() => { setConfirmDelete(false); onDelete(); }} className="btn btn-danger btn-sm">
      Confirmer
    </button>
  ) : (
    <button
      aria-label="Supprimer le snippet"
      title="Supprimer"
      onClick={() => setConfirmDelete(true)}
      className="btn btn-ghost btn-sm btn-icon hover:text-[var(--c-danger)]"
    >
      <IconTrash size={12} />
    </button>
  );
  const cancelDeleteButton = confirmDelete && (
    <button onClick={() => setConfirmDelete(false)} className="btn btn-ghost btn-sm">
      Annuler
    </button>
  );

  if (editing) {
    return (
      <div className="card border-[color-mix(in_srgb,var(--c-accent)_50%,transparent)] p-2.5">
        <SnippetForm
          initialName={snippet.name}
          initialCommand={snippet.command}
          initialAdaptive={snippet.adaptive}
          submitLabel="Enregistrer"
          onSubmit={(name, command) => { onUpdate(name, command); setEditing(false); }}
          onSubmitAdaptive={(name, command) => { onUpdateAdaptive(name, command); setEditing(false); }}
          onCancel={() => setEditing(false)}
          onError={onError}
        />
      </div>
    );
  }

  if (promptValues) {
    const submit = () => { run(fillVariables(snippet.command, promptValues), targetIds); setPromptValues(null); };
    return (
      <div className="card border-[color-mix(in_srgb,var(--c-accent)_50%,transparent)] p-2.5">
        <p className="mb-1.5 truncate text-[12.5px] font-medium text-[var(--c-text)]">{snippet.name}</p>
        <div className="space-y-1.5">
          {variables.map((name) => (
            <input
              key={name}
              value={promptValues[name]}
              onChange={(e) => setPromptValues({ ...promptValues, [name]: e.target.value })}
              onKeyDown={(e) => { if (e.key === "Enter") submit(); if (e.key === "Escape") setPromptValues(null); }}
              placeholder={name}
              autoFocus={name === variables[0]}
              className={`${inputClass} input-mono`}
            />
          ))}
          <div className="flex justify-end gap-1.5">
            <button aria-label="Annuler l'exécution" onClick={() => setPromptValues(null)} className="btn btn-ghost">Annuler</button>
            <button onClick={submit} className="btn btn-primary">
              <IconPlay size={11} /> Exécuter
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Le nom et la commande d'abord ; les actions dans le coin, révélées au
  // survol — sauf « Exécuter », qui est ce pour quoi on vient ici et reste
  // visible.
  return (
    <div className="card group p-2.5 transition-colors hover:border-[var(--c-border-strong)]">
      <div className="flex items-center gap-1.5">
        <p className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-[var(--c-text)]">{snippet.name}</p>
        {variables.length > 0 && (
          <span title={`Variables : ${variables.join(", ")}`} className="tag font-mono">
            {"{{}}"} {variables.length}
          </span>
        )}
        {(snippet.adaptive || isScript) && (
          <span className={`tag ${snippet.adaptive ? "tag-accent" : ""}`}>
            {snippet.adaptive ? "adaptatif" : "script"}
          </span>
        )}
      </div>
      <pre className="mt-1 line-clamp-2 whitespace-pre-wrap font-mono text-[11.5px] leading-snug text-[var(--c-text-muted)]">
        {snippet.command}
      </pre>
      {snippet.adaptive && (
        <p className="help-text mt-1.5 text-[11px]">Traduit selon la plateforme du terminal ciblé (hôte SSH, conteneur Docker exec ou terminal local — pas RDP). Les hôtes SSH sont aussi utilisables depuis Opérations de flotte.</p>
      )}
      <div className="mt-2 flex items-center gap-1">
        <TerminalTargetPicker terminals={openTerminals} selected={targets} onChange={setTargets} emptyLabel="Onglet actif" />
        <span className="ml-auto flex items-center gap-0.5">
          {confirmDelete ? (
            <>{cancelDeleteButton}{deleteButton}</>
          ) : (
            <>
              <span className="flex items-center opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                <button onClick={() => setEditing(true)} title="Modifier" aria-label="Modifier le snippet" className="btn btn-ghost btn-sm btn-icon">
                  <IconEdit size={12} />
                </button>
                {deleteButton}
              </span>
              <button onClick={handleRunClick} className="btn btn-primary btn-sm">
                <IconPlay size={10} /> Exécuter{targetIds.length > 0 ? ` (${targetIds.length})` : ""}
              </button>
            </>
          )}
        </span>
      </div>
    </div>
  );
}

export function SnippetsPanel({ workspace, onAddSnippet, onUpdateSnippet, onDeleteSnippet, onRunSnippet, onRunAdaptiveSnippet, onSaveAdaptiveSnippet, openTerminals, onError }: SnippetsPanelProps) {
  const [showForm, setShowForm] = useState(false);

  return (
    <div className="flex h-full min-w-0 flex-col">
      {/* Everything in a single scroll container — ensures add button and cards have identical width */}
      <div className="sidebar-scroll min-h-0 min-w-0 flex-1 space-y-1.5 overflow-y-auto pb-2">
        {/* Add button always at top */}
        <div>
          <button onClick={() => setShowForm((v) => !v)} className={`btn w-full ${showForm ? "btn-secondary" : "btn-primary"}`}>
            <IconPlus size={13} /> {showForm ? "Fermer le formulaire" : "Nouveau snippet"}
          </button>
          {showForm && (
            <div className="card mt-1.5 p-2.5">
              <SnippetForm
                submitLabel="Enregistrer"
                onSubmit={(name, command) => { onAddSnippet(name, command); setShowForm(false); }}
                onSubmitAdaptive={(name, command) => { onSaveAdaptiveSnippet(null, name, command); setShowForm(false); }}
                onCancel={() => setShowForm(false)}
                onError={onError}
              />
            </div>
          )}
        </div>

        {workspace.snippets.map((snippet) => (
          <SnippetCard
            key={snippet.id}
            snippet={snippet}
            openTerminals={openTerminals}
            onError={onError}
            onRun={onRunSnippet}
            onRunAdaptive={onRunAdaptiveSnippet}
            onUpdate={(name, command) => onUpdateSnippet(snippet.id, name, command)}
            onUpdateAdaptive={(name, command) => onSaveAdaptiveSnippet(snippet.id, name, command)}
            onDelete={() => onDeleteSnippet(snippet.id)}
          />
        ))}
        {workspace.snippets.length === 0 && !showForm && (
          <div className="px-2 py-8 text-center">
            <p className="text-[12.5px] font-medium text-[var(--c-text-secondary)]">Aucun snippet</p>
            <p className="help-text mt-1">Une commande enregistrée, à lancer d'un clic dans n'importe quel terminal — avec des <span className="font-mono">{"{{variables}}"}</span> demandées au moment de l'exécuter.</p>
          </div>
        )}
      </div>
    </div>
  );
}

const inputClass = "input";
