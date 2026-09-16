# @mcp-3pl/mock-extensiv

A local mock of the **Extensiv 3PL Warehouse Manager REST API** — HAL envelopes, RQL, paging,
ETag/If-Match, the documented exception bodies, signed webhooks, and a fault-injection control plane.

It exists so the MCP server can be built and attacked before sandbox credentials arrive. Every
behaviour is traced to a documentation URL in **[MOCK_FIDELITY.md](./MOCK_FIDELITY.md)**, which also
marks what is a guess and what to re-verify. Read it before trusting anything here.

## Run it

```bash
pnpm install
pnpm --filter @mcp-3pl/mock-extensiv build
pnpm --filter @mcp-3pl/mock-extensiv start          # node dist/cli.js
# or, without building:
pnpm --filter @mcp-3pl/mock-extensiv dev            # tsx src/cli.ts
```

```
Mock Extensiv API listening on http://127.0.0.1:4010
```

Environment variables:

| Variable | Default | Meaning |
|---|---|---|
| `MOCK_EXTENSIV_PORT` | `4010` | Listen port. `0` asks the OS for an ephemeral one; the real port is printed. |
| `MOCK_EXTENSIV_HOST` | `127.0.0.1` | Bind address. |
| `MOCK_EXTENSIV_SEED` | `default` | `default` for the seeded world, `empty` for nothing but auth. |
| `MOCK_EXTENSIV_LOG` | unset | `1` logs `METHOD path -> status` to stdout. |

`SIGINT` / `SIGTERM` shut the listener down cleanly.

## Use it from a test

```ts
import { createMockApp, startMockServer, DEFAULT_MOCK_CREDENTIALS } from '@mcp-3pl/mock-extensiv';

// In-process, no sockets — fastest, and enough for everything except dropped connections
// and outbound webhook delivery.
const { app, state } = createMockApp({ seed: 'default' });
const res = await app.request('/orders?pgsiz=5', { headers: { Authorization: `Bearer ${token}` } });

// A real listener when you need real TCP.
const server = await startMockServer({ port: 0 });
console.log(server.url); // http://127.0.0.1:53124
await server.close();
```

`createMockApp(opts)` and `startMockServer(opts)` both take:

```ts
{
  port?: number;            // startMockServer only; 0 = ephemeral
  host?: string;            // startMockServer only; default 127.0.0.1
  credentials?: { clientId: string; clientSecret: string; userLogin: string; tplGuid?: string };
  tokenTtlSeconds?: number; // default 3600
  seed?: 'default' | 'empty';
  log?: boolean;
  now?: () => Date;         // control the clock, e.g. to expire a token
}
```

`state` is the `MockState` instance: all seeded data and all the business rules. Mutate it directly in
a test, or drive it through `/__mock/*`.

## Authenticate

```bash
BASIC=$(printf 'mock-client-id:mock-client-secret' | base64)

curl -s http://127.0.0.1:4010/AuthServer/api/Token \
  -H "Authorization: Basic $BASIC" \
  -H 'Content-Type: application/json' \
  -d '{"grant_type":"client_credentials","user_login":"mock-integration-user"}'
```

```json
{"access_token":"…","token_type":"Bearer","expires_in":3600,"refresh_token":null,"scope":null}
```

Then send `Authorization: Bearer <access_token>` and `Accept: application/hal+json` on everything
else. Default credentials (`DEFAULT_MOCK_CREDENTIALS`):

| Field | Value |
|---|---|
| `clientId` | `mock-client-id` |
| `clientSecret` | `mock-client-secret` |
| `userLogin` | `mock-integration-user` |
| `tplGuid` | `00000000-0000-4000-8000-000000000001` |

## What it serves

Reads: `/billboard` · `/customers` · `/customers/{id}` · `/customers/{id}/items` ·
`/customers/{id}/items/{iid}` · `/properties/facilities` · `/properties/facilities/{id}/locations` ·
`/properties/carriers` · `/orders` · `/orders/{id}` · `/orders/{id}/items` · `/orders/{id}/packages` ·
`/orders/summaries` · `/orders/shipmentstrackinginfo` · `/inventory` · `/inventory/stocksummaries` ·
`/inventory/stockdetails` · `/inventory/receivers` · `/inventory/receivers/{id}` ·
`/events/webhook/key`

Writes: `POST /orders` · `PUT /orders/{id}` · `POST /orders/{id}/canceler` ·
`POST /orders/{id}/confirmer` · `POST /orders/{id}/completer` · `PUT /orders/orderholder` ·
`POST /inventory/receivers` · `PUT /inventory/receivers/{id}` ·
`POST /inventory/receivers/{id}/confirmer` · `POST /inventory/receivers/{id}/canceler` ·
`PUT /inventory/holder`

Every write demands `If-Match` (`428` without it, `412` on a stale tag), and the whole graph stays
consistent: creating an order allocates stock, cancelling releases it, confirming consumes it, and
confirming a receipt lands it and re-allocates short orders.

## Seeded world

`seed: 'default'` builds a fixed world by replaying `MockState` operations, so stock is consistent by
construction. Headlines: customers `1` Acme Outdoor Co, `2` Bluebird Cosmetics, `3` Northwind Traders
(deactivated), `9` Out Of Scope Co; facilities `1` LAX-1 and `2` DFW-2; 31 items; 9 receipts
(`7001`–`7009`); 42 orders (`41001`–`41042`) covering shipped, cancelled, on-hold, complete, open,
and two deliberately short ones (`41029`, `41030`) so `403 NotFullyAllocated` is reachable. The full
inventory is in [MOCK_FIDELITY.md §10](./MOCK_FIDELITY.md#10-the-seeded-world-seed-default).

## Control plane — `/__mock/*`

**None of these paths exist on the real API.** They are unauthenticated on purpose and are excluded
from the bearer and fault middleware.

| Method | Path | Body / query | Purpose |
|---|---|---|---|
| `POST` | `/__mock/reset` | `{"seed":"default"\|"empty"}` | Re-seed. Clears tokens, so re-authenticate afterwards. |
| `GET` | `/__mock/requests` | `?limit=N` | Request log; `Authorization` is redacted to `Bearer <redacted>`. |
| `DELETE` | `/__mock/requests` | — | Clear the log. |
| `POST` | `/__mock/faults` | `{expireAllTokens?, once?, latencyMs?, clear?}` | Inject faults (see below). |
| `GET` | `/__mock/state` | — | Full state dump: counters, orders, receivers, lots, subscriptions. |
| `POST` | `/__mock/webhooks` | `{url, resource, eventTypes}` | Add a webhook subscription. |
| `POST` | `/__mock/webhooks/emit` | `{eventType, resourceRel, resourceId}` | Force an emission. |
| `GET` | `/__mock/webhooks/deliveries` | `?flush=false` | Delivery log with attempts and signatures. |
| `POST` | `/__mock/stock` | `{customerId, facilityId, sku, onHandDelta}` | Move stock without a receipt. |

### Faults

```bash
# One 429 with Retry-After on the next GET /orders
curl -s http://127.0.0.1:4010/__mock/faults -H 'Content-Type: application/json' -d '{
  "once": [{ "match": "GET /orders", "status": 429, "retryAfterSeconds": 5, "body": {"error":"slow down"} }]
}'

# Kill every live token
curl -s http://127.0.0.1:4010/__mock/faults -H 'Content-Type: application/json' -d '{"expireAllTokens": true}'

# Apply the write, then abandon the connection: the client learns nothing, the order exists
curl -s http://127.0.0.1:4010/__mock/faults -H 'Content-Type: application/json' -d '{
  "once": [{ "match": "POST /orders", "status": 0, "dropConnection": true }]
}'

# Slow everything down
curl -s http://127.0.0.1:4010/__mock/faults -H 'Content-Type: application/json' -d '{"latencyMs": 750}'
curl -s http://127.0.0.1:4010/__mock/faults -H 'Content-Type: application/json' -d '{"clear": true}'
```

`match` is `METHOD /path-prefix`; the method may be `*`. Each `once` entry fires at most once.

`dropConnection` destroys the socket **after** the handler has run, so the effect is applied and the
outcome is unknown to the caller — the exact situation a retrying client has to survive. Under
`app.request()` there is no socket, so the mock returns the sentinel status `599` with
`X-Mock-Connection-Dropped: 1` instead. 599 is a mock artefact, not an Extensiv status.

## Webhooks

Deliveries are `POST`ed as `application/json` with a `Signature` header holding
base64(RSA-SHA256(raw body)). Verify against `GET /events/webhook/key`:

```ts
const { publicKey } = await (await fetch(`${url}/events/webhook/key`, { headers: auth })).json();
const verifier = createVerify('RSA-SHA256');
verifier.update(rawBody);            // the exact bytes, before JSON.parse
verifier.verify(publicKey, Buffer.from(req.headers.signature, 'base64'));
```

The seeded Acme customer already has an Order subscription pointing at
`http://127.0.0.1:4020/webhooks/extensiv`, so its deliveries fail unless something is listening
there. That is intentional: the delivery log then shows a realistic retry-and-fail record.

The mock retries three times, 50 ms apart, rather than the real ~6 hours. See
[MOCK_FIDELITY.md §9](./MOCK_FIDELITY.md#9-webhooks).

## Tests

```bash
npx vitest run packages/mock-extensiv
```

`src/__tests__/server.test.ts` is the only file that binds sockets (dropped connections, real webhook
delivery to a receiver it starts itself). Everything else runs in-process through `app.request()`.

## Fidelity

Read **[MOCK_FIDELITY.md](./MOCK_FIDELITY.md)**. It tables every implemented behaviour against its
source URL, marks it Documented / Inferred / Guess, and says what to re-verify against a sandbox. The
"Known divergences" section at the end lists the places where the mock deliberately differs —
shortened webhook retries, no rate limiting (none is documented), no role-based `403`, and more.
