// Small set of minimal stroke-based line icons, used in place of emoji
// throughout the app. All icons share a 24x24 viewBox, 1.75px stroke,
// round joins - keeps them visually consistent regardless of which glyph
// they replace, unlike emoji whose weight/style varies by platform font.
const PATHS = {
  'bar-chart': 'M4 20V10 M11 20V4 M18 20v-7',
  'book-stack': 'M4 19.5V6a2 2 0 0 1 2-2h11.5v15.5H6a2 2 0 0 0-2 2Z M6 17.5h11.5',
  'book-open': 'M12 6.5c-1.6-1-4-1.5-6.5-1.5v13c2.5 0 4.9.5 6.5 1.5 1.6-1 4-1.5 6.5-1.5V5c-2.5 0-4.9.5-6.5 1.5Z M12 6.5V20',
  folder: 'M4 6.5a1.5 1.5 0 0 1 1.5-1.5h4l2 2.5h7A1.5 1.5 0 0 1 20 9v8.5A1.5 1.5 0 0 1 18.5 19h-13A1.5 1.5 0 0 1 4 17.5Z',
  plus: 'M12 5v14 M5 12h14',
  pause: 'M8 5.5v13 M16 5.5v13',
  play: 'M7 5.2v13.6l11-6.8Z',
  refresh: 'M19 6.5A7.5 7.5 0 0 0 6.3 5.2 M5 4.5v3.2h3.2 M5 17.5A7.5 7.5 0 0 0 17.7 18.8 M19 19.5v-3.2h-3.2',
  camera: 'M4 8.2A1.2 1.2 0 0 1 5.2 7h2l1-1.6h7.6L16.8 7h2A1.2 1.2 0 0 1 20 8.2v9.6A1.2 1.2 0 0 1 18.8 19H5.2A1.2 1.2 0 0 1 4 17.8Z M12 16a3.4 3.4 0 1 0 0-6.8 3.4 3.4 0 0 0 0 6.8Z',
  map: 'M9 4.5 4 6.5v13l5-2 6 2 5-2v-13l-5 2-6-2Z M9 4.5v13 M15 6.5v13',
  edit: 'M14.2 5.2 18.8 9.8 8 20.5H3.5V16Z M12.7 6.7l3.6 3.6',
  trash: 'M5.5 7.5h13 M9.5 7.5V5.2a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v2.3 M7 7.5l.8 11.3a1.2 1.2 0 0 0 1.2 1.2h6a1.2 1.2 0 0 0 1.2-1.2l.8-11.3',
  'alert-triangle': 'M12 4.5 21 19.5H3ZM12 10v4.3 M12 17.2v.1',
  check: 'M4.5 12.5 9.5 17.5 19.5 6.5',
  'check-circle': 'M20 11.1V12a8 8 0 1 1-4.7-7.3 M20 5 12 13.2 9.5 10.7',
  clock: 'M12 20a8 8 0 1 0 0-16 8 8 0 0 0 0 16Z M12 7.5V12l3 2',
  ban: 'M12 20a8 8 0 1 0 0-16 8 8 0 0 0 0 16Z M6.3 6.3l11.4 11.4',
  bell: 'M6.5 10.5a5.5 5.5 0 0 1 11 0c0 4 1.5 5.5 1.5 5.5H5s1.5-1.5 1.5-5.5Z M10.2 19a1.8 1.8 0 0 0 3.5 0',
  'bell-off': 'M6.5 10.5a5.5 5.5 0 0 1 9.4-3.9 M18 12.6c.3 1.7.9 2.5.9 2.5H8.6 M5 16h6.5 M10.2 19a1.8 1.8 0 0 0 3.5 0 M4 4l16 16',
  globe: 'M12 20a8 8 0 1 0 0-16 8 8 0 0 0 0 16Z M4.2 9.5h15.6 M4.2 14.5h15.6 M12 4a12.5 12.5 0 0 1 0 16 M12 4a12.5 12.5 0 0 0 0 16',
  download: 'M12 4.5v10.3 M8 11.3l4 4 4-4 M5 18.5h14',
  upload: 'M12 19.5V9.2 M8 12.7l4-4 4 4 M5 5.5h14',
  search: 'M11 17.5a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13Z M20 20l-4.3-4.3',
  link: 'M9.5 14.5 14.5 9.5 M8 16.2 5.7 18.5a3 3 0 0 1-4.2-4.2L4 12M16 7.8l2.3-2.3a3 3 0 0 1 4.2 4.2L20 12',
  image: 'M4.5 5.5h15v13h-15Z M8 10.2a1.4 1.4 0 1 0 0-2.8 1.4 1.4 0 0 0 0 2.8 M4.5 16.5l4.5-4.5 3 3 4-5 3.5 4',
  eye: 'M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
  tag: 'M11.3 4.5H6a1.5 1.5 0 0 0-1.5 1.5v5.3a1.5 1.5 0 0 0 .44 1.06l8 8a1.5 1.5 0 0 0 2.12 0l5.3-5.3a1.5 1.5 0 0 0 0-2.12l-8-8a1.5 1.5 0 0 0-1.06-.44Z M8.7 9a.7.7 0 1 0 0-1.4.7.7 0 0 0 0 1.4Z',
  sparkles: 'M11.5 3.5 13 8l4.5 1.5L13 11l-1.5 4.5L10 11l-4.5-1.5L10 8ZM18.5 14.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8Z',
  send: 'M20.5 3.5 3 10.2l6.6 2.6 2.6 6.6ZM20.5 3.5 12.2 12.6',
  'chevron-up': 'M6 15l6-6 6 6',
  'chevron-down': 'M6 9l6 6 6-6',
  'chevron-left': 'M15 6l-6 6 6 6',
  'chevron-right': 'M9 6l6 6-6 6',
  megaphone: 'M4 10.5v3h2.5l7 3.2V7.3l-7 3.2Zm9.5-3.2v9.4l3-1.2a5.2 5.2 0 0 0 0-7Z',
  'file-text': 'M7 3.5h7l4 4v13H7Z M14 3.5v4h4 M9.5 12.5h5 M9.5 15.5h5',
  x: 'M6 6l12 12 M18 6L6 18',
  robot: 'M8 8.2h8a2 2 0 0 1 2 2v6.6a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V10.2a2 2 0 0 1 2-2Z M12 8.2V5 M9.5 12.3v1.6 M14.5 12.3v1.6 M9.5 17.8h5',
  sun: 'M12 16.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9ZM12 2.5v2M12 19.5v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M2.5 12h2M19.5 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4',
  moon: 'M20 14.2A8.5 8.5 0 1 1 9.8 4 6.8 6.8 0 0 0 20 14.2Z',
};

export default function Icon({ name, size = 16, strokeWidth = 1.75, style, className, title }) {
  const d = PATHS[name];
  if (!d) return null;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flexShrink: 0, ...style }}
      className={className}
      role={title ? 'img' : 'presentation'}
      aria-hidden={title ? undefined : true}
    >
      {title && <title>{title}</title>}
      <path d={d} />
    </svg>
  );
}
