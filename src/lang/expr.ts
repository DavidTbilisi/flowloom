import type { Expr, BinOp, Loc } from "./types.js";
import { tokenize, ExprSyntaxError, type Token } from "./tokenizer.js";

// ── Expression parser (Pratt / precedence-climbing) ─────────────────────────
// Produces an inspectable AST. No `eval`/`new Function` — expressions are
// interpreted by `evalExpr`, which keeps the engine safe and lets us analyse
// dependencies and (numerically) differentiate for loop-polarity detection.

const PREC: Record<BinOp, number> = {
  "+": 10,
  "-": 10,
  "*": 20,
  "/": 20,
  "%": 20,
  "^": 30,
};

// `^` is right-associative (2^3^2 = 2^9); everything else left-associative.
const RIGHT_ASSOC = new Set<BinOp>(["^"]);

class Parser {
  private toks: Token[];
  private pos = 0;
  constructor(private line: number, src: string) {
    this.toks = tokenize(src, line);
  }

  private peek(): Token {
    return this.toks[this.pos]!;
  }
  private next(): Token {
    return this.toks[this.pos++]!;
  }
  private loc(t: Token): Loc {
    return { line: this.line, col: t.col };
  }

  parse(): Expr {
    const e = this.parseExpr(0);
    const t = this.peek();
    if (t.type !== "eof") {
      throw new ExprSyntaxError(`unexpected '${t.value}'`, this.loc(t));
    }
    return e;
  }

  private parseExpr(minPrec: number): Expr {
    let left = this.parsePrefix();
    for (;;) {
      const t = this.peek();
      if (t.type !== "op") break;
      const op = t.value as BinOp;
      const prec = PREC[op];
      if (prec === undefined || prec < minPrec) break;
      this.next();
      const nextMin = RIGHT_ASSOC.has(op) ? prec : prec + 1;
      const right = this.parseExpr(nextMin);
      left = { kind: "binary", op, left, right, loc: left.loc };
    }
    return left;
  }

  private parsePrefix(): Expr {
    const t = this.peek();
    if (t.type === "op" && (t.value === "-" || t.value === "+")) {
      this.next();
      const arg = this.parsePrefix();
      return { kind: "unary", op: t.value, arg, loc: this.loc(t) };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): Expr {
    const t = this.next();
    if (t.type === "num") {
      const value = Number(t.value);
      if (!Number.isFinite(value)) {
        throw new ExprSyntaxError(`bad number '${t.value}'`, this.loc(t));
      }
      return { kind: "num", value, loc: this.loc(t) };
    }
    if (t.type === "ident") {
      if (this.peek().type === "lparen") {
        this.next(); // consume (
        const args: Expr[] = [];
        if (this.peek().type !== "rparen") {
          args.push(this.parseExpr(0));
          while (this.peek().type === "comma") {
            this.next();
            args.push(this.parseExpr(0));
          }
        }
        const close = this.next();
        if (close.type !== "rparen") {
          throw new ExprSyntaxError(`expected ')' after arguments to ${t.value}()`, this.loc(close));
        }
        return { kind: "call", name: t.value, args, loc: this.loc(t) };
      }
      return { kind: "ident", name: t.value, loc: this.loc(t) };
    }
    if (t.type === "lparen") {
      const e = this.parseExpr(0);
      const close = this.next();
      if (close.type !== "rparen") {
        throw new ExprSyntaxError("expected ')'", this.loc(close));
      }
      return e;
    }
    throw new ExprSyntaxError(`expected a value, got '${t.value || "end of expression"}'`, this.loc(t));
  }
}

/** Parse one expression string into an AST. Throws ExprSyntaxError on failure. */
export function parseExpr(src: string, line: number): Expr {
  return new Parser(line, src).parse();
}

/** All identifier names referenced by an expression (variables + function names excluded). */
export function freeVars(e: Expr, out: Set<string> = new Set()): Set<string> {
  switch (e.kind) {
    case "num":
      break;
    case "ident":
      out.add(e.name);
      break;
    case "unary":
      freeVars(e.arg, out);
      break;
    case "binary":
      freeVars(e.left, out);
      freeVars(e.right, out);
      break;
    case "call":
      // function name is not a free variable; its args may be
      for (const a of e.args) freeVars(a, out);
      break;
  }
  return out;
}

/** Pretty-print an AST back to canonical text (used for AI round-tripping / tests). */
export function printExpr(e: Expr): string {
  switch (e.kind) {
    case "num":
      return String(e.value);
    case "ident":
      return e.name;
    case "unary":
      return `${e.op}${wrap(e.arg, e)}`;
    case "binary":
      return `${wrap(e.left, e)} ${e.op} ${wrap(e.right, e)}`;
    case "call":
      return `${e.name}(${e.args.map(printExpr).join(", ")})`;
  }
}

function wrap(child: Expr, parent: Expr): string {
  const s = printExpr(child);
  if (child.kind === "binary" && parent.kind === "binary") {
    if (PREC[child.op] < PREC[parent.op]) return `(${s})`;
  }
  if (child.kind === "binary" && parent.kind === "unary") return `(${s})`;
  return s;
}
