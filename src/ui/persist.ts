// ── Model persistence & sharing ─────────────────────────────────────────────
// The model text is the whole state, so a shareable link is just the text
// encoded into the URL hash. This lets anyone (including an AI given the link)
// reconstruct the exact model. We also support downloading and loading `.flow`.

const PREFIX = "#m=";

/** UTF-8-safe base64 (btoa only handles latin1). */
function encodeText(s: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(s)));
}
function decodeText(b64: string): string {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** Read a model from the current URL hash, or null if none/invalid. */
export function readHash(): string | null {
  const h = location.hash;
  if (!h.startsWith(PREFIX)) return null;
  try {
    return decodeText(h.slice(PREFIX.length));
  } catch {
    return null;
  }
}

/** Reflect the current model into the URL hash without adding history entries. */
export function writeHash(source: string): void {
  const hash = PREFIX + encodeText(source);
  history.replaceState(null, "", location.pathname + location.search + hash);
}

/** Build a full shareable URL for the given model. */
export function shareUrl(source: string): string {
  return location.origin + location.pathname + location.search + PREFIX + encodeText(source);
}

/** Save a blob under a filename. One place owns the object-URL dance. */
export function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  // Revoking synchronously can beat the download in some browsers; a turn of
  // the event loop is enough and costs nothing.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Trigger a download of the model as a .flow file. */
export function downloadFlow(source: string, name = "model.flow"): void {
  download(new Blob([source], { type: "text/plain" }), name);
}

// ── Results and pictures ────────────────────────────────────────────────────
// The model text could always leave (download, link, clipboard); the *results*
// could not. A run you cannot put in a spreadsheet, and a diagram you cannot
// paste into a document, are a dead end at exactly the point the work becomes
// worth showing someone.

/** A filename stem from the model's first comment or first stock, else "model". */
export function modelSlug(source: string): string {
  const head = source.split(/\r?\n/).find((l) => l.trim().startsWith("#"))?.replace(/^#+\s*/, "")
    ?? source.match(/^\s*stock\s+([A-Za-z_]\w*)/m)?.[1]
    ?? "model";
  const slug = head.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48);
  return slug || "model";
}

/** Every visible series of a run as CSV, time first. */
export function resultCsv(
  t: number[],
  series: Map<string, number[]>,
  names: string[],
): string {
  const cols = names.filter((n) => series.has(n));
  const rows = [["t", ...cols].join(",")];
  for (let i = 0; i < t.length; i++) {
    rows.push([t[i]!, ...cols.map((n) => series.get(n)![i] ?? "")].join(","));
  }
  return `${rows.join("\n")}\n`;
}

/** Save a canvas as a PNG. Rejects if the browser refuses to encode it. */
export async function downloadCanvasPng(canvas: HTMLCanvasElement, name: string): Promise<void> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("the browser could not encode this canvas as a PNG");
  download(blob, name);
}

/**
 * Serialize a live `<svg>` as a standalone file.
 *
 * diagram.ts resolves every colour through `cssVar()` when it builds the markup,
 * so the shapes already carry literal fills and travel fine — the two things
 * `outerHTML` leaves behind are the namespace declaration a standalone file
 * needs and the page background the diagram was drawn against, which is the
 * difference between a readable picture and dark-on-dark.
 */
export function svgMarkup(svg: SVGSVGElement, background: string): string {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  const box = svg.getBoundingClientRect();
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("width", String(Math.round(box.width) || 800));
  clone.setAttribute("height", String(Math.round(box.height) || 600));
  clone.setAttribute("style", `background: ${background}`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n${clone.outerHTML}`;
}

/** Wire drag-and-drop of a .flow/.txt file onto an element. */
export function enableDropLoad(el: HTMLElement, onLoad: (text: string) => void): void {
  const stop = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
  };
  el.addEventListener("dragover", stop);
  el.addEventListener("drop", (e) => {
    stop(e);
    const file = (e as DragEvent).dataTransfer?.files?.[0];
    if (file) file.text().then(onLoad);
  });
}

// ── Autosave and recents ────────────────────────────────────────────────────
// The URL hash carries the model, so a *shared* link survives — but a plain
// reload of a tab that was never shared did not, and the only history was
// whatever the browser happened to keep. Two small stores fix that without
// pretending to be a file system: the working text, and the models you had open.

const AUTOSAVE = "flowloom.autosave";
const RECENTS = "flowloom.recents";
const MAX_RECENTS = 8;
/** Well under the ~5 MB localStorage budget, and past any hand-written model. */
const MAX_SAVE = 256 * 1024;

export interface Recent {
  /** Display name, from the model's first comment or first stock. */
  name: string;
  source: string;
  /** Epoch ms, for ordering and for "2 minutes ago". */
  at: number;
}

/** Remember the working text so a reload does not lose it. */
export function saveAutosave(source: string): void {
  try {
    if (source.length > MAX_SAVE) return;
    localStorage.setItem(AUTOSAVE, source);
  } catch { /* private mode, or a full quota — autosave is a convenience */ }
}

export function readAutosave(): string | null {
  try { return localStorage.getItem(AUTOSAVE); } catch { return null; }
}

export function clearAutosave(): void {
  try { localStorage.removeItem(AUTOSAVE); } catch { /* ignore */ }
}

export function readRecents(): Recent[] {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENTS) ?? "[]") as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.filter((r): r is Recent =>
      !!r && typeof (r as Recent).source === "string" && typeof (r as Recent).name === "string");
  } catch { return []; }
}

/**
 * Record a model in the recents list, most recent first.
 *
 * Keyed by *text*, so re-opening the same model moves it up rather than
 * duplicating it. Callers push only when a different model is adopted — never
 * on every edit, or a single session would fill the list with eight
 * near-identical snapshots of one model.
 */
export function pushRecent(source: string): void {
  const trimmed = source.trim();
  if (!trimmed || trimmed.length > MAX_SAVE) return;
  try {
    const list = readRecents().filter((r) => r.source !== trimmed);
    list.unshift({ name: modelSlug(trimmed).replace(/-/g, " "), source: trimmed, at: Date.now() });
    localStorage.setItem(RECENTS, JSON.stringify(list.slice(0, MAX_RECENTS)));
  } catch { /* ignore */ }
}

export function clearRecents(): void {
  try { localStorage.removeItem(RECENTS); } catch { /* ignore */ }
}
