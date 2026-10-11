/**
 * Copy-paste setup for an agent's MCP client (docs: get-started/agents.md): Claude Code's
 * `claude mcp add`, the `mcpServers` JSON Cursor and VS Code read, and the bare URL for any other
 * client. Without a token the client signs in through OAuth and you approve on a consent screen;
 * with a hand-made token the same snippets carry its Authorization header.
 */
import { useSignal } from "@preact/signals";
import { type McpClient, mcpSnippet } from "../lib/start.js";
import { CopyButton, Segmented } from "./ui.js";

const CLIENTS: { id: McpClient; label: string }[] = [
  { id: "claude", label: "Claude Code" },
  { id: "json", label: "Cursor, VS Code" },
  { id: "other", label: "Other" },
];

const WHERE: Record<McpClient, (token: boolean) => string> = {
  claude: (t) =>
    t
      ? "Run it in a terminal. The agent uses this token for every call."
      : "Run it in a terminal. On its first call Claude Code opens a sign-in page and you approve what it may do.",
  json: (t) =>
    t
      ? "Put it in .cursor/mcp.json or your VS Code MCP settings."
      : "Put it in .cursor/mcp.json or your VS Code MCP settings. The client signs in on first use and you approve it.",
  other: (t) =>
    t
      ? "Any MCP client that speaks streamable HTTP: this URL, and the header on every request."
      : "Any MCP client that speaks streamable HTTP. It signs in with OAuth on first use.",
};

export function McpSetup({ token, idPrefix = "mcp" }: { token?: string; idPrefix?: string }) {
  const client = useSignal<McpClient>("claude");
  const text = mcpSnippet(client.value, window.location.origin, token);
  return (
    <div class="mcp-setup" data-testid={token ? "mcp-setup-token" : "mcp-setup"}>
      <Segmented
        size="sm"
        label="Your MCP client"
        value={client.value}
        options={CLIENTS}
        onChange={(id) => (client.value = id)}
      />
      <p class="mcp-setup__where" id={`${idPrefix}-where`}>
        {WHERE[client.value](!!token)}
      </p>
      <div class="mcp-setup__box">
        <pre
          class="scroll-x"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable code block must be keyboard-focusable (axe scrollable-region-focusable)
          tabIndex={0}
          aria-describedby={`${idPrefix}-where`}
          data-testid="mcp-snippet"
        >
          <code>{text}</code>
        </pre>
        <CopyButton text={text} label="Copy" />
      </div>
    </div>
  );
}
