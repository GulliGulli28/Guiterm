import { useEffect, useRef, useState } from "react";
import type { Snippet } from "../lib/types";
import { extractVariables, fillVariables } from "../lib/snippets";

interface SnippetPickerProps {
  snippets: Snippet[];
  onRun: (command: string) => void;
  /** Additionally passes the snippet itself — lets a caller special-case an
   * adaptive snippet (route it into its own translate-then-run flow, e.g.
   * `FleetTab`'s AI-intent mode or `App.tsx`'s per-terminal execution,
   * instead of treating `resolvedText` as a literal command). When both this
   * and the picked snippet are adaptive, `onRun` is *not* also called —
   * `resolvedText` is DSL program text, not a runnable command, so only the
   * caller that knows how to translate it should act on it. Optional and
   * additive: existing callers that only need `onRun` are unaffected. */
  onSnippetResolved?: (snippet: Snippet, resolvedText: string) => void;
  onClose: () => void;
}

// Splits "sys start apache2" into a name filter ("sys") and positional args
// (["start", "apache2"]) that fill the snippet's {{variables}} in order of appearance.
function splitNameAndArgs(query: string): { namePart: string; args: string[] } {
  const trimmed = query.trim();
  const spaceIdx = trimmed.indexOf(" ");
  if (spaceIdx === -1) return { namePart: trimmed, args: [] };
  return { namePart: trimmed.slice(0, spaceIdx), args: trimmed.slice(spaceIdx + 1).trim().split(/\s+/).filter(Boolean) };
}

export function SnippetPicker({ snippets, onRun, onSnippetResolved, onClose }: SnippetPickerProps) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [pending, setPending] = useState<{ snippet: Snippet; values: Record<string, string> } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => { setActiveIndex(0); }, [query]);
  useEffect(() => { itemRefs.current[activeIndex]?.scrollIntoView({ block: "nearest" }); }, [activeIndex]);

  const { namePart, args } = splitNameAndArgs(query);
  const filtered = namePart
    ? snippets.filter((s) => s.name.toLowerCase().includes(namePart.toLowerCase()))
    : snippets;

  // Adaptive snippets are DSL program text, not a runnable command — when a
  // caller has opted into handling that itself (`onSnippetResolved`), `onRun`
  // must not also fire, or it would type the raw DSL into a terminal.
  const resolve = (snippet: Snippet, resolvedText: string) => {
    if (!(snippet.adaptive && onSnippetResolved)) onRun(resolvedText);
    onSnippetResolved?.(snippet, resolvedText);
  };

  const selectAt = (index: number, providedArgs: string[]) => {
    const snippet = filtered[index];
    if (!snippet) return;
    const variables = extractVariables(snippet.command);
    if (variables.length === 0) {
      resolve(snippet, snippet.command);
      onClose();
      return;
    }
    const values = Object.fromEntries(variables.map((v, i) => [v, providedArgs[i] ?? ""]));
    if (providedArgs.length >= variables.length) {
      // Every {{variable}} was supplied inline (e.g. "sys start apache2") — run immediately.
      resolve(snippet, fillVariables(snippet.command, values));
      onClose();
    } else {
      // Partial (or no) args typed inline — prefill what we have and prompt for the rest.
      setPending({ snippet, values });
    }
  };

  if (pending) {
    const variables = extractVariables(pending.snippet.command);
    const firstEmpty = variables.find((v) => !pending.values[v]) ?? variables[0];
    const submit = () => {
      resolve(pending.snippet, fillVariables(pending.snippet.command, pending.values));
      onClose();
    };
    return (
      <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-[15vh]" onClick={onClose}>
        <div className="modal w-full max-w-md overflow-hidden p-4" onClick={(e) => e.stopPropagation()}>
          <p className="mb-2 truncate text-[13px] font-semibold text-[var(--c-text)]">{pending.snippet.name}</p>
          <div className="space-y-1.5">
            {variables.map((name) => (
              <input
                key={name}
                value={pending.values[name]}
                onChange={(e) => setPending({ ...pending, values: { ...pending.values, [name]: e.target.value } })}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Enter") submit();
                  if (e.key === "Escape") onClose();
                }}
                placeholder={name}
                autoFocus={name === firstEmpty}
                className="input input-mono w-full"
              />
            ))}
          </div>
          <div className="mt-3 flex justify-end gap-1.5">
            <button onClick={onClose} className="btn btn-ghost">Annuler</button>
            <button onClick={submit} className="btn btn-primary">
              Exécuter
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-[15vh]" onClick={onClose}>
      <div className="modal w-full max-w-lg overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Escape") { e.preventDefault(); onClose(); }
            if (e.key === "ArrowDown") { e.preventDefault(); setActiveIndex((i) => Math.min(i + 1, filtered.length - 1)); }
            if (e.key === "ArrowUp") { e.preventDefault(); setActiveIndex((i) => Math.max(i - 1, 0)); }
            if (e.key === "Enter") { e.preventDefault(); selectAt(activeIndex, args); }
          }}
          placeholder="Snippet puis arguments… (ex : sys start apache2)"
          className="w-full border-b border-[var(--c-border)] bg-transparent px-4 py-3 text-[13.5px] text-[var(--c-text)] outline-none placeholder:text-[var(--c-text-muted)]"
        />
        <div className="sidebar-scroll max-h-80 overflow-y-auto py-1">
          {filtered.length === 0 && <p className="px-4 py-6 text-center text-[12.5px] text-[var(--c-text-muted)]">Aucun snippet</p>}
          {filtered.map((s, i) => {
            const variables = extractVariables(s.command);
            return (
              <button
                key={s.id}
                ref={(el) => { itemRefs.current[i] = el; }}
                onClick={() => selectAt(i, args)}
                onMouseEnter={() => setActiveIndex(i)}
                className={`mx-1 flex w-[calc(100%-0.5rem)] items-center justify-between gap-2 rounded-md px-3 py-1.5 text-left text-[12.5px] transition-colors ${
                  i === activeIndex ? "bg-[var(--c-accent-dim)] text-[var(--c-text)]" : "text-[var(--c-text-secondary)]"
                }`}
              >
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="truncate">{s.name}</span>
                  {s.adaptive && (
                    <span className="tag tag-accent">adaptatif</span>
                  )}
                </span>
                {variables.length > 0 ? (
                  <span className="ml-2 flex shrink-0 gap-1 overflow-hidden">
                    {variables.map((v, vi) => (
                      <span
                        key={v}
                        className={`tag truncate font-mono ${args[vi] ? "text-[var(--c-ok)]" : ""}`}
                      >
                        {args[vi] || v}
                      </span>
                    ))}
                  </span>
                ) : (
                  <span className="ml-2 max-w-[45%] shrink-0 truncate font-mono text-[10.5px] text-[var(--c-text-muted)]">{s.command.split("\n")[0]}</span>
                )}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
