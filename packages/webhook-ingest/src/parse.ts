import { createHash } from 'node:crypto';
import type { WmsEvent } from '@mcp-3pl/core';

/**
 * Wire payload per https://help.extensiv.com/en_US/rest-api/implementing-webhooks.
 * `links` and `data` arrive as JSON-encoded strings; `resource.body` is present
 * only when the subscription includes the resource.
 */
export interface ExtensivWebhookBody {
  tplId?: number | string;
  wmsEventId?: number | string;
  dateTime?: string;
  eventDateTimeUtc?: string;
  warehouseTransactionEventId?: number | string;
  createDateTimeUtc?: string;
  eventType?: string;
  resource?: { rel?: string; href?: string; body?: string | Record<string, unknown> };
  links?: string | Record<string, unknown>;
  data?: string | Record<string, unknown>;
  tags?: string;
}

function parseMaybeJson(v: unknown): Record<string, unknown> | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'object') return v as Record<string, unknown>;
  if (typeof v !== 'string') return undefined;
  try {
    const parsed = JSON.parse(v) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** Extensiv timestamps come without a zone designator but are documented as UTC. */
export function toIsoUtc(v: string | undefined, fallback: string): string {
  if (!v) return fallback;
  const withZone = /[zZ]|[+-]\d\d:?\d\d$/.test(v) ? v : v + 'Z';
  const t = Date.parse(withZone);
  return Number.isFinite(t) ? new Date(t).toISOString() : fallback;
}

function idFromHref(href: string | undefined): string | undefined {
  const m = href?.match(/\/(\d+)(?:\?|$)/);
  return m?.[1];
}

export function parseWebhook(raw: Buffer, body: ExtensivWebhookBody, receivedAt: string, verified: boolean): WmsEvent {
  const links = parseMaybeJson(body.links) ?? {};
  const data = parseMaybeJson(body.data) ?? {};
  const resourceBody = parseMaybeJson(body.resource?.body);
  const rel = body.resource?.rel ?? '';
  const resourceType = rel.split('/').pop() || undefined;
  const resourceId = idFromHref(body.resource?.href) ?? (data.OrderId as string | undefined) ?? (data.ReceiverId as string | undefined) ?? (data.Id as string | undefined);
  const customerId = idFromHref(links['customers/customer'] as string | undefined);
  const facilityId = idFromHref(links['properties/facility'] as string | undefined);
  const referenceNum = (resourceBody?.referenceNum as string | undefined) ?? (resourceBody?.ReferenceNum as string | undefined);
  const eventType = body.eventType ?? 'Unknown';
  const id = body.tplId !== undefined && body.wmsEventId !== undefined ? `${body.tplId}:${body.wmsEventId}` : 'sha256:' + createHash('sha256').update(raw).digest('hex').slice(0, 32);
  const summaryParts = [eventType];
  if (resourceType && resourceId) summaryParts.push(`${resourceType} ${resourceId}`);
  if (referenceNum) summaryParts.push(`ref ${referenceNum}`);
  if (customerId) summaryParts.push(`customer ${customerId}`);
  if (body.tags) summaryParts.push(`tags: ${body.tags}`);
  return {
    id,
    receivedAt,
    occurredAt: toIsoUtc(body.eventDateTimeUtc ?? body.dateTime, receivedAt),
    eventType,
    tags: body.tags,
    resourceType,
    resourceId: resourceId !== undefined ? String(resourceId) : undefined,
    resourceHref: body.resource?.href,
    customerId,
    facilityId,
    referenceNum,
    summary: summaryParts.join(' · '),
    verified,
    raw: body,
  };
}
