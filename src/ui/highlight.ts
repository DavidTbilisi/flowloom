// ── Tolerant source tokenizer (for syntax coloring + contextual help) ────────
// Unlike src/lang/tokenizer.ts (which works per line and throws on malformed
// input), this scans the *whole* document and never throws: it always covers
// every character so the tokens rebuild the source verbatim. That property is
// what lets us paint a highlight overlay exactly behind the textarea and
// hit-test tokens under the mouse.
//
// DOM-free on purpose — it imports only data tables from the engine, so Vitest
// can pin it in Node.

import { BUILTINS, STATEFUL } from "../engine/index.js";

export type TokKind =
  | "keyword"
  | "builtin"
  | "ident"
  | "number"
  | "comment"
  | "op"
  | "punct"
  | "ws";

export interface Tok {
  text: string;
  start: number;
  end: number;
  /** 1-based line of the token's first character. */
  line: number;
  kind: TokKind;
  /** Lookup key into the help system, when the token is explainable. */
  helpKey?: string;
}

/** Line-leading keywords of the .flow grammar. */
export const KEYWORDS = new Set([
  "stock",
  "change",
  "d",
  "flow",
  "aux",
  "param",
  "const",
  "table",
  "sim",
  "plot",
]);

/** Engine-provided constants / clock identifiers a user can't redefine. */
export const CONSTS = new Set(["PI", "E", "t", "time", "dt"]);

/** Every builtin function name (stateless + the stateful delay/smooth family). */
export const FUNCTIONS = new Set([...Object.keys(BUILTINS), ...STATEFUL]);

const isIdentStart = (c: string) => /[A-Za-z_]/.test(c);
const isIdentPart = (c: string) => /[A-Za-z0-9_]/.test(c);
const isDigit = (c: string) => c >= "0" && c <= "9";
const OP_CHARS = new Set(["+", "-", "*", "/", "%", "^", "=", "<", ">", "!", "&", "|"]);
const OPS2 = new Set(["**", "<=", ">=", "==", "!=", "&&", "||"]);
/** Word aliases for logical operators — coloured like operators, not identifiers. */
const WORD_OPS = new Set(["and", "or", "not"]);
const PUNCT_CHARS = new Set(["(", ")", ",", "[", "]"]);

/** Tokenize an entire model source. The result spans every character. */
export function tokenizeSource(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  let line = 1;
  let atLineStart = true; // first non-ws token of a line gets keyword treatment
  const N = src.length;

  const push = (text: string, start: number, kind: TokKind, helpKey?: string) => {
    toks.push({ text, start, end: start + text.length, line, kind, helpKey });
  };

  while (i < N) {
    const c = src[i]!;

    // whitespace (including newlines, which advance the line + reset lineStart)
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      const start = i;
      let sawNewline = false;
      while (i < N) {
        const w = src[i]!;
        if (w === " " || w === "\t" || w === "\n" || w === "\r") {
          if (w === "\n") sawNewline = true;
          i++;
        } else break;
      }
      const text = src.slice(start, i);
      toks.push({ text, start, end: i, line, kind: "ws" });
      // bump the line counter by the number of newlines consumed
      for (const ch of text) if (ch === "\n") line++;
      if (sawNewline) atLineStart = true;
      continue;
    }

    // comment: # to end of line
    if (c === "#") {
      const start = i;
      while (i < N && src[i] !== "\n") i++;
      push(src.slice(start, i), start, "comment");
      atLineStart = false;
      continue;
    }

    // number (with optional fraction + scientific exponent)
    if (isDigit(c) || (c === "." && isDigit(src[i + 1] ?? ""))) {
      const start = i;
      while (i < N && isDigit(src[i]!)) i++;
      if (src[i] === ".") { i++; while (i < N && isDigit(src[i]!)) i++; }
      if (src[i] === "e" || src[i] === "E") {
        const j = i + 1;
        const sign = src[j] === "+" || src[j] === "-" ? 1 : 0;
        if (isDigit(src[j + sign] ?? "")) {
          i = j + sign;
          while (i < N && isDigit(src[i]!)) i++;
        }
      }
      push(src.slice(start, i), start, "number");
      atLineStart = false;
      continue;
    }

    // identifier (keyword / builtin / const / plain)
    if (isIdentStart(c)) {
      const start = i;
      while (i < N && isIdentPart(src[i]!)) i++;
      const word = src.slice(start, i);
      let kind: TokKind = "ident";
      let helpKey: string | undefined = `ident:${word}`;
      if (WORD_OPS.has(word)) {
        push(word, start, "op");
        atLineStart = false;
        continue;
      }
      if (atLineStart && KEYWORDS.has(word)) {
        kind = "keyword";
        helpKey = word;
      } else if (FUNCTIONS.has(word)) {
        kind = "builtin";
        helpKey = `fn:${word}`;
      } else if (CONSTS.has(word)) {
        kind = "builtin";
        helpKey = `const:${word}`;
      }
      push(word, start, kind, helpKey);
      atLineStart = false;
      continue;
    }

    // two-char operators: ** <= >= == != && ||
    if (OPS2.has(c + (src[i + 1] ?? ""))) {
      push(c + src[i + 1]!, i, "op");
      i += 2;
      atLineStart = false;
      continue;
    }

    // single-char operator / punctuation
    if (OP_CHARS.has(c)) {
      push(c, i, "op");
      i++;
      atLineStart = false;
      continue;
    }
    if (PUNCT_CHARS.has(c)) {
      push(c, i, "punct");
      i++;
      atLineStart = false;
      continue;
    }

    // anything else (e.g. a stray '.' or unknown symbol) — keep it as punct so
    // the stream stays lossless.
    push(c, i, "punct");
    i++;
    atLineStart = false;
  }

  return toks;
}

/** The explainable token containing offset `pos` (caret/cursor), or null. */
export function tokenAt(toks: Tok[], pos: number): Tok | null {
  for (const t of toks) {
    if (!t.helpKey) continue;
    if (pos >= t.start && pos <= t.end) return t;
  }
  return null;
}
