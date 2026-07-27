import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  test: {
    environment: "node",
    // `.claude` holds agent worktrees — full copies of the repo, test files
    // included. Without this every suite runs twice (the counts silently
    // double) and a stale copy can fail on code that no longer exists.
    exclude: ["**/node_modules/**", "**/dist/**", "**/.claude/**"],
  },
});
