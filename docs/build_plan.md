# Build plan (reconstructed)

> ASSUMPTION: the approved build plan referenced in the request was not present in the repository, on disk, or in any connected service at session start. This document reconstructs it from the request text. Sections 2 and 3 are treated as the contract. Where the original plan may have named a library, this reconstruction records the choice actually made and why.

## 1. Goal
An installable TypeScript MCP server for Extensiv 3PL Warehouse Manager, built on a reusable core with an Extensiv adapter, verified end to end against a local mock of the public API, and ready to point at the real API with a one-value configuration change.

## 2. Contract: behaviour
| # | Requirement | Where it is met |
|---|---|---|
| 2.1 | Sixteen task-shaped tools, not endpoint wrappers | `packages/core/src/tools/read_tools.ts` (11), `write_tools.ts` (5). Tool list in `docs/architecture.md`. |
| 2.2 | Read-only by default; write tools unregistered unless explicitly enabled | `createWmsMcpServer` registers `WRITE_TOOLS` only when `ScopePolicy.writesEnabled`; `EXTENSIV_MCP_WRITES_ENABLED=true` also requires `EXTENSIV_MCP_WRITE_CUSTOMER_IDS`. |
| 2.3 | Two-phase prepare-and-commit on every mutation | `MutationEngine.prepare` (adapter plans, no write) and `MutationEngine.commit`. The four prepare tools return a `change_id`; only `commit_change` writes. |
| 2.4 | Idempotency keys make replays no-ops | Change ids are the idempotency handle: a committed change replays from the stored outcome. Prepare accepts a client `idempotency_key` and dedupes identical intents by fingerprint. Upstream natural keys (reference number per customer) are looked up before any POST. |
| 2.5 | Webhook ingest as its own process | `packages/webhook-ingest` (`extensiv-webhook-ingest` bin) writes `events.jsonl`; the server's `recent_events` tool reads it. |
| 2.6 | One-value switch to the live API | `EXTENSIV_BASE_URL` (mock: `http://127.0.0.1:4010`; production: `https://secure-wms.com`). The token URL derives from it. Changes prepared against one base URL cannot be committed against another. |
| 2.7 | Mock is a deliverable with cited behaviours and flagged guesses | `packages/mock-extensiv` with `MOCK_FIDELITY.md`; every handler cites `// SOURCE:` or flags `// GUESS:`. |
| 2.8 | Scope enforcement | `ScopePolicy`: read allowlists, explicit write allowlists, re-checked at commit. |
| 2.9 | Blast-radius caps | Lines/units per mutation capped by config. |
| 2.10 | Audit | `audit.jsonl` records every tool call, prepare, commit, replay and refusal. |

## 3. Contract: structure
| Package | npm name | Role |
|---|---|---|
| `packages/core` | `@mcp-3pl/core` | WMS-agnostic domain model, adapter interface, policy, mutation engine, stores, HTTP client base, the 16 tools, server factory. |
| `packages/adapter-extensiv` | `@mcp-3pl/adapter-extensiv` | OAuth client-credentials auth, HAL/RQL translation, mapping to the domain model, mutation planning/execution against Extensiv endpoints. |
| `packages/server` | `extensiv-mcp-server` (bin `extensiv-mcp`) | Installable entry point: stdio and Streamable HTTP transports, `--check`, `--print-config`. |
| `packages/webhook-ingest` | `@mcp-3pl/webhook-ingest` (bin `extensiv-webhook-ingest`) | Separate webhook receiver with signature verification. |
| `packages/mock-extensiv` | `@mcp-3pl/mock-extensiv` (bin `extensiv-mock`) | Local mock API with fault injection and webhook emission. |
| `evals/` | | 25-prompt tool-selection eval suite and runner. |
| `docs/` | | Runbook, sign-off template, inquiry email draft, verification status, research notes. |

## 4. Library choices (freedom exercised)
| Choice | Reason |
|---|---|
| `@modelcontextprotocol/sdk` 1.30 (v1 line) | Stable, documented, wire-compatible with v2 clients; v2 split packages shipped days ago. See `docs/research/mcp_sdk_notes.md`. |
| zod v4 (`zod/v4`) | SDK's internal schema library; one dependency for config, tool input and wire validation. |
| Hono + `@hono/node-server` | Tiny, testable via `app.request()` without sockets; used by mock and webhook ingest. SDK already depends on Hono. |
| Express (server HTTP transport only) | The SDK's `createMcpExpressApp` provides Host validation for Streamable HTTP. |
| JSONL files for change/event/audit stores | Two processes share the event file without a database; crash-safe append; trivial to inspect during sign-off. |
| vitest | Fast, ESM-native. |
| pnpm workspaces + TS project references | Package isolation with a single install. |

## 5. Verification plan
1. Unit tests per package (core engine/policy/http, adapter mapping/auth, mock RQL/ETag/webhooks, ingest signature).
2. Integration: server + adapter against the mock, every tool called through a real MCP client (in-memory and stdio).
3. Attacks: replayed write, out-of-scope write, writes disabled, 401 mid-call, 412 version conflict, lost response on POST, 429.
4. Eval suite: 25 prompts scored on first tool selected.
5. Three review passes with fixes, recorded in `docs/verification_status.md`.
