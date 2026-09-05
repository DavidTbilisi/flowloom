// ── A very small XML reader ─────────────────────────────────────────────────
// Just enough of XML to read an XMILE file: elements, attributes, text, CDATA,
// comments, self-closing tags, and the five predefined entities.
//
// Hand-rolled because flowloom ships with one runtime dependency (the MCP SDK)
// and intends to keep it that way, and because the browser's DOMParser is not
// available in the CLI, the MCP server or the Node tests — all of which need to
// import a model. It is a reader, not a validator: anything it does not
// understand (namespaces beyond the prefix, DTDs, processing instructions) is
// skipped rather than rejected, because a real .stmx from a real tool will
// contain things this does not model and still be perfectly readable.

export interface XmlNode {
  /** Tag name with any namespace prefix stripped, lowercased. */
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  /** Concatenated direct text content, trimmed. */
  text: string;
}

const ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

function decode(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (all, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) return String.fromCodePoint(parseInt(body.slice(2), 16));
    if (body.startsWith("#")) return String.fromCodePoint(parseInt(body.slice(1), 10));
    return ENTITIES[body] ?? all;
  });
}

const bare = (name: string): string => {
  const i = name.indexOf(":");
  return (i < 0 ? name : name.slice(i + 1)).toLowerCase();
};

export class XmlParseError extends Error {}

/** Parse an XML document into a tree. Throws XmlParseError on malformed input. */
export function parseXml(src: string): XmlNode {
  const root: XmlNode = { name: "#document", attrs: {}, children: [], text: "" };
  const stack: XmlNode[] = [root];
  let i = 0;

  const top = (): XmlNode => stack[stack.length - 1]!;

  while (i < src.length) {
    const lt = src.indexOf("<", i);
    if (lt < 0) { top().text += decode(src.slice(i)); break; }
    if (lt > i) top().text += decode(src.slice(i, lt));

    if (src.startsWith("<!--", lt)) {
      const end = src.indexOf("-->", lt);
      i = end < 0 ? src.length : end + 3;
      continue;
    }
    if (src.startsWith("<![CDATA[", lt)) {
      const end = src.indexOf("]]>", lt);
      if (end < 0) throw new XmlParseError("unterminated CDATA section");
      top().text += src.slice(lt + 9, end);
      i = end + 3;
      continue;
    }
    if (src.startsWith("<?", lt) || src.startsWith("<!", lt)) {
      const end = src.indexOf(">", lt);
      i = end < 0 ? src.length : end + 1;
      continue;
    }

    const gt = findTagEnd(src, lt);
    if (gt < 0) throw new XmlParseError("unterminated tag");
    const raw = src.slice(lt + 1, gt);

    if (raw.startsWith("/")) {
      if (stack.length > 1) stack.pop();
      i = gt + 1;
      continue;
    }

    const selfClosing = raw.endsWith("/");
    const body = selfClosing ? raw.slice(0, -1) : raw;
    const nameEnd = body.search(/[\s/]/);
    const name = bare(nameEnd < 0 ? body : body.slice(0, nameEnd));
    const node: XmlNode = { name, attrs: attributes(nameEnd < 0 ? "" : body.slice(nameEnd)), children: [], text: "" };
    top().children.push(node);
    if (!selfClosing) stack.push(node);
    i = gt + 1;
  }

  for (const n of walk(root)) n.text = n.text.trim();
  return root;
}

/** The `>` that closes a tag, skipping any inside a quoted attribute value. */
function findTagEnd(src: string, from: number): number {
  let quote = "";
  for (let i = from + 1; i < src.length; i++) {
    const c = src[i]!;
    if (quote) { if (c === quote) quote = ""; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === ">") return i;
  }
  return -1;
}

function attributes(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out[bare(m[1]!)] = decode(m[3] ?? m[4] ?? "");
  return out;
}

function* walk(n: XmlNode): Generator<XmlNode> {
  yield n;
  for (const c of n.children) yield* walk(c);
}

/** Every descendant with this tag name, in document order. */
export function findAll(node: XmlNode, name: string): XmlNode[] {
  return [...walk(node)].filter((n) => n.name === name && n !== node);
}

/** The first direct child with this name. */
export function child(node: XmlNode, name: string): XmlNode | undefined {
  return node.children.find((c) => c.name === name);
}

/** Text of the first direct child with this name. */
export function childText(node: XmlNode, name: string): string | undefined {
  return child(node, name)?.text;
}
