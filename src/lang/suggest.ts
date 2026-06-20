// ── "Did you mean?" — nearest-name suggestions ──────────────────────────────
// A tiny edit-distance matcher used to enrich "unknown name" diagnostics. It
// lives in src/lang (not the engine) so the parser can reach it without the
// lower layer depending on the engine — and so every consumer (CLI, MCP, and
// the studio editor) gets the suggestion straight from the diagnostic message.

/** Levenshtein edit distance between two short identifiers. */
export function editDistance(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
    }
    prev = cur;
  }
  return prev[n]!;
}

/**
 * The closest candidate to `name`, or undefined if nothing is plausibly close.
 * A case-only difference always wins (a common LLM typo: birthrate vs birthRate);
 * otherwise the edit distance must be small relative to the word length, so we
 * don't suggest wild guesses.
 */
export function suggestName(name: string, candidates: Iterable<string>): string | undefined {
  const lower = name.toLowerCase();
  let best: string | undefined;
  let bestD = Infinity;
  for (const c of candidates) {
    if (c === name) continue;
    if (c.toLowerCase() === lower) return c; // case-only — the strongest signal
    const d = editDistance(name, c);
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  if (best === undefined) return undefined;
  const max = Math.max(1, Math.floor(name.length / 3)); // ~one edit per three characters
  return bestD <= max ? best : undefined;
}

/**
 * The actionable suffix for an "unknown X" diagnostic: a `— did you mean 'Y'?`
 * when a candidate is close, otherwise `— <fallback>`. The point is that a
 * blocking diagnostic is never a dead end — an agent (or a person) always gets a
 * next move, whether the mistake was a typo or a name it simply has to define.
 */
export function suggestSuffix(name: string, candidates: Iterable<string>, fallback: string): string {
  const hint = suggestName(name, candidates);
  return hint ? ` — did you mean '${hint}'?` : ` — ${fallback}`;
}
