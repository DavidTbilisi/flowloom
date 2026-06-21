import { describe, it, expect, vi, beforeEach } from "vitest";

// CONTRACT: the theme is the single source of truth for the canvas/SVG layers
// too — applyTheme flips the <html> data-theme attribute and clears the cssVar
// cache so plot.ts/diagram.ts repaint from the new palette. (jsdom-free: stub
// the tiny DOM surface theme.ts touches.)

const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  vi.resetModules();
  const root: Record<string, unknown> = {
    _attrs: {} as Record<string, string>,
    setAttribute(k: string, v: string) { (this._attrs as Record<string, string>)[k] = v; },
    getAttribute(k: string) { return (this._attrs as Record<string, string>)[k] ?? null; },
  };
  (globalThis as unknown as { document: unknown }).document = { documentElement: root };
  (globalThis as unknown as { localStorage: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  };
  (globalThis as unknown as { getComputedStyle: unknown }).getComputedStyle = () => ({
    getPropertyValue: () => "#abcdef",
  });
});

describe("theme", () => {
  it("defaults to dark and persists a switch to light", async () => {
    const { initTheme, applyTheme, currentTheme } = await import("../../src/ui/theme.js");
    expect(initTheme()).toBe("dark");
    applyTheme("light");
    expect(currentTheme()).toBe("light");
    expect(store.get("flowloom.theme")).toBe("light");
  });

  it("restores the saved theme on boot", async () => {
    store.set("flowloom.theme", "light");
    const { initTheme } = await import("../../src/ui/theme.js");
    expect(initTheme()).toBe("light");
  });

  it("cssVar resolves a custom property (and never returns empty)", async () => {
    const { cssVar } = await import("../../src/ui/theme.js");
    expect(cssVar("--ink")).toBe("#abcdef");
  });
});
