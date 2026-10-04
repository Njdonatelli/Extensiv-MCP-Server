# Mock fidelity

Where this mock's behaviour comes from, and how much to trust it. Status values:

- **Documented** — stated on the cited page, in words or in a sample payload.
- **Inferred** — not stated, but the only reading consistent with what *is* stated.
- **Guess** — undocumented; the mock picked something plausible. Treat as a mock artefact, not as API truth.

Citations are the server-rendered REL documentation the API serves about itself
(`https://3w.extensiv.com/Rels/...`, `https://3w.extensiv.com/rels/{service}/{rel}`) plus
`help.extensiv.com`. The Postman-published reference at `developer.3plcentral.com` is unreadable
without a browser, so nothing here comes from it. Research notes:
[`docs/research/api_reference_notes.md`](../../docs/research/api_reference_notes.md) and
[`docs/research/help_center_notes.md`](../../docs/research/help_center_notes.md).

`https://3w.extensiv.com/Rels/exceptions` was re-fetched and re-checked on 2026-09-16; every
status code, exception shape and ErrorCode in §6 comes from that reading.

The table below is kept in sync with the `// SOURCE:` / `// INFERRED:` / `// GUESS:` comments in
`src/`. If the code and this file disagree, the code comment is the one that was written next to the
behaviour — fix both.

---

## 1. Authentication and tokens

| Behaviour | Endpoint | Source URL | Status | What to re-verify |
|---|---|---|---|---|
| `POST /AuthServer/api/Token`, OAuth2 `client_credentials`, `Authorization: Basic base64(clientId:clientSecret)`, JSON body | `POST /AuthServer/api/Token` | https://3w.extensiv.com/Rels/auth ; https://help.extensiv.com/en_US/rest-api/providing-rest-api-access | Documented | — |
| Body field is `user_login` | `POST /AuthServer/api/Token` | https://3w.extensiv.com/Rels/auth | Documented | — |
| `tpl` (3PL GUID) in the body, required only for Single-Tenant *dynamic* credentials | `POST /AuthServer/api/Token` | https://3w.extensiv.com/Rels/auth | Documented | Whether a *static* credential rejects a supplied `tpl`. The mock only validates it when present. |
| `user_login_id` accepted as an alias for `user_login` | `POST /AuthServer/api/Token` | — | **Guess** | This spelling appears in neither source. Drop the tolerance once the real endpoint is exercised. |
| 200 body `{access_token, token_type:"Bearer", expires_in, refresh_token:null, scope:null}`, `application/json; charset=utf-8` | `POST /AuthServer/api/Token` | https://3w.extensiv.com/Rels/auth | Documented | — |
| `expires_in` = 3600 by default | `POST /AuthServer/api/Token` | https://3w.extensiv.com/Rels/auth (sample) ; help center "typically between 30 and 60 minutes" | Inferred | The real TTL varies per tenant. Override with `tokenTtlSeconds`. |
| Bad Basic credentials → `401 {"error":"invalid_client"}` | `POST /AuthServer/api/Token` | RFC 6749 §5.2 | **Guess** | The real failure body is documented nowhere, and this one is now known to be **wrong for production**: a live probe on 2026-09-21 got `401 {"Message":"invalid_client: client not registered"}` — an ASP.NET `Message`, not the RFC pair (`docs/research/api_reference_notes.md` §1). The status code matches; the body shape does not. The mock still emits the RFC shape, so the adapter reads `Message`, `error` and `error_description` alike. |
| Wrong `grant_type` → `400 {"error":"unsupported_grant_type"}` | `POST /AuthServer/api/Token` | RFC 6749 §5.2 | **Guess** | Same. |
| Missing `user_login` → `400 {"error":"invalid_request"}`; unknown `user_login` → `401 invalid_client`; wrong `tpl` → `400 invalid_request` | `POST /AuthServer/api/Token` | — | **Guess** | Same. |
| Access token is opaque; clients must not parse it | every call | https://3w.extensiv.com/Rels/auth | Documented | The real token looks like a JWT. Nothing may depend on that. |
| `Authorization: Bearer <token>` on every non-token call | all | https://3w.extensiv.com/Rels/auth | Documented | — |
| Missing / invalid / expired bearer → `401` | all | https://3w.extensiv.com/Rels/exceptions ("Missing Authorization header with proper bearer token") | Documented | — |
| The `401` body is empty | all | — | **Guess** | Rels/exceptions gives no body for 401. Do not build error handling on an empty body. |
| `GET /events/webhook/key` is served **without** a bearer; every other route is bearer-gated | `GET /events/webhook/key` | — | **Guess** | The help center gives the URL with no auth note. The mock serves the key anonymously because a standalone receiver has to bootstrap trust before it holds any credential — gating it meant the shipped webhook-ingest CLI, pointed at the shipped mock with default config, 401'd on the key fetch and rejected every genuinely signed delivery. Whether the real endpoint is open is still unconfirmed; check before assuming a receiver needs no API credentials. |
| Role-based `403` (OrderConfirm, ReceiverEdit, …) | all | https://3w.extensiv.com/Rels/auth ; https://help.extensiv.com/en_US/rest-api/getting-started-with-credential-management | Documented, **not implemented** | The mock grants every role. Role denial is a real 403 the mock will never produce. |

## 2. Headers, media types, ETag / If-Match

| Behaviour | Endpoint | Source URL | Status | What to re-verify |
|---|---|---|---|---|
| Responses are `application/hal+json` | all HAL reads/writes | https://3w.extensiv.com/Rels/hal ; /Rels/headers | Documented | The mock adds `; charset=utf-8`. |
| `ETag` on single-resource GET, on `PUT`, and on `POST`-create | `/orders/{id}`, `/customers/{id}`, `/customers/{id}/items/{iid}`, `/inventory/receivers/{id}`, `POST /orders`, `POST /inventory/receivers` | https://3w.extensiv.com/Rels/headers | Documented | — |
| `If-Match` required when updating a resource | `PUT /orders/{id}`, `PUT /inventory/receivers/{id}`, all operators | https://3w.extensiv.com/Rels/headers | Documented | — |
| Missing `If-Match` → `428`; non-matching → `412`; both with empty bodies | as above | https://3w.extensiv.com/Rels/exceptions (428 "If-Match header required", 412 "doesn't match the current state") | Documented (status) / **Guess** (empty body) | — |
| `If-Match: *` and a comma-separated list are accepted; `W/` weak prefix is stripped | as above | RFC 9110 | **Guess** | The real server's tolerance is untested. |
| ETag value is `"` + base64 of an 8-byte counter + `"` | as above | — | **Guess** | SQL Server rowversions surface through Newtonsoft as base64 of 8 bytes (e.g. `"AAAAAAALdzM="`), which is why the mock uses that shape. It is opaque — never parse it. |
| Customer ETag derived from `1_000_000 + customerId` | `GET /customers/{id}` | — | **Guess** | A customer carries no `rowVersion` on the wire, so the mock invents a stable one. |
| Item ETag is the literal `readOnly.rowVersion` in quotes | `GET /customers/{id}/items/{iid}` | https://3w.extensiv.com/rels/customers/item (model has `readOnly.rowVersion`) | Inferred | — |
| `Cache-Control` on the rels the docs call "cacheable" | `/customers`, `/customers/{id}/items`, `/properties/facilities` | https://3w.extensiv.com/Rels/headers ; each rel page | Documented (cacheability) / **Guess** (`private, max-age=60`) | The real max-age. |
| Unqualified `.NET` timestamps, `2016-12-25T23:00:00`, no offset, no milliseconds | every date field | every rel-page sample | Documented (shape) / **Guess** (UTC vs warehouse-local) | Whether the real API's unqualified timestamps are UTC or facility-local. The mock renders UTC and reads a zoneless date-time it receives (`confirmDate`, `arrivalDate`, rql date values) as UTC, whatever the host time zone. |

## 3. HAL envelopes and rel names

| Behaviour | Endpoint | Source URL | Status | What to re-verify |
|---|---|---|---|---|
| Collections are `{totalResults, _embedded:{"<rel>":[...]}, _links}` with `self`/`next`/`prev` | all collections | https://3w.extensiv.com/Rels/hal | Documented | — |
| `_embedded` / `_links` keys are the literal `http://api.3plCentral.com/rels/...` URLs (note the capital C) | all | https://3w.extensiv.com/Rels/hal | Documented | — |
| `orders/order`, `orders/item`, `orders/package`, `orders/packagecontent`, `orders/orderparceltrackpackageinfo`, `customers/customer`, `customers/item`, `inventory/receiver`, `inventory/receiveritem`, `properties/facility`, `properties/location`, `properties/carrier` | respective collections | https://3w.extensiv.com/Rels/hal ; each rel page | Documented | — |
| `/inventory`, `/inventory/stockdetails` and `/orders/summaries` use the bare key `"item"` | those three | https://3w.extensiv.com/Rels/hal | Documented | — |
| `/inventory/stocksummaries` returns `{totalResults, summaries:[...]}` with **no** `_embedded` | `GET /inventory/stocksummaries` | https://3w.extensiv.com/rels/inventory/stocksummaries | Documented | — |
| `/inventory/stocksummaries` also has no `_links` | `GET /inventory/stocksummaries` | https://3w.extensiv.com/rels/inventory/stocksummaries (sample shows neither) | **Guess** | The documented sample shows only `totalResults` and `summaries`, so the mock emits exactly that. If the real response does carry paging links, a client that follows `next` will break against the mock. |
| `next` only when a further page exists; `prev` only when `pgnum > 1`; other query parameters preserved on both | all paged collections | https://3w.extensiv.com/Rels/hal | Inferred | The real link generation may always emit both. |
| `/billboard` is the HATEOAS entry point; do not hardcode URIs | `GET /billboard` | https://3w.extensiv.com/Rels/billboard | Documented | The exact rel set. The mock advertises only the collections it implements, which is certainly a subset. |
| Operator rels on a resource appear only when the transition is legal | `/orders/{id}`, `/inventory/receivers/{id}` | https://3w.extensiv.com/Rels/billboard ; https://3w.extensiv.com/rels/orders/order | Documented (principle) / **Guess** (per-link condition) | Which link appears in which state. The mock's rules: `edit`/`ordercancel` when Open; `orderconfirm` when Open, fully allocated and not on hold; `ordercomplete` when Open and not yet completed; `orderallocate` when not fully allocated; `orderdeallocate` when something is allocated; `orderunconfirm` when Closed. |
| Identifier objects return every alternate on GET (`{externalId,name,id}` customer, `{name,id}` facility, `{sku,id}` item) and one alternate suffices on write, `id` winning | all | https://3w.extensiv.com/Rels/identifiers | Documented | — |

## 4. RQL and sort

| Behaviour | Endpoint | Source URL | Status | What to re-verify |
|---|---|---|---|---|
| `rql=` FIQL-style, `;` = and, `,` = or, `;` binds tighter, parentheses override | every rel with `rql` | https://3w.extensiv.com/Rels/rql | Documented | — |
| Operators `==`, `!=`, `=gt=`, `=ge=`, `=lt=`, `=le=`, `=in=(…)`, `=out=(…)`, `=hv=true\|false` | as above | https://3w.extensiv.com/Rels/rql | Documented | — |
| Wildcards `*x`, `x*`, `*x*` with `==` / `!=` on string properties only; `x**` is ill-formed | as above | https://3w.extensiv.com/Rels/rql | Documented | — |
| Property names and values are case-insensitive; dotted paths for nesting | as above | https://3w.extensiv.com/Rels/rql | Documented | — |
| Values are typed by the model property (date / number / bool / string); an empty value is legal only with `==` / `!=` | as above | https://3w.extensiv.com/Rels/rql | Documented | — |
| Server URL-decodes values twice, so `%25` reaches the parser as `%` | as above | https://3w.extensiv.com/Rels/rql ("Character Escape Sequences") | Documented | The mock decodes once more inside the value, matching the described double decode. Exercise `( ) * = , ;` inside real values. |
| Unsupported property → `400 QueryParameterException {Parameters:["rql"], ErrorCode:"NotParsable", Hint:"Properties not supported: <name>"}` | as above | https://3w.extensiv.com/Rels/exceptions | Documented | — |
| Syntax error → same `NotParsable`, different hint text | as above | — | **Guess** | Only the ErrorCode is documented; the mock's hint wording is invented. |
| An unknown **sort** property is reported as `NotParsable` with `Parameters:["sort"]` | every rel with `sort` | — | **Guess** | The docs only show the rql case. |
| Which property paths each rel accepts | all | https://3w.extensiv.com/Rels/rql ("API model names") + each rel's model | Inferred | Only `readonly.creationdate`, `readonly.isclosed` and `customeridentifier.id` are quoted verbatim anywhere. `src/routes/shapes.ts` derives every other path from the model on the rel page. Expect mismatches on nested paths. |
| On an order, both `customeridentifier.id` and `readonly.customeridentifier.id` work (and likewise for `facilityidentifier`, `status`, `isclosed`) | `/orders`, `/inventory/receivers` | https://3w.extensiv.com/Rels/rql quotes `customeridentifier.id`, but the order model puts it under `readOnly` | **Guess** | Which spelling the real parser takes. The mock accepts both so a client cannot be wrong against the mock and right against production. |
| `status` is only reliable for Canceled; filter on `readonly.isclosed` otherwise | `/orders` | https://3w.extensiv.com/Rels/rql | Documented | The mock's `status` filter is exact for all three values, so it is *more* permissive than production. |
| `sort=fld,-fld2`, `-` = descending; nulls sort first ascending | every rel with `sort` | https://3w.extensiv.com/Rels/rql | Documented (syntax) / **Guess** (null ordering) | Where the real server puts nulls. |
| `/inventory/stocksummaries` has no `sort` parameter | `GET /inventory/stocksummaries` | https://3w.extensiv.com/rels/inventory/stocksummaries | Documented | The mock ignores a `sort` it is given there rather than erroring — arguably it should 400. |

## 5. Paging limits per rel

`pgnum` is 1-indexed. A `pgsiz` above the limit, or a non-positive `pgsiz`/`pgnum`, is
`400 QueryParameterException {Parameters:["pgsiz"|"pgnum"], ErrorCode:"NotParsable"}`.

| Rel | Default | Max | Source URL | Status | What to re-verify |
|---|---|---|---|---|---|
| `/orders` | 100 | 1000 | https://3w.extensiv.com/rels/orders/orders ; /Rels/rql | Documented | — |
| `/inventory` | 100 | 1000 | https://3w.extensiv.com/rels/inventory/inventory | Documented | — |
| `/inventory/stocksummaries` | 100 | 500 | https://3w.extensiv.com/rels/inventory/stocksummaries | Documented | — |
| `/inventory/stockdetails` | 100 | 500 | https://3w.extensiv.com/rels/inventory/stockdetails | Documented | — |
| `/inventory/receivers` | 100 | 500 | https://3w.extensiv.com/rels/inventory/receivers | Documented | — |
| `/customers` | 20 | 100 | https://3w.extensiv.com/rels/customers/customers | Documented | — |
| `/customers/{id}/items` | 10 | 100 | https://3w.extensiv.com/rels/customers/items | Documented | — |
| `/orders/shipmentstrackinginfo` | 100 | 4000 | https://3w.extensiv.com/rels/orders/shipmentstrackinginfo | Documented (max) / **Guess** (default) | The real default. |
| `/orders/summaries` | 100 | 1000 | — | **Guess** | Both numbers. The mock copies `/orders`. |
| `/properties/facilities`, `/properties/facilities/{id}/locations` | 100 | 1000 | — | **Guess** | Both numbers, and whether these rels page at all. |
| `/orders/{id}/items`, `/orders/{id}/packages` | not paged | — | https://3w.extensiv.com/rels/orders/items ; /packages | Inferred | Whether the real sub-resources page. The mock returns every line with `totalResults` equal to the list length. |
| The error for an over-limit `pgsiz` is `400 … NotParsable` | all | https://3w.extensiv.com/rels/inventory/stocksummaries ("specifying more is an error") + https://3w.extensiv.com/Rels/exceptions (QueryParameter codes are only `Required`, `NotParsable` = "Query parameter bad data", `DoesNotExist`) | Inferred | `NotParsable` is the only one of the three documented QueryParameter codes that fits, but the real server might answer 400 with a different exception type entirely. |

## 6. Error bodies

| Behaviour | Endpoint | Source URL | Status | What to re-verify |
|---|---|---|---|---|
| Bodies are Newtonsoft `TypeNameHandling.Objects`: a `$type` plus PascalCase members | all 4xx | https://3w.extensiv.com/Rels/exceptions | Documented | — |
| `QueryParameterException {$type, Parameters, ErrorCode, Hint}` → 400 | list rels | https://3w.extensiv.com/Rels/exceptions | Documented | The verbatim `$type` string is documented only for this exception. |
| `ModelValidationException {$type, ModelType, Properties:[{Name,Value}], ErrorCode, Hint}` → 400 | writes | https://3w.extensiv.com/Rels/exceptions (shape and `ModelType` 0 Api / 1 Orm / 2 Other confirmed 2026-09-16) | Documented (shape) / **Guess** (the `$type` assembly qualifier, and that the mock always sends `ModelType: 0`) | Whether a given failure is reported as Api (0) or Orm (1). |
| `OperationException {$type, ActionNameType, ActionName, ErrorCode, Hint}` → 403 | operators | https://3w.extensiv.com/Rels/exceptions (shape and `ActionNameType` 0 Rel / 1 ClassName / 2 Parser confirmed 2026-09-16) | Documented (shape) / **Guess** (the `$type` qualifier, that the mock always sends `ActionNameType: 0`, and the `ActionName` strings — the mock uses the rel name, e.g. `orderconfirm`) | `ActionName` is "where the operation exception was detected", so the real value may be a controller method rather than a rel. |
| `ListException {$type, Faults:[{EntryNumber, EntryInfo, WmsException{ErrorCode,Hint,Message}}]}` | `PUT /orders/orderholder`, `PUT /inventory/holder` | https://3w.extensiv.com/Rels/exceptions | Documented (shape) / **Guess** (that this is what the hold response's `exceptions` member contains) | The hold rel only prints `"exceptions": {...}`. |
| ModelValidation codes `Required`, `DoesNotExist`, `Duplicate`, `Incompatible`, `ValueNotSupported` | writes | https://3w.extensiv.com/Rels/exceptions | Documented | Which code applies to which specific failure. Each mapping in `state.ts` is a judgement call. |
| Operation codes `InUse`, `WrongCustomerInBatch`, `MixedFacilitiesInBatch`, `OrderConfirmed`, `AlreadyCompleted`, `NotFullyAllocated`, `DateInFuture`, `DateBeforeFreeze`, `OrderNotConfirmed`, `OrderCanceled`, `Unallocated`, `FullyAllocated` | operators | https://3w.extensiv.com/Rels/exceptions | Documented | The per-code *descriptions* are narrower than the mock's use of them: `OrderConfirmed` is documented as "Order can't be completed or split because it's confirmed" and `OrderCanceled` as "Order can't be unconfirmed because it's canceled". The mock reuses them for any operation on a Closed / Canceled order, which is the closest documented fit but is **Inferred**. |
| `OnHold` operation code (order on hold blocks confirm) | `POST /orders/{id}/confirmer` | https://help.extensiv.com/en_US/order-management/putting-orders-on-hold-in-3pl-warehouse-manager ("REST API actions are blocked") | **Guess** (the code name) | No documented code covers "on hold". The mock invents `OnHold` rather than misreport a documented one. |
| `404` for a missing resource, empty body | all | https://3w.extensiv.com/Rels/exceptions | Documented (status) / **Guess** (empty body) | — |
| A non-integer path id is a `404` | all `/{id}` paths | — | **Guess** | The real server may answer 400. |
| `500` carries a **plain-text** body | all | https://3w.extensiv.com/Rels/exceptions | Documented | The mock echoes the internal message, which the real server certainly does not. |
| Unparsable JSON request body → `400 ModelValidationException Required` on `Body` | writes | — | **Guess** | The real behaviour for malformed JSON. |
| An unknown `detail` / `itemdetail` / `receivertype` value → `400 … NotParsable` | `/orders`, `/inventory/receivers` | — | **Guess** | The docs list the allowed values but not the rejection. |
| No `429` / rate limiting | all | https://3w.extensiv.com/Rels/exceptions ; help center | **Documented absence** | Rate limits are documented nowhere. The mock never throttles on its own; use `/__mock/faults` to simulate one. |

## 7. Reads

| Behaviour | Endpoint | Source URL | Status | What to re-verify |
|---|---|---|---|---|
| `GET /customers{?pgsiz,pgnum,rql,sort,facilityId,includeInUse}` | `/customers` | https://3w.extensiv.com/rels/customers/customers | Documented | `includeInUse` is accepted and ignored — the mock does not model "in use". |
| Customer model: `readOnly{customerId,creationDate,deactivated}`, `companyInfo`, `primaryContact`, `externalId`, `facilities[]`, `primaryFacilityIdentifier`, `options.alerts.webHookParameters[]`, `options.receiving.receiveAgainstAsns` (0 Disabled / 1 Enabled / 2 Blind) | `/customers`, `/customers/{id}` | https://3w.extensiv.com/rels/customers/customer | Documented | Fields the mock omits entirely (it never fabricates one it cannot keep consistent). |
| `GET /customers/{id}/items{?…}`; item model with `options.inventoryUnit`, `options.packageUnit`, `options.trackBys` (0 Disallow / 1 Allow / 2 Require), `inventoryMethod` (1 FIFO / 2 LIFO / 3 FEFO); "active" = `readOnly.deactivated === false` | `/customers/{id}/items` | https://3w.extensiv.com/rels/customers/items ; /item | Documented | `kitInclusion` / `storageRateInclusion` are accepted and ignored. |
| `GET /properties/facilities{?…,customerId}`; facility has `timeZoneName` as a Windows tz id | `/properties/facilities` | https://3w.extensiv.com/rels/properties/facilities | Documented | — |
| `GET /properties/facilities/{id}/locations` → `properties/location` rel | `/properties/facilities/{id}/locations` | https://3w.extensiv.com/rels/properties/locationsbyfac | Documented | Whether it supports `rql`/`sort`/paging (the mock offers them — **Guess**). |
| `GET /properties/carriers` → `{defaultBillingCodes, defaultShipmentServices, _embedded:{properties/carrier:[…]}}` | `/properties/carriers` | https://3w.extensiv.com/rels/properties/carriers | Documented (envelope) / **Guess** (the element shape of the two default lists — the mock returns the distinct codes the carriers expose) | — |
| `GET /orders{?pgsiz,pgnum,rql,sort,detail,itemdetail,markforlistid,skulist,skucontains,hvpbatchname,upclist}` | `/orders` | https://3w.extensiv.com/rels/orders/orders | Documented | `markforlistid` and `hvpbatchname` are **not implemented**: the mock does not model pick batches and silently ignores them. Do not rely on them against the mock. |
| `detail` = None, OrderItems, BillingDetails, SavedElements, Packages, Contacts, ProposedBilling, OutboundSerialNumbers, SmallParcel, ParcelOptions, Inserts, All (comma-delimited, default None) | `/orders`, `/orders/{id}` | https://3w.extensiv.com/rels/orders/orders | Documented | The mock only *acts* on `OrderItems`, `Packages` and `All`; the rest are validated then ignored, because the mock does not model billing, inserts or small-parcel options. |
| `itemdetail` = None, SavedElements, Allocations, All, AllocationsWithDetail | `/orders`, `/orders/{id}`, `/orders/{id}/items` | https://3w.extensiv.com/rels/orders/orders | Documented | — |
| `readOnly.allocations` is `null` unless `itemdetail` asks; `Allocation.detail` filled only for `AllocationsWithDetail` | order items | https://3w.extensiv.com/rels/orders/orders | **Guess** | Whether the real API omits the property, sends `null`, or sends `[]`. |
| `skulist` (comma list, exact), `skucontains` (partial), `upclist` narrow the collection to orders containing a matching line | `/orders` | https://3w.extensiv.com/rels/orders/orders | Documented (existence) / **Guess** (case-insensitivity, and that they match *any* line) | — |
| `GET /orders/{id}{?detail,itemdetail}` → 200 + ETag | `/orders/{id}` | https://3w.extensiv.com/rels/orders/order | Documented | — |
| Order `readOnly` block: `orderId, fullyAllocated, isClosed, processDate, pickStarted, pickDoneDate, packStarted, packDoneDate, asnSentDate, batchIdentifier, smallParcelShipDate, shipDate, onHoldDate, onHoldReason, customerIdentifier, facilityIdentifier, warehouseTransactionSourceType, creationDate, createdByIdentifier, lastModifiedDate, lastModifiedByIdentifier, status, chargesPending` | `/orders/{id}` | https://3w.extensiv.com/rels/orders/order | Documented | — |
| Status enum `WarehouseTransactionApiStatus`: 0 Open, 1 Closed, 2 Canceled — there is no "Complete" *status* | orders, receivers | https://3w.extensiv.com/rels/orders/order | Documented | — |
| "Complete" is modelled as `readOnly.processDate` being set | `POST /orders/{id}/completer` | https://help.extensiv.com/en_US/order-management/understanding-order-statuses (Open → Complete → Closed) | **Guess** | Which field the real API moves when an order is marked Complete. |
| `warehouseTransactionSourceType` 7 = RestApi | orders, receivers created via the API | https://3w.extensiv.com/rels/orders/orders | Documented | — |
| `createdByIdentifier` / `lastModifiedByIdentifier` name the `user_login` | orders, receivers | — | **Guess** | The real identity shown for an API-created transaction. |
| `GET /orders/{id}/items` → 200 + ETag, `orders/item` rel | `/orders/{id}/items` | https://3w.extensiv.com/rels/orders/items | Documented | — |
| `GET /orders/{id}/packages` → `orders/package` with nested `orders/packagecontent` | `/orders/{id}/packages` | https://3w.extensiv.com/rels/orders/packages ; /package | Documented | — |
| `GET /orders/summaries` → `_embedded.item[{orderId, referenceNum, poNum, fullyAllocated, customerIdentifier, facilityIdentifier, creationDate, isClosed}]` | `/orders/summaries` | https://3w.extensiv.com/rels/orders/summaries | Documented | — |
| `GET /orders/shipmentstrackinginfo` → `orders/orderparceltrackpackageinfo` with `trackingUrl`, `deliveryStatus`, `deliveryDate` | `/orders/shipmentstrackinginfo` | https://3w.extensiv.com/rels/orders/shipmentstrackinginfo | Documented (fields) / **Guess** (values) | `trackingUrl`, `deliveryStatus` ("In Transit") and `deliveryDateEstimated` (ship + 3 days) are fabricated; the real ones come from the carrier-tracking add-on. `deliveryDate` is always `null`. |
| Tracking numbers live in `routingInfo.trackingNumber`, `readOnly.packages[].trackingNumber` and `parcelResponse.trackingNumbers[]` | orders | https://3w.extensiv.com/rels/orders/order | Documented | The mock populates `routingInfo`, the package and `parcelResponse`, but not `readOnly.packages` (packages come from `/orders/{id}/packages` and `detail=Packages`). |
| `GET /inventory/stocksummaries{?pgsiz,pgnum,rql,orderednotallocated}` → per item/qualifier/facility `{totalReceived, allocated, available, onHold, onHand, orderedNotAllocated, facilityId}`; no `customerIdentifier` on a row | `/inventory/stocksummaries` | https://3w.extensiv.com/rels/inventory/stocksummaries | Documented | Scope by `rql=customeridentifier.id==N`; the mock filters on a hidden customerIdentifier and strips it from the response (**Inferred** — this is the only way the documented rql path can work on a row that has no such field). |
| `orderednotallocated` toggles the `orderedNotAllocated` computation, on by default | `/inventory/stocksummaries` | https://3w.extensiv.com/rels/inventory/stocksummaries (parameter exists) | **Guess** (semantics and default) | — |
| `GET /inventory/stockdetails{?customerid,facilityid,…}` — **both** required | `/inventory/stockdetails` | https://3w.extensiv.com/rels/inventory/stockdetails | Documented | The mock answers `400 QueryParameterException {ErrorCode:"Required", Parameters:[the missing ones]}` — the code is documented, the `Parameters` contents are **Inferred**. |
| Lots with `onHand <= 0` do not appear in `/inventory/stockdetails` or `/inventory` | those two | — | **Guess** | Whether fully-shipped lots vanish or linger with zeroes. |
| `GET /inventory` → `_embedded.item[]` with `inventoryAgeDays`, `onHold`, `onHoldReason`, `locationIdentifier`, … | `/inventory` | https://3w.extensiv.com/rels/inventory/inventory | Documented | — |
| `GET /inventory/receivers{?…,detail,itemdetail,purchaseorderid,receivertype}` | `/inventory/receivers` | https://3w.extensiv.com/rels/inventory/receivers | Documented | `purchaseorderid` is accepted and ignored (no PO model). |
| `detail` = None, ReceiveItems, BillingDetails, SavedElements, All, ProposedBilling | `/inventory/receivers` | https://3w.extensiv.com/rels/inventory/receivers | Documented | The mock acts only on `ReceiveItems` / `All`. |
| `itemdetail` on receivers | `/inventory/receivers` | https://3w.extensiv.com/rels/inventory/receivers (parameter named, values not listed) | **Guess** | The mock accepts the order-side enum and ignores it. |
| `receivertype` 0 Normal, 1 Return, 2 ReceiveAgainst, 3 OnlyASNs, 4 NoASNs | `/inventory/receivers` | https://3w.extensiv.com/rels/inventory/receivers | Documented | The mock maps 3 → `receiverType == 2` and 4 → `receiverType != 2`; that reading of "OnlyASNs"/"NoASNs" is **Inferred**. |
| `GET /inventory/receivers/{id}{?detail,itemdetail}` → 200 + ETag | `/inventory/receivers/{id}` | https://3w.extensiv.com/rels/inventory/receiver | Documented | — |
| `GET /billboard` | `/billboard` | https://3w.extensiv.com/Rels/billboard | Documented | See §3. |
| `/orders/adjustments`, `/orders/{id}/routing`, `POST /orders/{id}/items`, `/orders/{id}/allocator`, `/orders/{id}/unconfirmer`, `/inventory/adjustments`, `POST /customers/{id}/items` | — | documented rels | **Not implemented** | These rels exist and the mock does not serve them. A client that follows an `orderallocate` or `orderunconfirm` link the mock advertises will get a 404. |

## 8. Writes and operators

| Behaviour | Endpoint | Source URL | Status | What to re-verify |
|---|---|---|---|---|
| `POST /orders` → `201` + ETag | `POST /orders` | https://3w.extensiv.com/rels/orders/orders | Documented | — |
| Required on create: `customerIdentifier`, `facilityIdentifier`, `referenceNum`, `shipTo`, at least one `orderItems[]` entry with `itemIdentifier` + `qty` | `POST /orders` | https://3w.extensiv.com/rels/orders/orders | **Partly documented** | The verbatim required-field list was truncated in the fetch. Treat this set as partly inferred; the mock may demand something optional or allow something required. |
| Duplicate `referenceNum` → `400 ModelValidationException Duplicate` | `POST /orders` | https://3w.extensiv.com/Rels/exceptions ("such as a duplicate order ReferenceNum") | Documented | Uniqueness **scope**: the mock enforces per customer and counts cancelled orders. **Guess**. |
| Missing required field → `400 … Required`; unknown customer/facility/sku → `DoesNotExist`; bad `orderType` → `ValueNotSupported` | `POST /orders` | https://3w.extensiv.com/Rels/exceptions ; https://3w.extensiv.com/rels/orders/order (`orderType` ∈ B2B, D2C, AmazonFBA) | Documented (codes) / **Guess** (mapping per case) | A deactivated item is reported `DoesNotExist` — **Guess**. |
| A facility not assigned to the customer → `DoesNotExist` | `POST /orders`, `POST /inventory/receivers` | — | **Guess** | Could be `Incompatible`. |
| `trackLotNumber = 2` (Require) forces a lot number; `trackExpirationDate = 2` forces an expiry | `POST /orders`, `POST /inventory/receivers` | https://3w.extensiv.com/rels/customers/item (trackBys) | Inferred | That "Require" is enforced at transaction time with `Required`. |
| The create response echoes the order with its items | `POST /orders`, `POST /inventory/receivers` | — | **Guess** | The real default `detail` on a create response. |
| Creating an order allocates available stock FIFO by received date, honouring a requested `lotNumber` | `POST /orders` | https://3w.extensiv.com/rels/customers/item (`inventoryMethod` 1 FIFO) | Inferred | When the real WMS allocates (on create, on a pick batch, on a scheduled run) and how partial allocation behaves. The mock allocates synchronously on create and re-allocates short open orders whenever stock arrives. |
| `PUT /orders/{id}` "Updates an unconfirmed order"; `If-Match`; `200` + ETag | `PUT /orders/{id}` | https://3w.extensiv.com/rels/orders/order | Documented | — |
| Updating a non-Open order → `403 OperationException` `OrderConfirmed` (Closed) or `OrderCanceled` (Canceled) | `PUT /orders/{id}` and every order operator | https://3w.extensiv.com/Rels/exceptions | Documented (codes) / Inferred (which state maps to which) | — |
| A `PUT` carrying `orderItems` **replaces** the lines (releasing then re-allocating) | `PUT /orders/{id}` | — | **Guess** | Whether the real PUT replaces or merges lines. |
| `POST /orders/{id}/canceler` — `If-Match`, body `{reason}` (required), `204` | canceler | https://3w.extensiv.com/rels/orders/ordercancel | Documented | The `charge` and `invoiceCreationInfo` body members are accepted and ignored (no billing model). |
| Cancelling releases the allocations | canceler | — | Inferred | — |
| `POST /orders/{id}/confirmer` — `If-Match`, `204`; body `{confirmDate, trackingNumber, trailerNumber, sealNumber, billOfLading, loadNumber, doorNumber, pickupDate, …}` | confirmer | https://3w.extensiv.com/rels/orders/orderconfirm | Documented | `billing`, `recalcAutoCharges` and `invoiceCreationInfo` are accepted and ignored. |
| Confirm refuses when not fully allocated → `403 NotFullyAllocated`; a future `confirmDate` → `403 DateInFuture` | confirmer | https://3w.extensiv.com/rels/orders/orderconfirm ; https://3w.extensiv.com/Rels/exceptions | Documented | `DateBeforeFreeze` is a documented code the mock never raises — it does not model the facility freeze date (`lastCloseDate` is seeded but not enforced). |
| Confirm consumes `onHand` and clears `allocated`, sets `status = 1 Closed`, `isClosed`, `shipDate`, pick/pack dates | confirmer | https://help.extensiv.com/en_US/order-management/understanding-order-statuses ; https://help.extensiv.com/en_US/receipt-management/understanding-receipt-statuses | Inferred | — |
| Confirm through the API synthesises one package holding every line | confirmer | — | **Guess** | Real packages come from packing. The mock's single package, its 18×12×10 dimensions and its summed weight are invented. |
| An order on hold cannot be confirmed | confirmer | https://help.extensiv.com/en_US/order-management/putting-orders-on-hold-in-3pl-warehouse-manager | Documented (the block) / **Guess** (the `OnHold` code) | — |
| `POST /orders/{id}/completer` — `If-Match`, `204`; a second call → `403 AlreadyCompleted` | completer | https://3w.extensiv.com/rels/orders/ordercomplete ; https://3w.extensiv.com/Rels/exceptions | Documented (endpoint, code) / **Guess** (that completion is `processDate`) | The help centre calls Complete irreversible; the mock does not prevent a later cancel of a completed order. |
| `PUT /orders/orderholder{?deallocate,holdReason,release}`, body `{"orderIdentifiers":[{"id":1}]}`, → `200 {"heldOrderIds":[…],"exceptions":{…}}` | orderholder | https://3w.extensiv.com/rels/orders/orderholder | Documented | The `exceptions` contents are a **Guess** (see §6). Non-existent or non-Open ids become faults rather than failing the batch — **Inferred**. |
| `deallocate=true` also releases the allocations | orderholder | https://3w.extensiv.com/rels/orders/orderholder (the flag exists) | Inferred | — |
| Hold/release emits `OrderUpdate` | orderholder | — | **Guess** | The help centre lists Inventory Hold events but no order-hold event name. |
| The help centre says holding is impossible once a tracking number or ship date exists | orderholder | https://help.extensiv.com/en_US/order-management/putting-orders-on-hold-in-3pl-warehouse-manager | Documented, **not implemented** | The mock only refuses to hold a non-Open order. |
| `POST /inventory/receivers` → `201` + ETag; required `customerIdentifier`, `facilityIdentifier`, `referenceNum`, `receiveItems[]` | `POST /inventory/receivers` | https://3w.extensiv.com/rels/inventory/receivers | Documented | — |
| A customer configured for Receive Against gets `receiverType 2` (ASN) | `POST /inventory/receivers` | https://3w.extensiv.com/rels/inventory/receivers ; customer `options.receiving.receiveAgainstAsns` | Documented | — |
| `createReceiver` stores the submitted `qty` as the receive item's `qty` on an **Open** receiver, defaults `readOnly.expectedQty` to that same value and sets `readOnly.inventoryLevels` to `{onHand: 0, available: 0}` until the confirmer runs | `POST /inventory/receivers` | — | **Guess** | This split between "planned" and "on hand" on an un-arrived receiver is the mock's own reconstruction, not ground truth: no rel page says what `qty` means before the confirmer runs. The adapter now deliberately declines to read `qty` as a *received* quantity unless the receiver is Closed or carries an `arrivalDate`, so a mock ASN due tomorrow reports nothing received (`docs/research/api_reference_notes.md` §6, marked UNVERIFIED there). If real 3PLWM lets a warehouse key partial quantities into an open receiver, both the mock's shape and that adapter reading are wrong. |
| Duplicate receiver `referenceNum` → `400 Duplicate` | `POST /inventory/receivers` | — | **Guess** | The receivers rel only says `referenceNum` is required. The mock mirrors the order rule. |
| `PUT /inventory/receivers/{id}` "Updates an unconfirmed receiver"; `If-Match`; `200` + ETag | `PUT /inventory/receivers/{id}` | https://3w.extensiv.com/rels/inventory/receiver | Documented | — |
| `POST /inventory/receivers/{id}/confirmer` — `If-Match`, `204`; `arrivalDate` must not be in the future | confirmer | https://3w.extensiv.com/rels/inventory/receiverconfirm | Documented | — |
| Confirming a receipt creates the stock lots (on-hand), lands them in the given location or the first pickable one, and re-allocates short open orders | confirmer | https://help.extensiv.com/en_US/receipt-management/understanding-receipt-statuses ("Confirm Receipt … makes inventory on-hand") | Documented (effect) / Inferred (location default, re-allocation timing) | — |
| `POST /inventory/receivers/{id}/canceler` — `If-Match`, body `{reason}` (required), `204` | canceler | https://3w.extensiv.com/rels/inventory/receivercancel | Documented | — |
| Receiver operators on a non-Open receiver reuse the order codes `OrderConfirmed` / `OrderCanceled` | receiver operators | — | **Guess** | No receiver-specific operation codes are documented. |
| `PUT /inventory/holder{?holdReason,release}`, body `{"receiveItemIdentifiers":[{"id":1}]}` | `PUT /inventory/holder` | https://3w.extensiv.com/rels/inventory/inventoryhold | Documented (endpoint, body) / **Guess** (response body — the mock mirrors orderholder with `heldReceiveItemIds`) | — |
| Holding a lot moves everything not already allocated onto hold; releasing moves it all back | `PUT /inventory/holder` | — | **Guess** | What the real hold does to already-allocated units. |
| `/inventory/receivers/{id}/completer` and `/unconfirmer` | — | inferred rels | **Not implemented** | The research notes list them as inferred paths; the mock does not serve them. |

## 9. Webhooks

| Behaviour | Endpoint | Source URL | Status | What to re-verify |
|---|---|---|---|---|
| No public `/webhooks` REST endpoint; subscriptions come from the UI or `customer.options.alerts.webHookParameters[]` (`name, resource, eventTypes, url, includeResource, resourceApiParameters`) | — | https://help.extensiv.com/en_US/rest-api/configuring-webhooks ; https://3w.extensiv.com/rels/master/webhooksconfig | Documented | The mock reads the seeded customers' `webHookParameters` and additionally lets `/__mock/webhooks` register an "Any Customer" subscription. |
| Resource values: Order, Receiver, Adjustment, Assembly, OrderItem, Item, InventorySummary | — | https://3w.extensiv.com/rels/master/webhooksconfig | Documented | The mock only emits for Order, Receiver and InventorySummary. |
| Destination URLs must be `https://` | — | https://help.extensiv.com/en_US/rest-api/configuring-webhooks | Documented, **relaxed** | The mock accepts `http://` so a local receiver works. |
| Delivery: HTTP POST, `Content-Type: application/json`, header `Signature` = base64(RSA-SHA256 over the raw body) | outbound | https://help.extensiv.com/en_US/rest-api/implementing-webhooks | Documented | — |
| Payload `{tplId, wmsEventId, dateTime (deprecated), eventDateTimeUtc, warehouseTransactionEventId, createDateTimeUtc, eventType, resource{rel,href,body}, links, data, tags}`; `links` and `data` are escaped-JSON **strings**; `tags` is comma-delimited | outbound | https://help.extensiv.com/en_US/rest-api/implementing-webhooks | Documented | — |
| Webhook timestamps carry seven fractional digits and no offset | outbound | implementing-webhooks sample `2022-01-07T19:54:15.4770000` | Documented | — |
| `resource.body` present only when "Include resource in payload" | outbound | implementing-webhooks | Documented | — |
| `resource.href` carries the subscription's `resourceApiParameters` as a query string | outbound | implementing-webhooks sample `/orders/206568?detail=OrderItems` | **Guess** | Where that query string actually comes from. |
| `data` is `{"OrderId":"<id>"}` for an order, `{"<Resource>Id":"<id>"}` otherwise | outbound | implementing-webhooks sample (order only) | Inferred | The real key for non-order resources. |
| `links` carries `uiproperties/user`, `customers/customer`, `properties/facility` | outbound | implementing-webhooks sample | Documented | — |
| `OrderConfirm` carries `tags: "Shipped"` | outbound | implementing-webhooks sample | Documented | Which other events carry tags. The mock sends `""` for everything else. |
| Event names: Order (OrderCreate, OrderComplete, OrderUpdate, OrderConfirm, OrderUnconfirm, OrderCancel, OrderFullyAllocated, …), Receipt, Adjustment, Assembly, Order Item, Item, Inventory Summary, Inventory Hold | outbound | https://help.extensiv.com/en_US/rest-api/configuring-webhooks | Documented (the labels) | Only `OrderConfirm` appears verbatim as a wire string. The mock emits `OrderCreate`, `OrderUpdate`, `OrderCancel`, `OrderConfirm`, `OrderComplete`, `ReceiverCreate`, `ReceiverUpdate`, `ReceiverConfirm`, `ReceiverCancel`, `InventoryHoldPlace`, `InventoryHoldRelease`. Everything except `OrderConfirm` is a **Guess** at the exact string, and the mock never emits `OrderFullyAllocated`, `OrderPickJobDone`, pack events or item/adjustment/assembly events. |
| Receiver must answer within 3 seconds with a 20x | outbound | implementing-webhooks | Documented | The mock's request timeout is 3s to match. |
| Retries at intervals for ~6 hours, then a 3-day dead-letter queue | outbound | implementing-webhooks | Documented, **shortened** | The mock retries 3 times, 50 ms apart, and has no dead-letter queue. |
| Delivery order is not guaranteed; order by `eventDateTimeUtc` | outbound | implementing-webhooks | Documented | The mock delivers in emission order, so it will not surface an out-of-order bug. |
| `GET /events/webhook/key` → `{publicKey (PEM spki), retrievalDateISO}`; `previousRetrievalDateISO` → `304` | `/events/webhook/key` | implementing-webhooks | Documented | `retrievalDateISO` identifies the key version (the instant the mock's key pair was generated) — **Inferred**, because otherwise the `304` comparison could never match. |
| Source IPs 3.131.3.90, 3.131.5.63, 3.17.2.36 | outbound | https://help.extensiv.com/en_US/3plwhm-integrations-general-information/whitelisting-ip-addresses | Documented, N/A | The mock delivers from wherever it runs. |

## 10. The seeded world (`seed: 'default'`)

Built by replaying `MockState` operations, so `onHand = available + allocated + onHold` holds on every
lot. All dates are relative to the moment the app is created. Everything here is mock invention —
**no source, no fidelity claim** — but tests depend on it, so it is documented precisely.

| Thing | Values |
|---|---|
| Facilities | `1` LAX-1 (Pacific Standard Time, 90045), `2` DFW-2 (Central Standard Time, 75261) |
| Locations | 13 at LAX-1 (`101`–`112` as `A/B-bay-level`, plus `DOCK-RECV`), 9 at DFW-2 (`201`–`208`, plus `DOCK-RECV`) |
| Carriers | UPS, FedEx, USPS, LTL Freight, each with shipment services and billing codes |
| Customers | `1` Acme Outdoor Co (facilities 1+2, Receive-Against enabled, one Order webhook → `http://127.0.0.1:4020/webhooks/extensiv`), `2` Bluebird Cosmetics (facility 1), `3` Northwind Traders (**deactivated**), `9` Out Of Scope Co (facility 2) |
| Items | 20 for customer 1 (`1001`–`1020`, `ACME-*`; `ACME-FILTER-SQZ` requires a lot number, `ACME-MEAL-CHILI` an expiry, `ACME-LANTERN-LED` is deactivated), 8 for customer 2 (`2001`–`2008`, `BLB-*`; `BLB-SERUM-30ML` requires an expiry), 3 for customer 9 (`9001`–`9003`, `OOS-*`) |
| Receivers | 9, ids `7001`–`7009`, refs `ACME-ASN-5001`–`5005`, `BLB-RCV-3001`–`3003`, `OOS-RCV-100`. 5 closed (confirmed, with received-quantity variances on `ACME-PAD-REG`, `BLB-LIP-CORAL`, `ACME-MEAL-CHILI`), 3 open (`ACME-ASN-5004` due tomorrow, `ACME-ASN-5005` overdue, `BLB-RCV-3003` due in 5 days), 1 cancelled (`BLB-RCV-3002`) |
| Receiver types | 5 are ASNs (`receivertype=3` → 5), 4 are not (`receivertype=4` → 4) |
| Stock lots | 38 with on-hand stock; `/inventory/stockdetails?customerid=1&facilityid=1` returns 21 rows; 36 stock-summary groups |
| Orders | 42, ids `41001`–`41042`, refs `ACME-SO-10001`–`10031`, `BLB-SO-20001`–`20008`, `OOS-SO-1`–`3`. 24 closed (shipped, with tracking numbers and one package each), 3 cancelled (`ACME-SO-10004`, `ACME-SO-10009`, `BLB-SO-20008`), 2 on hold (`41031` = `ACME-SO-10023`, `41041` = `ACME-SO-10030`, both reason "Address verification"), 1 complete (`ACME-SO-10028`), the rest open |
| Deliberately short orders | `41029` (`ACME-SO-10021`, wants an `ACME-COOLER-45` that is out of stock) and `41030` (`ACME-SO-10022`, wants 30 `ACME-TENT-4P` with 14 on hand) — both open and **not** fully allocated, which is what makes `403 NotFullyAllocated` reachable |
| Counts a test can rely on | 4 customers, 2 facilities, 42 orders (18 with `readonly.isclosed==false`, 24 closed, 3 cancelled, 31 for customer 1), 9 receivers, 24 shipment-tracking rows, 38 inventory rows |
| `seed: 'empty'` | No facilities, customers, items, orders, receivers or lots; auth still works |

## 11. Mock-only control plane

Nothing under `/__mock/` exists on the real API. It is unauthenticated on purpose and is excluded
from both the bearer middleware and the fault middleware.

| Endpoint | What it does |
|---|---|
| `POST /__mock/reset` | Re-seeds (`{"seed":"default"\|"empty"}`). Also clears tokens, so callers must re-authenticate. |
| `GET /__mock/requests` | The request log: `{seq, method, path, query, headers, body, status, at, dropped?}`. `Authorization` is replaced with `Bearer <redacted>` / `Basic <redacted>` when the entry is recorded, so a live credential never reaches this endpoint. `?limit=N` returns the last N. |
| `DELETE /__mock/requests` | Clears the log. |
| `POST /__mock/faults` | `{expireAllTokens?, once?: [{match:"METHOD /path-prefix", status, retryAfterSeconds?, body?, dropConnection?}], latencyMs?, clear?}`. `match`'s method may be `*`; the path is a prefix. Each `once` entry fires at most once. |
| `GET /__mock/state` | `MockState.dump()`: counters, tokens (without the secret), orders, receivers, lots, faults, subscriptions. |
| `POST /__mock/webhooks` | `{url, resource, eventTypes, name?, includeResource?, customerId?}` — adds a subscription. Without `customerId` it fires for every customer. |
| `POST /__mock/webhooks/emit` | `{eventType, resourceRel, resourceId}` — forces an emission without performing the operation. |
| `GET /__mock/webhooks/deliveries` | The delivery log with attempts and signatures. Drains the in-flight queue first unless `?flush=false`. |
| `POST /__mock/stock` | `{customerId, facilityId, sku, onHandDelta}` — moves stock without a receipt, then re-allocates short open orders. |

`dropConnection` means: run the handler so the write lands, then abandon the response.

- Over a real socket (`startMockServer`) the socket is destroyed and the client gets a network error.
- Under `app.request()` there is no socket, so the mock returns the sentinel status **599** with
  `X-Mock-Connection-Dropped: 1`. This is a mock artefact; 599 is not an Extensiv status. It exists so
  the "outcome unknown, effect applied" branch is observable without sockets.

---

## Known divergences from the real API

1. **Webhook retries are shortened.** Three attempts 50 ms apart instead of ~6 hours of retries, and
   there is no dead-letter queue. A client that depends on eventual delivery hours later is untested.
2. **No rate limiting.** No numeric limit and no `429` behaviour is published anywhere, so the mock
   never throttles. Use `/__mock/faults` to force a `429` with a `Retry-After` and make sure your
   client backs off — but do not treat the mock's shape as Extensiv's.
3. **No role-based authorization.** Every credential has every role. The mock will never produce the
   role-denial `403` that a real credential with a narrow role set does.
4. **Webhook destinations may be `http://`.** The real product requires `https://`.
5. **Delivery is in-order.** The real service explicitly does not guarantee chronological delivery.
6. **Not every documented rel is served.** Adjustments, order routing, `POST /orders/{id}/items`,
   allocator/deallocator/unconfirmer, receiver completer/unconfirmer and `POST /customers/{id}/items`
   are absent, even where a state-conditional `_links` entry advertises them.
7. **Billing is absent.** `billing.billingCharges` is always `[]`, `chargesPending` always `false`,
   and `detail=BillingDetails` / `ProposedBilling` are validated then ignored.
8. **Pick batches and small-parcel options are absent.** `markforlistid`, `hvpbatchname`,
   `purchaseorderid`, `kitInclusion`, `storageRateInclusion` and `includeInUse` are accepted and
   silently ignored, and `readOnly.batchIdentifier` is always `null`.
9. **Tracking enrichment is fabricated.** `trackingUrl`, `deliveryStatus` and
   `deliveryDateEstimated` are synthesised; `deliveryDate` is always `null`.
10. **Confirming an order synthesises one package.** Real packages come from packing, with real
    dimensions and per-package contents.
11. **No facility freeze date enforcement.** `DateBeforeFreeze` is a documented `403` the mock never
    raises.
12. **`/inventory/stocksummaries` has no paging links,** matching the documented sample. If the real
    response carries `_links`, a client that follows `next` will behave differently here.
13. **Errors carry mock-authored `Hint` text**, and a `500` echoes the internal message. Match on
    `ErrorCode`, never on `Hint`.
14. **Timestamps are UTC rendered without an offset, and parsed the same way.** A date-time with no
    zone is read as UTC on input too, independent of the host's time zone; an explicit `Z` or offset
    is honoured. Whether the real API means UTC or warehouse-local time is not documented — this is
    the single most likely source of a silent off-by-hours bug when moving from the mock to a sandbox.
15. **The token-rejection body is the wrong shape.** The mock emits the RFC 6749 §5.2
    `{"error", "error_description"}` pair; production was observed on 2026-09-21 answering
    `401 {"Message":"invalid_client: client not registered"}` for unregistered Basic credentials.
    The status code matches, the body does not, so a client that parses only `error` will read
    nothing from a real rejection.
