# @mcp-3pl/webhook-ingest

The webhook receiver for the Extensiv MCP server. It runs as its **own process**, separate from the MCP server, because Extensiv requires a public HTTPS endpoint that answers within 3 seconds while an MCP server is typically a local stdio child process with no inbound network at all.

Source for the delivery contract: https://help.extensiv.com/en_US/rest-api/implementing-webhooks

## What it does

1. Accepts `POST /webhooks/extensiv` with `Content-Type: application/json`.
2. Verifies the `Signature` header, which is base64(RSA-SHA256) over the **raw** request body, against the public key published at `${EXTENSIV_BASE_URL}/events/webhook/key`. On a verification failure it re-fetches the key once, because Extensiv handles rotation by republishing.
3. Parses the payload into a WMS-agnostic event: event type, occurrence time (from `eventDateTimeUtc`, which the docs say is UTC and is not guaranteed to arrive in order), resource type and id, customer and facility ids extracted from the `links` block, and the reference number when the subscription includes the resource body.
4. Appends it to `events.jsonl`, deduplicating on `tplId:wmsEventId`.
5. Answers `200` immediately. The work between request and response is one signature check and one file append.

The MCP server's `recent_events` tool reads the same file. Point both processes at the same `EXTENSIV_MCP_EVENTS_FILE` (or the same `EXTENSIV_MCP_STATE_DIR`).

## Run it

Bash/Zsh:

```bash
EXTENSIV_BASE_URL=https://secure-wms.com \
EXTENSIV_MCP_STATE_DIR=/var/lib/extensiv-mcp \
node packages/webhook-ingest/dist/cli.js
```
Expected output (JSON on stderr): `"msg":"webhook ingest listening"` with the url, the events file and the key source.

Health check, in another shell (Bash/Zsh):

```bash
curl -s http://127.0.0.1:4020/healthz
```
Expected output: `{"ok":true,"events":0,"stats":{...}}`

## Configuration

See the table in the [root README](../../README.md#webhook-ingest-separate-process). The ones that matter most:

| Variable | Why you would change it |
|---|---|
| `EXTENSIV_WEBHOOK_REQUIRE_SIGNATURE` | Leave `true`. Setting it `false` accepts anything posted to the URL. |
| `EXTENSIV_WEBHOOK_PUBLIC_KEY_PEM` | Pin the key when the process cannot reach the key endpoint, or to rehearse rotation. |
| `EXTENSIV_WEBHOOK_INGRESS_TOKEN` | A second check on top of the signature when a tunnel or proxy can add a bearer header. |

## Deployment notes

- Extensiv requires an `https://` destination URL and only delivers from `3.131.3.90`, `3.131.5.63` and `3.17.2.36` (https://help.extensiv.com/en_US/3plwhm-integrations-general-information/whitelisting-ip-addresses). Terminate TLS in front of this process and allow-list those addresses.
- A delivery that is not answered with a 20x is retried for roughly six hours, then held in a dead-letter queue for three more days. Recovering from that queue means emailing api@extensiv.com, so keep the process up.
- Webhooks are a paid add-on priced by data usage. Subscribe to the event types you need and leave "include resource in payload" off unless a tool needs the body.
