// ── AI draft: prose → .flow ──────────────────────────────────────────────────
// The headline AI-first feature: describe a system in English and Claude writes
// a runnable .flow model. flowloom's clean text format is the ideal LLM target
// (no diagram XML to hallucinate), and the model it emits is *checked and run* by
// the same engine the rest of the app uses — so the AI's output is verifiable,
// not a vibe. Bring-your-own Anthropic key (stored locally, sent only to
// Anthropic); the app is fully functional without it, so this stays optional and
// keeps flowloom dependency-free — a raw fetch, no SDK in the browser bundle.

const KEY_STORE = "flowloom.anthropicKey";
const MODEL_STORE = "flowloom.aiModel";
const ENDPOINT = "https://api.anthropic.com/v1/messages";

/** The models offered in the picker. First is the default. */
export const MODELS = [
  { id: "claude-opus-5", label: "Opus 5 — most capable" },
  { id: "claude-sonnet-5", label: "Sonnet 5 — faster" },
  { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5 — fastest" },
] as const;

export const DEFAULT_MODEL = MODELS[0].id;

/** A whole model is easily more than 2,000 tokens, and a truncated draft fails
 *  to parse mid-line — which reads as "the AI is bad at this" rather than "we
 *  cut it off". Streaming is what makes a budget this size safe to ask for. */
const MAX_TOKENS = 16_000;

export function getStoredKey(): string {
  try { return localStorage.getItem(KEY_STORE) ?? ""; } catch { return ""; }
}
export function setStoredKey(key: string): void {
  try { key ? localStorage.setItem(KEY_STORE, key) : localStorage.removeItem(KEY_STORE); } catch { /* ignore */ }
}
export function getStoredModel(): string {
  try {
    const id = localStorage.getItem(MODEL_STORE);
    return MODELS.some((m) => m.id === id) ? id! : DEFAULT_MODEL;
  } catch { return DEFAULT_MODEL; }
}
export function setStoredModel(id: string): void {
  try { localStorage.setItem(MODEL_STORE, id); } catch { /* ignore */ }
}

// The grammar an LLM needs, compressed. Mirrors docs/llms.txt; kept short so it's
// cheap to send on every draft. The hard rule is "emit ONLY .flow text".
const SYSTEM = `You write models in flowloom's .flow language — a text-first systems-thinking format (Vensim-style stocks, flows, feedback loops). Output ONLY valid .flow text: no prose, no markdown, no code fences.

Grammar (one statement per line; # starts a comment):
  stock NAME [unit] = EXPR        an accumulator; EXPR is its INITIAL value
  change(NAME) = EXPR             the net rate dNAME/dt that gets integrated (alias: d(NAME))
  flow  NAME [unit] = EXPR        a named rate (same maths as aux, drawn as a flow)
  aux   NAME [unit] = EXPR        an instantaneous computed value, recomputed each step
  param NAME [unit] = EXPR        a constant knob (alias: const)
  switch NAME = on|off            a 0/1 policy toggle; use as if(NAME, a, b)
  table NAME = (x,y) (x,y) ...    a piecewise-linear lookup; call as NAME(x)
  scenario NAME key=value ...     a named override set (params, switches on/off, stock inits, dt/to)
  link A -> B +|-                 a declared signed influence; a sketch of links alone is valid (draws, has loops, doesn't run)
  expect [SCENARIO] min:Cash >= 0 a claim the model must keep satisfying (its own test); == v ± tol for a cited number
  data NAME [unit] = (t,v) (t,v)  a measured series read off the clock, held between samples (add linear to interpolate)
  (multi-file models use include "part.flow" as ns — but emit ONE self-contained text here)
  sim dt=0.1 to=50 start=0 method=rk4   integration settings (method: euler | rk4 | map)
  plot A B C                      which series are visible by default

Operators: + - * / % ^, comparisons (< <= > >= == !=) and && || ! returning 1/0.
Builtins: min max abs exp ln log10 sqrt pow sin cos tan floor ceil round sign
  if(cond,a,b) clamp(x,lo,hi) step(h,t0) pulse(t0,w) ramp(slope,t0,t1)
  random() random_uniform(lo,hi) random_normal(mean,sd)
  smooth(x,tau) smooth3(x,tau) delay1(x,tau) delay3(x,tau)  (stateful, exponential)
  previous(x) delay_fixed(x,n)  (exactly one step / n time units ago — a pipeline)

Rules: every referenced name must be defined; a model needs >=1 stock; a stock
changes ONLY through its change()/d() rate; if(c,a,b) evaluates BOTH branches, so
guard the operand (x/max(y,1e-9)), not the branch. A discrete-period model (monthly,
yearly) should use sim method=map dt=1: change() is then a per-step increment in the
stock's own units (flow income [GEL], no multiplying by dt). Prefer a short comment header
explaining the model, sensible param values, and a plot line. Pick dt/to so the
interesting dynamics are visible.`;

interface ApiError { error?: { message?: string } }

export interface DraftOptions {
  apiKey: string;
  /** One of MODELS[].id. Defaults to the stored choice. */
  model?: string;
  /** Called with each chunk of model text as it arrives, so the editor can fill
   *  in live instead of showing a spinner for twenty seconds. */
  onChunk?: (text: string, whole: string) => void;
  /** Called when the model starts and stops thinking, for a status line. */
  onThinking?: (thinking: boolean) => void;
  /** Abort the request — the Cancel button. */
  signal?: AbortSignal;
}

/**
 * One server-sent event from the streaming Messages API.
 *
 * Only the three deltas matter here: text (the model), thinking (a status
 * line), and the terminal stop_reason — which is the difference between "the
 * model finished" and "we ran out of budget mid-line", a distinction the old
 * non-streaming path silently threw away.
 */
interface StreamEvent {
  type?: string;
  delta?: { type?: string; text?: string; thinking?: string; stop_reason?: string };
  content_block?: { type?: string };
  error?: { message?: string };
}

/** Parse an SSE body, yielding each `data:` payload. */
async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<StreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    // Events are separated by a blank line; a chunk may split one in half.
    let sep: number;
    while ((sep = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      for (const line of block.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try { yield JSON.parse(payload) as StreamEvent; } catch { /* skip a malformed frame */ }
      }
    }
  }
}

/** Pull the .flow source out of a model response, tolerating ```fences``` or a
 *  stray sentence even though the system prompt forbids them. */
export function extractFlow(text: string): string {
  const fenced = text.match(/```(?:flow|text)?\s*\n([\s\S]*?)```/);
  const body = (fenced ? fenced[1]! : text).trim();
  return body;
}

/**
 * Ask Claude to turn `prompt` into a .flow model. Returns the model text.
 * Throws an Error with a user-facing message on auth / network / refusal.
 *
 * Streaming, for three reasons: a whole model can take a while and a spinner
 * says nothing; a generous token budget is only safe if the caller can watch it
 * arrive; and a request that can be read incrementally can also be cancelled.
 */
export async function draftFlow(prompt: string, opts: DraftOptions): Promise<string> {
  let res: Response;
  try {
    res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": opts.apiKey,
        "anthropic-version": "2023-06-01",
        // lets the request run from a browser with the user's own key
        "anthropic-dangerous-direct-browser-access": "true",
      },
      ...(opts.signal ? { signal: opts.signal } : {}),
      body: JSON.stringify({
        model: opts.model ?? getStoredModel(),
        max_tokens: MAX_TOKENS,
        stream: true,
        // Choosing stocks, flows and a dt that makes the dynamics visible is
        // exactly the kind of thing worth a moment of thought.
        thinking: { type: "adaptive" },
        system: SYSTEM,
        messages: [{ role: "user", content: `Build a .flow model: ${prompt}` }],
      }),
    });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new Error("couldn't reach the Anthropic API (network/CORS) — check your connection");
  }

  if (!res.ok) {
    let data: ApiError = {};
    try { data = (await res.json()) as ApiError; } catch { /* a non-JSON error body */ }
    if (res.status === 401) throw new Error("invalid API key");
    if (res.status === 429) throw new Error("rate limited — wait a moment and retry");
    throw new Error(data.error?.message ?? `Anthropic API error (${res.status})`);
  }
  if (!res.body) throw new Error("the Anthropic API returned no response body");

  let text = "";
  let stop: string | undefined;
  let inThinking = false;
  for await (const ev of sseEvents(res.body)) {
    if (ev.type === "error") throw new Error(ev.error?.message ?? "the Anthropic API reported an error mid-stream");
    if (ev.type === "content_block_start") {
      inThinking = ev.content_block?.type === "thinking";
      if (inThinking) opts.onThinking?.(true);
      continue;
    }
    if (ev.type === "content_block_stop") {
      if (inThinking) opts.onThinking?.(false);
      inThinking = false;
      continue;
    }
    if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta" && ev.delta.text) {
      text += ev.delta.text;
      opts.onChunk?.(ev.delta.text, text);
      continue;
    }
    if (ev.type === "message_delta" && ev.delta?.stop_reason) stop = ev.delta.stop_reason;
  }

  if (stop === "refusal") throw new Error("the model declined this request");
  // A truncated draft fails to parse somewhere in the middle, which reads as
  // "the AI is bad at this" unless we say what actually happened.
  if (stop === "max_tokens") throw new Error(`the draft was cut off at ${MAX_TOKENS} tokens — ask for a smaller model, or split it into parts`);
  const flow = extractFlow(text);
  if (!flow) throw new Error("the model returned no model text — try rephrasing");
  return flow;
}
