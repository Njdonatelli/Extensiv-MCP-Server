# Verification status

What is actually proven about this server, and what is still waiting on real Extensiv credentials. Every row in the verified table names the test or command that demonstrates it; nothing here is claimed because the code "looks right".

**Bottom line.** The server, the reusable core, the Extensiv adapter and the webhook receiver are verified end to end against a local mock of the Extensiv REST API that was written from Extensiv's public documentation. **No authenticated call has ever been made to a real Extensiv tenant**, because no API credential exists yet. The single exception is a deliberate credential-free probe of the production token endpoint on 2026-09-21, which proved the one-value switch reaches the real host and corrected one wrong assumption in the code (section 7). Every row in section 3 is a claim about Extensiv's behaviour that the mock currently makes on Extensiv's behalf.

| | |
|---|---|
| Verified on | branch `claude/extensiv-3pl-mcp-server-fap4kz`, at its tip. Re-run `bash scripts/verify.sh` to reproduce every number in this table. |
| Test suite | 405 tests in 29 files, all passing (`npx vitest run`) |
| By package | mock-extensiv 135, adapter-extensiv 105, core 103, server 49 (integration, attacks and transport hardening), webhook-ingest 7, evals 6 |
| Typecheck and build | `npx tsc -b tsconfig.json` and `pnpm -r --filter './packages/*' run build` both clean |
| Tool-selection eval | 6 runs through a real MCP client against the running server. Task reach 23/25 (92%) in five of six, and it has never moved on a code change. First-call 18/25 (72%) most recently, with a measured spread of about ±2 prompts at n=1 — see the variance section in [evals/README.md](../evals/README.md) before reading a single run as a regression |
| Adversarial review | 6 lenses raised 53 findings; 13 survived 3-vote verification and all 13 are addressed or documented |
| Live exercise | 6 slices drove the built server through a real MCP client over both transports: 150 behavioural checks, 133 held. 14 defects raised, 9 confirmed by 3-vote verification, plus 2 more reproduced and fixed. All 11 reproductions replayed clean after the fix ([section 6](#6-what-the-live-exercise-found)) |
| Mock fidelity | 161 status-bearing rows: 128 single-label (84 Documented, 11 Inferred, 33 Guess) and 33 deliberately compound, where the docs pin the shape but not the values. Reproduce with `python3 scripts/count_fidelity.py` ([MOCK_FIDELITY.md](../packages/mock-extensiv/MOCK_FIDELITY.md)) |

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
| All 16 tools are reachable through a real MCP client | `integration.test.ts` (in-process client), six eval runs driving the built binary over stdio from a separate process, and the live-exercise slices in section 6 which called every one of the 16 over both transports |
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
| A change cannot be committed against another tenant that shares the base URL, or under a different environment label | core engine suite: two adapters differing only by `tenantKey`, and two differing only by label, both refused |
| An identical `update_order` can be prepared and committed again, while a double-submitted create is still absorbed | core engine suite |
| A torn final line in a JSONL store is separated rather than glued to the next record | store suite writes an unterminated line, appends, and reads both back |
| The client secret never reaches a tool result, the audit log or the change store | `attacks.test.ts` greps all three |
| Webhook deliveries verify against the published key, survive rotation, and dedupe | webhook-ingest suite (7 tests), including a real signature check and a rotation that re-fetches the key once |
| An event ingested by the separate process is visible to `recent_events` | `integration.test.ts` wires the ingest app to the mock's subscription and asserts the event arrives with `verified: true` |
| A failed HTTP bind fails loudly instead of logging success | `transport_hardening.test.ts` spawns the real CLI against an occupied port and asserts a non-zero exit with no "listening" line; also covers an unresolvable host and an unassignable address |
| A malformed HTTP body returns JSON-RPC `-32700`, never a stack trace | `transport_hardening.test.ts` posts `{not json` and asserts the shape, the content type, and the absence of any filesystem path |
| HTTP sessions are bounded and reclaimed, and a live one is never evicted | `transport_hardening.test.ts` fills the cap (503 / `-32000`), sweeps idle sessions, and holds an open notification stream open across the idle window to prove a healthy client survives |
| A non-loopback HTTP bind is refused without an explicit opt-in | `transport_hardening.test.ts`: `0.0.0.0` throws `VALIDATION` naming `EXTENSIV_MCP_HTTP_ALLOW_REMOTE` and binds nothing; loopback is unaffected |
| `recent_events` cannot be used as an existence oracle for out-of-scope data | `read_scope_leaks.test.ts`, and independently through a real MCP client: probing an out-of-scope reference number and an unused one return byte-identical responses |
| Read scope is enforced on records echoed inside a response, not only on top-level lists | `read_scope_leaks.test.ts`; `describe_scope` with facility scope `1` names `DFW-2` nowhere, including inside `customers[].facilities` |
| A date argument is validated locally and the rule is visible to the model | `input_validation_and_audit.test.ts`; `tools/list` shows a JSON Schema `pattern` on every `isoDate` field, and `today` / `09/16/2026` / `2026` are refused while `2026-09-16` and `2026-09-16T08:00:00Z` prepare |
| One tool call cannot grow the audit log without bound | `input_validation_and_audit.test.ts` caps `AuditEntry.input` at 1000 characters with a visible truncation marker |
| A receipt that has not arrived is not reported as received or short | `receipt_received_qty.test.ts` and `integration.test.ts`: the seeded open ASN returns `arrived: false`, `totalReceivedQty` 0 and `varianceLines` 0, while a closed receiver still reports real variances |
| Concurrent first deliveries of one event id store exactly one record | `event_store_concurrency.test.ts`, including that a failed disk append leaves the id unclaimed so a retry is still stored |
| The shipped mock and the shipped webhook receiver pair on default configuration | `webhook_key_public.test.ts`, and a manual end-to-end run: the receiver fetched the key unauthenticated, verified a mock-signed delivery and stored it |
| The mock itself matches the documented wire format | mock suite (135 tests) covering RQL operators and precedence, paging limits per rel, HAL envelopes and rel names, every documented error code, and the write operators |

## 2. Verified by construction or inspection only

| Claim | Why there is no test | Risk if wrong |
|---|---|---|
| Nothing is written to stdout except MCP protocol traffic | Asserted by the logger's design (stderr only) and by the stdio client working, not by a byte-level check | A stray `console.log` would corrupt the stdio transport |
| The Streamable HTTP transport shares one set of stores per process | Covered by a cross-instance store test and the wiring in `cli.ts`. `transport_hardening.test.ts` now drives many concurrent HTTP sessions, but asserts on session lifecycle rather than on a change crossing between them | A change prepared in one session would be unknown in another |
| Secrets are redacted from logs | `redact()` is unit-covered by key shape, and the attack suite greps the artefacts; log output is not scanned line by line | A credential in a log file |
| Argument-schema violations reach the model as the SDK's own validation error, not this server's structured shape, and are not audited | The SDK validates before the handler runs and 1.30 exposes no tool-call middleware. Deliberate: see "Known limitations" in `architecture.md`. A malformed call never reaches the warehouse system | A client bug is harder to see in the audit log |

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
| 10 | `GET /events/webhook/key` needs no bearer token | The article gives the URL with no auth note. The mock used to require one, which meant the two shipped CLIs could not pair out of the box; it now serves the key unauthenticated, on the reasoning that a receiver must bootstrap trust before it holds any credential | `curl` the key endpoint with no Authorization header | 401. The ingest process would then need credentials of its own |
| 11 | Event type strings for non-order resources follow `<Resource><Verb>` | Only `OrderConfirm` appears verbatim | Subscribe to receipt and inventory-hold events and read what arrives | The strings differ, so `recent_events` type filters silently match nothing |
| 12 | No rate limiting, because none is documented | 429 appears nowhere in the rel docs | Watch Support Portal, Account, API Usage during a read-heavy day | 429s appear. The client already honours `Retry-After`, but the limits need to inform polling |
| 13 | A sandbox tenant can have REST credentials, at `https://box.secure-wms.com` | Not documented; the Support Portal is listed as unavailable in Sandbox | Ask the CSM. Question 1 of the drafted inquiry email | No sandbox credentials exist, and the first real call is against production data |
| 14 | The role set on the credential covers the endpoints each tool uses | The help centre names roles, never their endpoints | Run every read tool with the read-only role set; `verify_connection` reports a 403 as a problem | A 403 on a tool, naming the missing role |
| 15 | Receipts have no supplier field | `ReceiverCreate` has a `shipTo` block whose meaning on an inbound receipt is undocumented | Ask Extensiv what `shipTo` means on a receiver | It is the supplier, in which case `create_receipt` should write it instead of warning |
| 16 | Orders created through the API can be cancelled | The help centre says API-created orders auto-Complete, while the API status enum reports Open until confirmed | Create then cancel a throwaway order | Cancel is refused, and the rollback playbook needs the UI Reopen step first |
| 17 | **`ReceiveItem.qty` on a receiver that has not arrived is a plan, not an arrival.** Every received quantity and every variance rests on this. The adapter now reports 0 received until the receiver is Closed or carries an `arrivalDate`, because the previous reading told the model that an ASN due tomorrow had fully landed | No rel page says whether a receive item holds stock before the confirmer runs. An unconfirmed ASN comes back with `qty == expectedQty` and `inventoryLevels` 0/0, which is what the mock reproduces — our own reconstruction, not ground truth | Read an open Receive-Against ASN with nothing received, then a partially received open receiver if 3PLWM allows one to exist | `qty` is 0 or null before arrival, in which case the guard is harmless but redundant; or a warehouse can key partial quantities into an open receiver, in which case we now **under-report** real arrivals |

## 4. Switching to the real API

One value: `EXTENSIV_BASE_URL`. The token URL is derived from it unless `EXTENSIV_AUTH_URL` is set, and nothing else in the configuration changes shape between the mock, a sandbox and production.

A change prepared against one base URL cannot be committed against another: the engine stores the target with the change and refuses a cross-environment commit. A `change_id` minted while pointed at the mock can never fire against production.

Recommended order when credentials arrive:

1. `extensiv-mcp --check` with writes off. Confirms auth, the environment label, and what the credential can actually see.
2. Read-only soak. Leave `EXTENSIV_MCP_WRITES_ENABLED` unset and compare a handful of orders and stock positions against the 3PLWM UI. Mapping mistakes surface here.
3. Work section 3 top to bottom on a throwaway customer, recording each answer in `MOCK_FIDELITY.md`. Rows 1, 4 and 16 deserve a throwaway order before anything real, and row 17 wants an open ASN read before anyone trusts a received quantity.
4. Only then complete [production_write_signoff.md](production_write_signoff.md) and enable writes for one customer.

## 5. Known guesses

The mock flags every invented behaviour in code (`// GUESS:`) and tabulates them in `MOCK_FIDELITY.md`: 33 rows are outright guesses, 11 are inferred, and a further 33 are part-documented and part-guessed (run `python3 scripts/count_fidelity.py`). The adapter flags every inferred property name (`// INFERRED:`) and lists them in its README. Those two lists are the full re-verification backlog; section 3 is the subset that would change behaviour rather than wording.

## 6. What the live exercise found

Six independent slices drove the built server through a real MCP SDK client — real handshake, real process boundary, both transports — against the mock and, for one slice, against the real Extensiv host. 150 behavioural checks, 133 held. Fourteen defects were raised and each was put to three independent verifiers instructed to refute it; nine survived. Two further defects were reproduced by every verifier but downgraded rather than dismissed, and were fixed too.

The nine confirmed, and the two downgraded, are all fixed at the tip of this branch, and every original reproduction was replayed against the rebuilt binary. What is worth carrying forward is not the count but the pattern: **every one of them was invisible to a passing test suite.** The suite was green at 324 tests while the HTTP transport would log success and exit zero on a failed bind, while `recent_events` leaked the existence of out-of-scope data through a counter, and while an ASN that had not arrived reported itself fully received.

Five findings were refuted 3-0 and are recorded here so they are not re-raised: SDK-level validation errors bypassing the structured error shape (deliberate, section 2); a commit-time scope check said to disagree with what is sent upstream (reachable only by hand-editing `changes.jsonl`, not through any tool); the event-store race at the severity claimed (readers dedupe, so the model never sees a duplicate); an out-of-range HTTP port (rejected by config before it reaches the transport); and missing `engines` declarations (a packaging gap, now closed, not a defect).

## 7. What the real Extensiv API has actually told us

No credential exists, so this is deliberately short. Everything below came from an unauthenticated probe on 2026-09-21 using obviously fake credential values, at most two requests per endpoint.

| Observation | Why it matters |
|---|---|
| `POST https://secure-wms.com/AuthServer/api/Token` answers **HTTP 401** with `{"Message":"invalid_client: client not registered"}` | The code assumed the OAuth2 shape — HTTP 400 with an `error` field — so the only actionable detail was silently discarded on every real rejection. `auth.ts` now reads `Message`, `error` and `error_description`. This is the first assumption in the project corrected by the live API rather than by a document |
| `GET` on the same URL answers 405 | Confirms it is POST-only, as the rel docs describe |
| `https://api.3plcentral.com/rels/auth` answers 302 | The rel host is live and redirecting; the notes record it without guessing the target |
| Pointing at production needs exactly one value | `EXTENSIV_BASE_URL`. Production is in fact the built-in default, so the mock is the override. `verify_connection` against the real host returned `environmentLabel: "production"`, `authenticated: false`, a clean `AUTH_FAILED`, and no secret anywhere in the output |

What this does **not** establish: any HAL envelope, any RQL property name, any ETag behaviour, any write, and every row in section 3. The probe reached the front door and read the error on it. Nothing behind it has been seen.

