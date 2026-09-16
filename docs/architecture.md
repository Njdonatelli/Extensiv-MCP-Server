# Architecture

## Processes
```
+-------------------+      stdio / streamable HTTP      +---------------------------+
|  MCP client       | <-------------------------------> |  extensiv-mcp (server)    |
|  (Claude, IDE)    |                                   |  core + adapter-extensiv  |
+-------------------+                                   +------------+--------------+
                                                                     | HTTPS (bearer)
                                                                     v
                                                        +---------------------------+
                                                        | Extensiv 3PLWM REST API   |
                                                        | or packages/mock-extensiv |
                                                        +------------+--------------+
                                                                     | webhooks (signed POST)
                                                                     v
+-------------------+        events.jsonl (append)      +---------------------------+
|  recent_events    | <-------------------------------- | extensiv-webhook-ingest   |
|  tool (reader)    |                                   | (separate process)        |
+-------------------+                                   +---------------------------+
```
State directory (`EXTENSIV_MCP_STATE_DIR`, default `.state/`): `changes.jsonl` (prepared/committed changes), `audit.jsonl` (every call and outcome), `events.jsonl` (webhook events).

## Layers
| Layer | Package | Knows about |
|---|---|---|
| Tools + policy + engine | `@mcp-3pl/core` | The domain model only. Never a URL, never a wire field. |
| Adapter | `@mcp-3pl/adapter-extensiv` | Extensiv auth, HAL envelopes, RQL, ETags, error bodies; maps to the domain model; plans and executes mutations. |
| Entry point | `extensiv-mcp-server` | Config loading, transports, CLI flags. |
| Ingest | `@mcp-3pl/webhook-ingest` | Extensiv webhook payload + signature; writes domain `WmsEvent`s. |
| Mock | `@mcp-3pl/mock-extensiv` | Extensiv wire format, replicated from the public docs with citations. |

A second warehouse system would add one adapter package and one entry point; core and its tests are reused unchanged.

## The 16 tools
| # | Tool | Kind | Task it answers |
|---|---|---|---|
| 1 | `verify_connection` | read | "Are we connected, to what, and can we write?" |
| 2 | `describe_scope` | read | "Which customers/warehouses can you see or change?" |
| 3 | `find_orders` | read | "Show me Acme's open orders from last week." |
| 4 | `get_order_status` | read | "What happened to ACME-SO-10007, did it ship?" |
| 5 | `find_stuck_orders` | read | "What can't ship and why?" |
| 6 | `check_inventory` | read | "How many tents are available at LAX? What's low?" |
| 7 | `lookup_item` | read | "Is this SKU lot tracked, what are the dims?" |
| 8 | `find_receipts` | read | "What inbound is due this week?" |
| 9 | `get_receipt_status` | read | "What was short on receipt 88213?" |
| 10 | `operations_summary` | read | "Today's rundown for Acme." |
| 11 | `recent_events` | read | "What shipped in the last two hours (webhook feed)?" |
| 12 | `create_order` | prepare | "Set up an order…" (preview only) |
| 13 | `update_order` | prepare | "Change the ship-to on…" (preview only) |
| 14 | `cancel_order` | prepare | "Cancel order…" (preview only) |
| 15 | `create_receipt` | prepare | "Acme has 480 units arriving Thursday…" (preview only) |
| 16 | `commit_change` | commit | "Yes, go ahead." The only tool that writes. |

Tools 12–16 are not registered unless `EXTENSIV_MCP_WRITES_ENABLED=true` and `EXTENSIV_MCP_WRITE_CUSTOMER_IDS` is set. Shipping, confirming receipts, releasing holds and inventory adjustments are deliberately not exposed.

## Two-phase mutation lifecycle
```
prepare tool ──► adapter.planMutation (reads only) ──► policy.assertWrite ──► caps ──► store ChangeRecord(prepared)
                                                                                          │ change_id + preview
commit_change ──► load record ──► replay? return stored outcome
                              ──► expired/discarded/failed/other env? refuse
                              ──► policy.assertWrite again
                              ──► adapter.findApplied (natural key) ──► found? record committed (found_existing)
                              ──► adapter.checkPreconditions (fresh version/status) ──► failed? record failed, refuse
                              ──► adapter.executeMutation (exactly once)
                                    ├─ ok ──► record committed (executed)
                                    └─ lost response ──► record outcome_unknown; next commit reconciles by natural key
```
Idempotency layers:
1. `change_id` replay → stored outcome, no write.
2. Client `idempotency_key` and intent fingerprint → same change id on repeated prepare.
3. Upstream natural key (customer + reference number) checked before every create; already-cancelled orders commit as no-ops; updates carry `If-Match` so a stale preview fails with 412 rather than overwriting.
4. In-process coalescing of concurrent commits of one id.

## Scope policy
| Setting | Effect |
|---|---|
| `EXTENSIV_MCP_ALLOWED_CUSTOMER_IDS` / `..._FACILITY_IDS` | Reads outside the list are refused; lists are filtered. Empty = everything the credential can see. |
| `EXTENSIV_MCP_WRITES_ENABLED` | Registers write tools. |
| `EXTENSIV_MCP_WRITE_CUSTOMER_IDS` (+ `_FACILITY_IDS`) | Writes to other customers are refused at prepare and again at commit. Never implicit. |
| `EXTENSIV_MCP_MAX_LINES_PER_MUTATION`, `..._UNITS_...` | Blast-radius caps. |
| `EXTENSIV_MCP_CHANGE_TTL_SECONDS` | Prepared changes expire (default 15 minutes). |

## Failure handling in the HTTP layer
| Upstream signal | Behaviour |
|---|---|
| 401 mid-call | Invalidate token, log in once, replay the request; second 401 → `AUTH_FAILED`. |
| 429 | Wait `Retry-After` (capped), retry up to `EXTENSIV_MAX_RETRIES`; beyond the cap → `RATE_LIMITED`. |
| 5xx / network on GET | Bounded exponential backoff. |
| network failure on POST/PUT | `OUTCOME_UNKNOWN`; the engine marks the change and reconciles by natural key on the next commit. |
| 412 on PUT/operator | `PRECONDITION_FAILED`; operator must re-prepare. |

## Error contract to the model
Every tool error is `{ error: { code, message, hint?, retryable, details? } }` with `isError: true`. Codes: `AUTH_FAILED, SCOPE_DENIED, WRITES_DISABLED, NOT_FOUND, AMBIGUOUS, VALIDATION, PRECONDITION_FAILED, CHANGE_EXPIRED, CHANGE_UNKNOWN, CHANGE_NOT_COMMITTABLE, RATE_LIMITED, UPSTREAM_ERROR, UPSTREAM_UNAVAILABLE, OUTCOME_UNKNOWN, INTERNAL`.

## Known limitations

**Argument-schema violations are not audited.** Each tool is registered with its full zod schema so the model receives an accurate JSON Schema. The MCP SDK validates arguments against that schema before the handler runs, so a malformed call returns the SDK's own `Input validation error: …` text rather than this server's `{ error: { code: 'VALIDATION', … } }` shape, and no audit entry is written. Registering a permissive schema instead would restore both, at the cost of hiding every argument's type and description from the model, which is a worse trade for a server whose whole point is that the model picks the right tool with the right arguments. A malformed call never reaches the warehouse system, so the gap is in observability of client bugs, not in write safety. The SDK exposes no tool-call middleware in 1.30 that would let us have both.

**Cross-field requirements are invisible to the model unless the description says so.** A zod `.refine()` is dropped when the schema is converted to JSON Schema. Every such requirement is therefore stated in the field and tool descriptions, and `get_order_status`, `get_receipt_status` and `update_order` each carry theirs. Adding a new refined schema means adding the sentence too.

**A change is bound to its tenant, not just its base URL.** Two Extensiv tenants share `https://secure-wms.com` and differ only by credentials, and two server instances launched from one directory share a state directory. `ChangeRecord.target` therefore carries the system, the base URL, the environment label and a non-secret digest of the credential (`AdapterInfo.tenantKey`), and a commit is refused unless all four match. Give each tenant its own `EXTENSIV_MCP_STATE_DIR` as well.

**Committed changes are reused only for creates.** A prepared change is deduped by intent so a double-submit cannot write twice. That reuse extends past the commit only for `create_order` and `create_receipt`, which have a natural key that makes "already done" meaningful. `update_order` and `cancel_order` are repeatable intents: setting a field back to a value it previously held is byte-identical to the earlier request and must write again.
