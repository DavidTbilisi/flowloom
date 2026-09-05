// ── Include resolution ───────────────────────────────────────────────────────
// `include "engine.flow" as eng [key=value …]` composes models out of parts
// while keeping the thing the whole toolchain operates on a SINGLE TEXT: the
// resolver is a source-to-source pass that inlines the child file with every
// declared name prefixed `eng.`, and everything downstream — parser, engine,
// studio, MCP, share links — never learns includes exist. The CLI resolves from
// disk automatically; `flowloom bundle` prints the resolved text for the
// places that only take one text. The reader is injected, so this module stays
// I/O-free like the rest of src/lang.
//
// What an include takes from the child: stocks, change() rates, flows, auxes,
// params/consts/switches, tables, data lines, dims, links — the model's
// *structure*. What it drops (each dropped line is kept as a comment): the
// child's `sim` and `plot` (the parent owns time and presentation), and its
// `scenario`/`expect` lines (they are claims about the child under the child's
// own settings — re-state the ones that matter in the parent's namespace).
//
// Bindings rewire the child at include time:
//   include "engine.flow" as eng rate=0.02 cashIn=spendable
// A number / on / off rebinds the child declaration's value in place. Anything
// else is an expression in the PARENT's scope: the child's `param cashIn = 0`
// becomes `aux eng.cashIn = spendable` — the composition point where a parent
// signal drives a child input.

import { parseModel } from "./parser.js";

export interface IncludeOptions {
  /** Read a file's text by resolved path. Throw to report "not found". */
  read: (path: string) => string;
  /** Directory of the including file; relative paths resolve against it. */
  dir?: string;
  /** Resolution chain, for cycle reporting (internal). */
  stack?: string[];
}

const INCLUDE = /^include\s+"([^"]+)"\s+as\s+([A-Za-z_]\w*)\s*(.*?)\s*(#.*)?$/;

/** True when the text has include lines to resolve. */
export function hasIncludes(text: string): boolean {
  return text.split(/\r?\n/).some((l) => INCLUDE.test(l.trim()));
}

/** Pure path join: `dir + rel`, handling `./` and `../`. */
function joinPath(dir: string, rel: string): string {
  if (rel.startsWith("/")) return rel;
  const parts = (dir ? dir.split("/") : []).filter((p) => p !== "" && p !== ".");
  for (const seg of rel.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return (dir.startsWith("/") ? "/" : "") + parts.join("/");
}

const dirname = (path: string): string => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Every name the child declares (dotted names from its own includes included). */
function declaredNames(text: string, path: string): string[] {
  let m;
  try {
    m = parseModel(text);
  } catch (e) {
    throw new Error(`include "${path}": the included file does not parse — ${(e as Error).message.split("\n")[0]}`);
  }
  const names = new Set<string>();
  for (const s of m.stocks) names.add(s.name);
  for (const v of m.vars) names.add(v.name);
  for (const [n] of m.tables) if (!n.includes("#")) names.add(n); // `x#data` renames via its data line
  for (const [n] of m.dims) names.add(n);
  for (const l of m.links) { names.add(l.from); names.add(l.to); } // sketch nodes may be otherwise undeclared
  return [...names];
}

interface Binding { key: string; value: string }

function parseBindings(spec: string, path: string): Binding[] {
  const out: Binding[] = [];
  for (const tok of spec.split(/\s+/).filter(Boolean)) {
    const eq = tok.indexOf("=");
    if (eq <= 0 || eq === tok.length - 1) throw new Error(`include "${path}": binding expects key=value, got '${tok}'`);
    out.push({ key: tok.slice(0, eq), value: tok.slice(eq + 1) });
  }
  return out;
}

/**
 * Resolve every `include` line in `text`, depth-first, into one flat text.
 * Deterministic and pure — all I/O goes through `opts.read`.
 */
export function resolveIncludes(text: string, opts: IncludeOptions): string {
  const dir = opts.dir ?? "";
  const stack = opts.stack ?? [];
  const usedNs = new Set<string>();
  const lines = text.split(/\r?\n/);
  const out: string[] = [];

  for (const raw of lines) {
    const m = raw.trim().match(INCLUDE);
    if (!m) { out.push(raw); continue; }
    const [, rel, ns, bindSpec] = m;
    const path = joinPath(dir, rel!);
    if (stack.includes(path)) throw new Error(`include cycle: ${[...stack, path].join(" → ")}`);
    if (usedNs.has(ns!)) throw new Error(`include "${rel}": namespace '${ns}' is already used by another include — pick a different \`as\` name`);
    usedNs.add(ns!);

    let childRaw: string;
    try {
      childRaw = opts.read(path);
    } catch (e) {
      throw new Error(`include "${rel}": cannot read ${path} — ${(e as Error).message}`);
    }
    // Depth-first: the child's own includes are inlined (namespaced) before we
    // rename, so nested names arrive here already dotted and rename cleanly.
    let child = resolveIncludes(childRaw, { read: opts.read, dir: dirname(path), stack: [...stack, path] });

    // Rename the child's declared names, longest first so `inner.x` is rewritten
    // before a bare `x` could match inside it; lookarounds keep segments whole.
    const names = declaredNames(child, path).sort((a, b) => b.length - a.length);
    for (const name of names) {
      child = child.replace(new RegExp(`(?<![\\w.])${esc(name)}(?![\\w.])`, "g"), `${ns}.${name}`);
    }

    // Apply bindings on the renamed text: rewrite the declaration line in place.
    for (const { key, value } of parseBindings(bindSpec ?? "", rel!)) {
      const full = `${ns}.${key}`;
      // `(?:>=\s*0\s*)?` keeps a `stock X >= 0 = …` floor inside the preserved
      // middle group, so binding its init doesn't silently drop the declaration.
      const decl = new RegExp(`^(\\s*)(param|const|switch|stock|aux|flow|data)(\\s+${esc(full)}\\s*(?:\\[[^\\]]*\\])?\\s*(?:>=\\s*0\\s*)?=\\s*)([^#\\n]*)(#.*)?$`, "m");
      const hit = child.match(decl);
      if (!hit) throw new Error(`include "${rel}": no param, switch, const, or stock named '${key}' to bind (looked for '${full}')`);
      const kind = hit[2]!;
      const simple = /^(-?\d+(\.\d+)?([eE][+-]?\d+)?|on|off|true|false|yes|no)$/.test(value);
      if (kind === "data") throw new Error(`include "${rel}": '${key}' is a data series — bind params, switches, consts, or stock inits`);
      if (!simple && (kind === "switch")) throw new Error(`include "${rel}": switch '${key}' takes on or off, got '${value}'`);
      const newKind = simple ? kind : kind === "param" || kind === "const" || kind === "aux" || kind === "flow" ? "aux" : kind;
      child = child.replace(decl, (_all, ws, _k, mid, _rhs, comment) => `${ws}${newKind}${mid}${value}${comment ? `   ${comment}` : ""}`);
    }

    // The parent owns time, presentation, and claims: drop (as comments) the
    // child's sim/plot/scenario/expect lines.
    child = child
      .split("\n")
      .map((l) => (/^\s*(sim|plot|scenario|expect)\s/.test(l) ? `# (from include, inert) ${l.trim()}` : l))
      .join("\n");

    out.push(`# ── include "${rel}" as ${ns} ${"─".repeat(Math.max(3, 58 - rel!.length - ns!.length))}`);
    out.push(child.trimEnd());
    out.push(`# ── end include "${rel}" ${"─".repeat(Math.max(3, 63 - rel!.length))}`);
  }
  return out.join("\n");
}
