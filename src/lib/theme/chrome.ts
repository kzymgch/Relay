// Chrome palette: every colour outside the xterm canvas.
//
// `applyChromePalette(palette)` writes each slot to a `--relay-*` custom
// property on `document.documentElement`. All component CSS files reference
// these tokens via `var(--relay-…)`, so swapping the palette repaints the
// entire app chrome in one assignment without a Svelte rerender.

export interface ChromePalette {
  /** Page background behind the toolbar. */
  appBg: string;
  /** Top toolbar background. */
  toolbarBg: string;
  /** Toolbar border bottom. */
  toolbarBorder: string;
  /** Toolbar text + icon colour. */
  toolbarFg: string;
  /** Pane container background (visible only briefly while xterm boots). */
  paneBg: string;
  /** Default pane outline. */
  paneBorder: string;
  /** Pane outline when focused. */
  paneBorderFocused: string;
  /** Pane header background. */
  paneHeaderBg: string;
  /** Pane header text + buttons. */
  paneHeaderFg: string;
  /** Highlight applied while a DnD payload hovers a pane. */
  dropHighlight: string;
  /** Status indicator colours. */
  statusRunning: string;
  statusSpawning: string;
  statusExited: string;
  statusError: string;
  /** Modal backdrop overlay. */
  modalBackdrop: string;
  /** Modal body background. */
  modalBg: string;
  /** Modal text colour. */
  modalFg: string;
  /** Command palette body background. */
  paletteBg: string;
  /** Highlight bar in the palette list. */
  paletteHighlight: string;
  /** Bottom status bar background. */
  statusBarBg: string;
  /** Bottom status bar text. */
  statusBarFg: string;
}

/** All chrome slot ids, used to iterate when writing CSS variables. */
export const CHROME_SLOTS: readonly (keyof ChromePalette)[] = [
  "appBg",
  "toolbarBg",
  "toolbarBorder",
  "toolbarFg",
  "paneBg",
  "paneBorder",
  "paneBorderFocused",
  "paneHeaderBg",
  "paneHeaderFg",
  "dropHighlight",
  "statusRunning",
  "statusSpawning",
  "statusExited",
  "statusError",
  "modalBackdrop",
  "modalBg",
  "modalFg",
  "paletteBg",
  "paletteHighlight",
  "statusBarBg",
  "statusBarFg",
];

/**
 * Camel-case slot id → `--relay-kebab-case` CSS custom property name.
 * Exported so tests can assert the exact variable names.
 */
export function cssVarName(slot: keyof ChromePalette): string {
  return `--relay-${slot.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
}

/**
 * Apply a chrome palette to the document root. Subsequent calls overwrite the
 * same variables, so the document only ever holds one palette at a time.
 */
export function applyChromePalette(
  palette: ChromePalette,
  target: HTMLElement = document.documentElement
): void {
  for (const slot of CHROME_SLOTS) {
    target.style.setProperty(cssVarName(slot), palette[slot]);
  }
}
