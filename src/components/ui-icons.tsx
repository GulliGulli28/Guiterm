type P = { size?: number; className?: string };

export function IconHosts({ size = 16, className }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className}>
      <rect x="1" y="2" width="14" height="5" rx="1.5" stroke="currentColor" strokeWidth="1.25" />
      <rect x="1" y="9" width="14" height="5" rx="1.5" stroke="currentColor" strokeWidth="1.25" />
      <circle cx="12.5" cy="4.5" r="1" fill="currentColor" />
      <circle cx="12.5" cy="11.5" r="1" fill="currentColor" />
    </svg>
  );
}

export function IconSnippets({ size = 16, className }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className}>
      <path d="M5.5 5L2.5 8L5.5 11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M10.5 5L13.5 8L10.5 11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M9 3L7 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

export function IconTunnels({ size = 16, className }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className}>
      <circle cx="2.5" cy="8" r="1.5" stroke="currentColor" strokeWidth="1.25" />
      <circle cx="13.5" cy="8" r="1.5" stroke="currentColor" strokeWidth="1.25" />
      <path d="M4 8h3.5M8.5 8H12" stroke="currentColor" strokeWidth="1.25" strokeDasharray="1.5 1.5" strokeLinecap="round" />
      <path d="M11 6.5l2 1.5-2 1.5" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function IconKeychain({ size = 16, className }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className}>
      <circle cx="5.5" cy="7" r="3.5" stroke="currentColor" strokeWidth="1.25" />
      <path d="M9 7h5" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
      <path d="M12 7v2M14 7v2" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
    </svg>
  );
}

export function IconSettings({ size = 16, className }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className}>
      {[0, 60, 120, 180, 240, 300].map((angle) => (
        <rect
          key={angle}
          x="7.05"
          y="0.6"
          width="1.9"
          height="2.9"
          rx="0.7"
          fill="currentColor"
          transform={`rotate(${angle} 8 8)`}
        />
      ))}
      <circle cx="8" cy="8" r="3.1" stroke="currentColor" strokeWidth="1.25" fill="none" />
      <circle cx="8" cy="8" r="1.15" fill="currentColor" />
    </svg>
  );
}

export function IconTerminal({ size = 16, className }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className}>
      <path d="M3 5l3.5 3L3 11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M9 11h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

export function IconTransfer({ size = 16, className }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className}>
      <path d="M2 4.5C2 3.67 2.67 3 3.5 3H6l1.5 2H12.5c.83 0 1.5.67 1.5 1.5v5c0 .83-.67 1.5-1.5 1.5h-9C2.67 13 2 12.33 2 11.5V4.5Z" stroke="currentColor" strokeWidth="1.25" />
      <path d="M8 7v4M6 9.5L8 11.5 10 9.5" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function IconMonitor({ size = 16, className }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className}>
      <rect x="2" y="2" width="12" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.25" />
      <path d="M5 14h6M8 11v3" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
    </svg>
  );
}

export function IconDotsVertical({ size = 16, className }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" className={className}>
      <circle cx="8" cy="4" r="1.25" />
      <circle cx="8" cy="8" r="1.25" />
      <circle cx="8" cy="12" r="1.25" />
    </svg>
  );
}

export function IconPlus({ size = 16, className }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className}>
      <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

export function IconKeyboard({ size = 16, className }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className}>
      <rect x="1.5" y="4" width="13" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.25" />
      <path d="M4 7h1M7 7h1M10 7h1M4 10h8" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
    </svg>
  );
}

export function IconSplit({ size = 16, className }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className}>
      <rect x="1.5" y="2" width="13" height="12" rx="1.5" stroke="currentColor" strokeWidth="1.25" />
      <path d="M8 2v12" stroke="currentColor" strokeWidth="1.25" />
    </svg>
  );
}

export function IconClose({ size = 16, className }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className}>
      <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

export function IconEdit({ size = 16, className }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className}>
      <path d="M10.5 3.5l2 2L5 13H3v-2l7.5-7.5Z" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round" />
    </svg>
  );
}

export function IconTrash({ size = 16, className }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className}>
      <path d="M3 5h10M6 5V3.5h4V5" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M5.5 5l.5 7.5h5L12 5" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function IconUpload({ size = 16, className }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className}>
      <path d="M8 10V3M5 6L8 3l3 3" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M3 11v2h10v-2" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
    </svg>
  );
}

export function IconDownload({ size = 16, className }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className}>
      <path d="M8 3v7M5 7.5L8 10.5l3-3" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M3 11v2h10v-2" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
    </svg>
  );
}

export function IconFolder({ size = 16, className }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className}>
      <path d="M2 4.5C2 3.67 2.67 3 3.5 3H6l1.5 2H12.5c.83 0 1.5.67 1.5 1.5v5c0 .83-.67 1.5-1.5 1.5h-9C2.67 13 2 12.33 2 11.5V4.5Z" stroke="currentColor" strokeWidth="1.25" />
    </svg>
  );
}

export function IconChevronDown({ size = 16, className }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className}>
      <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function IconChevronRight({ size = 16, className }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className}>
      <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function IconFlash({ size = 16, className }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" className={className}>
      <path d="M9 1.5L4 9h4.5L6 14.5l7.5-7.5H9V1.5Z" />
    </svg>
  );
}

export function IconSearch({ size = 16, className }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className}>
      <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.25" />
      <path d="M11 11l3 3" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
    </svg>
  );
}

export function IconPlay({ size = 16, className }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" className={className}>
      <path d="M5 3.5l8 4.5-8 4.5V3.5Z" />
    </svg>
  );
}

export function IconPalette({ size = 16, className }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className}>
      <path d="M8 1.5c-3.6 0-6.5 2.75-6.5 6.15 0 2.55 2 3.85 3.6 3.85.75 0 .95-.4.95-.85s-.25-.65-.25-1.2c0-.55.45-1 1.05-1h1.6c2 0 3.55-1.4 3.55-3.5 0-2.4-1.9-3.45-4-3.45Z" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round" />
      <circle cx="4.6" cy="7.4" r="0.75" fill="currentColor" />
      <circle cx="6.4" cy="4.9" r="0.75" fill="currentColor" />
      <circle cx="9.6" cy="4.9" r="0.75" fill="currentColor" />
      <circle cx="11.2" cy="7.4" r="0.75" fill="currentColor" />
    </svg>
  );
}

export function IconShield({ size = 16, className }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className}>
      <path d="M8 1.5l5.5 2v4c0 3.5-2.3 5.9-5.5 7-3.2-1.1-5.5-3.5-5.5-7v-4L8 1.5Z" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round" />
      <path d="M5.8 8l1.6 1.6 2.8-3.2" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function IconSun({ size = 16, className }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className}>
      <circle cx="8" cy="8" r="3" stroke="currentColor" strokeWidth="1.25" />
      <path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.2 3.2l1.1 1.1M11.7 11.7l1.1 1.1M3.2 12.8l1.1-1.1M11.7 4.3l1.1-1.1" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
    </svg>
  );
}

export function IconMoon({ size = 16, className }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className}>
      <path d="M13.5 9.8A5.8 5.8 0 0 1 6.2 2.5a5.8 5.8 0 1 0 7.3 7.3Z" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round" />
    </svg>
  );
}

export function IconBell({ size = 16, className }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className}>
      <path d="M8 2.5c-2 0-3.25 1.5-3.25 3.75v1.5c0 .9-.35 1.75-1 2.4l-.5.5h9.5l-.5-.5c-.65-.65-1-1.5-1-2.4v-1.5C11.25 4 10 2.5 8 2.5Z" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round" />
      <path d="M6.5 12.5a1.5 1.5 0 0 0 3 0" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
    </svg>
  );
}

export function IconBroadcast({ size = 16, className }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className}>
      <circle cx="8" cy="8" r="1.5" fill="currentColor" />
      <path d="M5.5 5.5a3.6 3.6 0 0 0 0 5" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
      <path d="M10.5 5.5a3.6 3.6 0 0 1 0 5" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
      <path d="M3.2 3.2a6.6 6.6 0 0 0 0 9.6" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
      <path d="M12.8 3.2a6.6 6.6 0 0 1 0 9.6" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
    </svg>
  );
}

export function IconRefresh({ size = 16, className }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className}>
      <path d="M2.5 8a5.5 5.5 0 0 1 9.3-4" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
      <path d="M13.5 8a5.5 5.5 0 0 1-9.3 4" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
      <path d="M11.5 2.5v2.5H9" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M4.5 13.5V11H7" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
