import { Suspense, type ComponentType } from "react";
import { alertTone, describeAlert } from "../lib/awsIdentities";
import { SIDEBAR_BUTTONS, isSidebarButtonVisible, type SidebarButtonId, type SidebarPanelKind } from "../lib/sidebarButtons";

import { renderModulePanel } from "../modules/registry";
import type { AppContext, SidebarActions } from "../modules/types";
import { IconHosts, IconSnippets, IconTunnels, IconKeychain, IconSettings, IconTransfer, IconShield, IconDatabase, IconFleet, IconCloud, IconNetDiag } from "./ui-icons";
import { TabLoadingFallback } from "./TabLoadingFallback";

interface SidebarProps {
  panel: SidebarPanelKind;
  onPanelChange: (panel: SidebarPanelKind) => void;
  ctx: AppContext;
  actions: SidebarActions;
}

// L'ordre et les libellés vivent dans `lib/sidebarButtons` — partagés avec le
// réglage de masquage, qui doit se lire contre cette barre. Ici, seule
// l'icône. Le `Record` rend l'oubli impossible : ajouter un bouton sans son
// icône est une erreur `tsc`.
const BUTTON_ICONS: Record<SidebarButtonId, ComponentType<{ size?: number }>> = {
  knownHosts: IconShield,
  hosts:      IconHosts,
  sftp:       IconTransfer,
  snippets:   IconSnippets,
  tunnels:    IconTunnels,
  database:   IconDatabase,
  keychain:   IconKeychain,
  aws:        IconCloud,
  fleet:      IconFleet,
  netdiag:    IconNetDiag,
};

/**
 * La coquille de la barre latérale : la bande de boutons, et le conteneur du
 * panneau courant.
 *
 * Ne connaît **aucun** panneau. Chacun est rendu par son module
 * (`modules/registry`), là où ce composant déclarait 45 props qu'il se
 * contentait de faire suivre. Ce qui reste ici est le shell — comme le shell
 * d'onglets d'`App.tsx`, il est noyau et non extensible.
 */
export function Sidebar({ panel, onPanelChange, ctx, actions }: SidebarProps) {
  const tone = alertTone(actions.awsAlerts);
  const hidden = ctx.preferences.hiddenSidebarButtons;

  // `fleet` et `netdiag` ouvrent un onglet au lieu de changer de panneau. Ils
  // vivent dans cette barre parce que c'est là qu'on cherche « ce que sait
  // faire l'app » — un bouton relégué dans la barre d'onglets ne se trouvait
  // pas.
  const activate = (id: SidebarButtonId) => {
    if (id === "fleet") return actions.openFleet();
    if (id === "netdiag") return actions.openNetDiag();
    onPanelChange(id);
  };

  return (
    <aside className="flex min-w-0 flex-1 overflow-hidden">
      {/* Vertical nav strip — fixed 44px, never overflows regardless of sidebar width */}
      <nav className="relative flex w-11 shrink-0 flex-col items-center border-r border-[var(--c-border)] bg-[var(--c-bg)] py-2 gap-0.5">
        {SIDEBAR_BUTTONS.filter((b) => isSidebarButtonVisible(b.id, hidden)).map((b) => {
          const Icon = BUTTON_ICONS[b.id];
          const active = panel === b.id;
          // The dot only ever belongs to the AWS tab, and only when something
          // that carries work is about to lapse — see `aws_sso::alerts`.
          const alerting = b.id === "aws" && tone !== null;
          const label = b.hint ? `${b.label} — ${b.hint}` : b.label;
          return (
            <button
              key={b.id}
              onClick={() => activate(b.id)}
              // The reason goes in the tooltip rather than the badge: a bare
              // dot says "something", and the hosts are what makes it a
              // decision.
              title={alerting ? [b.label, ...actions.awsAlerts.map(describeAlert)].join("\n") : label}
              className={`relative flex h-9 w-9 items-center justify-center rounded-lg border transition-all duration-150 ${
                active
                  ? "accent-surface"
                  : "border-transparent text-[var(--c-text-faint)] hover:bg-white/5 hover:text-[var(--c-text-secondary)]"
              }`}
            >
              <Icon size={16} />
              {alerting && (
                <span
                  className={`absolute right-1 top-1 h-2 w-2 rounded-full ring-2 ring-[var(--c-bg)] ${
                    tone === "danger" ? "bg-rose-500" : "bg-amber-400"
                  }`}
                />
              )}
            </button>
          );
        })}
        <div className="mt-auto">
          <button
            onClick={() => onPanelChange(panel === "settings" ? "hosts" : "settings")}
            title="Paramètres"
            className={`relative flex h-9 w-9 items-center justify-center rounded-lg border transition-all duration-150 ${
              panel === "settings"
                ? "accent-surface"
                : "border-transparent text-[var(--c-text-faint)] hover:bg-white/5 hover:text-[var(--c-text-secondary)]"
            }`}
          >
            <IconSettings size={16} />
          </button>
        </div>
      </nav>

      {/* Panel content */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-[var(--c-bg2)]">
        {/* `data-sidebar-panel` : le seul point d'accroche stable pour vérifier
            en E2E que le panneau demandé rend bien quelque chose. Sans lui, le
            test devrait viser des classes utilitaires Tailwind, qui changent
            au premier ajustement de style. */}
        <div data-sidebar-panel={panel} className="min-h-0 min-w-0 flex-1 overflow-hidden p-2">
          <Suspense fallback={<TabLoadingFallback />}>
            {renderModulePanel(panel, ctx, actions)}
          </Suspense>
        </div>
      </div>
    </aside>
  );
}
