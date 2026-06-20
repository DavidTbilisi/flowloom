// ── Editor: syntax-highlight overlay + token hover ──────────────────────────
// A plain <textarea> can't tag its tokens, so we use the classic backdrop
// technique: a <pre> sits exactly behind a transparent-text textarea and paints
// the colored tokens. The same spans drive contextual help — on mousemove we
// hit-test their rects (we can't use pointer-events, because the textarea must
// keep every click and keystroke). Keyboard users get help from the caret too.

import type { Store } from "./store.js";
import { tokenizeSource, tokenAt, type Tok } from "./highlight.js";
import { resolveHelp, type HelpEntry } from "./help-content.js";

export interface Editor {
  textarea: HTMLTextAreaElement;
  /** Re-highlight from the textarea's current value (after programmatic edits). */
  refresh(): void;
  /** Set the text and re-highlight (does not fire `input`). */
  setValue(text: string): void;
  /** Focus and select 1-based line range [from, to], scrolling it into view. */
  selectLines(from: number, to: number): void;
}

export function mountEditor(
  wrap: HTMLElement,
  textarea: HTMLTextAreaElement,
  store: Store,
  setHelp: (e: HelpEntry | null) => void,
): Editor {
  // backdrop <pre> behind the (now transparent-text) textarea
  const pre = document.createElement("pre");
  pre.id = "hl";
  pre.setAttribute("aria-hidden", "true");
  wrap.insertBefore(pre, textarea);
  textarea.classList.add("transparent-text");

  let toks: Tok[] = [];

  function refresh(): void {
    toks = tokenizeSource(textarea.value);
    // Build one <div class="ln"> per logical line so a CSS counter can paint the
    // gutter number; wrapping a line keeps its number top-aligned. Only `ws`
    // tokens can straddle a newline, so they're the only ones we split.
    const lines: string[] = [""];
    for (const t of toks) {
      if (t.kind === "ws" && t.text.includes("\n")) {
        const parts = t.text.split("\n");
        lines[lines.length - 1] += esc(parts[0]!);
        for (let k = 1; k < parts.length; k++) lines.push(esc(parts[k]!));
      } else {
        lines[lines.length - 1] += tokenHtml(t);
      }
    }
    pre.innerHTML = lines.map((h) => `<div class="ln">${h}</div>`).join("");
    syncScroll();
  }

  function tokenHtml(t: Tok): string {
    const body = esc(t.text);
    if (t.kind === "ws" || t.kind === "punct" || t.kind === "op") return body;
    const attrs = t.helpKey
      ? ` data-help="${esc(t.helpKey)}"${t.helpKey.startsWith("ident:") ? ` data-name="${esc(t.text)}"` : ""}`
      : "";
    return `<span class="tok-${t.kind}"${attrs}>${body}</span>`;
  }

  function syncScroll(): void {
    pre.scrollTop = textarea.scrollTop;
    pre.scrollLeft = textarea.scrollLeft;
  }

  function setValue(text: string): void {
    textarea.value = text;
    refresh();
  }

  function selectLines(from: number, to: number): void {
    const lines = textarea.value.split("\n");
    let start = 0;
    for (let i = 0; i < from - 1 && i < lines.length; i++) start += lines[i]!.length + 1;
    let end = start;
    for (let i = from - 1; i < to && i < lines.length; i++) end += lines[i]!.length + 1;
    textarea.focus();
    textarea.setSelectionRange(start, Math.max(start, end - 1));
    // scroll the selection roughly into view
    const lineH = textarea.scrollHeight / Math.max(1, lines.length);
    textarea.scrollTop = Math.max(0, (from - 2) * lineH);
    syncScroll();
  }

  // ── token hover (manual hit-test of the laid-out spans) ──
  let pending = false;
  let lastX = 0;
  let lastY = 0;
  wrap.addEventListener("mousemove", (e) => {
    lastX = e.clientX;
    lastY = e.clientY;
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      const span = hitTest(lastX, lastY);
      setHelp(span ? resolveHelp(span.dataset.help!, store) : null);
    });
  });
  wrap.addEventListener("mouseleave", () => setHelp(null));

  function hitTest(x: number, y: number): HTMLElement | null {
    const spans = pre.querySelectorAll<HTMLElement>("[data-help]");
    for (const s of spans) {
      const r = s.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return s;
    }
    return null;
  }

  // ── caret-based help (keyboard users) ──
  const caretHelp = () => {
    const tok = tokenAt(toks, textarea.selectionStart);
    if (tok) setHelp(resolveHelp(tok.helpKey!, store));
  };
  textarea.addEventListener("keyup", caretHelp);
  textarea.addEventListener("select", caretHelp);

  textarea.addEventListener("input", refresh);
  textarea.addEventListener("scroll", syncScroll);

  refresh();
  return { textarea, refresh, setValue, selectLines };
}

function esc(s: string): string {
  return s.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c]!);
}
