/** Shared test harness. Not a test file: vitest only collects `*.test.ts`. */
import { createMockApp, DEFAULT_MOCK_CREDENTIALS, type MockOptions } from '../index.js';
import type { MockState } from '../state.js';

export const CREDS = DEFAULT_MOCK_CREDENTIALS;

export function basicHeader(clientId = CREDS.clientId, clientSecret = CREDS.clientSecret): string {
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;
}

export interface Harness {
  app: ReturnType<typeof createMockApp>['app'];
  state: MockState;
  token: string;
  /** Authenticated request helper. */
  req(path: string, init?: RequestInit): Promise<Response>;
  get(path: string): Promise<Response>;
  getJson<T = Record<string, unknown>>(path: string): Promise<T>;
  post(path: string, body?: unknown, headers?: Record<string, string>): Promise<Response>;
  put(path: string, body?: unknown, headers?: Record<string, string>): Promise<Response>;
  /** Unauthenticated control-plane call. */
  control(path: string, method?: string, body?: unknown): Promise<Response>;
  etagOf(path: string): Promise<string>;
}

export async function harness(opts: MockOptions = {}): Promise<Harness> {
  const { app, state } = createMockApp(opts);
  const tokenRes = await app.request('/AuthServer/api/Token', {
    method: 'POST',
    headers: { Authorization: basicHeader(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'client_credentials', user_login: CREDS.userLogin }),
  });
  const token = ((await tokenRes.json()) as { access_token: string }).access_token;
  const auth = (extra: Record<string, string> = {}): Record<string, string> => ({
    Authorization: `Bearer ${token}`,
    Accept: 'application/hal+json',
    ...extra,
  });

  const req = (path: string, init: RequestInit = {}): Promise<Response> =>
    app.request(path, { ...init, headers: auth((init.headers ?? {}) as Record<string, string>) });

  const h: Harness = {
    app,
    state,
    token,
    req,
    get: (path) => req(path),
    getJson: async <T>(path: string): Promise<T> => {
      const res = await req(path);
      return (await res.json()) as T;
    },
    post: (path, body, headers = {}) =>
      req(path, { method: 'POST', headers: { 'Content-Type': 'application/hal+json', ...headers }, body: JSON.stringify(body ?? {}) }),
    put: (path, body, headers = {}) =>
      req(path, { method: 'PUT', headers: { 'Content-Type': 'application/hal+json', ...headers }, body: JSON.stringify(body ?? {}) }),
    control: (path, method = 'POST', body) =>
      app.request(path, {
        method,
        headers: { 'Content-Type': 'application/json' },
        ...(method === 'GET' || method === 'DELETE' ? {} : { body: JSON.stringify(body ?? {}) }),
      }),
    etagOf: async (path) => {
      const res = await req(path);
      const etag = res.headers.get('ETag');
      if (etag === null) throw new Error(`no ETag on ${path} (status ${res.status})`);
      return etag;
    },
  };
  return h;
}

/** A minimal, valid POST /orders body for the seeded Acme customer. */
export function orderBody(referenceNum: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    customerIdentifier: { id: 1 },
    facilityIdentifier: { id: 1 },
    referenceNum,
    shipTo: { name: 'Test Recipient', address1: '1 Test St', city: 'Los Angeles', state: 'CA', zip: '90045', country: 'US' },
    orderItems: [{ itemIdentifier: { sku: 'ACME-STOVE-01' }, qty: 2 }],
    ...overrides,
  };
}

export function receiverBody(referenceNum: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    customerIdentifier: { id: 1 },
    facilityIdentifier: { id: 1 },
    referenceNum,
    receiveItems: [{ itemIdentifier: { sku: 'ACME-STOVE-01' }, qty: 5 }],
    ...overrides,
  };
}

export const ORDER_REL = 'http://api.3plCentral.com/rels/orders/order';
export const ITEM_REL = 'http://api.3plCentral.com/rels/customers/item';
export const CUSTOMER_REL = 'http://api.3plCentral.com/rels/customers/customer';
export const RECEIVER_REL = 'http://api.3plCentral.com/rels/inventory/receiver';

export function embedded<T = Record<string, unknown>>(body: Record<string, unknown>, rel: string): T[] {
  const e = body._embedded as Record<string, T[]> | undefined;
  return e?.[rel] ?? [];
}
