import type { Loc } from "./types.js";

// ── Expression tokenizer ────────────────────────────────────────────────────
// Tokenizes a single expression string (the right-hand side of one declaration).
// Line-level structure (`stock`, `flow`, `d(...)`, comments) is handled by the
// model parser; this only sees math expressions.

export type TokType =
  | "num"
  | "ident"
  | "op"
  | "lparen"
  | "rparen"
  | "lbracket"
  | "rbracket"
  | "comma"
  | "eof";

export interface Token {
  type: TokType;
  value: string;
  col: number;
}

const OPS = new Set(["+", "-", "*", "/", "%", "^"]);

/**
 * Tokenize an expression. `line` is used only to attach a line number to
 * thrown errors; `col` on each token is 0-based within the expression text.
 */
export function tokenize(src: string, line: number): Token[] {
  const toks: Token[] = [];
  let i = 0;
  const at = (col: number): Loc => ({ line, col });

  while (i < src.length) {
    const c = src[i];

    if (c === " " || c === "\t" || c === "\r" || c === "\n") {
      i++;
      continue;
    }

    // number: 12, 12.5, .5, 1e3, 1.2e-3, 2E+4
    if (isDigit(c) || (c === "." && isDigit(src[i + 1] ?? ""))) {
      const start = i;
      while (i < src.length && isDigit(src[i]!)) i++;
      if (src[i] === ".") {
        i++;
        while (i < src.length && isDigit(src[i]!)) i++;
      }
      if (src[i] === "e" || src[i] === "E") {
        let j = i + 1;
        if (src[j] === "+" || src[j] === "-") j++;
        if (isDigit(src[j] ?? "")) {
          i = j;
          while (i < src.length && isDigit(src[i]!)) i++;
        }
      }
      toks.push({ type: "num", value: src.slice(start, i), col: start });
      continue;
    }

    // identifier: letters, digits, underscore (not leading digit)
    if (isIdentStart(c)) {
      const start = i;
      i++;
      while (i < src.length && isIdentPart(src[i]!)) i++;
      toks.push({ type: "ident", value: src.slice(start, i), col: start });
      continue;
    }

    if (c === "(") {
      toks.push({ type: "lparen", value: c, col: i });
      i++;
      continue;
    }
    if (c === ")") {
      toks.push({ type: "rparen", value: c, col: i });
      i++;
      continue;
    }
    if (c === "[") {
      toks.push({ type: "lbracket", value: c, col: i });
      i++;
      continue;
    }
    if (c === "]") {
      toks.push({ type: "rbracket", value: c, col: i });
      i++;
      continue;
    }
    if (c === ",") {
      toks.push({ type: "comma", value: c, col: i });
      i++;
      continue;
    }

    // operators (incl. `**` collapsed to `^`)
    if (c === "*" && src[i + 1] === "*") {
      toks.push({ type: "op", value: "^", col: i });
      i += 2;
      continue;
    }
    if (OPS.has(c!)) {
      toks.push({ type: "op", value: c!, col: i });
      i++;
      continue;
    }

    const loc = at(i);
    throw new ExprSyntaxError(`unexpected character '${c}'`, loc);
  }

  toks.push({ type: "eof", value: "", col: src.length });
  return toks;
}

export class ExprSyntaxError extends Error {
  loc: Loc;
  constructor(message: string, loc: Loc) {
    super(message);
    this.name = "ExprSyntaxError";
    this.loc = loc;
  }
}

function isDigit(c: string): boolean {
  return c >= "0" && c <= "9";
}
function isIdentStart(c: string): boolean {
  return (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_";
}
function isIdentPart(c: string): boolean {
  return isIdentStart(c) || isDigit(c);
}
