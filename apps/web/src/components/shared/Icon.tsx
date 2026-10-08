import React from "react";

// stroke 1.6 + round caps + currentColor — 与 design-skill icons.jsx 对齐
const ICONS: Record<string, React.ReactElement> = {
  back: <polyline points="15 6 9 12 15 18" />,
  chevDown: <polyline points="6 9 12 15 18 9" />,
  chevRight: <polyline points="9 6 15 12 9 18" />,
  chevLeft: <polyline points="15 6 9 12 15 18" />,
  close: <g><line x1="6" y1="6" x2="18" y2="18" /><line x1="6" y1="18" x2="18" y2="6" /></g>,
  plus: <g><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></g>,
  check: <polyline points="4 12 10 18 20 6" />,
  more: <g><circle cx="6" cy="12" r="1.2" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none" /><circle cx="18" cy="12" r="1.2" fill="currentColor" stroke="none" /></g>,
  grip: <g><circle cx="9" cy="7" r="1.1" fill="currentColor" stroke="none" /><circle cx="15" cy="7" r="1.1" fill="currentColor" stroke="none" /><circle cx="9" cy="12" r="1.1" fill="currentColor" stroke="none" /><circle cx="15" cy="12" r="1.1" fill="currentColor" stroke="none" /><circle cx="9" cy="17" r="1.1" fill="currentColor" stroke="none" /><circle cx="15" cy="17" r="1.1" fill="currentColor" stroke="none" /></g>,
  link: <g><path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1.06 1.06" /><path d="M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1.06-1.06" /></g>,
  image: <g><rect x="3" y="4" width="18" height="16" rx="2.5" /><circle cx="8.5" cy="9.5" r="1.5" /><polyline points="21 16 16 11 6 20" /></g>,
  video: <g><rect x="3" y="5" width="14" height="14" rx="2.5" /><path d="M17 9l4-2v10l-4-2" /></g>,
  play: <polygon points="7 5 19 12 7 19 7 5" fill="currentColor" stroke="none" />,
  pause: <g><rect x="6" y="5" width="4" height="14" fill="currentColor" stroke="none" /><rect x="14" y="5" width="4" height="14" fill="currentColor" stroke="none" /></g>,
  sparkles: <path d="M12 4v4M12 16v4M4 12h4M16 12h4M6.3 6.3l2.5 2.5M15.2 15.2l2.5 2.5M6.3 17.7l2.5-2.5M15.2 8.8l2.5-2.5" />,
  wand: <g><path d="M14 4l6 6" /><path d="M16 6l-9 9-3 3 1 1 3-3 9-9" /><path d="M19 13v3M20.5 14.5h-3M4 4v2M5 5H3" /></g>,
  refresh: <g><path d="M4 12a8 8 0 0 1 13.7-5.7L20 8" /><polyline points="20 4 20 8 16 8" /><path d="M20 12a8 8 0 0 1-13.7 5.7L4 16" /><polyline points="4 20 4 16 8 16" /></g>,
  trash: <g><polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /><path d="M10 11v6M14 11v6" /><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" /></g>,
  edit: <g><path d="M12 20h9" /><path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z" /></g>,
  filter: <polygon points="4 5 10 11 10 17 14 19 14 11 20 5 4 5" />,
  search: <g><circle cx="11" cy="11" r="7" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></g>,
  clock: <g><circle cx="12" cy="12" r="9" /><polyline points="12 7 12 12 16 14" /></g>,
  film: <g><rect x="3" y="3" width="18" height="18" rx="2.5" /><line x1="3" y1="9" x2="21" y2="9" /><line x1="3" y1="15" x2="21" y2="15" /><line x1="9" y1="3" x2="9" y2="21" /><line x1="15" y1="3" x2="15" y2="21" /></g>,
  bookmark: <path d="M6 4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v17l-6-3.5L6 21V4z" />,
  folderOpen: <g><path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v2" /><path d="M3 11h18l-2 8a2 2 0 0 1-2 1.5H6a2 2 0 0 1-2-1.5L3 11z" /></g>,
  imagePlus: <g><rect x="3" y="4" width="18" height="16" rx="2.5" /><circle cx="8.5" cy="9.5" r="1.5" /><polyline points="21 16 16 11 6 20" /><line x1="17" y1="6" x2="17" y2="12" /><line x1="14" y1="9" x2="20" y2="9" /></g>,
  checkCircle: <g><circle cx="12" cy="12" r="9" /><polyline points="8 12 11 15 16 9" /></g>,
  xCircle: <g><circle cx="12" cy="12" r="9" /><line x1="9" y1="9" x2="15" y2="15" /><line x1="15" y1="9" x2="9" y2="15" /></g>,
  map: <g><path d="M9 18l-6 3V6l6-3 6 3 6-3v15l-6 3-6-3z" /><path d="M9 3v15M15 6v15" /></g>,
  bookOpen: <g><path d="M3 4h6a3 3 0 0 1 3 3v14a3 3 0 0 0-3-3H3V4z" /><path d="M21 4h-6a3 3 0 0 0-3 3v14a3 3 0 0 1 3-3h6V4z" /></g>,
  message: <path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4v8z" />,
  heart: <path d="M20.8 5.6a5 5 0 0 0-7.1 0L12 7.3l-1.7-1.7a5 5 0 1 0-7.1 7.1L12 21l8.8-8.3a5 5 0 0 0 0-7.1z" />,
  flask: <g><path d="M9 3h6" /><path d="M10 3v5l-5.4 9.4A2.5 2.5 0 0 0 6.8 21h10.4a2.5 2.5 0 0 0 2.2-3.6L14 8V3" /><path d="M7.5 16h9" /></g>,
  package: <g><path d="M21 8l-9-5-9 5 9 5 9-5z" /><path d="M3 8v8l9 5 9-5V8" /><path d="M12 13v8" /></g>,
  moon: <path d="M21 13.2A8.5 8.5 0 0 1 10.8 3a7 7 0 1 0 10.2 10.2z" />,
  layers: <g><polygon points="12 3 2 8 12 13 22 8 12 3" /><polyline points="2 13 12 18 22 13" /><polyline points="2 18 12 23 22 18" /></g>,
  user: <g><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></g>,
  users: <g><circle cx="8" cy="7" r="3.5" /><circle cx="16" cy="7" r="3.5" /><path d="M1 21a7 7 0 0 1 14 0" /><path d="M9 21a8 8 0 0 1 14 0" /></g>,
  pin: <g><path d="M12 21l0 -4" /><path d="M8 7a4 4 0 0 1 8 0v3l2 4H6l2-4V7z" /></g>,
  spark: <path d="M12 3l1.8 5.4L19 10l-5.2 1.6L12 17l-1.8-5.4L5 10l5.2-1.6L12 3z" fill="currentColor" stroke="none" />,
  bolt: <polygon points="13 2 4 14 11 14 10 22 20 10 13 10 13 2" fill="currentColor" stroke="none" />,
  settings: <g><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></g>,
  arrowRight: <g><line x1="5" y1="12" x2="19" y2="12" /><polyline points="13 6 19 12 13 18" /></g>,
  arrowLeft: <g><line x1="19" y1="12" x2="5" y2="12" /><polyline points="11 6 5 12 11 18" /></g>,
  arrowUp: <g><line x1="12" y1="19" x2="12" y2="5" /><polyline points="5 11 12 5 19 11" /></g>,
  arrowDown: <g><line x1="12" y1="5" x2="12" y2="19" /><polyline points="5 13 12 19 19 13" /></g>,
  download: <g><path d="M12 3v12" /><polyline points="7 10 12 15 17 10" /><line x1="4" y1="20" x2="20" y2="20" /></g>,
  upload: <g><path d="M12 16V4" /><polyline points="7 9 12 4 17 9" /><line x1="4" y1="20" x2="20" y2="20" /></g>,
  save: <g><path d="M5 4h11l3 3v13H5z" /><path d="M8 4v5h7V4" /><rect x="8" y="14" width="8" height="5" rx="1" /></g>,
  help: <g><circle cx="12" cy="12" r="9" /><path d="M9.5 9a2.5 2.5 0 1 1 4 2c-.7.5-1.5 1-1.5 2" /><circle cx="12" cy="17" r="0.7" fill="currentColor" /></g>,
  warning: <g><path d="M12 3l10 17H2L12 3z" /><line x1="12" y1="10" x2="12" y2="14" /><circle cx="12" cy="17" r="0.7" fill="currentColor" /></g>,
  list: <g><line x1="8" y1="6" x2="20" y2="6" /><line x1="8" y1="12" x2="20" y2="12" /><line x1="8" y1="18" x2="20" y2="18" /><circle cx="4" cy="6" r="1" fill="currentColor" /><circle cx="4" cy="12" r="1" fill="currentColor" /><circle cx="4" cy="18" r="1" fill="currentColor" /></g>,
  grid: <g><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></g>,
  expand: <g><polyline points="4 14 4 20 10 20" /><polyline points="20 10 20 4 14 4" /><line x1="4" y1="20" x2="10" y2="14" /><line x1="14" y1="10" x2="20" y2="4" /></g>,
  compose: <g><rect x="3" y="4" width="18" height="14" rx="2" /><line x1="3" y1="8" x2="21" y2="8" /><polygon points="11 11 11 15 14 13" fill="currentColor" stroke="none" /></g>,
  eye: <g><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" /><circle cx="12" cy="12" r="3" /></g>,
  globe: <g><circle cx="12" cy="12" r="9" /><line x1="3" y1="12" x2="21" y2="12" /><path d="M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" /></g>,
  copy: <g><rect x="9" y="3" width="13" height="15" rx="2" /><path d="M5 7H4a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-1" /></g>,
  archive: <g><rect x="3" y="4" width="18" height="5" rx="1.5" /><path d="M5 9v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9" /><line x1="10" y1="13" x2="14" y2="13" /></g>,
  server: <g><rect x="3" y="3" width="18" height="7" rx="1.5" /><rect x="3" y="14" width="18" height="7" rx="1.5" /><circle cx="6.5" cy="6" r=".8" fill="currentColor" /><circle cx="6.5" cy="17" r=".8" fill="currentColor" /></g>,
  cpu: <g><rect x="4" y="4" width="16" height="16" rx="2" /><rect x="9" y="9" width="6" height="6" /><line x1="9" y1="4" x2="9" y2="2" /><line x1="15" y1="4" x2="15" y2="2" /><line x1="9" y1="22" x2="9" y2="20" /><line x1="15" y1="22" x2="15" y2="20" /><line x1="4" y1="9" x2="2" y2="9" /><line x1="4" y1="15" x2="2" y2="15" /><line x1="22" y1="9" x2="20" y2="9" /><line x1="22" y1="15" x2="20" y2="15" /></g>,
  trendUp: <g><polyline points="23 6 13.5 15.5 8.5 10.5 1 18" /><polyline points="17 6 23 6 23 12" /></g>,
  zap: <polygon points="13 2 4 14 11 14 10 22 20 10 13 10 13 2" />,
  volume: <g><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" /><path d="M15.5 8.5a5 5 0 0 1 0 7" /></g>,
  mic: <g><rect x="9" y="3" width="6" height="12" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></g>,
  music: <g><path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" /></g>,
  type: <g><polyline points="4 7 4 4 20 4 20 7" /><line x1="9" y1="20" x2="15" y2="20" /><line x1="12" y1="4" x2="12" y2="20" /></g>,
  shield: <g><path d="M12 3l8 4v5c0 5-3.5 8.5-8 9-4.5-.5-8-4-8-9V7l8-4z" /><polyline points="8 12 11 15 16 9" /></g>,
  lock: <g><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></g>,
  coin: <g><circle cx="12" cy="12" r="9" /><path d="M9.5 9.5h4a1.5 1.5 0 0 1 0 3h-3a1.5 1.5 0 0 0 0 3h4.5M12 7v2M12 15v2" /></g>,
  info: <g><circle cx="12" cy="12" r="9" /><path d="M12 10v7" /><circle cx="12" cy="7.5" r=".8" fill="currentColor" stroke="none" /></g>,
  history: <g><path d="M4 12a8 8 0 1 0 2.3-5.7" /><polyline points="4 4 6.5 6.5 4 9" /><path d="M12 7v5l3 2" /></g>,
  gitCompare: <g><circle cx="7" cy="7" r="3" /><circle cx="17" cy="17" r="3" /><path d="M7 10v2a5 5 0 0 0 5 5h2" /><path d="M17 14v-2a5 5 0 0 0-5-5h-2" /></g>,
  cut: <g><circle cx="6" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><line x1="20" y1="4" x2="8.12" y2="15.88" /><line x1="14.47" y1="14.48" x2="20" y2="20" /><line x1="8.12" y1="8.12" x2="12" y2="12" /></g>,
  circle: <circle cx="12" cy="12" r="9" />,
  monitor: <g><rect x="2" y="3" width="20" height="14" rx="2" /><line x1="8" y1="21" x2="16" y2="21" /><line x1="12" y1="17" x2="12" y2="21" /></g>,
  terminal: <g><polyline points="4 17 10 11 4 5" /><line x1="12" y1="19" x2="20" y2="19" /></g>,
  code: <g><polyline points="16 18 22 12 16 6" /><polyline points="8 6 2 12 8 18" /></g>,
  tool: <g><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" /></g>,
  undo: <g><polyline points="1 4 1 10 7 10" /><path d="M3.5 16A9 9 0 1 0 2 12" /></g>,
  slash: <line x1="6" y1="5" x2="18" y2="19" />,
  cmd: <g><path d="M8 8H6a2 2 0 0 0-2 2v4a2 2 0 0 0 2 2h2v-2H6V10h2V8z" /><path d="M16 8h2a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-2v-2h2V10h-2V8z" /><line x1="8" y1="16" x2="16" y2="16" /></g>,
  send: <g><polyline points="22 2 11 13" /><polygon points="22 2 15 22 11 13 2 9 22 2" /></g>,
  doc: <g><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" /><polyline points="14 3 14 9 20 9" /><line x1="8" y1="13" x2="16" y2="13" /><line x1="8" y1="17" x2="14" y2="17" /></g>,
  cornerDownLeft: <g><polyline points="9 10 4 15 9 20" /><path d="M20 4v7a4 4 0 0 1-4 4H4" /></g>,
  inbox: <g><polyline points="22 12 16 12 14 15 10 15 8 12 2 12" /><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" /></g>,
  home: <g><path d="M3 11l9-8 9 8" /><path d="M5 10v10h14V10" /></g>,
  gauge: <g><circle cx="12" cy="13" r="8" /><path d="M12 13l4-4" /><path d="M12 5v1M5 13h1M19 13h1M6.3 7.3l.7.7M17.7 7.3l-.7.7" /></g>,
  shot: <g><rect x="3" y="6" width="14" height="12" rx="2" /><path d="M17 10l4-2v8l-4-2" /><circle cx="10" cy="12" r="2" /></g>,
  stetho: <g><path d="M6 3v7a4 4 0 0 0 8 0V3" /><path d="M6 3h2M12 3h2" /><path d="M10 14v2a4 4 0 0 0 8 0" /><circle cx="18" cy="16" r="2" /></g>,
  stack: <g><polygon points="12 2 2 7 12 12 22 7 12 2" /><polyline points="2 17 12 22 22 17" /><polyline points="2 12 12 17 22 12" /></g>,
};

export type IconName = keyof typeof ICONS;

export interface IconProps extends Omit<React.SVGProps<SVGSVGElement>, "name"> {
  name: IconName;
  size?: number;
}

export function Icon({ name, size = 16, className = "", style = {}, strokeWidth = 1.6, ...rest }: IconProps) {
  const svgContent = ICONS[name] ?? ICONS.help;
  return (
    <svg
      {...rest}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={{ flexShrink: 0, ...style }}
    >
      {svgContent}
    </svg>
  );
}

export const iconNames = Object.keys(ICONS) as IconName[];

export default Icon;
