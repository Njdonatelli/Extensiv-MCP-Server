# Developer program inquiry (draft)

> **DRAFT — do not send.** Placeholders are in [brackets]. Review the six questions against the current open items in `docs/research/api_reference_notes.md` section 10 before sending; remove any that have since been answered. Facts referenced below come from the research notes (help.extensiv.com and 3w.extensiv.com/Rels); nothing here has been confirmed by Extensiv yet.

**To:** api@extensiv.com
**Cc:** customersuccess@extensiv.com
**From:** [name] <[shared-integration-mailbox@company.example]>
**Subject:** External REST/Developer credentials for a sandbox tenant and API questions — [Company], TPL [number]

---

Hello,

I am [name], [role] at [Company], a third-party logistics provider running 3PL Warehouse Manager (TPL number [number]; our CSM is [CSM name]).

We are building an internal MCP server: read-mostly assistant tooling over the 3PLWM REST API (orders, inventory, items, receipts, webhook events) with a small set of gated, audited writes limited to creating orders, updating open orders, cancelling open orders and creating receipts. Every write is prepared and previewed first, committed in a separate step, idempotent on reference number, and written to an audit log. Order confirmation and shipping are intentionally not exposed.

So far we have built and tested only against a local mock derived from the public rel documentation at 3w.extensiv.com/Rels and the help-center articles on credential management and webhooks. We have not yet used a production credential. Before we do, we would appreciate answers to the following:

1. Can External REST/Developer credentials be issued for a sandbox tenant (app-sandbox.extensiv.com or box.secure-wms.com), given that the Support Portal is not available in Sandbox? If so, what are the sandbox API base URL and AuthServer host?
2. Is the Developer Enablement package required for sandbox API access, and what are its pricing and lead time?
3. Are there documented rate limits or 429 behaviour for the REST API, and how is data usage metered and reported for the API package?
4. Can you confirm that POST /orders/{id}/canceler, PUT /orders/{id} with If-Match, and POST /inventory/receivers are covered by the OrderEdit, OrderWrite and ReceiverEdit roles on an External REST/Developer credential, with no additional roles needed?
5. What are the exact eventType strings delivered for non-order webhook resources (Receipt, Adjustment, Item, Inventory Summary, Inventory Hold), and is there a test emitter or replay facility for webhook deliveries?
6. For a single-tenant static credential, is user_login sufficient in the token request, or is the tpl GUID also required?

We can share our endpoint list and the role set we intend to request if that helps. Thank you for your time.

[name]
[title], [Company]
[phone] | [shared-integration-mailbox@company.example]

---

Word count of the body (greeting to signature): about 330.
