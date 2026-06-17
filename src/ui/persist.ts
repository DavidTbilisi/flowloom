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

/** Trigger a download of the model as a .flow file. */
export function downloadFlow(source: string, name = "model.flow"): void {
  const blob = new Blob([source], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
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
