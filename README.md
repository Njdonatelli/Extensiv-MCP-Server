# Extensiv 3PL MCP server

An installable MCP server that exposes [Extensiv 3PL Warehouse Manager](https://www.extensiv.com/) to an assistant through **sixteen task-shaped tools**. Read-only by default. Every mutation is two-phase: a prepare tool returns a preview and a `change_id`, and nothing is written until `commit_change` is called with that id. Commits are idempotent, scoped to an explicit customer allowlist, and written to an audit log.

It is built on a reusable, WMS-agnostic core, so a second warehouse system means one new adapter package rather than a rewrite.

> **Status:** verified end to end against a local mock of the Extensiv REST API written from the public documentation. It has **not** been run against real Extensiv credentials. See [`docs/verification_status.md`](docs/verification_status.md) for exactly what is proven and what waits on credentials, and [`packages/mock-extensiv/MOCK_FIDELITY.md`](packages/mock-extensiv/MOCK_FIDELITY.md) for every mocked behaviour with its doc source. 324 tests pass across the workspace; 32 mocked behaviours are flagged as outright guesses and 12 as inferred.

## Packages

| Package | Name | Role |
|---|---|---|
| `packages/core` | `@mcp-3pl/core` | Domain model, adapter contract, scope policy, two-phase mutation engine, stores, HTTP client, the 16 tools, server factory. Knows nothing about Extensiv. |
| `packages/adapter-extensiv` | `@mcp-3pl/adapter-extensiv` | OAuth2 client-credentials auth, HAL + RQL translation, ETag concurrency, mapping to the domain model, mutation planning and execution. |
| `packages/server` | `extensiv-mcp-server` (bin `extensiv-mcp`) | The installable entry point: stdio and Streamable HTTP transports, `--check`, `--print-config`. |
| `packages/webhook-ingest` | `@mcp-3pl/webhook-ingest` (bin `extensiv-webhook-ingest`) | Separate process that receives Extensiv webhooks, verifies the RSA signature, and appends events the server reads. |
| `packages/mock-extensiv` | `@mcp-3pl/mock-extensiv` (bin `extensiv-mock`) | Local mock of the real API with fault injection and signed webhook emission. A deliverable, not a stub. |
| `evals/` | | 25-prompt tool-selection eval suite, runner and recorded results. |

## The sixteen tools

Read tools (always registered): `verify_connection`, `describe_scope`, `find_orders`, `get_order_status`, `find_stuck_orders`, `check_inventory`, `lookup_item`, `find_receipts`, `get_receipt_status`, `operations_summary`, `recent_events`.

Write tools (registered **only** when writes are enabled): `create_order`, `update_order`, `cancel_order`, `create_receipt` all **prepare only**, plus `commit_change`, the single tool that writes.

Shipping and confirming orders, confirming receipts, releasing holds and adjusting inventory are deliberately not exposed. See [`docs/architecture.md`](docs/architecture.md) for what each tool answers and the full mutation lifecycle.

## Install and run

Requires Node 20 or newer (developed on 22) and pnpm 10.

```bash
pnpm install
pnpm build
```

Start against the local mock, in one shell (Bash/Zsh):

```bash
pnpm --filter @mcp-3pl/mock-extensiv start
```
Expected output: `Mock Extensiv API listening on http://127.0.0.1:4010`

Then check the server's connection in another shell (Bash/Zsh):

```bash
EXTENSIV_BASE_URL=http://127.0.0.1:4010 \
EXTENSIV_CLIENT_ID=mock-client-id \
EXTENSIV_CLIENT_SECRET=mock-client-secret \
EXTENSIV_USER_LOGIN=mock-integration-user \
node packages/server/dist/cli.js --check
```
Expected output: JSON with `"ok": true`, `"environmentLabel": "mock (local)"` and `"registeredTools"` listing 11 tool names.

### Pointing at the real API

Change **one value**: `EXTENSIV_BASE_URL=https://secure-wms.com`, and supply real credentials. The token URL is derived from it (`${EXTENSIV_BASE_URL}/AuthServer/api/Token`) unless `EXTENSIV_AUTH_URL` overrides it. A change prepared against one base URL cannot be committed against another, so a mock-era `change_id` can never fire against production.

[`docs/credential_runbook.md`](docs/credential_runbook.md) is the step-by-step for a 3PL admin obtaining those credentials.

### Registering with an MCP client

```json
{
  "mcpServers": {
    "extensiv": {
      "command": "node",
      "args": ["/path/to/MCP-Server-Extensiv/packages/server/dist/cli.js"],
      "env": {
        "EXTENSIV_BASE_URL": "https://secure-wms.com",
        "EXTENSIV_CLIENT_ID": "…",
        "EXTENSIV_CLIENT_SECRET": "…",
        "EXTENSIV_USER_LOGIN": "…",
        "EXTENSIV_MCP_STATE_DIR": "/var/lib/extensiv-mcp"
      }
    }
  }
}
```

Nothing in the server writes to stdout except the MCP protocol itself; all logging goes to stderr as JSON with credential-shaped values redacted.

## Configuration

### Connection (adapter)

| Variable | Default | Meaning |
|---|---|---|
| `EXTENSIV_BASE_URL` | `https://secure-wms.com` | The one value to change to switch environments. |
| `EXTENSIV_AUTH_URL` | `${EXTENSIV_BASE_URL}/AuthServer/api/Token` | Override only if the token host differs. |
| `EXTENSIV_CLIENT_ID` | — | Required. From Support Portal, Manage Credentials. |
| `EXTENSIV_CLIENT_SECRET` | — | Required. Never logged. |
| `EXTENSIV_USER_LOGIN` | — | Required. The integration user's 3PL Warehouse Manager ID, sent as `user_login`. |
| `EXTENSIV_TPL_GUID` | unset | Sent as `tpl`; only for single-tenant dynamic credentials. |
| `EXTENSIV_TOKEN_REFRESH_MARGIN_SECONDS` | `300` | Refresh this long before the token's stated expiry. |
| `EXTENSIV_HTTP_TIMEOUT_MS` | `30000` | Per-request timeout. |
| `EXTENSIV_MAX_RETRIES` | `3` | Retries for 429 and, on idempotent requests, 5xx and network errors. |

### Policy and behaviour (core)

| Variable | Default | Meaning |
|---|---|---|
| `EXTENSIV_MCP_WRITES_ENABLED` | `false` | When false the five write tools are **not registered at all**. |
| `EXTENSIV_MCP_WRITE_CUSTOMER_IDS` | — | **Required** when writes are enabled. Explicit customer allowlist; never implicit. |
| `EXTENSIV_MCP_WRITE_FACILITY_IDS` | unset | Optional further narrowing of writable facilities. |
| `EXTENSIV_MCP_ALLOWED_CUSTOMER_IDS` | all | Read scope. Empty means everything the credential can see. |
| `EXTENSIV_MCP_ALLOWED_FACILITY_IDS` | all | Read scope for facilities. |
| `EXTENSIV_MCP_MAX_LINES_PER_MUTATION` | `200` | Blast-radius cap. |
| `EXTENSIV_MCP_MAX_UNITS_PER_MUTATION` | `10000` | Blast-radius cap. |
| `EXTENSIV_MCP_CHANGE_TTL_SECONDS` | `900` | How long a prepared change stays committable. |
| `EXTENSIV_MCP_STATE_DIR` | `.state` | Holds `changes.jsonl`, `audit.jsonl`, `events.jsonl`. |
| `EXTENSIV_MCP_EVENTS_FILE` | `${stateDir}/events.jsonl` | Shared with the webhook-ingest process. |
| `EXTENSIV_MCP_AUDIT_FILE` | `${stateDir}/audit.jsonl` | Append-only audit log. |
| `EXTENSIV_MCP_TRANSPORT` | `stdio` | `stdio` or `http`. |
| `EXTENSIV_MCP_HTTP_HOST` | `127.0.0.1` | Streamable HTTP bind host. |
| `EXTENSIV_MCP_HTTP_PORT` | `3333` | Streamable HTTP port. |
| `EXTENSIV_MCP_LOG_LEVEL` | `info` | `silent`, `error`, `warn`, `info`, `debug`. Logs go to stderr. |
| `EXTENSIV_MCP_ENVIRONMENT_LABEL` | detected | Overrides the label shown on every write preview. |

### Webhook ingest (separate process)

| Variable | Default | Meaning |
|---|---|---|
| `EXTENSIV_WEBHOOK_PORT` | `4020` | Listen port. |
| `EXTENSIV_WEBHOOK_HOST` | `0.0.0.0` | Listen host. |
| `EXTENSIV_WEBHOOK_PATH` | `/webhooks/extensiv` | Delivery path. |
| `EXTENSIV_WEBHOOK_REQUIRE_SIGNATURE` | `true` | Reject deliveries whose RSA-SHA256 `Signature` does not verify. |
| `EXTENSIV_WEBHOOK_STORE_UNVERIFIED` | `false` | Only meaningful when the signature is not required. |
| `EXTENSIV_WEBHOOK_PUBLIC_KEY_PEM` | unset | Pin a key instead of fetching `${base}/events/webhook/key`. |
| `EXTENSIV_WEBHOOK_KEY_CACHE_SECONDS` | `3600` | Key cache lifetime; a verification failure re-fetches immediately. |
| `EXTENSIV_WEBHOOK_INGRESS_TOKEN` | unset | Extra bearer check for a reverse proxy or tunnel. |

Extensiv requires an `https://` destination and a 20x response within 3 seconds, so this process sits behind TLS termination. It answers after a signature check and one file append.

## Safety model

1. **Read-only by default.** Write tools are never registered unless explicitly enabled, so an assistant cannot call what it cannot see.
2. **Explicit write scope.** Enabling writes without a customer allowlist is a startup error.
3. **Two-phase writes.** Prepare validates and previews without touching the upstream system; only `commit_change` writes.
4. **Idempotency in four layers.** Replaying a `change_id` returns the stored outcome; a repeated prepare with the same intent or idempotency key returns the same id; the upstream natural key (customer plus reference number) is checked before every create; updates carry `If-Match` so a stale preview fails instead of overwriting.
5. **Re-checked at commit.** Scope, environment and upstream preconditions are all re-evaluated against live state, so a narrowed policy or a changed order stops the write.
6. **Lost responses are reconciled, never blindly retried.** A dropped connection on a POST yields `OUTCOME_UNKNOWN`; the next commit looks the resource up by reference number first.
7. **Audited.** Every call, prepare, commit, replay and refusal lands in `audit.jsonl`.
8. **Capped.** Lines and units per mutation are bounded.

Before enabling writes in production, fill in [`docs/production_write_signoff.md`](docs/production_write_signoff.md).

## Development

```bash
pnpm install
pnpm build          # tsc -b across packages
pnpm test           # vitest, whole workspace
pnpm typecheck      # tsc -b at the root
pnpm mock           # start the mock API
pnpm evals -- --help
```

## Documentation

| File | What it is |
|---|---|
| [`docs/architecture.md`](docs/architecture.md) | Processes, layers, the 16 tools, mutation lifecycle, failure handling. |
| [`docs/build_plan.md`](docs/build_plan.md) | The contract this repo was built against, and the library choices made. |
| [`docs/verification_status.md`](docs/verification_status.md) | What is verified against the mock versus what waits on credentials. |
| [`docs/credential_runbook.md`](docs/credential_runbook.md) | How a 3PL admin obtains and hands over credentials. |
| [`docs/production_write_signoff.md`](docs/production_write_signoff.md) | Sign-off template before enabling production writes. |
| [`docs/developer_program_inquiry_email.md`](docs/developer_program_inquiry_email.md) | Draft inquiry to Extensiv. Draft only, not sent. |
| [`docs/research/`](docs/research/) | The API, help-centre and MCP SDK research notes, with source URLs, that everything here was built from. |
| [`packages/mock-extensiv/MOCK_FIDELITY.md`](packages/mock-extensiv/MOCK_FIDELITY.md) | Every mocked behaviour, its source, and what to re-verify. |
| [`evals/README.md`](evals/README.md) | Eval scoring rule and runner. |

## License

MIT.
