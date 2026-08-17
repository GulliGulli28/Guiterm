import { lazy } from "react";
import { defineModule } from "./types";

const SnippetsPanel = lazy(() => import("../components/SnippetsPanel").then((m) => ({ default: m.SnippetsPanel })));

export const snippetsModule = defineModule({
  id: "snippets",
  label: "Snippets",
  panel: {
    kind: "snippets",
    render: (ctx, a) => (
      <SnippetsPanel
        workspace={ctx.workspace}
        onAddSnippet={a.addSnippet}
        onUpdateSnippet={a.updateSnippet}
        onDeleteSnippet={a.deleteSnippet}
        onRunSnippet={a.runSnippet}
        onRunAdaptiveSnippet={a.runAdaptiveSnippet}
        onSaveAdaptiveSnippet={a.saveAdaptiveSnippet}
        openTerminals={a.openTerminals}
      />
    ),
  },
});
