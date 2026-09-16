# MCP TypeScript SDK research notes (2026-09-16)

Source: fetched by a research subagent from the URLs listed at the bottom. Used to choose the SDK line and API surface.

## Decision
Build on **`@modelcontextprotocol/sdk@1.30.0`** (v1.x line) with **zod v4** imported from `zod/v4`.
Rationale: v2 (`@modelcontextprotocol/server` 2.0.0, split packages) shipped very recently; v1.x keeps receiving fixes for 6+ months and interoperates with v2 clients on the wire (both speak protocol 2025-11-25). Migration to v2 is mechanical (`npx @modelcontextprotocol/codemod@latest v1-to-v2 .`).

## v1.30.0 facts used in this repo
- `peerDependencies: { zod: "^3.25 || ^4.0" }`; SDK internally imports `zod/v4`.
- `new McpServer({ name, version }, options?)`; `await server.connect(transport)` returns `Promise<void>`.
- `server.registerTool(name, { title, description, inputSchema, outputSchema, annotations, _meta }, handler)`.
  `inputSchema` accepts a raw zod shape or a zod object. Handler `(args, extra) => CallToolResult`.
  Result: `{ content: [{type:'text', text}], structuredContent?, isError? }`. If `outputSchema` is set and result is not an error, `structuredContent` is required.
- `registerTool` returns `RegisteredTool` with `enable()`, `disable()`, `remove()`, `update()`; each emits `notifications/tools/list_changed`. Disabled tools are filtered out of `tools/list` and calling one throws `McpError(InvalidParams, "Tool X disabled")`.
  **This repo does not register write tools at all when writes are disabled** (stronger than `disable()`), so they never appear in `tools/list`.
- Transports: `StdioServerTransport` from `@modelcontextprotocol/sdk/server/stdio.js`; `StreamableHTTPServerTransport` from `@modelcontextprotocol/sdk/server/streamableHttp.js` (`{ sessionIdGenerator: undefined }` = stateless); `createMcpExpressApp()` from `@modelcontextprotocol/sdk/server/express.js` adds Host validation.
- Test client: `Client` from `@modelcontextprotocol/sdk/client/index.js`; `StdioClientTransport({ command, args, env, cwd })` from `@modelcontextprotocol/sdk/client/stdio.js`; `InMemoryTransport.createLinkedPair()` from `@modelcontextprotocol/sdk/inMemory.js`; `client.listTools()`, `client.callTool({ name, arguments })` (2nd positional arg is a result schema in v1).
- Spec `ToolAnnotations`: `readOnlyHint` (default false), `destructiveHint` (default true), `idempotentHint` (default false), `openWorldHint` (default true). Hints only; clients treat them as untrusted.
- Tool names: 1–128 chars, `[A-Za-z0-9_.-]`.

## Sources
- https://github.com/modelcontextprotocol/typescript-sdk (README, v2)
- https://registry.npmjs.org/@modelcontextprotocol/sdk/latest
- https://raw.githubusercontent.com/modelcontextprotocol/typescript-sdk/v1.x/{README.md,docs/server.md,docs/client.md,src/server/mcp.ts,src/client/index.ts,src/client/stdio.ts,src/inMemory.ts,src/examples/server/simpleStatelessStreamableHttp.ts}
- https://modelcontextprotocol.io/specification/latest/server/tools
- https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/schema/2025-06-18/schema.ts
- https://ts.sdk.modelcontextprotocol.io/v2/ (testing, clients, migration/upgrade-to-v2)
