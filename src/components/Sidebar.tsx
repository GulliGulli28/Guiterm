import { Suspense, useRef, type ComponentType } from "react";
import { useRowNavigation } from "../hooks/useRowNavigation";
import { alertTone, describeAlert } from "../lib/awsIdentities";
import { SIDEBAR_BUTTONS, isSidebarButtonVisible, type SidebarButtonDef, type SidebarButtonId, type SidebarPanelKind } from "../lib/sidebarButtons";

import { renderModulePanel } from "../modules/registry";
import type { AppContext, SidebarActions } from "../modules/types";
import { IconHosts, IconSnippets, IconTunnels, IconKeychain, IconSettings, IconTransfer, IconShield, IconDatabase, IconFleet, IconCloud, IconNetDiag, IconRunbook, IconVault, IconActivity } from "./ui-icons";
import { TabLoadingFallback } from "./TabLoadingFallback";
import { profileBarNeeded } from "./ProfileBar";
import { AccountMenu } from "./AccountMenu";
import { api } from "../lib/api";

interface SidebarProps {
  panel: SidebarPanelKind;
  onPanelChange: (panel: SidebarPanelKind) => void;
  /** Le panneau est déplié. Le rail, lui, reste toujours à l'écran. */
  panelVisible: boolean;
  onPanelVisibleChange: (visible: boolean) => void;
  /** Largeur du panneau, tenue par `App` (poignée de redimensionnement). */
  panelWidth: number;
  /** Pendant un glisser de la poignée : pas de transition, la largeur suit
   * la souris. */
  resizing: boolean;
  /** L'activité n'est pas un panneau mais un onglet : le rail l'ouvre. */
  onOpenActivity: () => void;
  ctx: AppContext;
  actions: SidebarActions;
}

// L'ordre et les libellés vivent dans `lib/sidebarButtons` — partagés avec le
// réglage de masquage, qui doit se lire contre ce rail. Ici, seule
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

/** Un bouton du rail : l'icône et son mot dessous. L'état actif est un fond
 * neutre et l'icône en couleur d'accent — pas un carré rempli, qui ferait de
 * chaque panneau ouvert une action primaire. */
function RailButton({ icon: Icon, label, title, active, onClick, alert, ...data }: {
  icon: ComponentType<{ size?: number; className?: string }>;
  label: string;
  title: string;
  active: boolean;
  /** `byMouse` : le clic vient d'un pointeur — un Entrée au clavier sur le
   * rail produit aussi un clic, mais avec `detail === 0`. */
  onClick: (byMouse: boolean) => void;
  /** La pastille d'alerte, et sa couleur. */
  alert?: "warn" | "danger" | null;
  "data-sidebar-button"?: string;
  "aria-keyshortcuts"?: string;
}) {
  return (
    <button
      type="button"
      onClick={(e) => onClick(e.detail > 0)}
      tabIndex={-1}
      data-nav-row=""
      title={title}
      aria-label={label}
      aria-current={active ? "page" : undefined}
      {...data}
      className={`relative flex h-[50px] w-full shrink-0 flex-col items-center justify-center gap-1 rounded-[10px] text-[11px] font-medium leading-none transition-colors duration-100 ${
        active
          ? "bg-[var(--c-active)] text-[var(--c-text)]"
          : "text-[var(--c-text-muted)] hover:bg-[var(--c-hover)] hover:text-[var(--c-text)]"
      }`}
    >
      <span className={active ? "text-[var(--c-accent-text)]" : undefined}><Icon size={18} /></span>
      <span className="max-w-full truncate tracking-[-0.01em]">{label}</span>
      {alert && (
        <span
          className={`absolute right-3.5 top-1.5 h-2 w-2 rounded-full ring-2 ring-[var(--c-bg)] ${alert === "danger" ? "bg-[var(--c-danger)]" : "bg-[var(--c-warn)]"}`}
        />
      )}
    </button>
  );
}

/**
 * La coquille de la barre latérale : le rail, toujours visible, et à côté le
 * panneau courant, qui se replie (`Ctrl+B`, ou un clic sur le bouton du
 * panneau déjà ouvert).
 *
 * Ne connaît **aucun** panneau. Chacun est rendu par son module
 * (`modules/registry`), là où ce composant déclarait 45 props qu'il se
 * contentait de faire suivre. Ce qui reste ici est le shell — comme le shell
 * d'onglets d'`App.tsx`, il est noyau et non extensible.
 */
export function Sidebar({ panel, onPanelChange, panelVisible, onPanelVisibleChange, panelWidth, resizing, onOpenActivity, ctx, actions }: SidebarProps) {
  const tone = alertTone(actions.awsAlerts);
  const hidden = ctx.preferences.hiddenSidebarButtons;
  const visibleButtons = SIDEBAR_BUTTONS.filter((b) => isSidebarButtonVisible(b.id, hidden));

  // Deux zones de focus (voir `lib/keyboardNav.ts`) : le rail, où ↑/↓
  // passent d'un bouton à l'autre et Entrée ouvre ; et le panneau, où le même
  // curseur parcourt les lignes de n'importe quel module — c'est
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

  // Ouvrir un panneau **et y aller** : rester sur le rail après Entrée
  // obligeait à un F6 de plus pour lire ce qu'on vient d'ouvrir. Le conteneur
  // n'existe qu'au rendu suivant, d'où la trame d'attente.
  const focusPanel = () => requestAnimationFrame(() => panelRef.current?.focus());
  // Un clic sur le bouton du panneau déjà ouvert le replie — le geste des
  // éditeurs de code, et le seul moyen à la souris maintenant que le rail ne
  // se replie plus avec lui. Au clavier, Entrée sur ce bouton va dans le
  // panneau, comme sur les autres : replier ce qu'on s'apprête à lire serait
  // un piège. `fleet` et `netdiag` ouvrent leur panneau **et** leur onglet de
  // travail : le panneau ne porte que le choix des cibles, l'ouvrir seul
  // donnerait un cul-de-sac.
  const activate = (id: SidebarButtonId, byMouse: boolean) => {
    if (byMouse && panelVisible && panel === id) {
      onPanelVisibleChange(false);
      return;
    }
    onPanelChange(id);
    onPanelVisibleChange(true);
    if (id === "fleet") actions.openFleet();
    if (id === "netdiag") actions.openNetDiag();
    focusPanel();
  };

  const renderButton = (b: SidebarButtonDef) => {
    const index = visibleButtons.indexOf(b);
    const combo = comboOf(index);
    // The dot only ever belongs to the AWS button, and only when something
    // that carries work is about to lapse — see `aws_sso::alerts`.
    const alerting = b.id === "aws" && tone !== null;
    // Le raccourci après un tiret, comme le complément : ce qui précède le
    // premier « — » reste le libellé nu, sur lequel les tests s'appuient.
    const label = [b.label, b.hint, combo].filter(Boolean).join(" — ");
    return (
      <RailButton
        key={b.id}
        icon={BUTTON_ICONS[b.id]}
        label={b.short}
        // The reason goes in the tooltip rather than the badge: a bare dot
        // says "something", and the hosts are what makes it a decision.
        title={alerting ? [b.label, ...actions.awsAlerts.map(describeAlert)].join("\n") : label}
        active={panelVisible && panel === b.id}
        onClick={(byMouse) => activate(b.id, byMouse)}
        alert={alerting ? tone : null}
        data-sidebar-button={b.id}
        aria-keyshortcuts={combo}
      />
    );
  };
  const inGroup = (group: SidebarButtonDef["group"]) => visibleButtons.filter((b) => b.group === group);
  const tools = inGroup("outils");
  const settingsCombo = ctx.preferences.keyboardShortcuts["settings.open"]?.replace("Shift", "Maj");

  // Un `<aside>` autour du rail et du panneau : c'est la barre latérale, et
  // l'E2E y cherche ses boutons (`aside nav button`).
  return (
    <aside className="flex min-h-0 shrink-0">
      <nav
        ref={navRef}
        tabIndex={0}
        data-focus-zone="sidebar-nav"
        aria-label="Panneaux"
        onKeyDown={navKeys.onKeyDown}
        onMouseDownCapture={navKeys.onMouseDownCapture}
        onFocus={navKeys.onFocus}
        className="nav-zone scrollbar-none relative flex w-[72px] shrink-0 flex-col gap-0.5 overflow-y-auto overflow-x-hidden border-r border-[var(--c-border)] bg-[var(--c-bg)] px-1 py-2 outline-none"
      >
        {inGroup("connexions").map(renderButton)}
        <div className="mx-2.5 my-1.5 h-px shrink-0 bg-[var(--c-border)]" />
        {tools.map(renderButton)}
        <RailButton
          icon={IconActivity}
          label="Activité"
          title="Activité — commandes, opérations de flotte et enregistrements"
          active={false}
          onClick={() => onOpenActivity()}
          data-sidebar-button="activity"
        />
        <div className="mt-auto flex shrink-0 flex-col items-stretch gap-0.5 pt-2">
          {inGroup("compte").map(renderButton)}
          <RailButton
            icon={IconSettings}
            label="Réglages"
            title={["Paramètres", settingsCombo].filter(Boolean).join(" — ")}
            active={panelVisible && panel === "settings"}
            onClick={() => {
              if (panelVisible && panel === "settings") onPanelChange("hosts");
              else { onPanelChange("settings"); onPanelVisibleChange(true); }
              focusPanel();
            }}
            data-sidebar-button="settings"
          />
          {profileBarNeeded(actions.guivaultStatus) && (
            <div className="flex justify-center pt-1.5">
              <AccountMenu
                status={actions.guivaultStatus}
                syncing={actions.guivaultSyncing}
                onSwitch={(target) => {
                  if (target === "local" || target === "account") {
                    api.guivaultSwitchView(target === "local").then(actions.onGuivaultStatusChange).catch((e) => ctx.reportError(String(e)));
                  } else {
                    // Un autre compte : il faut s'y connecter, c'est le panneau
                    // GuiVault qui le propose (déconnexion du courant comprise).
                    onPanelChange("guivault");
                    onPanelVisibleChange(true);
                  }
                }}
                onSyncNow={() => api.guivaultSync().then(actions.onGuivaultStatusChange).catch((e) => ctx.reportError(String(e)))}
                onOpenGuiVault={() => { onPanelChange("guivault"); onPanelVisibleChange(true); }}
              />
            </div>
          )}
        </div>
      </nav>

      {/* Le panneau. Replié, il garde son contenu monté (largeur nulle) :
          la recherche tapée, l'arborescence dépliée survivent à un aller-
          retour. */}
      <div
        style={{ width: panelVisible ? panelWidth : 0 }}
        className={`flex shrink-0 overflow-hidden ${resizing ? "" : "transition-[width] duration-200 ease-in-out"}`}
      >
        {/* `data-sidebar-panel` : le seul point d'accroche stable pour
            vérifier en E2E que le panneau demandé rend bien quelque chose.
            Sans lui, le test devrait viser des classes utilitaires Tailwind,
            qui changent au premier ajustement de style. */}
        <div
          ref={panelRef}
          tabIndex={0}
          data-focus-zone="sidebar-panel"
          data-sidebar-panel={panel}
          onKeyDown={panelKeys.onKeyDown}
          onMouseDownCapture={panelKeys.onMouseDownCapture}
          onFocus={panelKeys.onFocus}
          className="nav-zone min-h-0 min-w-0 flex-1 overflow-hidden bg-[var(--c-bg2)] p-3 outline-none"
        >
          <Suspense fallback={<TabLoadingFallback />}>
            {renderModulePanel(panel, ctx, actions)}
          </Suspense>
        </div>
      </div>
    </aside>
  );
}
