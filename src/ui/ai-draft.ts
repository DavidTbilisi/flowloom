// ── AI draft: prose → .flow ──────────────────────────────────────────────────
// The headline AI-first feature: describe a system in English and Claude writes
// a runnable .flow model. flowloom's clean text format is the ideal LLM target
// (no diagram XML to hallucinate), and the model it emits is *checked and run* by
// the same engine the rest of the app uses — so the AI's output is verifiable,
// not a vibe. Bring-your-own Anthropic key (stored locally, sent only to
// Anthropic); the app is fully functional without it, so this stays optional and
// keeps flowloom dependency-free — a raw fetch, no SDK in the browser bundle.

const KEY_STORE = "flowloom.anthropicKey";
const MODEL = "claude-opus-4-8";
const ENDPOINT = "https://api.anthropic.com/v1/messages";

export function getStoredKey(): string {
  try { return localStorage.getItem(KEY_STORE) ?? ""; } catch { return ""; }
}
export function setStoredKey(key: string): void {
  try { key ? localStorage.setItem(KEY_STORE, key) : localStorage.removeItem(KEY_STORE); } catch { /* ignore */ }
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
  table NAME = (x,y) (x,y) ...    a piecewise-linear lookup; call as NAME(x)
  sim dt=0.1 to=50 start=0 method=rk4   integration settings (method: euler | rk4)
  plot A B C                      which series are visible by default

Operators: + - * / % ^, comparisons (< <= > >= == !=) and && || ! returning 1/0.
Builtins: min max abs exp ln log10 sqrt pow sin cos tan floor ceil round sign
  if(cond,a,b) clamp(x,lo,hi) step(h,t0) pulse(t0,w) ramp(slope,t0,t1)
  random() random_uniform(lo,hi) random_normal(mean,sd)
  smooth(x,tau) smooth3(x,tau) delay1(x,tau) delay3(x,tau)  (stateful)

Rules: every referenced name must be defined; a model needs >=1 stock; a stock
changes ONLY through its change()/d() rate; if(c,a,b) evaluates BOTH branches, so
guard the operand (x/max(y,1e-9)), not the branch. Prefer a short comment header
explaining the model, sensible param values, and a plot line. Pick dt/to so the
interesting dynamics are visible.`;

interface ContentBlock { type: string; text?: string }
interface ApiResponse {
  content?: ContentBlock[];
  stop_reason?: string;
  error?: { message?: string };
}

/** Pull the .flow source out of a model response, tolerating ```fences``` or a
 *  stray sentence even though the system prompt forbids them. */
export function extractFlow(text: string): string {
  const fenced = text.match(/```(?:flow|text)?\s*\n([\s\S]*?)```/);
  const body = (fenced ? fenced[1]! : text).trim();
  return body;
}

/**
 * Ask Claude to turn `prompt` into a .flow model. Returns the raw model text.
 * Throws an Error with a user-facing message on auth / network / refusal.
 */
export async function draftFlow(prompt: string, apiKey: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        // lets the request run from a browser with the user's own key
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 2000,
        system: SYSTEM,
        messages: [{ role: "user", content: `Build a .flow model: ${prompt}` }],
      }),
    });
  } catch {
    throw new Error("couldn't reach the Anthropic API (network/CORS) — check your connection");
  }

  let data: ApiResponse;
  try { data = (await res.json()) as ApiResponse; } catch { data = {}; }

  if (!res.ok) {
    if (res.status === 401) throw new Error("invalid API key");
    if (res.status === 429) throw new Error("rate limited — wait a moment and retry");
    throw new Error(data.error?.message ?? `Anthropic API error (${res.status})`);
  }
  if (data.stop_reason === "refusal") throw new Error("the model declined this request");

  const text = (data.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
  const flow = extractFlow(text);
  if (!flow) throw new Error("the model returned no model text — try rephrasing");
  return flow;
}
