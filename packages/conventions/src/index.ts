/**
 * @app/conventions: the single source of truth for what the platform tells agents and writes into
 * repos: AGENTS.md, /start, /llms.txt, MCP discovery documents, nextSteps, error fixes, and the
 * default `.platform/*` files. Pure TypeScript (no Node, Workers or DOM APIs).
 */
export * from "./agents-md.js";
export * from "./calls.js";
export * from "./catalog.js";
export * from "./fixes.js";
export * from "./llms-txt.js";
export * from "./mcp-discovery.js";
export * from "./next-steps.js";
export * from "./platform-files.js";
export * from "./project.js";
export * from "./start.js";
export * from "./templates.js";
export * from "./version.js";
