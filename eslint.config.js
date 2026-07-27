import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

export default tseslint.config(
  // `.claude` holds agent worktrees — full copies of the repo. Without this,
  // every file gets linted twice (once here, once in the copy) and a stale
  // copy can report errors for code that no longer exists.
  { ignores: ["dist", "target", "src-tauri/target", "rdp-sidecar/target", ".claude"] },
  {
    files: ["src/**/*.{ts,tsx}"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    plugins: {
      "react-hooks": reactHooks,
    },
    languageOptions: {
      ecmaVersion: 2023,
      globals: globals.browser,
    },
    rules: {
      // Just the two well-established hooks rules — the plugin's own
      // "recommended-latest" bundle also pulls in a much larger set of
      // React Compiler-oriented static analysis rules (purity,
      // immutability, gating...) that would need a dedicated pass to
      // evaluate against this codebase, out of scope for a first setup.
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      // TS's own noUnusedLocals/noUnusedParameters (tsconfig.json) already
      // cover this as a hard build error — avoid a second, looser opinion.
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
);
