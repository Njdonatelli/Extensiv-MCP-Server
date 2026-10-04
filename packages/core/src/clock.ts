export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export function isoNow(clock: Clock = systemClock): string {
  return clock.now().toISOString();
}

const HAS_TIME = /T\d{2}:/;
const HAS_ZONE = /(?:[zZ]|[+-]\d{2}:?\d{2})$/;

/**
 * Epoch milliseconds for a domain timestamp, NaN when unparseable. A WMS may send date-times with
 * no zone (Extensiv does); those are read as UTC. Plain `Date.parse` reads them as the host's
 * local time, so the result would change with the machine the server runs on.
 */
export function parseTimestamp(value: string): number {
  const v = value.trim();
  return Date.parse(HAS_TIME.test(v) && !HAS_ZONE.test(v) ? `${v}Z` : v);
}
