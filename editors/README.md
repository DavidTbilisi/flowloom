# Editor support for `.flow`

`flow.tmLanguage.json` is a TextMate grammar for the flowloom language. It is
**generated** — `npm run gen:grammar` rebuilds it from the same keyword, builtin
and constant sets the studio's own editor paints from (`src/ui/highlight.ts`,
whose function list comes from the engine's `BUILTINS`/`STATEFUL`). A contract
test (`tests/unit/grammar.test.ts`) fails if the file drifts, so extending the
language can't leave highlighting elsewhere stale.

Don't edit the JSON; edit `scripts/gen-grammar.ts` and regenerate.

## Using it

**VS Code** — a minimal extension is a folder with this grammar and a
`package.json`:

```json
{
  "name": "flowloom",
  "version": "0.1.0",
  "engines": { "vscode": "^1.75.0" },
  "contributes": {
    "languages": [{ "id": "flow", "extensions": [".flow"], "aliases": ["flowloom"] }],
    "grammars": [{ "language": "flow", "scopeName": "source.flow", "path": "./flow.tmLanguage.json" }]
  }
}
```

Drop both files in `~/.vscode/extensions/flowloom/` and reload.

**Anything else that reads TextMate grammars** (Sublime Text, TextMate, Zed,
`bat`, `shiki`, `highlight.js`'s TextMate bridge) takes the same file — register
it against the scope `source.flow` and the `.flow` extension.

**GitHub** highlights by scope through Linguist, which only recognises grammars
registered upstream; until then `.flow` renders as plain text there.
