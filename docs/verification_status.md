# Verification status

What is actually proven about this server, and what is still waiting on real Extensiv credentials. Every row in the verified table names the test or command that demonstrates it; nothing here is claimed because the code "looks right".

**Bottom line.** The server, the reusable core, the Extensiv adapter and the webhook receiver are verified end to end against a local mock of the Extensiv REST API that was written from Extensiv's public documentation. **No call has ever been made to a real Extensiv tenant.** Every row in section 3 is a claim about Extensiv's behaviour that the mock currently makes on Extensiv's behalf.

| | |
|---|---|
| Commit | `44a24e9` |
| Test suite | 313 tests in 22 files, all passing (`npx vitest run`) |
| By package | mock-extensiv 127, adapter-extensiv 85, core 53, server 35 (20 integration + 15 attack), webhook-ingest 7, evals 6 |
| Typecheck and build | `npx tsc -b tsconfig.json` and `pnpm -r --filter './packages/*' run build` both clean |
| Tool-selection eval | 4 runs through a real MCP client against the running server; best 19/25 first-call (76%), 23/25 task-reach (92%) |
| Mock fidelity | 129 behaviours classified across 184 table rows: 85 Documented, 12 Inferred, 32 Guess ([MOCK_FIDELITY.md](../packages/mock-extensiv/MOCK_FIDELITY.md)) |

---

## 1. Verified against the mock

| Claim | How it is verified |
|---|---|
| The installable binary authenticates and reports what it is pointed at | `node packages/server/dist/cli.js --check` against the running mock returns `ok: true`, `environmentLabel: "mock (local)"`, 4 reachable customers, 2 facilities, and the 11 read tools |
| OAuth2 client_credentials exactly as documented: Basic header, `user_login` body, bearer thereafter | mock auth suite (13 tests); adapter auth suite (6) covers caching, the refresh margin, single-flight and invalidation |
| A token that expires mid-session is replaced and the request replayed | `attacks.test.ts` primes the mock to expire every token, then asserts the mock's own request log shows 401, then a token request, then a 200 |
| Bad credentials degrade to a reported problem, not a crash | `attacks.test.ts`: `verify_connection` returns `ok: false` with `AUTH_FAILED`, and the secret never appears in the message |
| 429 with `Retry-After` is waited out; an over-cap wait fails fast | `attacks.test.ts` plus `http_client.test.ts` |
| All 11 read tools return the promised shapes over MCP | `integration.test.ts` drives each one against the mock and asserts on real seeded data, including lots, variances, holds and tracking numbers |
| All 16 tools are reachable through a real MCP client | `integration.test.ts` (in-process client) and 4 eval runs driving the built binary over stdio from a separate process |
| Read-only by default: write tools are not registered at all | `integration.test.ts` asserts exactly 11 tools and no write tool in `tools/list`; 16 when writes are enabled |
| Two-phase writes: prepare touches nothing | `integration.test.ts` asserts the mock received no write request after a prepare |
| Commit writes exactly once; a replay returns the stored outcome | `attacks.test.ts` asserts one `POST /orders` in the mock's request log and an audit log reading `ok` then `replayed` |
| An idempotency key reused with a different intent is refused | `attacks.test.ts` |
| A stale version fails the commit with no write | `attacks.test.ts` moves the order's ETag between prepare and commit |
| ETag semantics: 428 without `If-Match`, 412 when stale | mock etag suite (10 tests) |
| A lost response is reconciled, never blindly retried | `attacks.test.ts` drops the connection on `POST /orders`, asserts `OUTCOME_UNKNOWN`, then a retry that finds the order by reference with exactly one order created |
| Reconciliation refuses to claim a resource whose content differs | adapter suite: an order holding the reference number with different lines raises `PRECONDITION_FAILED` |
| Out-of-scope writes and reads are refused before reaching the API | `attacks.test.ts` asserts `SCOPE_DENIED` and an empty write log; core suite covers names, ids, partial matches and facilities |
| A change prepared against one base URL cannot be committed against another | `attacks.test.ts` builds a second mock and asserts `CHANGE_NOT_COMMITTABLE` |
| Blast-radius caps refuse an oversized mutation | `attacks.test.ts` |
| The client secret never reaches a tool result, the audit log or the change store | `attacks.test.ts` greps all three |
| Webhook deliveries verify against the published key, survive rotation, and dedupe | webhook-ingest suite (7 tests), including a real signature check and a rotation that re-fetches the key once |
| An event ingested by the separate process is visible to `recent_events` | `integration.test.ts` wires the ingest app to the mock's subscription and asserts the event arrives with `verified: true` |
| The mock itself matches the documented wire format | mock suite (127 tests) covering RQL operators and precedence, paging limits per rel, HAL envelopes and rel names, every documented error code, and the write operators |

## 2. Verified by construction or inspection only

| Claim | Why there is no test | Risk if wrong |
|---|---|---|
| Nothing is written to stdout except MCP protocol traffic | Asserted by the logger's design (stderr only) and by the stdio client working, not by a byte-level check | A stray `console.log` would corrupt the stdio transport |
| The Streamable HTTP transport shares one set of stores per process | Covered by a cross-instance store test and the wiring in `cli.ts`; no multi-session HTTP test | A change prepared in one session would be unknown in another |
| Secrets are redacted from logs | `redact()` is unit-covered by key shape, and the attack suite greps the artefacts; log output is not scanned line by line | A credential in a log file |

## 3. Waits on real credentials

Each row is something the mock asserts on Extensiv's behalf. "First check" is what to run on day one; "falsified if" is what a wrong answer looks like, so nobody has to interpret the result.

| # | Assumption the mock encodes | Source or gap | First check with credentials | Falsified if |
|---|---|---|---|---|
| 1 | **A reference number is unique per customer.** The whole idempotency story rests on this: it is the natural key used to reconcile a lost write. | `POST /orders` duplicate `ReferenceNum` is listed under the `Duplicate` error code, but uniqueness is never stated as a constraint | Create an order, then create a second with the same reference for the same customer | The second create succeeds. Then reconciliation could claim the wrong order and the idempotency guarantee is void |
| 2 | The ~20 inferred RQL property names (`readonly.customeridentifier.id`, `readonly.shipdate`, `readonly.onholddate`, `referencenum`, `shipto.name`, `ponum`, `expecteddate`, the stocksummaries and item-master names) | Rels/rql documents the grammar, not the property names per rel | One `find_orders` per filter, one `find_receipts`, one `check_inventory`, one `lookup_item` | 400 `QueryParameterException` / `NotParsable`. This fails loudly, which is the good case |
| 3 | `POST /orders` required fields and the body shape | The verbatim required-field list was truncated in the doc fetch | `create_order` then `commit_change` for one line | 400 `ModelValidationException` `Required` naming a field we do not send |
| 4 | `PUT /orders/{id}?detail=None` leaves the existing lines untouched | Inferred from the `detail` parameter's description | `update_order` changing only notes, then re-read the lines | The lines are emptied or replaced. This would be data loss, so test it on a throwaway order first |
| 5 | Every GET used for a version returns an `ETag` | Rels/headers says single-resource GETs supply one | `get_order_status` and check the version token is present | The version is empty. `cancel_order` now refuses rather than cancelling unprotected |
| 6 | The canceler and confirmer take `If-Match` and answer 204 | Documented, but not exercised | `cancel_order` on a throwaway order | 428 or 412 despite sending the previewed version |
| 7 | `/inventory/stocksummaries` returns no paging links and its rql property names | The sample shows no `_links` | `check_inventory` for a customer with more than one page of SKUs | Rows are missing beyond the first page |
| 8 | Packages appear in `readOnly.packages[]` (the mapping now also reads the embedded rel keys) | Two documented shapes, neither confirmed for `detail=All` | `get_order_status` on a shipped order | Packages or tracking numbers are missing |
| 9 | Token TTL is around an hour; refreshing 5 minutes early is enough | Sample says 3600, help centre says 30 to 60 minutes and varies | Read `tokenExpiresInSeconds` from `verify_connection` | A TTL under 5 minutes would mean the margin re-authenticates on every call |
| 10 | `GET /events/webhook/key` needs no bearer token | The article gives the URL with no auth note; the mock requires one | `curl` the key endpoint with no Authorization header | 401. The ingest process would then need credentials of its own |
| 11 | Event type strings for non-order resources follow `<Resource><Verb>` | Only `OrderConfirm` appears verbatim | Subscribe to receipt and inventory-hold events and read what arrives | The strings differ, so `recent_events` type filters silently match nothing |
| 12 | No rate limiting, because none is documented | 429 appears nowhere in the rel docs | Watch Support Portal, Account, API Usage during a read-heavy day | 429s appear. The client already honours `Retry-After`, but the limits need to inform polling |
| 13 | A sandbox tenant can have REST credentials, at `https://box.secure-wms.com` | Not documented; the Support Portal is listed as unavailable in Sandbox | Ask the CSM. Question 1 of the drafted inquiry email | No sandbox credentials exist, and the first real call is against production data |
| 14 | The role set on the credential covers the endpoints each tool uses | The help centre names roles, never their endpoints | Run every read tool with the read-only role set; `verify_connection` reports a 403 as a problem | A 403 on a tool, naming the missing role |
| 15 | Receipts have no supplier field | `ReceiverCreate` has a `shipTo` block whose meaning on an inbound receipt is undocumented | Ask Extensiv what `shipTo` means on a receiver | It is the supplier, in which case `create_receipt` should write it instead of warning |
| 16 | Orders created through the API can be cancelled | The help centre says API-created orders auto-Complete, while the API status enum reports Open until confirmed | Create then cancel a throwaway order | Cancel is refused, and the rollback playbook needs the UI Reopen step first |

## 4. Switching to the real API

One value: `EXTENSIV_BASE_URL`. The token URL is derived from it unless `EXTENSIV_AUTH_URL` is set, and nothing else in the configuration changes shape between the mock, a sandbox and production.

A change prepared against one base URL cannot be committed against another: the engine stores the target with the change and refuses a cross-environment commit. A `change_id` minted while pointed at the mock can never fire against production.

Recommended order when credentials arrive:

1. `extensiv-mcp --check` with writes off. Confirms auth, the environment label, and what the credential can actually see.
2. Read-only soak. Leave `EXTENSIV_MCP_WRITES_ENABLED` unset and compare a handful of orders and stock positions against the 3PLWM UI. Mapping mistakes surface here.
3. Work section 3 top to bottom on a throwaway customer, recording each answer in `MOCK_FIDELITY.md`. Rows 1, 4 and 16 deserve a throwaway order before anything real.
4. Only then complete [production_write_signoff.md](production_write_signoff.md) and enable writes for one customer.

## 5. Known guesses

The mock flags every invented behaviour in code (`// GUESS:`) and tabulates all 32 in `MOCK_FIDELITY.md`, alongside 12 inferred ones. The adapter flags every inferred property name (`// INFERRED:`) and lists them in its README. Those two lists are the full re-verification backlog; section 3 is the subset that would change behaviour rather than wording.
