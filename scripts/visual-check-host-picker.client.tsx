// Rend un vrai `HostTreePicker` dans le navigateur, sans Tauri : le composant
// ne parle à personne d'autre qu'à son `onChange`. Piloté par
// `visual-check-host-picker.mjs`, qui ouvre la liste et mesure ce qui est
// réellement dessiné — indentation, pastilles de tags, filtrage.
//
// Ni `tsc` ni vitest ne peuvent voir ça : « l'arborescence est visible » est
// une affirmation sur des pixels (un dossier enfant décalé vers la droite,
// une pastille qui a une largeur) et sur un composant qui ne s'ouvre qu'au
// clic. Le même montage que `visual-check-transfer-columns`.
import { createRoot } from "react-dom/client";
import { HostTreePicker } from "../src/components/HostTreePicker";
import type { Group, GroupId, Host, HostId } from "../src/lib/types";
import { IconTerminal } from "../src/components/ui-icons";
import "../src/index.css";

const groups: Group[] = [
  { id: "g-prod" as GroupId, name: "Prod", parentId: null },
  { id: "g-web" as GroupId, name: "Web", parentId: "g-prod" as GroupId },
  { id: "g-lab" as GroupId, name: "Labo", parentId: null },
];

function host(id: string, label: string, groupId: string | null, tags: string[]): Host {
  return {
    id: id as HostId,
    label,
    address: `${id}.exemple.fr`,
    port: 22,
    username: "root",
    auth: "agent",
    groupId: groupId as GroupId | null,
    jumpVia: [],
    tags,
    startupSnippets: [],
    envVars: [],
  } as unknown as Host;
}

// Deux machines **au même libellé** dans deux dossiers différents : le cas
// que la liste plate rendait indiscernable.
const hosts: Host[] = [
  host("h-api-prod", "api", "g-web", ["prod", "eu-west"]),
  host("h-api-lab", "api", "g-lab", ["bac-a-sable"]),
  host("h-racine", "sans-dossier", null, []),
];

const root = createRoot(document.getElementById("host")!);
let picked: string | null = null;

function render() {
  root.render(
    <HostTreePicker
      hosts={hosts}
      groups={groups}
      customIcons={[]}
      value={picked}
      onChange={(v) => { picked = v; render(); }}
      specials={[{ value: "local", label: "Local", hint: "Cette machine", icon: <IconTerminal size={12} /> }]}
    />,
  );
}
render();

declare global {
  interface Window {
    __pickerState: () => { picked: string | null };
  }
}
window.__pickerState = () => ({ picked });
