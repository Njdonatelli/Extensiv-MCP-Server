# Extensiv 3PL Warehouse Manager REST API research notes (2026-09-16)

Source: fetched by a research subagent. This file is the citation base for `packages/mock-extensiv`. Every mock behaviour cites one of the URLs below; anything marked INFERRED is a guess to re-verify against sandbox or production. Anything marked UNVERIFIED is a guess the code already acts on and that must be re-checked the moment real credentials exist. A single class of fact is marked **VERIFIED LIVE**: it comes from a direct probe of the production API on the stated date, not from a documentation page, so it cites no URL.

## 0. Where the real documentation lives
- https://developer.extensiv.com/ is a landing page; the 3PLWM tile links to https://developer.3plcentral.com, a Postman-published JS shell (unreadable without a browser; /docs, /reference, swagger paths all 404).
- The authoritative server-rendered reference is the **REL documentation** served from the API itself: `http://api.3plcentral.com/rels/...` → **https://3w.extensiv.com/Rels/** (index) and `https://3w.extensiv.com/rels/{service}/{rel}`. Every rel key in a HAL `_embedded`/`_links` block is literally the URL of its own doc page.
- Concept pages: https://3w.extensiv.com/Rels/auth, /Rels/headers, /Rels/hal, /Rels/rql, /Rels/exceptions, /Rels/billboard, /Rels/identifiers. Service indexes: /Rels/orders, /Rels/inventory, /Rels/customers, /Rels/properties.
- Doc contact: api@extensiv.com. Docs are "subject to change without warning".
- Base API URL: `https://secure-wms.com` (help center). `secure-wms.com/` root redirects to the UI at 3w.extensiv.com/smartui.
- **VERIFIED LIVE (2026-09-21, direct probe, no doc page):** both API hosts are reachable from the open internet without credentials. `GET https://secure-wms.com/AuthServer/api/Token` answers **405** — the endpoint exists and is POST-only, which matches §1. `https://api.3plcentral.com/rels/auth` answers **302** (a redirect; the target was not recorded).

## 1. Authentication (https://3w.extensiv.com/Rels/auth ; https://help.extensiv.com/en_US/rest-api/providing-rest-api-access)
Credential types: "Single-Tenant static" (third-party developers; issued for one 3PL), "Single-Tenant dynamic" (internal; must send `tpl` GUID), "Multi-Tenant" (internal). OAuth2 client_credentials: BASIC auth to get a token, BEARER to call.

```
POST https://secure-wms.com/AuthServer/api/Token
Authorization: Basic <base64(clientId:clientSecret)>
Content-Type: application/json; charset=utf-8
Accept: application/json

{ "grant_type": "client_credentials", "user_login": "guysmiley" }
```
- Body field is **`user_login`** ("Provided by warehouse"; identifies which connection created a transaction). Rels/auth also documents `"tpl": "<threepl guid>"`, required only for Single-Tenant dynamic credentials. `user_login_id` does not appear in either source. INFERRED: mock accepts `user_login` and tolerates `user_login_id` / `tpl` as optional.
- Success (200, `application/json; charset=utf-8`):
  `{ "access_token": "...", "token_type": "Bearer", "expires_in": 3600, "refresh_token": null, "scope": null }`
  Help center says tokens last "typically between 30 and 60 minutes" and recommends refreshing at least every 30 minutes.
- API calls: `Authorization: Bearer <token>`, `Accept: application/hal+json`.
- 401 = not authenticated; 403 = authenticated but role-based authorization denies.
- **VERIFIED LIVE (2026-09-21, direct probe with deliberately fake credentials, no doc page):** `POST https://secure-wms.com/AuthServer/api/Token` with Basic credentials that are not registered answers **HTTP 401** with the body `{"Message":"invalid_client: client not registered"}`. That is an ASP.NET `Message` field on a 401 — **not** the OAuth2 `400` + `{"error","error_description"}` shape of RFC 6749 §5.2, which is what `packages/mock-extensiv` emits and what was assumed before this probe. The adapter now reads whichever of `Message`, `error` or `error_description` is present, tolerates a non-JSON body, and bounds and sanitises the text before it reaches a message or a log line. The rejection body for other failure modes (wrong `grant_type`, unknown `user_login`, wrong `tpl`) and the sandbox's rejection shape remain unobserved.
- Roles (help center): C2CTransfer, CustomerEdit, CustomerNotifyEdit, CustomerNotifyView, CustomerView, FacilityEdit, FacilityView, InventoryDetailView, InventoryEdit, InventoryRead, ItemEdit, ItemView, OrderConfirm, OrderEdit, OrderImport, OrderView, OrderWrite, PoEdit, PoView, ReadPropertiesThirdParty, ReceiverEdit, ReceiverView, WritePropertiesThirdParty.
- Billboard entry point `/billboard` (HATEOAS; docs say do not hardcode URIs).

Sandbox: UI at `https://box.secure-wms.com/` (legacy) and `https://app-sandbox.extensiv.com/`. No sandbox API hostname or credential process is documented. INFERRED: sandbox API base `https://box.secure-wms.com` with the same `/AuthServer/api/Token` path.

## 2. Headers, ETag/If-Match, HAL, RQL, paging, errors
### Headers (https://3w.extensiv.com/Rels/headers)
- Request: `Content-Type: application/hal+json` recommended; `If-Match` "Required when updating a resource"; `Accept: application/hal+json`.
- Response: `ETag` on single-resource GET/PUT/POST-create; `Link`; `Cache-Control`.
- Per-rel rule pattern: GET single → 200 + ETag; PUT → If-Match required, 200 + ETag; POST create → 201 + ETag; operators (POST/PUT) → 204 with If-Match required; DELETE → 204 (If-Match required).

### HAL (https://3w.extensiv.com/Rels/hal)
- Media type `application/hal+json`. Collections: `{"totalResults": N, "_embedded": {"<rel>": [...]}, "_links": {...}}` with `next`/`prev`/`self`. Property names are camelCase on the wire.
- Embedded rel keys use the literal `http://api.3plCentral.com/rels/...` form:
  `.../orders/order`, `.../orders/item`, `.../orders/package`, `.../orders/packagecontent`, `.../customers/customer`, `.../customers/item`, `.../inventory/receiver`, `.../inventory/receiveritem`, `.../inventory/adjustment`, `.../properties/facility`, `.../properties/location`, `.../properties/carrier`.
- Some lists use the bare key `"item"`: /inventory, /inventory/stockdetails, /orders/summaries.
- `/inventory/stocksummaries` does NOT use `_embedded`; it returns `{"totalResults":1,"summaries":[...]}`.
- Identifiers (https://3w.extensiv.com/Rels/identifiers): GET returns all alternates (`{"externalId","name","id"}` for customer; `{"name","id"}` for facility; `{"sku","id"}` for item). On PUT/POST one alternate suffices; `id` wins if supplied.

### RQL / paging / sort (https://3w.extensiv.com/Rels/rql)
- Query params `rql=`, `sort=`, `pgsiz=`, `pgnum=` (1-indexed). Page-size limits per rel: /orders 1000 (default 100); /inventory 1000 (100); /inventory/stocksummaries 500 (100); /inventory/stockdetails 500 (100); /inventory/receivers 500 (100); /customers/{id}/items 100 (10); /customers 100 (20). Exceeding is an error (INFERRED: 400 QueryParameterException).
- FIQL-style: predicates joined by `;` (and) and `,` (or); parentheses allowed. Operators `==`, `!=`, `=gt=`, `=ge=`, `=lt=`, `=le=`, `=in=(a,b,c)`, `=out=(...)`, `=hv=true|false`. Wildcards `*x`, `x*`, `*x*` with `==`/`!=`. Property names are API model names, dotted for nesting (e.g. `readonly.creationdate`, `readonly.isclosed`, `customeridentifier.id`). Case-insensitive. Values: dates, numbers, `true|false`, strings. Example: `rql=fld1==bill;fld2=gt=12;(fld3=in=(x,y,z),fld4!=sam*)`.
- Escaping: URL-encode `% ! ( ) * = , ;` inside values, then encode `%` again as `%25` (server decodes twice).
- Sort: `sort=fld2,-fld3` (`-` desc).
- Order status note: for rql on orders, `status` is only reliable for Canceled; otherwise filter on `readonly.isclosed`.

### Errors (https://3w.extensiv.com/Rels/exceptions)
200 success; 201 created; 202 accepted (async); 204 no content; 400 bad request (JSON exception body); 401 missing/invalid bearer; 403 forbidden (role lacks access OR operation not allowed, JSON body); 404 not found; 412 If-Match does not match; 428 If-Match header required; 500 plain-text body. **429 / rate limiting is not documented anywhere.**

Error body (Newtonsoft `TypeNameHandling.Objects`):
`{"$type":"WMS.V2.Generic.Models.Exceptions.QueryParameterException, WMS.V2.Generic.Models","Parameters":["rql"],"ErrorCode":"NotParsable","Hint":"Properties not supported: gorp"}`
Types: `AuthorizationException {ErrorCode, Hint}`; `ListException {Faults:[{EntryNumber, EntryInfo, WmsException{ErrorCode,Hint,Message}}]}`; `ModelValidationException {ModelType, Properties:[{Name,Value}], ErrorCode, Hint}`; `OperationException {ActionNameType, ActionName, ErrorCode, Hint}`; `QueryParameterException {Parameters:[...], ErrorCode, Hint}`.
ErrorCode values: ModelValidation (400): Required, DoesNotExist, Duplicate, Incompatible, ValueNotSupported. OperationException (403): InUse, WrongCustomerInBatch, MixedFacilitiesInBatch, OrderConfirmed, AlreadyCompleted, NotFullyAllocated, DateInFuture, DateBeforeFreeze, OrderNotConfirmed, OrderCanceled, Unallocated, FullyAllocated. QueryParameter (400): Required, NotParsable, DoesNotExist. Field names in error bodies are PascalCase.

## 3. Orders
### Collection (https://3w.extensiv.com/rels/orders/orders)
- `GET /orders{?pgsiz,pgnum,rql,sort,detail,itemdetail,markforlistid,skulist,skucontains,hvpbatchname,upclist}` → 200. `detail` (comma-delimited, default None): None, OrderItems, BillingDetails, SavedElements, Packages, Contacts, ProposedBilling, OutboundSerialNumbers, SmallParcel, ParcelOptions, Inserts, All. `itemdetail`: None, SavedElements, Allocations, All, AllocationsWithDetail. `skulist` comma-delimited; `skucontains` partial.
  Response `{"totalResults","_embedded":{"http://api.3plCentral.com/rels/orders/order":[...]}}` + next/prev links.
- `POST /orders` → 201 + ETag. Required (PARTLY INFERRED; the verbatim block was truncated): customerIdentifier (id or name), facilityIdentifier, referenceNum, orderItems (itemIdentifier + qty), shipTo. Duplicate ReferenceNum → 400 ModelValidationException `Duplicate`; missing → `Required`.

### Single (https://3w.extensiv.com/rels/orders/order)
- `GET /orders/{id}{?detail,itemdetail}` → 200 + ETag.
- `PUT /orders/{id}{?detail,itemdetail,recalcautocharges}` "Updates an unconfirmed order"; If-Match required; 200 + ETag.
- `readOnly{orderId, fullyAllocated, isClosed, processDate, pickStarted, pickDoneDate, packStarted, packDoneDate, asnSentDate, batchIdentifier, smallParcelShipDate, packages[], shipDate, onHoldDate, onHoldReason, customerIdentifier, facilityIdentifier, warehouseTransactionSourceType (7 RestApi), creationDate, createdByIdentifier, lastModifiedDate, lastModifiedByIdentifier, status, chargesPending}`.
- **Order status enum** `WarehouseTransactionApiStatus`: 0 Open ("Has not yet been confirmed"), 1 Closed ("Has been confirmed"), 2 Canceled. There is no "Complete" status value in the API; "complete" is an operator. Same enum for receivers and adjustments.
- Writable top level: `referenceNum, description, poNum, externalId, earliestShipDate, shipCancelDate, notes, numUnits1, totalWeight, totalVolume, billingCode, asnNumber, shippingNotes, invoiceNumber, routingInfo{isCod, isInsurance, requiresDeliveryConf, scacCode, carrier, mode, account, shipPointZip, capacityTypeIdentifier, loadNumber, billOfLading, trackingNumber, trailerNumber, sealNumber, doorNumber, pickupDate}, billing{billingCharges[]}, shipTo{contactId, companyName, name, title, address1, address2, city, state, zip, country, phoneNumber, fax, emailAddress, dept, isAddressResidential, code, addressStatus}, soldTo, billTo, savedElements[{name,value}], parcelOption{...}, parcelResponse{orderId, trackingNumbers[], returnTrackingNumbers[]}, expectedDeliveryDate, orderType ("B2B","D2C","AmazonFBA")`.
- Tracking numbers live in `routingInfo.trackingNumber`, `readOnly.packages[].trackingNumber`, `parcelResponse.trackingNumbers[]`.
- Order items embedded under `_embedded["http://api.3plCentral.com/rels/orders/item"]` when detail includes OrderItems. OrderItem: `readOnly{orderItemId, fullyAllocated, unitIdentifier, allocations[{receiveItemId, qty, detail{itemTraits{itemIdentifier, qualifier, lotNumber, serialNumber, expirationDate}, locationIdentifier}}], rowVersion}, itemIdentifier{sku,id}, qualifier, externalId, qty, secondaryQty, lotNumber, serialNumber, expirationDate, notes, savedElements[]`.
- Links on an order are conditional on state: edit, items, packages, customer, facility, ordercancel, orderconfirm, ordercomplete, orderallocate, orderdeallocate, orderunconfirm, ...

### Sub-resources and operators (https://3w.extensiv.com/rels/orders/<rel>)
- items: `GET /orders/{id}/items` 200 + ETag; `POST /orders/{id}/items` If-Match 201; `PUT /orders/{id}/items` If-Match 200.
- routing: `GET/PUT /orders/{id}/routing` (PUT If-Match, 200 + ETag).
- ordercancel: `POST /orders/{id}/canceler` "Cancel an open order"; If-Match required; 204. Body `{"reason": "str" (required), "charge": 1.0, "invoiceCreationInfo": {...}}`.
- orderconfirm (ship): `POST /orders/{id}/confirmer` If-Match; 204. Body `{confirmDate, trackingNumber, trailerNumber, sealNumber, billOfLading, loadNumber, doorNumber, pickupDate, billing, recalcAutoCharges, invoiceCreationInfo}`. 403 OperationException codes: NotFullyAllocated, DateInFuture, DateBeforeFreeze, AlreadyCompleted/OrderConfirmed.
- orderunconfirm `POST /orders/{id}/unconfirmer` If-Match 204. ordercomplete `POST /orders/{id}/completer` If-Match 204. orderallocate `PUT /orders/{id}/allocator` If-Match 204.
- orderholder: `PUT /orders/orderholder{?deallocate,holdReason,release}` 200; body `{"orderIdentifiers":[{"id":1}]}`; response `{"heldOrderIds":[1],"exceptions":{...}}`.
- packages: `GET /orders/{id}/packages` → `_embedded["...rels/orders/package"]` items `{packageId, length, width, height, weight, trackingNumber, description, createDate, _embedded: {"...rels/orders/packagecontent": [{packageContentId, orderItemId, qty, lotNumber, itemIdentifier}]}}`.
- summaries: `GET /orders/summaries{?pgsiz,pgnum,rql,sort}` → `_embedded.item[{orderId, referenceNum, poNum, fullyAllocated, customerIdentifier, facilityIdentifier, creationDate, isClosed}]`.
- shipmentstrackinginfo: `GET /orders/shipmentstrackinginfo` (pgsiz limit 4000) → `_embedded["...rels/orders/orderparceltrackpackageinfo"]` with `orderId, referenceNum, packageId, carrier, carrierService, trackingNumber, trackingUrl, deliveryStatus, shipDate, deliveryDate`.

## 4. Inventory / stock
- stocksummaries (https://3w.extensiv.com/rels/inventory/stocksummaries): `GET /inventory/stocksummaries{?pgsiz,pgnum,rql,orderednotallocated}` 200 (limit 500) → `{"totalResults":1,"summaries":[{"itemIdentifier":{"sku","id"},"qualifier","totalReceived","allocated","available","onHold","onHand","orderedNotAllocated","facilityId"}]}`. No `sort` param. Note: no customerIdentifier on a summary row; scope by rql `customeridentifier.id==N` (INFERRED property name).
- stockdetails (https://3w.extensiv.com/rels/inventory/stockdetails): `GET /inventory/stockdetails{?customerid,facilityid,pgsiz,pgnum,rql,sort}` **customerid and facilityid required**; 200 → `_embedded.item[{receiveItemId, itemIdentifier, description, upc, qualifier, received, available, isOnHold, quarantined, onHand, lotNumber, serialNumber, expirationDate, cost, locationIdentifier{nameKey{facilityIdentifier,name},id}, receiverId, receivedDate, referenceNum, poNum}]`.
- inventory (https://3w.extensiv.com/rels/inventory/inventory): `GET /inventory{?pgsiz,pgnum,rql,sort}` 200 (limit 1000) → `_embedded.item[]` with `receiverId, receivedDate, receiveItemId, customerIdentifier, facilityIdentifier, itemIdentifier, itemDescription, upc, qualifier, receivedQty, onHandQty, availableQty, onHoldQty, inventoryAgeDays, lotNumber, serialNumber, expirationDate, locationIdentifier, onHold, onHoldReason, referenceNum, poNum`.
- inventoryhold: `PUT /inventory/holder{?holdReason,release}` body `{"receiveItemIdentifiers":[{"id":1}]}`.
- adjustments: `GET /inventory/adjustments`; `POST /inventory/adjustments{?noCommit}` 201 + ETag with `_embedded.item[{qty (+/-), receiveItemId, itemIdentifier, qualifier, lotNumber, expirationDate, locationInfo, ...}]`.

## 5. Items (https://3w.extensiv.com/rels/customers/items ; /rels/customers/item)
- `GET /customers/{id}/items{?pgsiz,pgnum,rql,sort,kitInclusion,storageRateInclusion}` 200, cacheable, limit 100 default 10 → `_embedded["http://api.3plCentral.com/rels/customers/item"]`.
- `POST /customers/{id}/items` 201 + ETag. `GET /customers/{id}/items/{iid}` 200 + ETag; `PUT` If-Match; `DELETE` If-Match 204.
- Item model: `readOnly{customerIdentifier, itemId, creationDate, lastModifiedDate, deactivated, rowVersion}, itemId, sku, upc, description, description2, inventoryCategory, cost, price, options{inventoryUnit{unitIdentifier{name,id}, minimumStock, maximumStock, reorderQuantity, inventoryMethod(1 FIFO,2 LIFO,3 FEFO), imperial{netWeight,length,width,height,weight}, metric{...}}, packageUnit{...}, trackBys{trackLotNumber(0 Disallow,1 Allow,2 Require), trackSerialNumber(0..4), trackExpirationDate(0..2), trackCost}, ...}, tags[]`. "Active" is `readOnly.deactivated === false`.

## 6. Receivers / ASNs (https://3w.extensiv.com/rels/inventory/receivers ; /receiver ; /receiverconfirm ; /receivercancel)
- `GET /inventory/receivers{?pgsiz,pgnum,rql,sort,detail,itemdetail,purchaseorderid,receivertype}` 200 (limit 500). `detail`: None, ReceiveItems, BillingDetails, SavedElements, All, ProposedBilling. `receivertype`: 0 Normal, 1 Return, 2 ReceiveAgainst (ASN), 3 OnlyASNs, 4 NoASNs. → `_embedded["http://api.3plCentral.com/rels/inventory/receiver"]`, each with `_embedded["http://api.3plCentral.com/rels/inventory/receiveritem"]` when detail includes ReceiveItems.
- `POST /inventory/receivers` → 201 + ETag. Body: `customerIdentifier, facilityIdentifier, referenceNum (required), poNum, externalId, arrivalDate, expectedDate, notes, carrier, trackingNumber, trailerNumber, receiveItems[], ...`. Customers configured for "Receive Against" get an ASN (receiverType 2).
- `GET /inventory/receivers/{id}{?detail,itemdetail}` 200 + ETag. `PUT /inventory/receivers/{id}` If-Match; "Updates an unconfirmed receiver".
- Receiver.readOnly: `receiverId, receiverType, customerIdentifier, facilityIdentifier, creationDate, createdByIdentifier, lastModifiedDate, status (0 Open, 1 Closed, 2 Canceled), chargesPending`.
- ReceiveItem: `readOnly{receiveItemId, expectedQty, inventoryLevels{onHand, available}, rowVersion}, itemIdentifier{sku,id}, qualifier, qty, lotNumber, serialNumber, expirationDate, cost, locationInfo{locationId, display}, onHold, onHoldReason`.
- **UNVERIFIED (no live credentials; a GUESS the adapter already acts on):** `ReceiveItem.qty` on a receiver that has **not** arrived is treated as a plan, not an arrival. "Arrived" means `readOnly.status == 1` (Closed) or a stamped `arrivalDate`; a cancelled receiver never counts. Until then the adapter reports `qtyReceived` 0 and a per-line variance of `-qtyExpected`. No rel page says what `qty` means before the confirmer runs, and the opposite reading — `qty` is whatever the warehouse has keyed in so far — would make this UNDER-report a partial receipt. To settle it once credentials exist, fetch, in order: (a) `GET /inventory/receivers/{id}?detail=ReceiveItems` for an **open Receive-Against ASN (receiverType 2) with nothing physically received** and compare `qty`, `readOnly.expectedQty` and `readOnly.inventoryLevels.onHand` against what the UI shows for that receipt; (b) the same fetch for an **open receiver that has been partially received**, if 3PLWM allows keying partial quantities into a receiver without confirming it — if `qty` moves there, the guess is wrong; (c) the same receiver once more after `POST /inventory/receivers/{id}/confirmer`, to see which of the three fields the confirmer moves.
- Operators: `POST /inventory/receivers/{id}/confirmer` If-Match 204, body `{arrivalDate (not future), trackingNumber, trailerNumber, sealNumber, billOfLading, loadNumber, billing, recalcAutoCharges}`. `POST /inventory/receivers/{id}/canceler` If-Match 204, body `{"reason":"str"(required)}`. INFERRED paths: `/completer`, `/unconfirmer`.

## 7. Customers, facilities, locations, carriers
- customers (https://3w.extensiv.com/rels/customers/customers): `GET /customers{?pgsiz,pgnum,rql,sort,facilityId,includeInUse}` 200 cacheable → `_embedded["http://api.3plCentral.com/rels/customers/customer"]`. Model: `readOnly{customerId, creationDate, deactivated}, companyInfo{companyName, name, address1, address2, city, state, zip, country, phoneNumber, emailAddress}, primaryContact, externalId, facilities[{name,id}], primaryFacilityIdentifier, options{alerts{webHookParameters[{name, resource, eventTypes, url, includeResource}]}, receiving{receiveAgainstAsns(0 Disabled,1 Enabled,2 Blind)}, ...}`.
- customer (https://3w.extensiv.com/rels/customers/customer): `GET /customers/{id}` 200 + ETag.
- facilities (https://3w.extensiv.com/rels/properties/facilities): `GET /properties/facilities{?pgsiz,pgnum,rql,sort,customerId}` 200 cacheable → `_embedded["http://api.3plCentral.com/rels/properties/facility"]`: `facilityId, name, deactivated, code, timeZoneName ("Pacific Standard Time"), shippingZip, contact{...}, lastCloseDate, rowVersion`.
- locations (https://3w.extensiv.com/rels/properties/locationsbyfac): `GET /properties/facilities/{id}/locations` → `_embedded["...properties/location"]` `{locationId, name, field1..4, facilityIdentifier, deactivated, hasInventory, pickPath}`.
- carriers (https://3w.extensiv.com/rels/properties/carriers): `GET /properties/carriers` → `{"defaultBillingCodes":[...], "defaultShipmentServices":[...], "_embedded":{"http://api.3plCentral.com/rels/properties/carrier":[{name, description, scacCode, deactivated, carrierCode, displayName, shipmentServices[], billingCodes[]}]}}`. INFERRED: `routingInfo.carrier`/`mode` on orders are free strings matching carrier name / service code.

## 8. Webhooks (help center articles ; https://3w.extensiv.com/rels/master/webhooksconfig)
- No public `/webhooks` REST endpoint for third parties. Configured in the UI (Customers > Event Notifications) or via `customer.options.alerts.webHookParameters[]` (`name, resource, eventTypes, url (https only), includeResource, resourceApiParameters`). Resource values: Order, Receiver, Adjustment, Assembly, OrderItem, Item, InventorySummary.
- Delivery: HTTP POST, `Content-Type: application/json`, header `Signature` = base64 RSA-SHA256 of the raw body. Payload body:
```
{"tplId":2,"wmsEventId":2070354,"dateTime":"2022-01-07T19:54:15.4770000","eventDateTimeUtc":"2025-01-07T19:54:15.4770000","warehouseTransactionEventId":1,"createDateTimeUtc":"2025-01-07T19:54:18.4770000","eventType":"OrderConfirm",
 "resource":{"rel":"orders/order","href":"/orders/206568?detail=OrderItems","body":"{...}"},
 "links":"{\"uiproperties/user\":{\"LastModifiedBy\":\"/uiproperties/users/-1\"},\"customers/customer\":\"/customers/143\",\"properties/facility\":\"/properties/facilities/10\"}",
 "data":"{\"OrderId\":\"206568\"}","tags":"Shipped"}
```
  `resource.body` only if IncludeResource; `links` and `data` are escaped-JSON strings; `tags` comma-delimited; delivery order not guaranteed.
- Public key: `GET https://secure-wms.com/events/webhook/key` → `{"publicKey": "<PEM spki>", "retrievalDateISO": "..."}`; optional `previousRetrievalDateISO` → 304.
- Receiver must answer within 3 seconds with 20x; retries for ~6 hours, then dead-letter for 3 days.
- Source IPs to allow-list (https://help.extensiv.com/en_US/3plwhm-integrations-general-information/whitelisting-ip-addresses): 3.131.3.90, 3.131.5.63, 3.17.2.36.
- INFERRED: event type strings for non-order resources follow the same `<Resource><Verb>` pattern (e.g. `ReceiverConfirm`); only `OrderConfirm` is shown verbatim.

## 9. Other
- No `/reports` endpoint for third parties; billing rides inside transactions. Async rels return 202 with a status link.
- No API version segment in paths; no changelog page. Product releases on the second Wednesday monthly.

## 10. Gaps
- 429 / rate-limit behaviour and headers: not documented.
- What `ReceiveItem.qty` means on a receiver that has not arrived (§6): UNVERIFIED, and the adapter's reading of it is load-bearing for every received-quantity and variance number the server reports.
- The token endpoint's rejection body is now known for production (§1, VERIFIED LIVE), but only for unregistered Basic credentials; the sandbox's shape and the other failure modes are still unknown.
- Verbatim `POST /orders` and `PUT /orders/{id}` required-field lists were truncated in the fetch; treat as partly inferred.
- Sandbox API hostname and credential process: not documented.
- developer.3plcentral.com Postman collection is unreadable without JS.

Sources read: https://developer.extensiv.com/ ; https://developer.3plcentral.com/ ; https://3w.extensiv.com/rels ; /Rels/{auth,headers,hal,rql,exceptions,billboard,identifiers,orders,inventory,customers,properties} ; /rels/orders/{orders,order,items,item,orderrouting,ordercancel,orderconfirm,orderunconfirm,ordercomplete,orderallocate,ordershort,orderholder,packages,package,packagesgenerate,summaries,shipmentstrackinginfo} ; /rels/inventory/{stocksummaries,stocksummariesfororder,stockdetails,inventory,receivers,receiver,receiverconfirm,receivercancel,receiveitems,adjustments,adjustment,inventoryhold} ; /rels/customers/{customers,customer,items,item} ; /rels/properties/{facilities,locationsbyfac,locations,carriers} ; /rels/master/webhooksconfig ; help.extensiv.com REST API articles ; sandbox overview ; whitelisting-ip-addresses.
