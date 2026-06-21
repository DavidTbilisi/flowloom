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

/** Apply the saved theme (default dark) at boot and return it. */
export function initTheme(): Theme {
  let t: Theme = "dark";
  try { if (localStorage.getItem(STORE) === "light") t = "light"; } catch { /* ignore */ }
  document.documentElement.setAttribute("data-theme", t);
  return t;
}
