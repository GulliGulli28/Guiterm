import type { TerminalTabHandle } from "../components/TerminalTab";

// `shellCapable`: false for an RDP target (see `RdpTab.tsx`'s handle) — it
// has no shell/PTY to pipe a base64-decoded script into, so a multi-line
// command is instead typed as-is (its own `runCommand` turns each embedded
// `\n` into a real Enter keypress line by line, unrelated to this wrapping).
export function runOnTerminalHandle(handle: TerminalTabHandle, command: string, shellCapable: boolean) {
  if (shellCapable && command.includes("\n")) {
    // Encode script as base64 and decode+execute in one line so the terminal
    // only shows a compact command, not the full script content.
    const b64 = new TextEncoder().encode(command);
    handle.runCommand(`echo '${b64}' | base64 -d | bash`);
  } else {
    handle.runCommand(command);
  }
}
