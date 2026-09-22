import { Suspense, useRef, type ComponentType } from "react";
import { useRowNavigation } from "../hooks/useRowNavigation";
import { alertTone, describeAlert } from "../lib/awsIdentities";
import { SIDEBAR_BUTTONS, isSidebarButtonVisible, type SidebarButtonId, type SidebarPanelKind } from "../lib/sidebarButtons";

import { renderModulePanel } from "../modules/registry";
import type { AppContext, SidebarActions } from "../modules/types";
import { IconHosts, IconSnippets, IconTunnels, IconKeychain, IconSettings, IconTransfer, IconShield, IconDatabase, IconFleet, IconCloud, IconNetDiag, IconRunbook, IconVault } from "./ui-icons";
import { TabLoadingFallback } from "./TabLoadingFallback";
import { ProfileBar, profileBarNeeded } from "./ProfileBar";
import { api } from "../lib/api";

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
  runbook:    IconRunbook,
  netdiag:    IconNetDiag,
  guivault:   IconVault,
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
  const visibleButtons = SIDEBAR_BUTTONS.filter((b) => isSidebarButtonVisible(b.id, hidden));

  // Deux zones de focus (voir `lib/keyboardNav.ts`) : la bande de boutons,
  // où ↑/↓ passent d'un bouton à l'autre et Entrée ouvre ; et le panneau,
  // où le même curseur parcourt les lignes de n'importe quel module — c'est
  // `EntityRow`/`GroupRow` qui les marquent, pas les panneaux. Échap ramène
  // au terminal, une lettre va à la recherche du panneau s'il en a une.
  const navRef = useRef<HTMLElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const navKeys = useRowNavigation(navRef, { onEscape: actions.focusTerminal });
  const panelKeys = useRowNavigation(panelRef, {
    onEscape: actions.focusTerminal,
    onType: () => panelRef.current?.querySelector<HTMLElement>("[data-panel-search]") ?? null,
  });
  /** Le raccourci du n-ième bouton visible, pour l'infobulle. */
  const comboOf = (index: number): string | undefined => {
    const combo = ctx.preferences.keyboardShortcuts[`sidebar.panel${index + 1}`];
    return combo ? combo.replace("Shift", "Maj") : undefined;
  };

  // `fleet` et `netdiag` ouvrent leur panneau **et** leur onglet de travail.
  // Le panneau ne porte que le choix des cibles : l'ouvrir seul donnerait un
  // cul-de-sac, on cocherait des machines sans avoir où lancer quoi que ce
  // soit. Un clic continue donc de donner un écran utilisable, comme quand ces
  // deux boutons n'ouvraient qu'un onglet.
  const activate = (id: SidebarButtonId) => {
    onPanelChange(id);
    if (id === "fleet") actions.openFleet();
    if (id === "netdiag") actions.openNetDiag();
  };

  return (
    <aside className="flex min-w-0 flex-1 overflow-hidden">
      {/* Vertical nav strip — fixed 44px, never overflows regardless of sidebar width */}
      <nav
        ref={navRef}
        tabIndex={0}
        data-focus-zone="sidebar-nav"
        aria-label="Panneaux"
        onKeyDown={navKeys.onKeyDown}
        onMouseDownCapture={navKeys.onMouseDownCapture}
        onFocus={navKeys.onFocus}
        className="nav-zone relative flex w-11 shrink-0 flex-col items-center gap-px border-r border-[var(--c-border)] bg-[var(--c-bg)] py-1.5 outline-none"
      >
        {visibleButtons.map((b, index) => {
          const Icon = BUTTON_ICONS[b.id];
          const active = panel === b.id;
          // The dot only ever belongs to the AWS tab, and only when something
          // that carries work is about to lapse — see `aws_sso::alerts`.
          const alerting = b.id === "aws" && tone !== null;
          const combo = comboOf(index);
          // Le raccourci après un tiret, comme le complément : ce qui précède
          // le premier « — » reste le libellé nu, sur lequel les tests s'appuient.
          const label = [b.label, b.hint, combo].filter(Boolean).join(" — ");
          return (
            <button
              key={b.id}
              onClick={() => activate(b.id)}
              tabIndex={-1}
              data-nav-row=""
              data-sidebar-button={b.id}
              aria-keyshortcuts={combo}
              // The reason goes in the tooltip rather than the badge: a bare
              // dot says "something", and the hosts are what makes it a
              // decision.
              title={alerting ? [b.label, ...actions.awsAlerts.map(describeAlert)].join("\n") : label}
              // L'état actif est un marqueur sur le bord gauche et l'icône en
              // couleur d'accent — pas un carré rempli, qui ferait de chaque
              // panneau ouvert une action primaire.
              className={`relative flex h-9 w-9 items-center justify-center rounded-md transition-colors duration-100 ${
                active
                  ? "bg-[var(--c-accent-dim)] text-[var(--c-accent-text)] before:absolute before:-left-[5px] before:top-2 before:bottom-2 before:w-0.5 before:rounded-r before:bg-[var(--c-accent)]"
                  : "text-[var(--c-text-muted)] hover:bg-[var(--c-hover)] hover:text-[var(--c-text)]"
              }`}
            >
              <Icon size={16} />
              {alerting && (
                <span
                  className={`absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full ring-2 ring-[var(--c-bg)] ${
                    tone === "danger" ? "bg-[var(--c-danger)]" : "bg-[var(--c-warn)]"
                  }`}
                />
              )}
            </button>
          );
        })}
        <div className="mt-auto">
          <button
            onClick={() => onPanelChange(panel === "settings" ? "hosts" : "settings")}
            tabIndex={-1}
            data-nav-row=""
            data-sidebar-button="settings"
            title={["Paramètres", ctx.preferences.keyboardShortcuts["settings.open"]?.replace("Shift", "Maj")].filter(Boolean).join(" — ")}
            className={`relative flex h-9 w-9 items-center justify-center rounded-md transition-colors duration-100 ${
              panel === "settings"
                ? "bg-[var(--c-accent-dim)] text-[var(--c-accent-text)] before:absolute before:-left-[5px] before:top-2 before:bottom-2 before:w-0.5 before:rounded-r before:bg-[var(--c-accent)]"
                : "text-[var(--c-text-muted)] hover:bg-[var(--c-hover)] hover:text-[var(--c-text)]"
            }`}
          >
            <IconSettings size={16} />
          </button>
        </div>
      </nav>

      {/* Panel content */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-[var(--c-bg2)]">
        {/* Quel workspace on regarde : global, donc au-dessus de tous les
            panneaux — pas seulement Hôtes. */}
        {profileBarNeeded(actions.guivaultStatus) && (
          <ProfileBar
            status={actions.guivaultStatus}
            syncing={actions.guivaultSyncing}
            onSwitch={(target) => {
              if (target === "local" || target === "account") {
                api.guivaultSwitchView(target === "local").then(actions.onGuivaultStatusChange).catch((e) => ctx.reportError(String(e)));
              } else {
                // Un autre compte : il faut s'y connecter, c'est le panneau
                // GuiVault qui le propose (déconnexion du courant comprise).
                onPanelChange("guivault");
              }
            }}
            onSyncNow={() => api.guivaultSync().then(actions.onGuivaultStatusChange).catch((e) => ctx.reportError(String(e)))}
            onOpenGuiVault={() => onPanelChange("guivault")}
          />
        )}
        {/* `data-sidebar-panel` : le seul point d'accroche stable pour vérifier
            en E2E que le panneau demandé rend bien quelque chose. Sans lui, le
            test devrait viser des classes utilitaires Tailwind, qui changent
            au premier ajustement de style. */}
        <div
          ref={panelRef}
          tabIndex={0}
          data-focus-zone="sidebar-panel"
          data-sidebar-panel={panel}
          onKeyDown={panelKeys.onKeyDown}
          onMouseDownCapture={panelKeys.onMouseDownCapture}
          onFocus={panelKeys.onFocus}
          className="nav-zone min-h-0 min-w-0 flex-1 overflow-hidden p-3 outline-none"
        >
          <Suspense fallback={<TabLoadingFallback />}>
            {renderModulePanel(panel, ctx, actions)}
          </Suspense>
        </div>
      </div>
    </aside>
  );
}
