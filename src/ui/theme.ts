// ── Theme (dark / light) ─────────────────────────────────────────────────────
// One palette, two themes. The CSS custom properties on <html> are the single
// source of truth; the CSS uses them directly and the canvas/SVG layers read
// them through cssVar() — so a theme switch repaints the editor, plot, and
// diagram from the same values, with no second palette to keep in sync.

export type Theme = "dark" | "light";
const STORE = "flowloom.theme";
let cache = new Map<string, string>();

/** Current value of a CSS custom property (e.g. "--ink"), cached until the theme
 *  changes. Lets plot.ts / diagram.ts paint from the same palette as the CSS. */
export function cssVar(name: string): string {
  let v = cache.get(name);
  if (v === undefined) {
    try { v = getComputedStyle(document.documentElement).getPropertyValue(name).trim(); } catch { v = ""; }
    if (!v) v = "#888";
    cache.set(name, v);
  }
  return v;
}

export function currentTheme(): Theme {
  return document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
}

export function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute("data-theme", theme);
  cache = new Map(); // palette changed — re-read lazily on the next paint
  try { localStorage.setItem(STORE, theme); } catch { /* ignore */ }
}

/** The theme the operating system is asking for, when it says. */
function systemTheme(): Theme {
  try { return matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark"; } catch { return "dark"; }
}

/**
 * Apply the theme at boot and return it.
 *
 * A stored choice always wins — it is the user telling us directly. Absent one,
 * the system preference decides, and the app keeps following it until the user
 * makes a choice: someone whose machine switches to light at sunrise should not
 * have to find the toggle every morning. `applyTheme` writes the choice, which
 * is what ends the following.
 */
export function initTheme(): Theme {
  let stored: string | null = null;
  try { stored = localStorage.getItem(STORE); } catch { /* ignore */ }
  const t: Theme = stored === "light" || stored === "dark" ? stored : systemTheme();
  document.documentElement.setAttribute("data-theme", t);
  if (!stored) {
    try {
      matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => {
        let chosen: string | null = null;
        try { chosen = localStorage.getItem(STORE); } catch { /* ignore */ }
        if (chosen) return; // the user has since decided; stop following
        document.documentElement.setAttribute("data-theme", systemTheme());
        cache = new Map();
        onChange?.();
      });
    } catch { /* no matchMedia — stay put */ }
  }
  return t;
}

let onChange: (() => void) | undefined;

/** Called when the *system* theme changes while we are following it, so the
 *  canvas layers (which cache their colours) can repaint. */
export function onThemeChange(fn: () => void): void {
  onChange = fn;
}
