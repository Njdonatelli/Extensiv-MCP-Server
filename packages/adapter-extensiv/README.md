# @mcp-3pl/adapter-extensiv

`WmsAdapter` implementation for the **Extensiv 3PL Warehouse Manager** REST API
(OAuth2 client_credentials, HAL+JSON, RQL, ETag/If-Match).

The core package owns policy, the two-phase mutation engine and the tool surface.
This package owns exactly four things:

| File | Responsibility |
|---|---|
| `src/config.ts` | env -> validated `ExtensivConfig`, environment label, client-id masking |
| `src/auth.ts` | `POST /AuthServer/api/Token` with BASIC auth, cached + single-flight bearer token |
| `src/rql.ts` / `src/hal.ts` | the FIQL/RQL query language and HAL collection/paging helpers |
| `src/mapping.ts` / `src/adapter.ts` | wire -> domain mapping, endpoints, query translation, two-phase writes |

Every upstream call goes through core's `HttpClient`, which already implements the
one-shot 401 re-auth + replay, 429 `Retry-After`, bounded backoff for idempotent
requests and `OUTCOME_UNKNOWN` when a non-idempotent request loses its response.
None of that is duplicated here.

## Configuration

| Env var | Required | Default | Meaning |
|---|---|---|---|
| `EXTENSIV_CLIENT_ID` | yes | — | Client id from Support Portal -> Manage Credentials (Beta) |
| `EXTENSIV_CLIENT_SECRET` | yes | — | Client secret from the same grid. Never logged, never in a preview |
| `EXTENSIV_USER_LOGIN` | yes | — | The customer user's *3PL Warehouse Manager ID* (Hub -> Users). Sent as `user_login` |
| `EXTENSIV_BASE_URL` | no | `https://secure-wms.com` | API base. `https://box.secure-wms.com` for the legacy sandbox (host INFERRED), `http://localhost:<port>` for the mock |
| `EXTENSIV_AUTH_URL` | no | `<baseUrl>/AuthServer/api/Token` | Override only if the token endpoint is not co-hosted |
| `EXTENSIV_TPL_GUID` | no | — | Sent as `tpl`; required only for "Single-Tenant dynamic" credentials |
| `EXTENSIV_TOKEN_REFRESH_MARGIN_SECONDS` | no | `300` | Re-login this long before `expires_in` elapses (tokens last 30-60 min) |
| `EXTENSIV_HTTP_TIMEOUT_MS` | no | `30000` | Per-request timeout |
| `EXTENSIV_MAX_RETRIES` | no | `3` | Retries for 429/5xx on idempotent requests only |
| `EXTENSIV_MCP_ENVIRONMENT_LABEL` | no | derived from the host | Label shown on every write preview (`production`, `sandbox (legacy box)`, `mock (local)`) |

Roles the credential needs (Support Portal -> Manage Credentials):
`CustomerView, FacilityView, ReadPropertiesThirdParty, ItemView, InventoryDetailView,
OrderView, ReceiverView` for reads, plus `OrderEdit, OrderImport, OrderWrite,
ReceiverEdit` for the write tools. `verify_connection` reports a 403 as a named-role
problem instead of failing.

## Endpoints used

| Adapter method | Upstream |
|---|---|
| `verifyConnection` | token, `GET /properties/facilities?pgsiz=1`, `GET /customers?pgsiz=1` |
| `listCustomers` / `listFacilities` | `GET /customers`, `GET /properties/facilities` (`pgsiz=100`, cached 60 s) |
| `findOrders` | `GET /orders?detail=OrderItems&sort=-readonly.creationdate&rql=…&skulist=…` |
| `getOrder` | `GET /orders/{id}?detail=All&itemdetail=All` (ETag -> `version`), or list by `referencenum` then re-read by id |
| `findReceipts` / `getReceipt` | `GET /inventory/receivers?detail=ReceiveItems`, `GET /inventory/receivers/{id}?detail=All` |
| `getInventory` | `GET /inventory/stocksummaries` (+ `GET /inventory/stockdetails?customerid=&facilityid=` for lots) |
| `findItems` | `GET /customers/{customerId}/items?pgsiz=100` |
| `create_order` | `POST /orders` |
| `update_order` | `PUT /orders/{id}?detail=None` with `If-Match` |
| `cancel_order` | `POST /orders/{id}/canceler` with `If-Match` (204 -> re-read) |
| `create_receipt` | `POST /inventory/receivers` |

## Wire -> domain mapping

| Domain field | Extensiv wire source | Notes |
|---|---|---|
| `OrderSummary.status` | `readOnly.status` | `0 -> open`, `1 -> closed`, `2 -> cancelled`. The `WarehouseTransactionApiStatus` enum has **no Complete member** ("Mark Complete" is an operator), so the domain's `'complete'` is never produced for Extensiv |
| `onHold` / `holdReason` | `readOnly.onHoldDate != null` / `readOnly.onHoldReason` | a hold is a date, not a status |
| `createdAt` / `updatedAt` | `readOnly.creationDate` / `readOnly.lastModifiedDate` | passed through as sent, with no zone; core's `parseTimestamp` reads a zoneless date-time as UTC (GUESS: UTC vs warehouse-local is undocumented) |
| `shippedAt` | `readOnly.shipDate`, else `readOnly.smallParcelShipDate` | small-parcel orders stamp the second field |
| `trackingNumbers` | `routingInfo.trackingNumber` + `readOnly.packages[].trackingNumber` + `parcelResponse.trackingNumbers[]` | deduped union, order preserved |
| `carrier` / `service` | `routingInfo.carrier` / `routingInfo.mode` | |
| `lineCount` / `totalQty` | embedded `…/orders/item` rows, else `numUnits1` | `detail=None` responses have no items |
| `fullyAllocated`, `pickDone`, `packDone` | `readOnly.fullyAllocated`, `pickDoneDate`, `packDoneDate` | |
| `OrderDetail.version` | the `ETag` response header, verbatim | goes straight back out as `If-Match` |
| `OrderDetail.timeline` | `creationDate, onHoldDate, pickStarted, pickDoneDate, packStarted, packDoneDate, shipDate, lastModifiedDate` | sorted ascending, human event names |
| `OrderLine.qtyOrdered` / `qtyAllocated` | `qty` / sum of `readOnly.allocations[].qty` | `qtyAllocated` is undefined without `itemdetail=Allocations` |
| `OrderLine.qtyPicked` / `qtyShipped` | sum of `readOnly.packages[].packageContents[].qty` for the line | GUESS: no per-line picked/shipped quantity exists upstream; `qtyShipped` only once the order has a ship date |
| `allocationSummary` | `readOnly.fullyAllocated` + per-line `qtyOrdered - qtyAllocated` | |
| `Item.active` | `!readOnly.deactivated` | |
| `Item.reorderPoint` | `options.inventoryUnit.reorderQuantity`, else `minimumStock` | |
| `Item.trackLots/trackExpiration/trackSerials` | `options.trackBys.trackLotNumber / trackExpirationDate / trackSerialNumber > 0` | enum `0 Disallow, 1 Allow, 2 Require` |
| `Item.dimensions` / `weight` | `options.inventoryUnit.imperial` | GUESS: inches / pounds; the rel page states no unit |
| `ReceiptLine.qtyExpected` / `qtyReceived` / `variance` | `readOnly.expectedQty` (else `qty`) / `qty` / received - expected | a plain receiver has a null `expectedQty`, so its variance is 0 |
| `ReceiptSummary.totalExpectedQty` / `totalReceivedQty` | sums of the lines | |
| `InventoryPosition` | `/inventory/stocksummaries` `summaries[]` row (`onHand, available, allocated, onHold`) | the rel has no `_embedded`; rows carry no customer, so the adapter supplies it |
| `LotPosition` | `/inventory/stockdetails` `_embedded.item[]` | `allocated = onHand - available`, `onHold = onHand` when `isOnHold` |

## Query translation

Statuses use the documented rule that `status` is only reliable for Canceled
(https://3w.extensiv.com/Rels/rql): `closed -> readonly.isclosed==true`,
`cancelled -> readonly.status==2`, `open`/`complete` ->
`(readonly.isclosed==false;readonly.status!=2)`. A SKU filter on orders uses the
documented `skulist` query parameter, not RQL.

## INFERRED property names — re-verify against the real API

The REL documentation names very few RQL properties verbatim. Everything below is
the documented *model* property path, lower-cased, and must be re-checked against a
live tenant (a wrong name returns `400 QueryParameterException / NotParsable`,
which is loud but still a bug).

| RQL / query name | Used by | Why it is a guess |
|---|---|---|
| `readonly.customeridentifier.id` | `findOrders`, `getOrder`, `findReceipts`, `getReceipt` | the rql page shows `customeridentifier.id` as its nesting example but never for these rels |
| `readonly.facilityidentifier.id` | `findOrders`, `findReceipts` | same |
| `readonly.shipdate` | `findOrders` (`shippedAfter/Before`) | field documented on the model, rql spelling not shown |
| `readonly.onholddate` (with `=hv=`) | `findOrders` (`onHold`) | "on hold" is modelled as a date, so has-value is the test |
| `referencenum` | orders + receivers lookup by reference number | |
| `shipto.name` | `findOrders` (`shipToNameContains`) | |
| `readonly.status` | `findReceipts` | documented for orders' cancel case only |
| `ponum` | `findReceipts` | |
| `expecteddate` | `findReceipts` | |
| `customeridentifier.id` | `getInventory` on `/inventory/stocksummaries` | summary rows carry no customer, so this filter is the only way to scope them |
| `facilityid` | `getInventory` | the row field is `facilityId` |
| `itemidentifier.sku` | `getInventory`, `stockdetails` | |
| `sku`, `upc`, `description`, `readonly.deactivated` | `findItems` | |

Other inferred behaviour to re-verify:

- **`PUT /orders/{id}` body** = the GET body minus `readOnly`/`_links`/`_embedded`.
  The verbatim required-field list was truncated in the doc fetch. `orderItems` is
  deliberately **not** sent: INFERRED that omitting it leaves the existing lines
  untouched (lines have their own `/orders/{id}/items` sub-resource).
- **`readOnly.packages[]`** is assumed to carry the same shape as
  `/orders/{id}/packages`, including inline `packageContents[]`.
- **`numUnits1`** is assumed to be the order's total unit count (fallback when no
  items are embedded).
- **`ReceiptSummary.closedAt`** falls back to `readOnly.lastModifiedDate` when the
  status is Closed; the receiver model has no confirmation timestamp.
- **`/properties/facilities` page-size ceiling** is not in the documented `pgsiz`
  table; 100 is used.
- **Sandbox API host** `https://box.secure-wms.com` (research notes §1).
- **429** is not documented anywhere for this API; the client handles it anyway.

## Error mapping

`translateUpstreamError` (exported, unit-tested):

| Upstream | Domain code |
|---|---|
| 412 | `PRECONDITION_FAILED` — the resource moved after the preview; prepare again |
| 428 | `INTERNAL` — the adapter always sends `If-Match`, so this is our bug |
| 400 `ErrorCode: Duplicate` | re-runs `findApplied`; returns the existing resource with `via: 'found_existing'` (the lost-response race) |
| 400 other | `VALIDATION`, carrying the upstream `Hint` |
| 403 `OperationException` | `VALIDATION` with the `Hint` (e.g. `OrderCanceled`, `AlreadyCompleted`) |
| 403 other | `SCOPE_DENIED` (missing role) |
| 404 | `NOT_FOUND` |
| 429 / 5xx / transport | left as `HttpClient` set them (`RATE_LIMITED`, `UPSTREAM_UNAVAILABLE`, `OUTCOME_UNKNOWN`) |

## Tests

`npx vitest run packages/adapter-extensiv` — no network, no dependency on the mock
package: a fake `fetchImpl` serves the HAL fixtures in `src/__fixtures__/`.
