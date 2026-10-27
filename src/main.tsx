import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import "./index.css";
// Latin + latin-ext only (covers French/European text) rather than the full
// charset (which also ships cyrillic/cyrillic-ext/greek/greek-ext, ~50%
// more font weight for glyphs this app's users are unlikely to need) — a
// glyph outside this subset just falls back to a system font, no crash.
// Geist et Geist Mono : la police par défaut de l'interface et des données
// (refonte d'octobre 2026, `docs/refonte-ui.md`). Le 700 de Geist Mono sert
// au gras du terminal.
import "@fontsource/geist/latin-400.css";
import "@fontsource/geist/latin-ext-400.css";
import "@fontsource/geist/latin-500.css";
import "@fontsource/geist/latin-ext-500.css";
import "@fontsource/geist/latin-600.css";
import "@fontsource/geist/latin-ext-600.css";
import "@fontsource/geist-mono/latin-400.css";
import "@fontsource/geist-mono/latin-ext-400.css";
import "@fontsource/geist-mono/latin-500.css";
import "@fontsource/geist-mono/latin-ext-500.css";
import "@fontsource/geist-mono/latin-700.css";
import "@fontsource/geist-mono/latin-ext-700.css";
// Inter, pour l'option de police de l'interface — trois graisses, latin.
import "@fontsource/inter/latin-400.css";
import "@fontsource/inter/latin-ext-400.css";
import "@fontsource/inter/latin-500.css";
import "@fontsource/inter/latin-ext-500.css";
import "@fontsource/inter/latin-600.css";
import "@fontsource/inter/latin-ext-600.css";
import "@fontsource/jetbrains-mono/latin-400.css";
import "@fontsource/jetbrains-mono/latin-ext-400.css";
import "@fontsource/jetbrains-mono/latin-700.css";
import "@fontsource/jetbrains-mono/latin-ext-700.css";
import "@fontsource/fira-code/latin-400.css";
import "@fontsource/fira-code/latin-ext-400.css";
import "@fontsource/fira-code/latin-700.css";
import "@fontsource/fira-code/latin-ext-700.css";
import "@fontsource/source-code-pro/latin-400.css";
import "@fontsource/source-code-pro/latin-ext-400.css";
import "@fontsource/source-code-pro/latin-700.css";
import "@fontsource/source-code-pro/latin-ext-700.css";
import "@fontsource/ubuntu-mono/latin-400.css";
import "@fontsource/ubuntu-mono/latin-ext-400.css";
import "@fontsource/ubuntu-mono/latin-700.css";
import "@fontsource/ubuntu-mono/latin-ext-700.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
