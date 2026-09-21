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
State directory (`EXTENSIV_MCP_STATE_DIR`, default `.state/`): `changes.jsonl` (prepared/committed changes), `audit.jsonl` (every call and outcome), `events.jsonl` (webhook events). All three are append-only JSONL, re-read from the tail, so a second process may append while the server reads. `audit.jsonl` records arguments for the write tools and on the error path only, capped at 1000 characters of JSON (see the tool input contract). `events.jsonl` is deduped by event id.

## Transports
`--stdio` (the default) is one server process per client. Streamable HTTP (`EXTENSIV_MCP_HTTP_HOST` / `EXTENSIV_MCP_HTTP_PORT`, default `127.0.0.1:3333`) serves `POST /mcp`, `GET /mcp` (the notification stream), `DELETE /mcp` and `GET /healthz`, with one MCP server instance per session and one shared adapter, change store, event store and audit log behind them.

**The HTTP endpoint has no authentication of any kind.** No bearer, no allow-list, nothing: whoever can open a socket to it gets every registered read tool, and every write tool that is enabled, against this warehouse system. On loopback the operating system has already answered the question of who that is. Off it nothing has, so a non-loopback bind is refused with `VALIDATION` unless `EXTENSIV_MCP_HTTP_ALLOW_REMOTE=true` states the exposure is deliberate — a breaking change for an existing `0.0.0.0` deployment. The supported way to reach the server from another host is an authenticating reverse proxy in front of a loopback bind, or an SSH tunnel.

| HTTP transport setting | Default | Effect |
|---|---|---|
| `EXTENSIV_MCP_HTTP_ALLOW_REMOTE` | `false` | Permits a bind to a host outside 127.0.0.0/8 and `::1`. Without it such a bind is refused. |
| `EXTENSIV_MCP_HTTP_SESSION_IDLE_SECONDS` | `900` | A session with no request and no open notification stream for this long is closed. |
| `EXTENSIV_MCP_HTTP_MAX_SESSIONS` | `64` | Cap on concurrent sessions. |

These three are read from the environment inside `packages/server/src/transports.ts` rather than through `CoreConfigSchema`, because they guard the bind and the session table and that file owns both end to end; the names follow the same convention as the core keys. They are therefore **not** printed by `--print-config`. An unusable value throws `Invalid HTTP transport configuration: <VAR>: <issue>` before anything binds.

| HTTP transport failure | Behaviour |
|---|---|
| Bind fails (port in use, address not local, permission) | Host, port, `code`, `errno` and `syscall` are logged and the process exits non-zero. It no longer logs `streamable http transport listening` and exits 0 with nothing bound. |
| Malformed JSON body | `400` with `{"jsonrpc":"2.0","error":{"code":-32700,…},"id":null}` as `application/json`, never Express's default HTML stack trace, which handed an unauthenticated caller absolute on-disk paths. Other body faults answer `-32000` in the same shape, anything else `-32603`. |
| `Mcp-Session-Id` present but unknown | `404` with JSON-RPC `-32001`. |
| Session cap reached | `503` with JSON-RPC `-32000` naming `EXTENSIV_MCP_HTTP_MAX_SESSIONS`. A live session is never evicted to make room: it belongs to a client mid-conversation, and an unauthenticated caller must not be able to push it out. |
| Session idle past the timeout | Swept — transport and server closed, and the client has to `initialize` again. A session holding an open `GET /mcp` notification stream is not swept while that stream is open, since such a stream is quiet by design and arrival time alone would reap a healthy client. |

## Layers
| Layer | Package | Knows about |
|---|---|---|
| Tools + policy + engine | `@mcp-3pl/core` | The domain model only. Never a URL, never a wire field. |
| Adapter | `@mcp-3pl/adapter-extensiv` | Extensiv auth, HAL envelopes, RQL, ETags, error bodies; maps to the domain model; plans and executes mutations. |
| Entry point | `extensiv-mcp-server` | Config loading, transports, CLI flags. |
| Ingest | `@mcp-3pl/webhook-ingest` | Extensiv webhook payload + signature; writes domain `WmsEvent`s. |
| Mock | `@mcp-3pl/mock-extensiv` | Extensiv wire format, replicated from the public docs with citations. |

A second warehouse system would add one adapter package and one entry point; core and its tests are reused unchanged.

All five publishable packages declare `engines: { "node": ">=20" }` and an `exports` map, and each build script marks its `dist/cli.js` executable — so a freshly cloned repository must be built (`pnpm build`) before any CLI can be run directly. The mock serves `GET /events/webhook/key` without a bearer token, matching the real API, where a receiver must bootstrap trust before it holds any credential; every other mock route stays bearer-gated. That pairing is what lets the shipped mock CLI and the shipped webhook-ingest CLI verify signatures and store events out of the box instead of rejecting every delivery with 401.

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

Three read tools qualify what they return, and the qualification is part of the answer, not a footnote:
- `describe_scope` and `check_inventory` filter the records they echo, not only the list they return (see Scope policy).
- `get_receipt_status` counts a quantity as received only once the record says the goods arrived. It returns `arrived`, and when that is false an `outstandingNote` saying that nothing has landed so no line can be short, with `varianceLines: 0` and an empty `variances` (see Known limitations — the underlying reading of the wire field is a guess).
- `recent_events` reports `withheldUnattributedInWindow`, which counts only events carrying no customer link at all (see Scope policy).

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
| `EXTENSIV_MCP_ALLOWED_CUSTOMER_IDS` / `..._FACILITY_IDS` | Reads outside the list are refused; lists *and the records inside them* are filtered. Empty = everything the credential can see. |
| `EXTENSIV_MCP_WRITES_ENABLED` | Registers write tools. |
| `EXTENSIV_MCP_WRITE_CUSTOMER_IDS` (+ `_FACILITY_IDS`) | Writes to other customers are refused at prepare and again at commit. Never implicit. |
| `EXTENSIV_MCP_MAX_LINES_PER_MUTATION`, `..._UNITS_...` | Blast-radius caps. |
| `EXTENSIV_MCP_CHANGE_TTL_SECONDS` | Prepared changes expire (default 15 minutes). |

**Read scope is enforced on every record echoed, not only on the top-level list.** A filter that stops at the list leaks through the objects inside it: `describe_scope` named out-of-scope facilities inside each `customers[]` record while counting those same facilities under `hiddenByPolicy`, and `check_inventory` returned stock rows for facilities whose id the same server refuses as an argument. Both now run the nested facility list through the read policy too.

`recent_events` drops an event attributed to an out-of-scope customer without counting it anywhere. Counted, the response was an existence oracle: a probe of an out-of-scope `reference_num` answered 1 where an unused reference answered 0 — the very thing `recent_events{customer_id}` refuses with `SCOPE_DENIED`. What remains is `withheldUnattributedInWindow`, plus a `withheldNote` sentence when it is non-zero. It counts only events with no customer link at all, and it is taken over the whole `since`..now window, ignoring the call's `event_types`, `customer_id` and `reference_num`: computed after the caller's filters it would vary with the probe in the same way. It replaces the field previously called `withheldUnattributed`, which no longer exists.

## Failure handling in the upstream HTTP layer
| Upstream signal | Behaviour |
|---|---|
| 401 mid-call | Invalidate token, log in once, replay the request; second 401 → `AUTH_FAILED`, carrying the auth server's own reason (see the error contract). |
| 429 | Wait `Retry-After` (capped), retry up to `EXTENSIV_MAX_RETRIES`; beyond the cap → `RATE_LIMITED`. |
| 5xx / network on GET | Bounded exponential backoff. |
| network failure on POST/PUT | `OUTCOME_UNKNOWN`; the engine marks the change and reconciles by natural key on the next commit. |
| 412 on PUT/operator | `PRECONDITION_FAILED`; operator must re-prepare. |

## Tool input contract
Arguments are validated before anything upstream is called, and the rules the model must follow reach it as JSON Schema.

Every argument typed `common.isoDate` — `create_order` / `update_order` `earliest_ship_date`, `create_receipt` `expected_date` and each line's `expirationDate`, `find_orders` `created_after` / `created_before` / `shipped_after` / `shipped_before`, `find_receipts` `expected_after` / `expected_before` / `created_after`, `operations_summary` `day`, `recent_events` `since` — must be a date (`2026-09-16`) or a date-time with optional seconds, optional fractional seconds and an optional `Z` or numeric offset (`2026-09-16T14:30Z`, `2026-09-16T04:00:00-07:00`). Partial dates (`2026`, `2026-09`), US-style `09/16/2026` and relative words (`today`, `yesterday`) are refused as `VALIDATION`, with a message naming the field and the accepted shapes. The field used to accept any string of four or more characters, so `earliest_ship_date: "today"` — what a model writes when the operator says "ship it today" — was stored verbatim as the order's earliest ship date in the warehouse system.

The rule is a zod `.regex()` deliberately. `.regex()` survives the conversion to JSON Schema as `pattern`, so the model is shown the format; a `.refine()` is dropped in that conversion, and the model would never see the very format it keeps getting wrong (see the second known limitation).

`AuditEntry.input` is capped at 1000 characters of JSON. Beyond that the entry records a truncated JSON *string* ending in an ellipsis rather than the argument object. The audit log is what an operator reconstructs an incident from, and recording arguments verbatim let one call append as many bytes as a client chose to send — a 200 000-character `reference_num_contains` grew `audit.jsonl` by 200 kB — so a buggy or hostile client could bury the record that matters.

## Error contract to the model
Every tool error is `{ error: { code, message, hint?, retryable, details? } }` with `isError: true`. Codes: `AUTH_FAILED, SCOPE_DENIED, WRITES_DISABLED, NOT_FOUND, AMBIGUOUS, VALIDATION, PRECONDITION_FAILED, CHANGE_EXPIRED, CHANGE_UNKNOWN, CHANGE_NOT_COMMITTABLE, RATE_LIMITED, UPSTREAM_ERROR, UPSTREAM_UNAVAILABLE, OUTCOME_UNKNOWN, INTERNAL`.

`VALIDATION` also covers a date argument in the wrong format, refused locally without spending an upstream round trip on it.

`AUTH_FAILED` now carries the reason the auth server gave. A credential-free probe of `POST https://secure-wms.com/AuthServer/api/Token` with deliberately fake credentials, run against production on 2026-09-21, answered HTTP 401 with an ASP.NET body `{"Message":"invalid_client: client not registered"}` — not the OAuth2 `400` + `{"error"}` shape the code comment and the research notes had assumed. Whichever of `Message`, `error` or `error_description` is present is read, a non-JSON body is tolerated, the text is bounded to 160 characters, control characters are collapsed and our own client secret is redacted out of it. The message then reads `Extensiv rejected the API credentials (HTTP 401, invalid_client: client not registered).`, which is what tells an unregistered client id apart from a disabled credential or a bad `user_login`. The trade is worth stating plainly: bounded, sanitised upstream text now reaches a model-visible message where previously none did. The structured log line `extensiv login rejected` renamed its meta key from `error` to `reason` and carries the same text — operator tooling grepping the old key must switch.

## Known limitations

**Argument-schema violations are not audited.** Each tool is registered with its full zod schema so the model receives an accurate JSON Schema. The MCP SDK validates arguments against that schema before the handler runs, so a malformed call returns the SDK's own `Input validation error: …` text rather than this server's `{ error: { code: 'VALIDATION', … } }` shape, and no audit entry is written. `runTool` re-validates with the same schema and does produce the `VALIDATION` shape and an audit entry, but only for a call that reaches it — which, through the SDK, a schema violation never does. The date rules in the tool input contract ride on that same schema, so a `today` is refused either way and with the same wording; only the envelope and the audit entry differ. That audit entry, when it is written, is also the one that carries no `input` at all, so the 1000-character cap never applies to it. Registering a permissive schema instead would restore both, at the cost of hiding every argument's type and description from the model, which is a worse trade for a server whose whole point is that the model picks the right tool with the right arguments. A malformed call never reaches the warehouse system, so the gap is in observability of client bugs, not in write safety. The SDK exposes no tool-call middleware in 1.30 that would let us have both.

**Cross-field requirements are invisible to the model unless the description says so.** A zod `.refine()` is dropped when the schema is converted to JSON Schema. Every such requirement is therefore stated in the field and tool descriptions, and `get_order_status`, `get_receipt_status` and `update_order` each carry theirs. Adding a new refined schema means adding the sentence too. A single-field format rule has the better option available and takes it: `common.isoDate` uses `.regex()`, which does survive as `pattern`.

**A change is bound to its tenant, not just its base URL.** Two Extensiv tenants share `https://secure-wms.com` and differ only by credentials, and two server instances launched from one directory share a state directory. `ChangeRecord.target` therefore carries the system, the base URL, the environment label and a non-secret digest of the credential (`AdapterInfo.tenantKey`), and a commit is refused unless all four match. Give each tenant its own `EXTENSIV_MCP_STATE_DIR` as well.

**Received quantities before arrival rest on a GUESS about the real API.** The receipt mapping reports `qtyReceived: 0`, `totalReceivedQty: 0` and a per-line variance of `-qtyExpected` — the quantity still outstanding — until the receiver itself says the goods landed: status Closed, or a stamped `arrivalDate`. A cancelled receiver never reports a received quantity. That is what stops "what was short on the last delivery?" being answered with an entire un-arrived ASN, which is how it read before: an open ASN where nothing had physically arrived reported full receipt and zero variance on every line. But no rel page states whether a receive item holds stock before the confirmer runs. `ReceiveItem.qty` on an un-arrived receiver is *assumed* to be a plan rather than an arrival, inferred from an unconfirmed ASN coming back with `qty == expectedQty` and inventory levels of 0/0; the assumption was made without live credentials. RE-VERIFY it the moment real Extensiv credentials exist: if real 3PLWM lets a warehouse key partial quantities into an open receiver, this now under-reports them.

**Event dedupe is guaranteed within one ingest process, not across two.** `JsonlEventStore.append` does its id check inside the serialised write queue, so N concurrent first-time appends of one event id produce exactly one line and exactly one `inserted: true`; outside the queue they all saw an unclaimed id and each wrote its own. The webhook-ingest `duplicate` flag is therefore true for any delivery of an id already stored *or* being stored concurrently, and a verified delivery increments exactly one of `stats.stored` and `stats.duplicates`, so `/healthz` no longer counts one event id as two stored events. Durability is still ordered ahead of memory: the id is committed to the in-memory set only after the append reaches disk, so a failed write leaves the id unclaimed and a retried delivery is still stored. Two ingest processes appending to one `events.jsonl` share no queue and can still each write a line for one id; the reader dedupes on id when it re-scans the tail, so a query answers correctly and the file carries the duplicate line. Run one ingest process per events file.

`ChangeStore.put` has the inverse ordering — it commits the record to memory first and then queues the disk write (it still awaits it) — so a change record whose append fails is present in memory for the life of the process, where an event whose append fails is not. Neither ordering has been changed; the asymmetry is recorded here because it is easy to read one store and assume the other.

**Nothing authenticates to this server.** The adapter authenticates *to* Extensiv; the MCP endpoint has no credential of its own. Over stdio the client is the process that launched it, so the question is already answered. Over Streamable HTTP it is not answered at all, which is why a non-loopback bind is refused unless `EXTENSIV_MCP_HTTP_ALLOW_REMOTE=true` and why the remote path is an authenticating proxy or an SSH tunnel. The session cap and the idle sweep bound what an unauthenticated caller can consume; they do not keep one out.

**Committed changes are reused only for creates.** A prepared change is deduped by intent so a double-submit cannot write twice. That reuse extends past the commit only for `create_order` and `create_receipt`, which have a natural key that makes "already done" meaningful. `update_order` and `cancel_order` are repeatable intents: setting a field back to a value it previously held is byte-identical to the earlier request and must write again.
