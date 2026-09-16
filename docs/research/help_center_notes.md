# Extensiv help center research notes (2026-09-16)

Source: fetched by a research subagent from help.extensiv.com. Every claim below carries the article URL it came from. Items marked INFERRED were not stated verbatim and must be re-verified once credentials or a CSM contact are available.

Domain notes: `help.3plcentral.com` 301-redirects to `help.extensiv.com`. `developer.extensiv.com` is a static landing page linking the 3PLWM REST reference at `developer.3plcentral.com`.

REST API category index: https://help.extensiv.com/en_US/rest-api

## 1. Obtaining REST API credentials (self-service)
Primary doc: https://help.extensiv.com/en_US/rest-api/getting-started-with-credential-management

Credentials are self-provisioned in the **Support Portal → Manage Credentials (Beta)** page:
1. Log in at https://app.extensiv.com/ → open the **3PL Warehouse Manager** tile.
2. Click **Support** (upper-right) to open the Support Portal.
3. Select **Manage Credentials (Beta)**.
4. **Create New Credential** → **External REST/Developer** → **Continue**.
5. Fields: **Customer ID** (must match Manage Customers grid), **Platform**, **Developer Contact Info**, **Notes**, **Enabled**.
6. Roles: recommended developer set `CustomerView, FacilityView, InventoryDetailView, ItemView, OrderEdit, OrderView, OrderWrite, ReadPropertiesThirdParty, ReceiverView`.
   Full role list: C2CTransfer, CustomerEdit, CustomerNotifyEdit, CustomerNotifyView, CustomerView, FacilityEdit, FacilityView, InventoryDetailView, InventoryEdit, InventoryRead, ItemEdit, ItemView, OrderConfirm (closing of orders), OrderEdit (modification of Open and Complete orders), OrderImport, OrderView, OrderWrite (canceling and splitting of orders), PoEdit, PoView, ReadPropertiesThirdParty, ReceiverEdit, ReceiverView, WritePropertiesThirdParty.
7. **Save** → Client ID / Client Secret appear in the grid.

Prerequisite: create a **customer user** per credential, named after the integration, assigned to the relevant customers; its permission level does not affect API permissions. Its **3PL Warehouse Manager ID** is the `user_login` value: Extensiv Hub → **Users** → search user → "3PL Warehouse Manager ID".

| Artifact | Where |
|---|---|
| Client ID / Client Secret | Support Portal → Manage Credentials grid |
| `user_login` (3PL Warehouse Manager ID) | Extensiv Hub → Users → user detail |
| Customer ID | 3PLWM → Customers → Manage Customers grid (column-header ellipsis → Columns → Customer ID) |
| Warehouse/Facility ID | Warehouse → Manage Warehouse (INFERRED: grid column) |
| TPL Number and GUID | Support Portal → Account → Account Information (https://help.extensiv.com/en_US/navigation/tech-support-team) |

Access prerequisites (https://help.extensiv.com/en_US/customer-central/support-portal-faqs): WMS subscription must include an API package and the user must be the Support Portal "super user"; otherwise contact the CSM.
Deprovisioning: email API@extensiv.com.

Auth mechanics (https://help.extensiv.com/en_US/rest-api/providing-rest-api-access): Base64 `ClientID:ClientSecret` → `Authorization: Basic …`; `POST https://secure-wms.com/AuthServer/api/Token` with JSON `{"grant_type":"client_credentials","user_login":"[Provided by warehouse]"}`; token valid "typically between 30 and 60 minutes"; refresh "no less than every 30 minutes".
The Hub-level API (`api-hub.extensiv.com`, https://help.extensiv.com/en_US/navigation/logging-in-to-the-extensiv-api) is a different API and is out of scope.

## 2. API user / roles
- No "API Access" checkbox on user records. Permissions come solely from roles selected on the credential.
- User management is in Extensiv Hub (https://help.extensiv.com/en_US/user-setup/1623698-managing-users); roles at https://help.extensiv.com/en_US/user-setup/managing-user-roles.
- Admin permissions that matter: Administration Module > Manage 3PL Info; Customer Module > Data Connections (webhooks); Warehouse Module > Manage Warehouse; Customer Module > Manage Customers; Customer Module > Customer Items > Manage Items.
- INFERRED: a credential's Customer ID scopes the key to one customer; multi-customer developers need one credential per customer.

## 3. Finding IDs
- Customer ID: Customers → Manage Customers → add "Customer ID" column. (https://help.extensiv.com/en_US/customer-setup/managing-customers)
- Facility: Warehouse → Manage Warehouse (https://help.extensiv.com/en_US/warehouse-setup/managing-warehouses). Warehouses added/deactivated only via CSM.
- Items: Items → Manage Items → select customer → Create (https://help.extensiv.com/en_US/item-creation/creating-items).
- Account toggles: https://help.extensiv.com/en_US/warehouse-setup/configuring-3pl-settings ("Close Orders Upon Tracking Update", "Overallocated SOAP Order Check").

## 4. Webhooks
Config (https://help.extensiv.com/en_US/rest-api/configuring-webhooks): **Customers → Event Notifications**; permission Customer Module > Data Connections. Select Webhook Scope (a customer or "Any Customer") → New Webhook → Description → Destination URL (must be `https://`) → Event Type → events/resources ("Include resource in payload") → Save.

Event types: **Order** (OrderCreate, OrderComplete, OrderUpdate, OrderConfirm = moved to Closed, OrderUnconfirm, OrderCancel, OrderFullyAllocated, OrderExcludedFromPickJob, OrderPickJobDone, Pack started, Pack Complete); **Receipt** (Create, Complete, Update, Confirm = Closed, Unconfirm, Cancel); **Adjustment** (Create, Confirm, Cancel, Update); **Assembly** (Create, Cancel, Update, Confirm); **Order Item** (Pack, Unpack, Pick, Unpick); **Item** (Create, Update); **Inventory Summary** (Update); **Inventory Hold** (Place on Hold, Release from Hold). Delete events are internal only.

Implementation (https://help.extensiv.com/en_US/rest-api/implementing-webhooks):
- Respond within **3 seconds** or delivery counts as failed. Recommended: validate signature → return 20x → process async.
- Retries at regular intervals for roughly **six hours**, then dead-letter queue for 3 more days (email api@extensiv.com to retrieve).
- Payload: HTTP POST, `Content-Type: application/json`, body fields `tplId, wmsEventId, dateTime (deprecated), eventDateTimeUtc, warehouseTransactionEventId, createDateTimeUtc, eventType, resource{rel,href,body}, links, data, tags` (e.g. `"tags": "Shipped"`). Delivery is not guaranteed chronological; order by `eventDateTimeUtc`.
- Signature: header `Signature` = base64(RSA-SHA256 over the raw body). Public key: `GET https://secure-wms.com/events/webhook/key` → `{ publicKey (PEM/spki), retrievalDateISO }`; optional `previousRetrievalDateISO` → 304 if unchanged. Re-fetch the key on validation failure (rotation).
- FAQs (https://help.extensiv.com/en_US/rest-api/webhooks-faqs): HTTPS only; paid add-on priced by data usage.

## 5. Sandbox, Developer Enablement, contacts
- Sandbox (https://help.extensiv.com/en_US/sandbox-getting-started/extensiv-sandbox-overview, https://help.extensiv.com/en_US/technical-support/understanding-sandbox): Extensiv Sandbox `https://app-sandbox.extensiv.com/`; legacy 3PLWM sandbox `https://box.secure-wms.com/` ("will soon be deprecated"). Sandbox is a purchased premium feature; flavours Clean Environment / Golden Demo Data / Copy of Production. Support Portal is unavailable in Sandbox.
  INFERRED: whether REST credentials can be self-provisioned for a sandbox tenant is not stated; ask the CSM.
- Request: https://www.extensiv.com/sandbox-and-early-access or customersuccess@extensiv.com.
- Developer Enablement (https://help.extensiv.com/en_US/professional-services/developer-enablement): paid subscription; 4 hrs/month API specialist; access to all APIs incl. beta; sandbox; usage analyses. "Direct developer support is only available as part of a Developer Enablement package."
- Partner program: https://www.extensiv.com/ecosystem/become-a-partner.
- Contacts (https://help.extensiv.com/en_US/navigation/tech-support-team): API questions api@extensiv.com; 3PLWM support support-3plwms@extensiv.com; CSM customersuccess@extensiv.com; phone 888-375-2368.

## 6. Lifecycle terminology
Orders (https://help.extensiv.com/en_US/order-management/understanding-order-statuses): **Open** → **Complete** (API/EDI/import orders auto-Complete; irreversible) → **Closed** (Ship and Close; requires full allocation) ; **Canceled** (Find Orders → Manage → Cancel; generally not once Complete/in a pick batch). Reopen via Manage → Reopen.
Hold (https://help.extensiv.com/en_US/order-management/putting-orders-on-hold-in-3pl-warehouse-manager): Manage → Hold Order / Release Hold; while held, packing, shipping, Ship and Close, Mark Complete and REST API actions are blocked; cannot hold once tracking number / ship date present.
Receipts (https://help.extensiv.com/en_US/receipt-management/understanding-receipt-statuses): **Open** → **Complete** → **Closed** via Confirm Receipt (makes inventory on-hand); **Canceled** irreversible; Reopen blocked once inventory allocated.

## 7. Rate limits
No numeric rate limit published in the help center. API metered by data usage (Support Portal → Account → API Usage). INFERRED: throttling/429 details, if any, live in the developer reference.

## 8. Terms
Terms of Use https://www.extensiv.com/terms-of-service covers the marketing site only. No public developer ToS found. INFERRED: API use is governed by the customer's subscription agreement (API package add-on).
