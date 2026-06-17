// ── Contextual help status bar ──────────────────────────────────────────────
// One persistent bar pinned to the bottom of the window. It shows a one-line
// explanation of whatever the mouse is over. Most of the app feeds it through a
// single delegated mousemove listener that reads `data-help` off the nearest
// ancestor (HTML or SVG); the editor feeds it directly (it hit-tests its own
// token spans). When nothing is hovered it rotates a few gentle tips.

import type { Store } from "./store.js";
import { resolveHelp, type HelpEntry } from "./help-content.js";

const TIPS = [
  "Hover any keyword, node, or control for an explanation.",
  "The text is the model — diagram, plots, and loops are derived from it.",
  "Press the Learn button for a guided tour, lessons, and walkthroughs.",
  "Edit and it re-runs automatically · ⌘/Ctrl + Enter runs now.",
];

export interface StatusBar {
  el: HTMLElement;
  setHelp(entry: HelpEntry | null): void;
}

/**
 * Build the status bar and install the global hover delegation.
 * @param onLearnMore called when the user clicks "Learn more ›" (opens Format).
 */
export function mountStatusBar(
  root: HTMLElement,
  store: Store,
  onLearnMore: (anchor: string) => void,
): StatusBar {
  const el = root.querySelector("#statusbar") as HTMLElement;
  el.innerHTML = `<span class="sb-icon">ⓘ</span><span class="sb-text"></span><a class="sb-more" href="#" hidden>Learn more ›</a>`;
  const textEl = el.querySelector(".sb-text") as HTMLElement;
  const moreEl = el.querySelector(".sb-more") as HTMLAnchorElement;
  let curDoc: string | null = null;

  moreEl.addEventListener("click", (e) => {
    e.preventDefault();
    if (curDoc) onLearnMore(curDoc);
  });

  // idle tip rotation
  let tip = 0;
  const showTip = () => {
    textEl.textContent = TIPS[tip % TIPS.length]!;
    el.classList.remove("sb-active");
    moreEl.hidden = true;
    curDoc = null;
  };
  showTip();
  const tipTimer = window.setInterval(() => {
    if (!el.classList.contains("sb-active")) {
      tip++;
      showTip();
    }
  }, 7000);
  void tipTimer; // lives for the app's lifetime

  function setHelp(entry: HelpEntry | null): void {
    if (!entry) {
      showTip();
      return;
    }
    el.classList.add("sb-active");
    textEl.innerHTML = `<b class="sb-title">${esc(entry.title)}</b><span class="sb-body">${esc(entry.body)}</span>`;
    curDoc = entry.doc ?? null;
    moreEl.hidden = !curDoc;
  }

  // ── global hover delegation ──
  // The editor owns its own region (it hit-tests token spans), so skip it here.
  let pending = false;
  let lastTarget: Element | null = null;
  root.addEventListener("mousemove", (e) => {
    const target = e.target as Element | null;
    if (target === lastTarget) return;
    lastTarget = target;
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      if (!target || !target.isConnected) return;
      if (target.closest(".editor-wrap")) return; // editor drives the bar itself
      const host = target.closest<HTMLElement>("[data-help]");
      if (!host) {
        setHelp(null);
        return;
      }
      const key = host.dataset.help!;
      const name = host.dataset.name;
      // a named element (e.g. a diagram node) prefers its live identifier help,
      // falling back to the generic chrome entry.
      const entry =
        (name ? resolveHelp(`ident:${name}`, store) : null) ?? resolveHelp(key, store);
      setHelp(entry);
    });
  });

  return { el, setHelp };
}

function esc(s: string): string {
  return s.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c]!);
}
