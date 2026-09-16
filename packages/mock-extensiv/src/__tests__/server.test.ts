/**
 * The only test file that binds real sockets. Everything provable with `app.request()` lives in the
 * other files; this one covers what needs a TCP connection: an abandoned connection, and outbound
 * webhook delivery to a receiver started inside the test.
 */
import { createVerify } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startMockServer } from '../index.js';
import { basicHeader, CREDS, orderBody } from './helpers.js';

interface Hook {
  body: string;
  signature: string | undefined;
  contentType: string | undefined;
}

let mock: Awaited<ReturnType<typeof startMockServer>>;
let receiver: Server;
let receiverUrl: string;
let token: string;
const hooks: Hook[] = [];

const json = { 'Content-Type': 'application/json' };

beforeAll(async () => {
  mock = await startMockServer({ port: 0 });

  receiver = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      hooks.push({ body, signature: req.headers.signature as string | undefined, contentType: req.headers['content-type'] });
      // SOURCE: implementing-webhooks — answer within 3 seconds with a 20x.
      res.writeHead(200);
      res.end('ok');
    });
  });
  await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  receiverUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/hook`;

  const tokenRes = await fetch(`${mock.url}/AuthServer/api/Token`, {
    method: 'POST',
    headers: { Authorization: basicHeader(), ...json },
    body: JSON.stringify({ grant_type: 'client_credentials', user_login: CREDS.userLogin }),
  });
  token = ((await tokenRes.json()) as { access_token: string }).access_token;
});

afterAll(async () => {
  await new Promise<void>((resolve) => receiver.close(() => resolve()));
  await mock.close();
});

function auth(extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${token}`, Accept: 'application/hal+json', ...extra };
}

describe('startMockServer', () => {
  it('binds an ephemeral port and reports it', () => {
    expect(mock.port).toBeGreaterThan(0);
    expect(mock.url).toBe(`http://127.0.0.1:${mock.port}`);
  });

  it('serves over real HTTP', async () => {
    const res = await fetch(`${mock.url}/billboard`, { headers: auth() });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/hal+json; charset=utf-8');
  });
});

describe('webhook delivery', () => {
  it('POSTs a signed payload that verifies against GET /events/webhook/key', async () => {
    await fetch(`${mock.url}/__mock/webhooks`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ name: 'test-receiver', url: receiverUrl, resource: 'Order', eventTypes: ['OrderCreate'], includeResource: true }),
    });

    const created = await fetch(`${mock.url}/orders`, {
      method: 'POST',
      headers: auth({ 'Content-Type': 'application/hal+json' }),
      body: JSON.stringify(orderBody('WEBHOOK-1')),
    });
    expect(created.status).toBe(201);
    const orderId = ((await created.json()) as { readOnly: { orderId: number } }).readOnly.orderId;

    // Draining the delivery queue also waits out the seeded subscription's failing retries.
    const deliveries = (await (await fetch(`${mock.url}/__mock/webhooks/deliveries`)).json()) as {
      deliveries: { url: string; ok: boolean; eventType: string; attempts: { status: number | null }[] }[];
    };
    const mine = deliveries.deliveries.find((d) => d.url === receiverUrl);
    expect(mine?.ok).toBe(true);
    expect(mine?.eventType).toBe('OrderCreate');
    expect(mine?.attempts[0]?.status).toBe(200);

    expect(hooks).toHaveLength(1);
    const hook = hooks[0] as Hook;
    expect(hook.contentType).toBe('application/json');
    expect(hook.signature).toBeTruthy();

    // SOURCE: implementing-webhooks — Signature is base64(RSA-SHA256 over the raw body).
    const key = (await (await fetch(`${mock.url}/events/webhook/key`, { headers: auth() })).json()) as { publicKey: string };
    const verifier = createVerify('RSA-SHA256');
    verifier.update(hook.body);
    expect(verifier.verify(key.publicKey, Buffer.from(hook.signature as string, 'base64'))).toBe(true);

    // Tampering with the body invalidates the signature.
    const tampered = createVerify('RSA-SHA256');
    tampered.update(`${hook.body} `);
    expect(tampered.verify(key.publicKey, Buffer.from(hook.signature as string, 'base64'))).toBe(false);

    const payload = JSON.parse(hook.body) as {
      tplId: number;
      wmsEventId: number;
      eventType: string;
      eventDateTimeUtc: string;
      resource: { rel: string; href: string; body?: string };
      links: string;
      data: string;
      tags: string;
    };
    expect(payload.eventType).toBe('OrderCreate');
    expect(payload.resource.rel).toBe('orders/order');
    expect(payload.resource.href).toBe(`/orders/${orderId}`);
    expect(typeof payload.resource.body).toBe('string');
    expect(JSON.parse(payload.data) as Record<string, string>).toEqual({ OrderId: String(orderId) });
    expect(JSON.parse(payload.links) as Record<string, unknown>).toMatchObject({ 'customers/customer': '/customers/1' });
    // Seven fractional digits, no offset (SOURCE: implementing-webhooks sample).
    expect(payload.eventDateTimeUtc).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}$/);
  });
});

describe('dropConnection over a real socket', () => {
  it('leaves the write applied while the client sees a network error', async () => {
    await fetch(`${mock.url}/__mock/faults`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ once: [{ match: 'POST /orders', status: 0, dropConnection: true }] }),
    });

    await expect(
      fetch(`${mock.url}/orders`, {
        method: 'POST',
        headers: auth({ 'Content-Type': 'application/hal+json' }),
        body: JSON.stringify(orderBody('DROPPED-OVER-SOCKET')),
      }),
    ).rejects.toThrow();

    // The order exists even though the caller never got a response.
    const found = (await (
      await fetch(`${mock.url}/orders?rql=${encodeURIComponent('referencenum==DROPPED-OVER-SOCKET')}`, { headers: auth() })
    ).json()) as { totalResults: number };
    expect(found.totalResults).toBe(1);

    // The server is still healthy after abandoning a connection.
    expect((await fetch(`${mock.url}/billboard`, { headers: auth() })).status).toBe(200);
  });
});
