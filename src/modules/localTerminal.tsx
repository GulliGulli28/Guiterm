import { LocalTerminalTab } from "../components/LocalTerminalTab";
import { defineModule } from "./types";

// Eager, comme `terminal` : `Ctrl+T` doit ouvrir un shell tout de suite, et
// `SplitPane` monte de toute façon le même composant.
export const localTerminalModule = defineModule({
  id: "local-terminal",
  label: "Terminal local",
  tab: {
    kind: "local-terminal",
    render: (tab, ctx, isActive) => (
      <LocalTerminalTab
        isActive={isActive}
        preferences={ctx.preferences}
        initialCommand={tab.initialCommand}
        shell={tab.shell}
        onLongCommand={ctx.notifyLongCommand}
        onDisconnect={() => ctx.closeTab(tab.id, "disconnected")}
        onInputData={(data) => ctx.mirrorInput(tab.id, data)}
        ref={(handle) => ctx.registerTerminalHandle(tab.id, handle)}
      />
    ),
  },
});
