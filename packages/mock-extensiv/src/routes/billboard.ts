/**
 * HATEOAS entry point.
 * SOURCE: https://3w.extensiv.com/Rels/billboard — "/billboard" is the entry point, clients should
 * follow links rather than hardcode URIs, and "operator rels are present only if the state change is
 * valid for the given resource".
 * GUESS: the exact rel set on the real billboard is not enumerated in the fetched docs; the mock
 * advertises exactly the collections it implements.
 */
import { Hono } from 'hono';
import type { MockEnv } from '../env.js';
import { hal, relLink } from '../hal.js';

export function billboardRoutes(): Hono<MockEnv> {
  const app = new Hono<MockEnv>();

  app.get('/billboard', (c) =>
    hal(c, {
      _links: {
        self: { href: '/billboard' },
        [relLink('customers', 'customers')]: { href: '/customers' },
        [relLink('properties', 'facilities')]: { href: '/properties/facilities' },
        [relLink('properties', 'carriers')]: { href: '/properties/carriers' },
        [relLink('orders', 'orders')]: { href: '/orders' },
        [relLink('orders', 'summaries')]: { href: '/orders/summaries' },
        [relLink('orders', 'shipmentstrackinginfo')]: { href: '/orders/shipmentstrackinginfo' },
        [relLink('inventory', 'inventory')]: { href: '/inventory' },
        [relLink('inventory', 'stocksummaries')]: { href: '/inventory/stocksummaries' },
        [relLink('inventory', 'stockdetails')]: { href: '/inventory/stockdetails' },
        [relLink('inventory', 'receivers')]: { href: '/inventory/receivers' },
      },
    }),
  );

  return app;
}
