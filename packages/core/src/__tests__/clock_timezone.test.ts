// Must run before any Date is built; vitest forks one process per file, so this does not leak.
process.env.TZ = 'America/Los_Angeles';

import { describe, expect, it } from 'vitest';
import { parseTimestamp } from '../clock.js';

describe('parseTimestamp on a host west of UTC', () => {
  it('runs with a non-UTC local zone', () => {
    expect(new Date(2026, 0, 1).getTimezoneOffset()).toBe(480);
  });

  it('reads a zoneless date-time as UTC', () => {
    expect(parseTimestamp('2026-10-03T22:09:13')).toBe(Date.parse('2026-10-03T22:09:13Z'));
  });

  it('honours an explicit zone or offset', () => {
    const utc = Date.parse('2026-10-03T22:09:13Z');
    expect(parseTimestamp('2026-10-03T22:09:13.000Z')).toBe(utc);
    expect(parseTimestamp('2026-10-03T15:09:13-07:00')).toBe(utc);
  });

  it('reads a date-only value as UTC midnight and reports garbage as NaN', () => {
    expect(parseTimestamp('2026-10-03')).toBe(Date.parse('2026-10-03T00:00:00Z'));
    expect(Number.isNaN(parseTimestamp('soon'))).toBe(true);
  });
});
