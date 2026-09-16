# Production write sign-off

Sign this before anyone sets `EXTENSIV_MCP_WRITES_ENABLED=true` against `EXTENSIV_BASE_URL=https://secure-wms.com`. Keep the signed copy with the credential record. One sign-off per environment, per server instance, per credential. Re-sign if the write scope, caps or credential change.

Facts about Extensiv behaviour cite `docs/research/help_center_notes.md` / `docs/research/api_reference_notes.md` URLs. `ASSUMPTION:` marks anything not in those notes.

| Field | Value |
|---|---|
| 3PL company | `______________________________` |
| TPL number | `__________` |
| Server instance / host | `______________________________` |
| `EXTENSIV_MCP_ENVIRONMENT_LABEL` | `__________` |
| Credential Client ID (never the secret) | `______________________________` |
| Customer user (3PL Warehouse Manager ID) | `______________________________` |
| Sign-off version | `____` (increment on every re-sign) |

---

## 1. Scope of writes

Tick only what is being enabled. Anything unticked stays off (write tools not in the list should be removed from the server build or refused at commit; ASSUMPTION: per-tool disable is a server feature to confirm, otherwise all four prepare tools register together when writes are enabled).

| Write tool | Upstream call (from `docs/research/api_reference_notes.md`) | Enabled |
|---|---|---|
| `create_order` | `POST /orders` (201 + ETag; duplicate `referenceNum` per customer → 400 `Duplicate`) https://3w.extensiv.com/rels/orders/orders | [ ] |
| `update_order` | `PUT /orders/{id}` with `If-Match` ("Updates an unconfirmed order") https://3w.extensiv.com/rels/orders/order | [ ] |
| `cancel_order` | `POST /orders/{id}/canceler` with `If-Match`, body `{reason}` ("Cancel an open order") https://3w.extensiv.com/rels/orders/ordercancel | [ ] |
| `create_receipt` | `POST /inventory/receivers` (201 + ETag) https://3w.extensiv.com/rels/inventory/receivers | [ ] |
| `commit_change` | executes whichever of the above was prepared | [x] (always on when writes are on) |

Deliberately **not** exposed and not granted on the credential: order confirm/ship (`POST /orders/{id}/confirmer`, role OrderConfirm), unconfirm, complete, allocate, hold/release, receipt confirm, inventory adjustments, item/customer edits.

**Customer IDs allowed for writes** (`EXTENSIV_MCP_WRITE_CUSTOMER_IDS`, explicit list, no wildcard):

| Customer name | Customer ID | Approved by |
|---|---|---|
| `____________________` | `______` | `__________` |
| `____________________` | `______` | `__________` |

**Facility IDs allowed for writes** (`EXTENSIV_MCP_WRITE_FACILITY_IDS`; leave empty only if every facility the credential can see is acceptable):

| Facility name | Facility ID | Approved by |
|---|---|---|
| `____________________` | `______` | `__________` |

**Caps**

| Cap | Env var | Default | Value approved |
|---|---|---|---|
| Max lines per mutation | `EXTENSIV_MCP_MAX_LINES_PER_MUTATION` | 200 | `______` |
| Max units per mutation | `EXTENSIV_MCP_MAX_UNITS_PER_MUTATION` | 10000 | `______` |
| Change TTL (seconds a prepared change stays committable) | `EXTENSIV_MCP_CHANGE_TTL_SECONDS` | 900 | `______` |

Credential roles confirmed on the credential in Support Portal > Manage Credentials (Beta) (https://help.extensiv.com/en_US/rest-api/getting-started-with-credential-management):

- [ ] Read set present: CustomerView, FacilityView, InventoryDetailView, InventoryRead, ItemView, OrderView, ReceiverView, ReadPropertiesThirdParty
- [ ] Write roles present and no others: OrderEdit, OrderWrite, ReceiverEdit
- [ ] `OrderConfirm`, `InventoryEdit`, `ItemEdit`, `CustomerEdit`, `OrderImport`, `C2CTransfer`, `WritePropertiesThirdParty` are **not** ticked

## 2. Evidence required before enabling

| Evidence | Result | Date | Verified by |
|---|---|---|---|
| Unit/integration test suite (`pnpm test`) passes on the exact commit to be deployed | [ ] pass, commit `__________` | `____-__-__` | `__________` |
| Mock attack scenarios pass (duplicate reference replay, out-of-scope customer, out-of-scope facility, over-cap lines, over-cap units, expired change id, stale `If-Match` → 412, missing `If-Match` → 428, 403 role denial, 5xx mid-commit then replay) | [ ] pass | `____-__-__` | `__________` |
| Read-only run against production (`EXTENSIV_MCP_WRITES_ENABLED=false`) for `____` days with no incorrect data reported | [ ] done, from `____-__-__` to `____-__-__` | | `__________` |
| Sandbox write run (only if Extensiv provisioned API credentials for a sandbox tenant; see open question in `docs/credential_runbook.md` Step F) | [ ] done / [ ] not available | `____-__-__` | `__________` |
| Eval suite (`pnpm evals`) tool-selection accuracy: overall `____%`, category `write-prepare` `____%`, `commit` `____%`, `policy` `____%` (minimum acceptable: `____%`) | [ ] meets minimum | `____-__-__` | `__________` |
| `verify_connection` and `describe_scope` output attached, showing environment label, scope and writes flag | [ ] attached | `____-__-__` | `__________` |
| Rollback playbook (section 5) rehearsed once on the mock or sandbox | [ ] done | `____-__-__` | `__________` |

## 3. Operational controls

Tick to confirm each is in place and understood.

- [ ] **Two-phase confirm.** `create_order`, `update_order`, `cancel_order`, `create_receipt` only validate and return a preview plus a `change_id`. Nothing reaches Extensiv until `commit_change` is called with that id, and a change expires after `EXTENSIV_MCP_CHANGE_TTL_SECONDS`.
- [ ] **Idempotency.** Replaying `commit_change` with the same `change_id` returns the stored outcome without a second upstream call. Before any `POST`, the server checks the upstream natural key (reference number within the customer) so a retry after a timeout never double-creates. Extensiv itself rejects a duplicate `referenceNum` with 400 `ModelValidationException` / `Duplicate` (https://3w.extensiv.com/rels/orders/orders), which is the second line of defence.
- [ ] **Concurrency guard.** Updates and cancels send `If-Match` with the version token read at prepare time; Extensiv answers 412 if the order changed in between and 428 if the header is missing (https://3w.extensiv.com/Rels/exceptions). A 412 is surfaced to the user, never retried blindly.
- [ ] **Audit log.** Every committed change is appended to `audit.jsonl` under `EXTENSIV_MCP_STATE_DIR` with who (MCP client identity as presented to the server), what (tool, change id, customer, facility, reference number), when, the upstream request, and the outcome. Location: `______________________________`. Retention: `____` days/months (ASSUMPTION: your policy; Extensiv sets none). Backed up: [ ] yes, to `______________________________`.
- [ ] **Audit review.** `__________` (name) reviews the audit log `______` (daily / weekly). Anything committed for a customer or facility outside section 1 is an incident.
- [ ] **Extensiv-side trace.** Orders created by the server carry `readOnly.warehouseTransactionSourceType = 7 (RestApi)` and `createdByIdentifier` of the integration's customer user (https://3w.extensiv.com/rels/orders/order), so the 3PL admin can filter them in Find Orders. ASSUMPTION: the UI exposes a filter on source type / created-by.
- [ ] **Disable writes in under 5 minutes.** Procedure: (1) unset `EXTENSIV_MCP_WRITES_ENABLED` (or set it to `false`) in the server's environment; (2) restart the server process; (3) run `verify_connection` and confirm it reports writes disabled and the five write tools are absent from the tool list. Who can do this at any hour: `__________`, `__________`. Where the restart command is documented: `______________________________`.
- [ ] **Hard revoke.** If the credential itself must die: Support Portal > Manage Credentials (Beta) > untick **Enabled** on the credential, then email API@extensiv.com to deprovision (https://help.extensiv.com/en_US/rest-api/getting-started-with-credential-management). ASSUMPTION: already-issued tokens (valid 30 to 60 minutes) may keep working until expiry.
- [ ] **Webhook ingest** runs as a separate process and cannot write to Extensiv; it only appends to `EXTENSIV_MCP_EVENTS_FILE` after verifying the `Signature` header (https://help.extensiv.com/en_US/rest-api/implementing-webhooks).

## 4. Blast-radius limits

| Limit | Value | Notes |
|---|---|---|
| Customers writable | `____` customers (section 1) | Everything else is refused inside the prepare tool and again at commit |
| Facilities writable | `____` facilities (section 1) | |
| Max lines per single mutation | `____` | `EXTENSIV_MCP_MAX_LINES_PER_MUTATION` |
| Max units per single mutation | `____` | `EXTENSIV_MCP_MAX_UNITS_PER_MUTATION` |
| Max commits per hour (ASSUMPTION: not a server feature today; enforce by review if needed) | `____` | |
| Worst realistic case | One wrong order or receipt per commit, capped at the line/unit limits above, always reversible per section 5 | Confirm/ship is not exposed, so the server can never cause a shipment or close a receipt into on-hand inventory |
| Extensiv rate limits | Not published (https://3w.extensiv.com/Rels/exceptions lists no 429; API is metered by data usage, Support Portal > Account > API Usage, https://help.extensiv.com/en_US/customer-central/support-portal-faqs) | Watch API Usage weekly for the first month |

## 5. Rollback playbook per mutation

| Mutation | Undo through the server | Undo through the 3PLWM UI (3PL admin) | Constraints |
|---|---|---|---|
| `create_order` created a wrong order | `cancel_order` with the order id, reason `created in error by MCP change <change_id>`, then `commit_change` | **Find Orders** > select the order > **Manage** > **Cancel** (https://help.extensiv.com/en_US/order-management/understanding-order-statuses) | Cancel is "generally not" possible once the order is Complete or in a pick batch (same article). ASSUMPTION: API-created orders "auto-Complete" per the same article while the API status enum still reports 0 Open until confirmed (https://3w.extensiv.com/rels/orders/order); if the UI refuses, use **Manage** > **Reopen** first, then Cancel. Rehearse this once. |
| `update_order` changed ship-to / carrier / notes / earliest ship date | Another `update_order` with the previous values (the preview from the original change shows before/after; the audit log keeps the upstream request) then `commit_change` | Open the order in **Find Orders** and edit the fields back | `PUT /orders/{id}` only works on an unconfirmed order; once shipped/closed the change is moot. While the order is on hold, REST API actions are blocked (https://help.extensiv.com/en_US/order-management/putting-orders-on-hold-in-3pl-warehouse-manager) |
| `cancel_order` cancelled the wrong order | None. Canceled orders are not reopened by this server. | **Find Orders** > select the order > **Manage** > **Reopen** (https://help.extensiv.com/en_US/order-management/understanding-order-statuses) | ASSUMPTION: Reopen is available for Canceled orders in the UI (the article lists Reopen under Manage without stating which statuses allow it). If not, recreate the order with a new reference number. |
| `create_receipt` created a wrong receipt/ASN | Not exposed by this server (receipt cancel is deliberately not a tool) | Cancel the receipt in the UI while it is still **Open** (https://help.extensiv.com/en_US/receipt-management/understanding-receipt-statuses). ASSUMPTION: click path is **Receipts** > **Find Receipts** > select > **Manage** > **Cancel** (not stated in the notes) | Canceled is irreversible; Reopen is blocked once inventory from the receipt is allocated (same article). The receipt only affects on-hand inventory after someone confirms it, which this server cannot do. |
| Any | `commit_change` replay is safe: same `change_id` returns the stored outcome | | Never "undo" by committing a second copy with a new reference number |

## 6. Data and terms acknowledgement

- [ ] ASSUMPTION: API use is governed by the 3PL's subscription agreement and the API package add-on; no public developer terms of service were found (the marketing site terms at https://www.extensiv.com/terms-of-service cover the marketing site only). The signatories confirm the subscription includes the API package and, if used, the webhook add-on (https://help.extensiv.com/en_US/customer-central/support-portal-faqs, https://help.extensiv.com/en_US/rest-api/webhooks-faqs).
- [ ] The audit log and events file contain customer and consignee data (names, addresses, phone numbers, emails from `shipTo`). They are stored at `EXTENSIV_MCP_STATE_DIR` on a host that meets the 3PL's data-handling policy: `______________________________`.
- [ ] The MCP client(s) allowed to reach this server are listed here and each has an identifiable user: `______________________________`.
- [ ] Extensiv docs are "subject to change without warning" (https://3w.extensiv.com/Rels); releases ship the second Wednesday monthly (per `docs/research/api_reference_notes.md`). The integration owner re-runs the test suite against the mock and `verify_connection` against production after each release.

## 7. Sign-off

Enabling writes requires all three signatures.

| Role | Name | Date | Signature |
|---|---|---|---|
| 3PL owner / general manager | `____________________` | `____-__-__` | `____________________` |
| Operations lead | `____________________` | `____-__-__` | `____________________` |
| Integration owner (runs the server) | `____________________` | `____-__-__` | `____________________` |

**Conditions** (free text: e.g. "writes limited to customer 143 for 30 days, then re-review", "no cancels until pick-batch behaviour is confirmed with Extensiv", "review audit log daily for first two weeks"):

```
____________________________________________________________________________
____________________________________________________________________________
____________________________________________________________________________
____________________________________________________________________________
```

Effective date writes may be enabled: `____-__-__`. Review date (sign-off expires unless renewed): `____-__-__`.

## 8. Revocation record

Fill in when writes are disabled, the credential is rotated or revoked, or this sign-off is withdrawn.

| Date/time | Action (writes disabled / credential disabled / credential rotated / sign-off withdrawn) | Reason | Done by | Confirmed by `verify_connection` at |
|---|---|---|---|---|
| `____-__-__ __:__` | `____________________` | `____________________` | `__________` | `____-__-__ __:__` |
| `____-__-__ __:__` | `____________________` | `____________________` | `__________` | `____-__-__ __:__` |
