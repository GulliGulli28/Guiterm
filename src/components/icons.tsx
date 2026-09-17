import type { CustomIcon } from "../lib/types";

type RenderFn = (size: number) => React.ReactElement;

function badge(bg: string, text: string, fg = "white"): RenderFn {
  return (size) => (
    <svg width={size} height={size} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      <rect width="24" height="24" rx="5" fill={bg} />
      <text
        x="12"
        y="16.5"
        textAnchor="middle"
        fontSize="13"
        fontWeight="700"
        fontFamily="system-ui,ui-sans-serif,sans-serif"
        fill={fg}
      >
        {text}
      </text>
    </svg>
  );
}

export interface BuiltinIconDef {
  id: string;
  name: string;
  category: "linux" | "system" | "generic";
  render: RenderFn;
}

export const BUILTIN_ICONS: BuiltinIconDef[] = [
  // ── Linux distributions ────────────────────────────────────────────────
  { id: "ubuntu", name: "Ubuntu", category: "linux", render: badge("#E95420", "U") },
  { id: "debian", name: "Debian", category: "linux", render: badge("#A81D33", "D") },
  { id: "fedora", name: "Fedora", category: "linux", render: badge("#3C6EB4", "F") },
  { id: "rhel", name: "RHEL", category: "linux", render: badge("#CC0000", "R") },
  { id: "centos", name: "CentOS", category: "linux", render: badge("#932279", "C") },
  { id: "rocky", name: "Rocky Linux", category: "linux", render: badge("#10B981", "R") },
  { id: "alma", name: "AlmaLinux", category: "linux", render: badge("#1C5687", "A") },
  {
    id: "arch",
    name: "Arch Linux",
    category: "linux",
    render: (size) => (
      <svg width={size} height={size} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
        <path d="M12 2L23 21H1L12 2Z" fill="#1793D1" />
        <path d="M12 6.5L19.5 20H4.5L12 6.5Z" fill="#16455e" />
      </svg>
    ),
  },
  { id: "alpine", name: "Alpine Linux", category: "linux", render: badge("#0D597F", "A") },
  { id: "opensuse", name: "openSUSE", category: "linux", render: badge("#73BA25", "S", "#111") },
  { id: "nixos", name: "NixOS", category: "linux", render: badge("#5277C3", "λ") },
  { id: "kali", name: "Kali Linux", category: "linux", render: badge("#268FCD", "K") },
  { id: "mint", name: "Linux Mint", category: "linux", render: badge("#87CF3E", "M", "#111") },
  { id: "rasppi", name: "Raspberry Pi", category: "linux", render: badge("#BC1142", "π") },
  { id: "pop", name: "Pop!_OS", category: "linux", render: badge("#48B9C7", "P", "#111") },

  // ── Operating systems ──────────────────────────────────────────────────
  {
    id: "windows",
    name: "Windows",
    category: "system",
    render: (size) => (
      <svg width={size} height={size} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
        <rect x="1" y="1" width="10" height="10" rx="1.5" fill="#F35325" />
        <rect x="13" y="1" width="10" height="10" rx="1.5" fill="#81BC06" />
        <rect x="1" y="13" width="10" height="10" rx="1.5" fill="#05A6F0" />
        <rect x="13" y="13" width="10" height="10" rx="1.5" fill="#FFBA08" />
      </svg>
    ),
  },
  { id: "macos", name: "macOS", category: "system", render: badge("#6B7280", "⌘") },
  { id: "freebsd", name: "FreeBSD", category: "system", render: badge("#AB2B28", "B") },

  // ── Generic icons ──────────────────────────────────────────────────────
  {
    id: "server",
    name: "Serveur",
    category: "generic",
    render: (size) => (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect x="2" y="3" width="20" height="18" rx="2" fill="#374151" />
        <rect x="5" y="6" width="14" height="4" rx="1" fill="#6B7280" />
        <rect x="5" y="13" width="14" height="4" rx="1" fill="#6B7280" />
        <circle cx="17.5" cy="8" r="1.2" fill="#34D399" />
        <circle cx="17.5" cy="15" r="1.2" fill="#34D399" />
      </svg>
    ),
  },
  {
    id: "cloud",
    name: "Cloud",
    category: "generic",
    render: (size) => (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M6.5 19h11a4.5 4.5 0 0 0 .5-8.97A6.5 6.5 0 0 0 6 8a4.5 4.5 0 0 0-.5 8.97L6.5 19Z" fill="#60A5FA" />
      </svg>
    ),
  },
  {
    id: "database",
    name: "Base de données",
    category: "generic",
    render: (size) => (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <ellipse cx="12" cy="5" rx="9" ry="3" fill="#6366F1" />
        <path d="M3 5v5c0 1.66 4.03 3 9 3s9-1.34 9-3V5" fill="#6366F1" />
        <path d="M3 10v5c0 1.66 4.03 3 9 3s9-1.34 9-3v-5" fill="#4F46E5" />
        <ellipse cx="12" cy="19" rx="9" ry="3" fill="#4338CA" />
      </svg>
    ),
  },
  { id: "network", name: "Réseau", category: "generic", render: badge("#F59E0B", "⊞") },
  { id: "docker", name: "Docker", category: "generic", render: badge("#2496ED", "D") },
  { id: "vm", name: "Machine virtuelle", category: "generic", render: badge("#7C3AED", "VM") },
  { id: "linux", name: "Linux (générique)", category: "generic", render: badge("#374151", "L") },
  { id: "router", name: "Routeur", category: "generic", render: badge("#0891B2", "R") },
];

const CATEGORY_LABELS: Record<BuiltinIconDef["category"], string> = {
  linux: "Linux",
  system: "Systèmes",
  generic: "Générique",
};

export { CATEGORY_LABELS };

/** Est-ce que cet id désigne une icône qu'on sait dessiner ici ? `false`
 * pour une icône personnalisée absente de ce workspace — un hôte arrivé
 * d'un autre profil ou d'un vault GuiVault sans son icône. Les listes s'en
 * servent pour retomber sur l'icône du genre d'hôte plutôt que de laisser
 * une case vide (bug du 2026-09-17). */
export function hasIcon(iconId: string | null | undefined, customIcons: CustomIcon[]): boolean {
  if (!iconId) return false;
  return BUILTIN_ICONS.some((i) => i.id === iconId) || customIcons.some((i) => i.id === iconId);
}

// Renders any icon by ID (builtin or custom)
export function HostIcon({
  iconId,
  customIcons,
  size = 18,
}: {
  iconId?: string | null;
  customIcons: CustomIcon[];
  size?: number;
}) {
  if (!iconId) return null;
  const builtin = BUILTIN_ICONS.find((i) => i.id === iconId);
  if (builtin) return <>{builtin.render(size)}</>;
  const custom = customIcons.find((i) => i.id === iconId);
  if (custom)
    return (
      <img
        src={custom.dataUrl}
        width={size}
        height={size}
        className="rounded object-contain"
        alt={custom.name}
      />
    );
  return null;
}
