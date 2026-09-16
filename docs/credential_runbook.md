# Credential runbook for a 3PL admin

Audience: the 3PL Warehouse Manager (3PLWM) administrator who provisions access, and the person who runs the Extensiv MCP server. Every factual statement about Extensiv below carries the help-center or rel-doc URL it came from (collected in `docs/research/help_center_notes.md` and `docs/research/api_reference_notes.md`). Anything marked `ASSUMPTION:` was not stated in those sources and must be confirmed with Extensiv before you rely on it.

---

## 1. Purpose and who does what

The MCP server reads orders, inventory, items and receipts from 3PLWM through the REST API, receives webhook events, and (only when explicitly enabled) prepares and commits a small set of writes: create order, update open order, cancel order, create receipt. It needs one REST credential, one dedicated customer user, a list of Customer IDs and Facility IDs, and optionally a webhook subscription.

| Role | Person | Does |
|---|---|---|
| 3PL admin | `____________________` | Steps A through F below. Owns the Extensiv account, Support Portal super-user login, Extensiv Hub user administration. Produces the artifacts in the hand-off table (Step G). |
| Integration owner (runs the MCP server) | `____________________` | Receives the artifacts, sets the environment variables, runs `verify_connection` and `describe_scope` (Step I), operates the webhook ingest process, reviews the audit log. |
| CSM / Extensiv support | see contacts (Step J) | Enables the API package, sandbox, Developer Enablement, adds or deactivates warehouses. |

Rule of thumb: the 3PL admin never needs a terminal. The integration owner never needs the Support Portal login.

---

## 2. Prerequisites

1. Your 3PLWM subscription must include an **API package**, and the person creating the credential must be the Support Portal **super user**. If either is missing, contact your CSM. Source: https://help.extensiv.com/en_US/customer-central/support-portal-faqs
2. You can administer users in **Extensiv Hub** (user management lives there, not in the 3PLWM UI). Source: https://help.extensiv.com/en_US/user-setup/1623698-managing-users and https://help.extensiv.com/en_US/user-setup/managing-user-roles
3. Your 3PLWM user has these permissions (needed for Steps C and E). Source: https://help.extensiv.com/en_US/rest-api/getting-started-with-credential-management and https://help.extensiv.com/en_US/rest-api/configuring-webhooks
   - Administration Module > Manage 3PL Info
   - Customer Module > Manage Customers
   - Customer Module > Data Connections (webhooks)
   - Warehouse Module > Manage Warehouse
   - Customer Module > Customer Items > Manage Items
4. Webhooks are a **paid add-on priced by data usage**. Confirm it is on your subscription before Step E. Source: https://help.extensiv.com/en_US/rest-api/webhooks-faqs
5. If you want to test outside production, Sandbox is a **purchased premium feature** (Step F). Source: https://help.extensiv.com/en_US/technical-support/understanding-sandbox

Category index for all REST API help articles: https://help.extensiv.com/en_US/rest-api

---

## 3. Step-by-step

### Step A. Create the dedicated customer user and find its 3PL Warehouse Manager ID

Extensiv requires one **customer user per credential**, named after the integration and assigned to the customers the integration serves. Its UI permission level does not affect API permissions; API permissions come only from the roles on the credential (Step B). Source: https://help.extensiv.com/en_US/rest-api/getting-started-with-credential-management

1. Go to https://app.extensiv.com/ and sign in.
2. Open **Extensiv Hub** > **Users**. (Click paths inside Hub user management: https://help.extensiv.com/en_US/user-setup/1623698-managing-users)
3. Create a new user. Suggested values:
   - Name / login: `mcp-integration` (ASSUMPTION: naming convention; Extensiv only says "named after the integration").
   - Type: customer user.
   - Customers: every customer the MCP server should be able to read. (ASSUMPTION: the customer assignment on the user, together with the credential's Customer ID, is what limits what the API returns; the notes flag this as inferred.)
   - Email: a shared mailbox you control, not a person's mailbox, so the user survives staff changes (ASSUMPTION: operational advice).
4. Save the user.
5. Back in **Extensiv Hub** > **Users**, search for the user you just created and open it. Copy the value labelled **3PL Warehouse Manager ID**. This is the `user_login` value the server sends when it requests a token. Source: https://help.extensiv.com/en_US/rest-api/getting-started-with-credential-management

Record it here: `user_login (3PL Warehouse Manager ID): ____________________`

### Step B. Create the External REST/Developer credential

Source for every click in this step: https://help.extensiv.com/en_US/rest-api/getting-started-with-credential-management

1. Sign in at https://app.extensiv.com/ and open the **3PL Warehouse Manager** tile.
2. Click **Support** (upper-right). The Support Portal opens.
3. Click **Manage Credentials (Beta)**.
4. Click **Create New Credential**, choose **External REST/Developer**, click **Continue**.
5. Fill the fields:
   - **Customer ID**: must match the Customer ID shown in the Manage Customers grid (Step C). ASSUMPTION (flagged inferred in the research notes): this scopes the credential to one customer, so a server that must see several customers may need one credential per customer and therefore one MCP server instance per credential. Confirm with api@extensiv.com before provisioning for more than one customer.
   - **Platform**: `MCP server` or your internal system name.
   - **Developer Contact Info**: the integration owner's shared mailbox.
   - **Notes**: `Extensiv MCP server, read-only` or `... read+write`, and today's date.
   - **Enabled**: checked.
6. Select the roles. Pick exactly one of the two sets below.

**Minimum read-only role set** (use this first; it is enough for the 11 read tools):

```
CustomerView, FacilityView, InventoryDetailView, InventoryRead, ItemView, OrderView, ReceiverView, ReadPropertiesThirdParty
```

**Write role set** (only after the production write sign-off in `docs/production_write_signoff.md` is signed):

```
CustomerView, FacilityView, InventoryDetailView, InventoryRead, ItemView, OrderView, ReceiverView, ReadPropertiesThirdParty,
OrderEdit, OrderWrite, ReceiverEdit
```

Do **not** grant `OrderConfirm` (closing/shipping orders), `InventoryEdit`, `ItemEdit`, `CustomerEdit`, `OrderImport`, `C2CTransfer` or `WritePropertiesThirdParty`. The server never calls those operations, and leaving them off means a compromised credential cannot ship, adjust stock or edit items. Role descriptions (OrderConfirm = closing of orders; OrderEdit = modification of Open and Complete orders; OrderWrite = canceling and splitting of orders) are from https://help.extensiv.com/en_US/rest-api/getting-started-with-credential-management. Extensiv's own recommended developer set includes OrderEdit/OrderWrite by default; this runbook deliberately starts narrower.

7. Click **Save**. The **Client ID** and **Client Secret** appear in the credentials grid. Copy both immediately into your password manager (see Step G). Source: same article.

**Which role unlocks which tool.** The help center names the role, not the endpoint. The endpoint-to-role links below are therefore `ASSUMPTION` unless noted. 401 means the token is bad; 403 means the roles do not cover the call (https://3w.extensiv.com/Rels/auth).

| Role | Tools that need it | Endpoints (from `docs/research/api_reference_notes.md`) | Basis |
|---|---|---|---|
| CustomerView | describe_scope, verify_connection, and customer resolution inside every other tool | `GET /customers`, `GET /customers/{id}` | ASSUMPTION |
| FacilityView | describe_scope, check_inventory, operations_summary | `GET /properties/facilities` | ASSUMPTION (FacilityView vs ReadPropertiesThirdParty split not documented) |
| ReadPropertiesThirdParty | describe_scope, create_order (carrier validation) | `GET /properties/facilities`, `/properties/carriers`, `/properties/facilities/{id}/locations` | ASSUMPTION |
| OrderView | find_orders, get_order_status, find_stuck_orders, operations_summary | `GET /orders`, `GET /orders/{id}`, `/orders/summaries`, `/orders/{id}/packages`, `/orders/shipmentstrackinginfo` | ASSUMPTION |
| InventoryRead | check_inventory | `GET /inventory/stocksummaries`, `GET /inventory` | ASSUMPTION (which of InventoryRead / InventoryDetailView covers which endpoint is not documented; grant both) |
| InventoryDetailView | check_inventory (lots, expiry, on-hold detail) | `GET /inventory/stockdetails` | ASSUMPTION |
| ItemView | lookup_item, create_order and create_receipt (SKU validation), check_inventory (reorder points) | `GET /customers/{id}/items` | ASSUMPTION |
| ReceiverView | find_receipts, get_receipt_status, operations_summary | `GET /inventory/receivers`, `GET /inventory/receivers/{id}` | ASSUMPTION |
| OrderEdit | update_order (and commit_change for it) | `PUT /orders/{id}` with If-Match | Help center: "modification of Open and Complete orders". Endpoint link is ASSUMPTION. |
| OrderWrite | cancel_order (and commit_change for it); create_order | `POST /orders/{id}/canceler`; `POST /orders` | Help center: "canceling and splitting of orders". ASSUMPTION that `POST /orders` (create) is under OrderWrite rather than OrderEdit; grant both for writes. |
| ReceiverEdit | create_receipt (and commit_change for it) | `POST /inventory/receivers` | ASSUMPTION |
| (none extra) | recent_events, commit_change | recent_events reads the local events file only; commit_change reuses the role of the change it commits | By design of this server |

### Step C. Collect Customer IDs and Facility IDs

**Customer IDs.** Source: https://help.extensiv.com/en_US/customer-setup/managing-customers and https://help.extensiv.com/en_US/rest-api/getting-started-with-credential-management

1. In 3PL Warehouse Manager click **Customers** > **Manage Customers**.
2. In the grid, click the **ellipsis (…) on any column header** > **Columns** > tick **Customer ID**.
3. Write down the numeric Customer ID next to each customer name the server should read, and separately the ones it may write to.

| Customer name | Customer ID | Read | Write |
|---|---|---|---|
| `____________________` | `______` | [ ] | [ ] |
| `____________________` | `______` | [ ] | [ ] |

**Facility (warehouse) IDs.** Source: https://help.extensiv.com/en_US/warehouse-setup/managing-warehouses

1. Click **Warehouse** > **Manage Warehouse**.
2. Read the warehouse ID from the grid. ASSUMPTION (flagged inferred in the research notes): the ID is exposed as a grid column the same way as Customer ID. If no ID column is available, the integration owner can list them after Step I with `describe_scope`, which calls `GET /properties/facilities` and returns `facilityId` and `name` (https://3w.extensiv.com/rels/properties/facilities).
3. Warehouses are added or deactivated only through your CSM (same article).

| Facility name | Facility ID | Read | Write |
|---|---|---|---|
| `____________________` | `______` | [ ] | [ ] |

### Step D. TPL number and GUID

1. Open the Support Portal (3PL Warehouse Manager tile > **Support**).
2. Click **Account** > **Account Information**. Copy the **TPL Number** and **TPL GUID**. Source: https://help.extensiv.com/en_US/navigation/tech-support-team

The GUID is only sent in the token request for "Single-Tenant dynamic" credentials (https://3w.extensiv.com/Rels/auth). External REST/Developer credentials are "Single-Tenant static", which send `user_login` instead. Collect the GUID anyway: the server accepts it as optional `EXTENSIV_TPL_GUID`, and support will ask for the TPL number on any ticket.

### Step E. Webhooks (optional, needed for `recent_events`)

Source: https://help.extensiv.com/en_US/rest-api/configuring-webhooks, https://help.extensiv.com/en_US/rest-api/implementing-webhooks, https://help.extensiv.com/en_US/rest-api/webhooks-faqs

Before you start, get from the integration owner the public **https** destination URL of the webhook ingest process. The path is `/webhooks/extensiv`, so the URL looks like `https://<host>/webhooks/extensiv`. Extensiv rejects non-https URLs.

1. Click **Customers** > **Event Notifications**. (Requires permission Customer Module > Data Connections.)
2. Choose the **Webhook Scope**: a single customer, or **Any Customer**. Pick the same customers you listed for Read in Step C. If the server reads all customers, choose Any Customer.
3. Click **New Webhook**.
4. **Description**: `Extensiv MCP server events`.
5. **Destination URL**: the https URL from the integration owner.
6. **Event Type**: create one webhook per resource below and tick exactly these events:

| Resource (Event Type) | Events to tick | Why the server wants it |
|---|---|---|
| Order | OrderCreate, OrderUpdate, OrderConfirm, OrderCancel, OrderFullyAllocated, Pack Complete | order lifecycle, "shipped" (OrderConfirm = moved to Closed), allocation, packing |
| Receipt | Create, Confirm, Cancel | inbound lifecycle (Confirm = Closed, inventory becomes on-hand) |
| Inventory Hold | Place on Hold, Release from Hold | hold exceptions |

   Leave all other events (OrderComplete, OrderUnconfirm, pick-job events, Adjustment, Assembly, Order Item, Item, Inventory Summary) unticked unless the integration owner asks. Event names are from the help center list at https://help.extensiv.com/en_US/rest-api/configuring-webhooks. ASSUMPTION: the `eventType` string delivered on the wire for Receipt and Inventory Hold events follows the `<Resource><Verb>` pattern (only `OrderConfirm` is shown verbatim in the docs); the integration owner will confirm from the first real deliveries.

7. **Include resource in payload**: leave **off**. Webhooks are billed by data usage; the server fetches the record itself through the API when it needs it. Turn it on only if the integration owner asks.
8. Click **Save**.
9. Repeat 3 to 8 for each of the three resources.

Firewall: if the destination host sits behind an IP allow-list, allow Extensiv's webhook source addresses **3.131.3.90, 3.131.5.63, 3.17.2.36**. Source: https://help.extensiv.com/en_US/3plwhm-integrations-general-information/whitelisting-ip-addresses

What the integration owner's side does (for your awareness; you do not configure it): the `extensiv-webhook-ingest` process listens on `EXTENSIV_WEBHOOK_PORT` (default 4020), path `/webhooks/extensiv`, verifies the `Signature` header against the public key from `${EXTENSIV_BASE_URL}/events/webhook/key` (base64 RSA-SHA256 over the raw body; https://help.extensiv.com/en_US/rest-api/implementing-webhooks), answers within the required 3 seconds, and appends the event to `EXTENSIV_MCP_EVENTS_FILE`. Because Extensiv requires https, the process must sit behind a TLS reverse proxy or a tunnel. ASSUMPTION: any specific tunnel or proxy product (for example ngrok, Cloudflare Tunnel, Caddy, nginx) is the integration owner's choice; none is endorsed or required by Extensiv. Failed deliveries are retried for roughly six hours and then held in a dead-letter queue for three more days; email api@extensiv.com to retrieve them (same article).

### Step F. Sandbox

What exists. Source: https://help.extensiv.com/en_US/sandbox-getting-started/extensiv-sandbox-overview and https://help.extensiv.com/en_US/technical-support/understanding-sandbox

- **Extensiv Sandbox**: https://app-sandbox.extensiv.com/
- **Legacy 3PLWM sandbox**: https://box.secure-wms.com/ ("will soon be deprecated").
- Sandbox is a **purchased premium feature**. Flavours: Clean Environment, Golden Demo Data, Copy of Production.
- **The Support Portal is unavailable in Sandbox.** Since REST credentials are created in the Support Portal (Step B), it is an **open question whether an External REST/Developer credential can be provisioned for a sandbox tenant at all**, and what the sandbox API base URL / AuthServer host would be. ASSUMPTION (flagged inferred in the research notes): the sandbox API base would be `https://box.secure-wms.com` with the same `/AuthServer/api/Token` path. Do not set `EXTENSIV_BASE_URL` to that value until Extensiv confirms; use the draft in `docs/developer_program_inquiry_email.md` to ask.

How to request:
1. Fill in the form at https://www.extensiv.com/sandbox-and-early-access, or email customersuccess@extensiv.com. Source: https://help.extensiv.com/en_US/technical-support/understanding-sandbox
2. Ask in the same message whether the **Developer Enablement** package is required. It is a paid subscription that includes 4 hours per month of an API specialist, access to all APIs including beta, sandbox, and usage analyses; "Direct developer support is only available as part of a Developer Enablement package." Source: https://help.extensiv.com/en_US/professional-services/developer-enablement

Until a sandbox with API access exists, the integration owner tests against the local mock (`EXTENSIV_BASE_URL=http://127.0.0.1:4010`) and then runs read-only against production.

### Step G. Secure hand-off to the integration owner

Rules:
- Never send the Client Secret in plain-text email, chat, a ticket, or a screenshot. Use your password manager's share feature or a one-time secret link. ASSUMPTION: which tool; Extensiv does not prescribe one.
- Send the Client ID and the Client Secret through **different channels** if you have no shared vault.
- Everything else (IDs, base URL, user_login) is not secret but should still go in one written message so it is not retyped by hand.
- Ask the integration owner to confirm receipt and then delete the message containing the secret.

Checklist of what to send:

- [ ] Client ID
- [ ] Client Secret (secure channel only)
- [ ] `user_login` (the customer user's 3PL Warehouse Manager ID, Step A)
- [ ] Customer IDs, split into read list and write list (Step C)
- [ ] Facility IDs, split into read list and write list (Step C)
- [ ] TPL number and GUID (Step D)
- [ ] Base URL (production is `https://secure-wms.com`; https://help.extensiv.com/en_US/rest-api/providing-rest-api-access)
- [ ] Whether webhooks were configured and for which customers (Step E)
- [ ] An environment label the integration owner should display, e.g. `prod` or `sandbox`

Artifact to environment variable mapping (the integration owner fills the right column; the 3PL admin fills the values):

| Artifact from this runbook | Environment variable | Notes |
|---|---|---|
| Base URL | `EXTENSIV_BASE_URL` | Default `https://secure-wms.com`. `http://127.0.0.1:4010` for the local mock. Token URL is derived as `${EXTENSIV_BASE_URL}/AuthServer/api/Token` unless `EXTENSIV_AUTH_URL` is set. |
| Client ID | `EXTENSIV_CLIENT_ID` | From the Manage Credentials grid |
| Client Secret | `EXTENSIV_CLIENT_SECRET` | Secret. Never in a repo or a ticket. |
| 3PL Warehouse Manager ID of the customer user | `EXTENSIV_USER_LOGIN` | Sent as `user_login` in the token request |
| TPL GUID | `EXTENSIV_TPL_GUID` | Optional; only for Single-Tenant dynamic credentials |
| Customer IDs (read list) | `EXTENSIV_MCP_ALLOWED_CUSTOMER_IDS` | Comma-separated. Empty = everything the credential can see. |
| Facility IDs (read list) | `EXTENSIV_MCP_ALLOWED_FACILITY_IDS` | Comma-separated. Empty = everything the credential can see. |
| Customer IDs (write list) | `EXTENSIV_MCP_WRITE_CUSTOMER_IDS` | Required when writes are enabled. Explicit allow-list; no wildcard. |
| Facility IDs (write list) | `EXTENSIV_MCP_WRITE_FACILITY_IDS` | Optional |
| Writes enabled? | `EXTENSIV_MCP_WRITES_ENABLED` | Default `false`. Write tools are not registered unless `true`. Requires the signed `docs/production_write_signoff.md`. |
| Environment label | `EXTENSIV_MCP_ENVIRONMENT_LABEL` | Shown by `verify_connection` |
| Webhook destination host | (reverse proxy / tunnel config) | Points at `extensiv-webhook-ingest` on `EXTENSIV_WEBHOOK_PORT` (default 4020) |
| Events file | `EXTENSIV_MCP_EVENTS_FILE` | Written by the ingest process, read by `recent_events` |
| State directory | `EXTENSIV_MCP_STATE_DIR` | Change records, `audit.jsonl`, events |
| Change TTL | `EXTENSIV_MCP_CHANGE_TTL_SECONDS` | Default 900 (15 minutes) |
| Line / unit caps | `EXTENSIV_MCP_MAX_LINES_PER_MUTATION`, `EXTENSIV_MCP_MAX_UNITS_PER_MUTATION` | Defaults 200 and 10000 |

### Step H. Rotation and deprovisioning

Deprovisioning is by email to **API@extensiv.com**. Source: https://help.extensiv.com/en_US/rest-api/getting-started-with-credential-management

Rotation procedure (ASSUMPTION: Extensiv documents no rotation workflow; this sequence uses only documented UI elements):

1. Create a **new** External REST/Developer credential exactly as in Step B (same customer user, same roles). Note the new Client ID / Secret.
2. Hand off to the integration owner (Step G). The integration owner swaps `EXTENSIV_CLIENT_ID` / `EXTENSIV_CLIENT_SECRET`, restarts the server, and runs `verify_connection`.
3. Once confirmed, open Support Portal > **Manage Credentials (Beta)**, find the old credential, and untick **Enabled** (the "Enabled" field is listed on the credential form in the help article). ASSUMPTION: disabling stops new token requests; whether tokens already issued (valid 30 to 60 minutes, https://help.extensiv.com/en_US/rest-api/providing-rest-api-access) are also revoked immediately is not documented. Wait 60 minutes before treating the old secret as dead.
4. Email API@extensiv.com asking for the old credential to be deprovisioned, quoting the TPL number and the old Client ID (never the secret).
5. Record the rotation in the Revocation record of `docs/production_write_signoff.md` if writes were enabled.

Rotate immediately if: the secret was ever pasted into email, chat, a ticket or a repo; the integration owner leaves; the server host is compromised. Rotate on a schedule of `____` months otherwise (ASSUMPTION: your policy; Extensiv does not mandate one).

Deprovisioning the customer user: Extensiv Hub > Users > open the user > deactivate (https://help.extensiv.com/en_US/user-setup/1623698-managing-users). ASSUMPTION: deactivating the user also blocks token requests that use its 3PL Warehouse Manager ID; confirm by having the integration owner run `verify_connection` and expecting a failure.

### Step I. Verification

The integration owner does this after setting the environment variables. The 3PL admin only needs to read the results.

**1. Run `verify_connection` from the MCP client.** In the assistant connected to this server, type: `Run verify_connection`. A good result reports, for each line, the values below. ASSUMPTION: exact wording/format of the tool output is the server's, not Extensiv's.

- Auth: `ok`, token obtained from `https://secure-wms.com/AuthServer/api/Token`, `expires_in` around 3600 seconds (tokens last "typically between 30 and 60 minutes", https://help.extensiv.com/en_US/rest-api/providing-rest-api-access).
- Base URL / environment: `https://secure-wms.com`, label matches what you expected (`prod`, `sandbox`, `mock`).
- Scope: the customer and facility counts match Step C.
- Writes enabled: `false` for a read-only rollout. If it says `true` and you did not sign the write sign-off, stop and tell the integration owner.

Bad results and what they mean:
- `401` from the token endpoint: Client ID/Secret wrong, credential not Enabled, or `user_login` wrong (https://3w.extensiv.com/Rels/auth: 401 = not authenticated).
- `403` on a specific call: a role is missing on the credential (403 = authenticated but role-based authorization denies). Compare against the role set in Step B.
- Zero customers visible: the customer user (Step A) is not assigned to the customer, or the credential's Customer ID (Step B) does not match the grid.

**2. Run `describe_scope`.** Type: `Run describe_scope`. A good result lists every customer name and ID from your Step C read list, every facility name and ID, and the write policy (`writes disabled`, or the explicit write customer/facility IDs and the line/unit caps). Anything listed that you did not intend the server to see means the credential or user is scoped too widely; go back to Step A/B.

**3. Optional raw token check** (integration owner only; proves the credential independently of the server). Set the three environment variables first, then run the command for your shell.

Bash or Zsh (macOS / Linux):

```bash
curl -sS -X POST "https://secure-wms.com/AuthServer/api/Token" \
  -H "Authorization: Basic $(printf '%s:%s' "$EXTENSIV_CLIENT_ID" "$EXTENSIV_CLIENT_SECRET" | base64 | tr -d '\n')" \
  -H "Content-Type: application/json; charset=utf-8" \
  -H "Accept: application/json" \
  -d "{\"grant_type\":\"client_credentials\",\"user_login\":\"$EXTENSIV_USER_LOGIN\"}"
```

Expected output (one line; the token value will differ):

```
{"access_token":"eyJ...","token_type":"Bearer","expires_in":3600,"refresh_token":null,"scope":null}
```

PowerShell (Windows):

```powershell
$pair  = "$env:EXTENSIV_CLIENT_ID`:$env:EXTENSIV_CLIENT_SECRET"
$basic = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes($pair))
$body  = @{ grant_type = "client_credentials"; user_login = $env:EXTENSIV_USER_LOGIN } | ConvertTo-Json -Compress
Invoke-RestMethod -Method Post -Uri "https://secure-wms.com/AuthServer/api/Token" -Headers @{ Authorization = "Basic $basic"; Accept = "application/json" } -ContentType "application/json; charset=utf-8" -Body $body
```

Expected output (values will differ):

```
access_token  : eyJ...
token_type    : Bearer
expires_in    : 3600
refresh_token :
scope         :
```

Request/response shape source: https://3w.extensiv.com/Rels/auth and https://help.extensiv.com/en_US/rest-api/providing-rest-api-access. Never paste the printed token anywhere; it is a bearer credential for up to an hour.

### Step J. Contacts

Source: https://help.extensiv.com/en_US/navigation/tech-support-team unless noted.

| Need | Contact |
|---|---|
| API questions, credential deprovisioning, webhook dead-letter retrieval | api@extensiv.com (the help center writes it as API@extensiv.com in the credential article) |
| 3PL Warehouse Manager product support | support-3plwms@extensiv.com |
| CSM: API package, sandbox, Developer Enablement, add/deactivate warehouses | customersuccess@extensiv.com |
| Phone | 888-375-2368 |
| Sandbox and early-access request form | https://www.extensiv.com/sandbox-and-early-access |
| Developer Enablement package | https://help.extensiv.com/en_US/professional-services/developer-enablement |
| Partner program | https://www.extensiv.com/ecosystem/become-a-partner |
| Your CSM's name | `____________________` |
| Your integration owner | `____________________` |
