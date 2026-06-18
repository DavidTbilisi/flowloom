// ── Guided-learning engine ──────────────────────────────────────────────────
// One overlay drives all three learning modes (UI tour, interactive lessons,
// example walkthroughs). A step optionally targets an element (spotlight + card)
// or is a centered modal. `before(ctx)` runs on entry to set up the studio;
// `gate:"valid"` steps disable Next until `validate(ctx)` passes, re-checking
// live as the user edits. Everything drives the real studio through `ctx`.

import type { Store, Tab } from "./store.js";

export interface TourCtx {
  store: Store;
  setEditor(text: string): void;
  selectLines(from: number, to: number): void;
  gotoTab(tab: Tab): void;
  setFrame(frame: number): void;
  loadExample(name: string): void;
}

export interface Step {
  title: string;
  body: string;
  /** CSS selector of the element to spotlight; omit for a centered modal. */
  target?: string;
  before?: (ctx: TourCtx) => void;
  /** When `gate` is "valid", Next is enabled only while this returns true. */
  validate?: (ctx: TourCtx) => boolean;
  gate?: "next" | "valid";
}

export type Tour = Step[];

export interface TourHandle {
  close(): void;
}

/** Start a tour. Returns a handle so callers can close it programmatically. */
export function startTour(tour: Tour, ctx: TourCtx): TourHandle {
  let i = 0;
  let unsub: (() => void) | null = null;

  const overlay = document.createElement("div");
  overlay.className = "tour-overlay";
  overlay.innerHTML = `
    <div class="tour-spot" hidden></div>
    <div class="tour-card">
      <div class="tour-head"><span class="tour-progress"></span><button class="tour-skip" title="close">✕</button></div>
      <h3 class="tour-title"></h3>
      <p class="tour-body"></p>
      <div class="tour-nav">
        <button class="tour-back ghost">Back</button>
        <button class="tour-next primary">Next</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const spot = overlay.querySelector(".tour-spot") as HTMLElement;
  const card = overlay.querySelector(".tour-card") as HTMLElement;
  const titleEl = overlay.querySelector(".tour-title") as HTMLElement;
  const bodyEl = overlay.querySelector(".tour-body") as HTMLElement;
  const progEl = overlay.querySelector(".tour-progress") as HTMLElement;
  const backBtn = overlay.querySelector(".tour-back") as HTMLButtonElement;
  const nextBtn = overlay.querySelector(".tour-next") as HTMLButtonElement;

  overlay.querySelector(".tour-skip")!.addEventListener("click", close);
  backBtn.addEventListener("click", () => go(i - 1));
  nextBtn.addEventListener("click", () => (i >= tour.length - 1 ? close() : go(i + 1)));
  window.addEventListener("resize", position);
  window.addEventListener("scroll", position, true);

  function clearWatch() {
    if (unsub) { unsub(); unsub = null; }
  }

  function refreshGate() {
    const step = tour[i]!;
    if (step.gate === "valid" && step.validate) {
      const ok = step.validate(ctx);
      nextBtn.disabled = !ok;
      nextBtn.classList.toggle("waiting", !ok);
    } else {
      nextBtn.disabled = false;
      nextBtn.classList.remove("waiting");
    }
  }

  function go(n: number) {
    clearWatch();
    i = Math.max(0, Math.min(tour.length - 1, n));
    const step = tour[i]!;
    step.before?.(ctx);

    titleEl.textContent = step.title;
    bodyEl.textContent = step.body;
    progEl.textContent = `${i + 1} / ${tour.length}`;
    backBtn.disabled = i === 0;
    nextBtn.textContent = i === tour.length - 1 ? "Done" : "Next";

    // live re-validation for gated steps
    if (step.gate === "valid" && step.validate) {
      unsub = ctx.store.subscribe(refreshGate);
    }
    refreshGate();

    // position after layout settles (before() may have switched tabs)
    requestAnimationFrame(position);
  }

  function position() {
    const step = tour[i]!;
    const targetEl = step.target ? (document.querySelector(step.target) as HTMLElement | null) : null;
    if (!targetEl) {
      spot.hidden = true;
      card.classList.add("tour-center");
      card.style.left = card.style.top = "";
      return;
    }
    const r = targetEl.getBoundingClientRect();
    const pad = 6;
    spot.hidden = false;
    spot.style.left = `${r.left - pad}px`;
    spot.style.top = `${r.top - pad}px`;
    spot.style.width = `${r.width + pad * 2}px`;
    spot.style.height = `${r.height + pad * 2}px`;

    card.classList.remove("tour-center");
    // place the card below the target if there's room, else above
    const cardH = card.offsetHeight || 160;
    const below = r.bottom + 12;
    const top = below + cardH < window.innerHeight ? below : Math.max(12, r.top - cardH - 12);
    const left = Math.min(Math.max(12, r.left), window.innerWidth - card.offsetWidth - 12);
    card.style.top = `${top}px`;
    card.style.left = `${left}px`;
  }

  function close() {
    clearWatch();
    window.removeEventListener("resize", position);
    window.removeEventListener("scroll", position, true);
    overlay.remove();
  }

  go(0);
  return { close };
}
