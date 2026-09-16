/**
 * Customers and customer items.
 * SOURCE: https://3w.extensiv.com/rels/customers/customers ; /rels/customers/customer ;
 * /rels/customers/items ; /rels/customers/item.
 */
import { Hono } from 'hono';
import type { MockEnv } from '../env.js';
import { notFound } from '../errors.js';
import { collection, hal, listPipeline, parsePaging, REL } from '../hal.js';
import type { Customer, Item } from '../models.js';
import { compileRql, compileSort } from '../rql.js';
import type { MockState } from '../state.js';
import { optionalIntQuery, PAGING, pathId } from './common.js';
import { CUSTOMER_SHAPE, ITEM_SHAPE } from './shapes.js';

export function customersRoutes(state: MockState): Hono<MockEnv> {
  const app = new Hono<MockEnv>();

  // SOURCE: rels/customers/customers — GET /customers{?pgsiz,pgnum,rql,sort,facilityId,includeInUse},
  // page size limit 100, default 20, cacheable.
  app.get('/customers', (c) => {
    const paging = parsePaging(c, PAGING.customers);
    const filter = compileRql<Customer>(c.req.query('rql'), CUSTOMER_SHAPE);
    const sort = compileSort<Customer>(c.req.query('sort'), CUSTOMER_SHAPE);
    const facilityId = optionalIntQuery(c, 'facilityId');
    const scoped = facilityId === undefined ? state.customers : state.customers.filter((x) => x.facilities.some((f) => f.id === facilityId));
    const { page, totalResults, links } = listPipeline(c, scoped, filter, sort, paging);
    return hal(c, collection(REL.customer, page.map(withCustomerLinks), totalResults, links), 200, {
      'Cache-Control': 'private, max-age=60',
    });
  });

  // SOURCE: rels/customers/customer — GET /customers/{id} → 200 + ETag.
  app.get('/customers/:id', (c) => {
    const customer = state.customerById(pathId(c, 'id'));
    if (!customer) throw notFound();
    return hal(c, withCustomerLinks(customer), 200, { ETag: state.etagOfCustomer(customer) });
  });

  // SOURCE: rels/customers/items — GET /customers/{id}/items{?pgsiz,pgnum,rql,sort}, limit 100, default 10.
  app.get('/customers/:id/items', (c) => {
    const customerId = pathId(c, 'id');
    if (!state.customerById(customerId)) throw notFound();
    const paging = parsePaging(c, PAGING.items);
    const filter = compileRql<Item>(c.req.query('rql'), ITEM_SHAPE);
    const sort = compileSort<Item>(c.req.query('sort'), ITEM_SHAPE);
    const { page, totalResults, links } = listPipeline(c, state.itemsOfCustomer(customerId), filter, sort, paging);
    return hal(c, collection(REL.item, page.map((i) => withItemLinks(customerId, i)), totalResults, links), 200, {
      'Cache-Control': 'private, max-age=60',
    });
  });

  // SOURCE: rels/customers/item — GET /customers/{id}/items/{iid} → 200 + ETag.
  app.get('/customers/:id/items/:iid', (c) => {
    const customerId = pathId(c, 'id');
    if (!state.customerById(customerId)) throw notFound();
    const item = state.itemsOfCustomer(customerId).find((i) => i.itemId === pathId(c, 'iid'));
    if (!item) throw notFound();
    return hal(c, withItemLinks(customerId, item), 200, { ETag: state.etagOfItem(item) });
  });

  return app;
}

function withCustomerLinks(customer: Customer): Record<string, unknown> {
  const id = customer.readOnly.customerId;
  return {
    ...customer,
    _links: {
      self: { href: `/customers/${id}` },
      'http://api.3plCentral.com/rels/customers/items': { href: `/customers/${id}/items` },
      'http://api.3plCentral.com/rels/properties/facility': { href: `/properties/facilities/${customer.primaryFacilityIdentifier.id}` },
    },
  };
}

function withItemLinks(customerId: number, item: Item): Record<string, unknown> {
  return {
    ...item,
    _links: {
      self: { href: `/customers/${customerId}/items/${item.itemId}` },
      'http://api.3plCentral.com/rels/customers/customer': { href: `/customers/${customerId}` },
    },
  };
}
