// Tutorial 08 — AI-native: the text is the model, plus the MCP server.
export default {
  num: "08",
  slug: "ai-mcp",
  title: "AI-native — text-canonical & MCP",
  voice: "en-US-AriaNeural",
  rate: "-2%",
  viewport: { width: 1440, height: 810 },
  url: "http://localhost:5174/",
  segments: [
    {
      text: "Here's flowloom's big idea. A hand-drawn diagram is the worst thing for a machine to read — the meaning is hidden in pixel positions and arrow wiring. The same model as text is the best.",
      do: async (page, h) => { await h.run(); },
    },
    {
      text: "Because the text is canonical, an AI can edit the model the way you'd edit code — add a stock, retune a loop, change an input — just by changing lines.",
      do: async (page, h) => { await h.ai(); },
    },
    {
      text: "The built-in AI panel drafts or revises a model for you, right here. It writes text, you press Run, and you watch the dynamics — you never have to trust it blind.",
      do: async () => {},
    },
    {
      text: "And because it's all text, Copy and Share export the model as plain text or a link — portable, diffable, and version-controllable like any source file.",
      do: async (page, h) => { await h.aiClose(); },
    },
    {
      text: "flowloom even ships an MCP server, so an assistant can read and edit your models directly — always against the exact text that runs. Validate, don't vibe.",
      do: async () => {},
    },
  ],
};
