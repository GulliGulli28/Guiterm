const VARIABLE_PATTERN = /\{\{\s*([a-zA-Z_][\w]*)\s*\}\}/g;

export function extractVariables(command: string): string[] {
  const seen = new Set<string>();
  for (const match of command.matchAll(VARIABLE_PATTERN)) seen.add(match[1]);
  return Array.from(seen);
}

export function fillVariables(command: string, values: Record<string, string>): string {
  return command.replace(VARIABLE_PATTERN, (_, name) => values[name] ?? "");
}
