/**
 * Facilities, locations and carriers.
 * SOURCE: https://3w.extensiv.com/rels/properties/facilities ; /rels/properties/locationsbyfac ;
 * /rels/properties/carriers.
 */
import { Hono } from 'hono';
import type { MockEnv } from '../env.js';
import { notFound } from '../errors.js';
import { collection, hal, listPipeline, parsePaging, REL } from '../hal.js';
import { compileRql, compileSort } from '../rql.js';
import type { Facility, Location } from '../models.js';
import type { MockState } from '../state.js';
import { optionalIntQuery, PAGING, pathId } from './common.js';
import { FACILITY_SHAPE, LOCATION_SHAPE } from './shapes.js';

export function propertiesRoutes(state: MockState): Hono<MockEnv> {
  const app = new Hono<MockEnv>();

  // SOURCE: rels/properties/carriers — a flat object with defaults plus an _embedded carrier list.
  // Registered before /properties/facilities/... so the static segment always wins.
  app.get('/properties/carriers', (c) => {
    const carriers = state.carriers;
    // GUESS: the element shape of defaultBillingCodes / defaultShipmentServices is not shown on the
    // rel page; the mock returns the distinct codes carriers expose, which is the only self-consistent
    // reading of "default".
    const billingCodes = dedupeBy(
      carriers.flatMap((x) => x.billingCodes),
      (b) => b.code,
    );
    const services = dedupeBy(
      carriers.flatMap((x) => x.shipmentServices),
      (s) => s.code,
    );
    return hal(c, {
      defaultBillingCodes: billingCodes,
      defaultShipmentServices: services,
      _embedded: { [REL.carrier]: carriers },
      _links: { self: { href: '/properties/carriers' } },
    });
  });

  // SOURCE: rels/properties/facilities — GET /properties/facilities{?pgsiz,pgnum,rql,sort,customerId}, cacheable.
  app.get('/properties/facilities', (c) => {
    const paging = parsePaging(c, PAGING.facilities);
    const filter = compileRql<Facility>(c.req.query('rql'), FACILITY_SHAPE);
    const sort = compileSort<Facility>(c.req.query('sort'), FACILITY_SHAPE);
    const customerId = optionalIntQuery(c, 'customerId');
    const scoped =
      customerId === undefined
        ? state.facilities
        : state.facilities.filter((f) => state.customerById(customerId)?.facilities.some((x) => x.id === f.facilityId) ?? false);
    const { page, totalResults, links } = listPipeline(c, scoped, filter, sort, paging);
    return hal(c, collection(REL.facility, page.map(withFacilityLinks), totalResults, links), 200, {
      // SOURCE: Rels/headers — Cache-Control is a documented response header; this rel is "cacheable".
      'Cache-Control': 'private, max-age=60',
    });
  });

  app.get('/properties/facilities/:id', (c) => {
    const facility = state.facilityById(pathId(c, 'id'));
    if (!facility) throw notFound();
    return hal(c, withFacilityLinks(facility));
  });

  // SOURCE: rels/properties/locationsbyfac — GET /properties/facilities/{id}/locations.
  // GUESS: rql/sort/paging support on this rel is not documented; the mock offers them.
  app.get('/properties/facilities/:id/locations', (c) => {
    const id = pathId(c, 'id');
    if (!state.facilityById(id)) throw notFound();
    const paging = parsePaging(c, PAGING.locations);
    const filter = compileRql<Location>(c.req.query('rql'), LOCATION_SHAPE);
    const sort = compileSort<Location>(c.req.query('sort'), LOCATION_SHAPE);
    const rows = state.locations.filter((l) => l.facilityIdentifier.id === id);
    const { page, totalResults, links } = listPipeline(c, rows, filter, sort, paging);
    return hal(c, collection(REL.location, page, totalResults, links));
  });

  return app;
}

function withFacilityLinks(f: Facility): Record<string, unknown> {
  return {
    ...f,
    _links: {
      self: { href: `/properties/facilities/${f.facilityId}` },
      'http://api.3plCentral.com/rels/properties/locationsbyfac': { href: `/properties/facilities/${f.facilityId}/locations` },
    },
  };
}

function dedupeBy<T>(rows: T[], key: (row: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const row of rows) {
    const k = key(row);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(row);
  }
  return out;
}
