import type { WmsAdapter } from '../adapter.js';
import type { Clock } from '../clock.js';
import { systemClock } from '../clock.js';
import type { CoreConfig } from '../config.js';
import { WmsError, isWmsError, toWmsError } from '../errors.js';
import type { Logger } from '../logger.js';
import { silentLogger } from '../logger.js';
import { MUTATION_KINDS } from '../mutation.js';
import type { ChangeRecord, ChangeStatus, MutationInputMap, MutationKind, MutationOutcome, MutationPlan, PreconditionResult } from '../mutation.js';
import type { ScopePolicy } from '../policy.js';
import type { AuditLog } from '../stores/audit_log.js';
import { NoopAuditLog } from '../stores/audit_log.js';
import type { ChangeStore } from '../stores/change_store.js';
import { fingerprint, newChangeId } from './fingerprint.js';

export interface PrepareOptions {
  /** Caller-supplied key: preparing twice with the same key returns the same change. */
  idempotencyKey?: string;
  requestedBy?: string;
}

export interface PrepareResult {
  changeId: string;
  /** 'prepared' for a new plan; 'already_prepared' when an identical intent is pending; 'already_committed' when it was already committed. */
  status: 'prepared' | 'already_prepared' | 'already_committed';
  kind: MutationKind;
  summary: string;
  environment: { system: string; baseUrl: string; label: string };
  scope: MutationPlan['scope'];
  preview: Record<string, unknown>;
  warnings: string[];
  preconditions: string[];
  risk: MutationPlan['risk'];
  upstream: MutationPlan['upstream'];
  expiresAt: string;
  outcome?: MutationOutcome;
  nextStep: string;
}

export interface CommitResult {
  changeId: string;
  status: 'committed' | 'replayed';
  kind: MutationKind;
  summary: string;
  outcome: MutationOutcome;
  committedAt: string;
  message: string;
}

export interface MutationEngineOptions {
  adapter: WmsAdapter;
  store: ChangeStore;
  policy: ScopePolicy;
  config: Pick<CoreConfig, 'changeTtlSeconds' | 'maxLinesPerMutation' | 'maxUnitsPerMutation'>;
  audit?: AuditLog;
  logger?: Logger;
  clock?: Clock;
}

/**
 * Two-phase mutation engine. Invariants:
 *  1. prepare never writes upstream.
 *  2. commit executes each change at most once per change id; replays return the stored outcome.
 *  3. commit re-checks policy, environment and adapter preconditions against fresh state.
 *  4. before executing, the adapter's natural-key lookup runs so a retry after a lost
 *     response cannot double-create.
 *  5. concurrent commits of the same id in one process coalesce onto one in-flight promise.
 */
export class MutationEngine {
  private readonly adapter: WmsAdapter;
  private readonly store: ChangeStore;
  private readonly policy: ScopePolicy;
  private readonly cfg: MutationEngineOptions['config'];
  private readonly audit: AuditLog;
  private readonly log: Logger;
  private readonly clock: Clock;
  private readonly inFlight = new Map<string, Promise<CommitResult>>();

  constructor(opts: MutationEngineOptions) {
    this.adapter = opts.adapter;
    this.store = opts.store;
    this.policy = opts.policy;
    this.cfg = opts.config;
    this.audit = opts.audit ?? new NoopAuditLog();
    this.log = opts.logger ?? silentLogger;
    this.clock = opts.clock ?? systemClock;
  }

  private target(): ChangeRecord['target'] {
    return {
      system: this.adapter.info.system,
      baseUrl: this.adapter.info.baseUrl,
      environmentLabel: this.adapter.info.environmentLabel,
      tenantKey: this.adapter.info.tenantKey,
    };
  }

  async prepare<K extends MutationKind>(kind: K, input: MutationInputMap[K], opts: PrepareOptions = {}): Promise<PrepareResult> {
    if (!MUTATION_KINDS.includes(kind)) {
      throw new WmsError('VALIDATION', `Unknown mutation kind '${String(kind)}'.`);
    }
    const now = this.clock.now();

    // Cheap refusal before any upstream read when the caller named the customer.
    const early = (input as { customerId?: string }).customerId;
    if (early !== undefined) {
      try {
        this.policy.assertWrite({ customerId: String(early) }, kind.replace('_', ' '));
      } catch (e) {
        await this.audit.record({ at: now.toISOString(), kind: 'policy_refusal', tool: kind, outcome: 'refused', error: toWmsError(e).toJSON(), input: summarizeInput(input) });
        throw e;
      }
    }

    // Plan first: the normalized plan input is what the fingerprint and the idempotency
    // key are compared on, so both checks need it.
    const plan = await this.adapter.planMutation(kind, input);
    this.policy.assertWrite(plan.scope, plan.summary);
    this.enforceBlastRadius(plan);
    const fp = fingerprint(kind, plan.input);

    if (opts.idempotencyKey) {
      const byKey = await this.store.findByIdempotencyKey(opts.idempotencyKey);
      if (byKey && this.isReusable(byKey, now)) {
        // An idempotency key names one operation. Reusing it for a different intent is a
        // caller bug: replaying the earlier plan would silently ignore what was just asked.
        if (byKey.kind !== kind || byKey.fingerprint !== fp) {
          throw new WmsError('VALIDATION', `Idempotency key '${opts.idempotencyKey}' was already used for a different request (change ${byKey.id}: ${byKey.plan.summary}).`, {
            hint: 'Use a new idempotency key for a new request, or omit it to let the engine match on the request itself.',
            details: { existingChangeId: byKey.id, existingKind: byKey.kind, existingSummary: byKey.plan.summary },
          });
        }
        return this.toPrepareResult(byKey, byKey.status === 'committed' ? 'already_committed' : 'already_prepared');
      }
    }

    const dup = await this.store.findByFingerprint(fp);
    if (dup && this.isReusable(dup, now) && sameTarget(dup.target, this.target())) {
      await this.audit.record({ at: now.toISOString(), kind: 'prepare', tool: kind, changeId: dup.id, outcome: 'replayed' });
      return this.toPrepareResult(dup, dup.status === 'committed' ? 'already_committed' : 'already_prepared');
    }

    const record: ChangeRecord = {
      id: newChangeId(),
      kind,
      status: 'prepared',
      fingerprint: fp,
      idempotencyKey: opts.idempotencyKey,
      plan,
      target: this.target(),
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.cfg.changeTtlSeconds * 1000).toISOString(),
      commitAttempts: 0,
      requestedBy: opts.requestedBy,
    };
    await this.store.put(record);
    await this.audit.record({ at: record.createdAt, kind: 'prepare', tool: kind, changeId: record.id, outcome: 'ok', detail: { summary: plan.summary, scope: plan.scope, risk: plan.risk, upstream: plan.upstream } });
    this.log.info('change prepared', { changeId: record.id, kind, summary: plan.summary });
    return this.toPrepareResult(record, 'prepared');
  }

  async commit(changeId: string, opts: { requestedBy?: string } = {}): Promise<CommitResult> {
    const existing = this.inFlight.get(changeId);
    if (existing) return existing;
    const p = this.commitInner(changeId, opts).finally(() => this.inFlight.delete(changeId));
    this.inFlight.set(changeId, p);
    return p;
  }

  private async commitInner(changeId: string, opts: { requestedBy?: string }): Promise<CommitResult> {
    const now = this.clock.now();
    const rec = await this.store.get(changeId);
    if (!rec) {
      throw new WmsError('CHANGE_UNKNOWN', `No prepared change with id '${changeId}'.`, {
        hint: 'Change ids come from the prepare tools (create_order, update_order, cancel_order, create_receipt). Prepare first, then commit.',
      });
    }
    rec.commitAttempts += 1;

    // Checked before every other state check, including the committed-replay shortcut: an
    // outcome recorded against another environment names resources that do not exist here,
    // so reporting it as a successful replay would be a lie about this environment.
    if (!sameTarget(rec.target, this.target())) {
      throw new WmsError('CHANGE_NOT_COMMITTABLE', `Change ${changeId} was prepared against ${rec.target.environmentLabel} (${rec.target.baseUrl}) but this server targets ${this.adapter.info.environmentLabel} (${this.adapter.info.baseUrl}).`, {
        hint: 'Changes never cross environments. Prepare again against this environment.',
      });
    }

    if (rec.status === 'committed' && rec.outcome) {
      await this.store.put(rec);
      await this.audit.record({ at: now.toISOString(), kind: 'commit', tool: 'commit_change', changeId, outcome: 'replayed' });
      return {
        changeId,
        status: 'replayed',
        kind: rec.kind,
        summary: rec.plan.summary,
        outcome: rec.outcome,
        committedAt: rec.committedAt ?? rec.createdAt,
        message: `Change ${changeId} was already committed at ${rec.committedAt}; no further write was performed.`,
      };
    }
    if (rec.status === 'discarded') {
      throw new WmsError('CHANGE_NOT_COMMITTABLE', `Change ${changeId} was discarded.`, { hint: 'Prepare a new change.' });
    }
    if (rec.status === 'expired' || this.isExpired(rec, now)) {
      rec.status = 'expired';
      await this.store.put(rec);
      throw new WmsError('CHANGE_EXPIRED', `Change ${changeId} expired at ${rec.expiresAt}; nothing was written.`, {
        hint: 'Prepare the change again so the preview reflects current state, then commit the new id.',
      });
    }
    if (rec.status === 'failed') {
      throw new WmsError('CHANGE_NOT_COMMITTABLE', `Change ${changeId} previously failed (${rec.error?.code}: ${rec.error?.message}).`, {
        hint: 'Prepare a new change; the preview will reflect the current upstream state.',
      });
    }
    // Policy is re-evaluated at commit so a narrowed scope or disabled writes take effect immediately.
    try {
      this.policy.assertWrite(rec.plan.scope, rec.plan.summary);
    } catch (e) {
      await this.audit.record({ at: now.toISOString(), kind: 'policy_refusal', tool: 'commit_change', changeId, outcome: 'refused', error: toWmsError(e).toJSON() });
      throw e;
    }

    const resumingUnknown = rec.status === 'outcome_unknown' || rec.status === 'committing';
    rec.status = 'committing';
    await this.store.put(rec);

    try {
      const applied = await this.adapter.findApplied(rec.plan);
      if (applied) {
        return await this.finish(rec, { ...applied, via: 'found_existing' }, now, opts);
      }
      if (resumingUnknown && !rec.plan.upstreamIdempotent && rec.plan.kind !== 'create_order' && rec.plan.kind !== 'create_receipt') {
        // A lost response on a non-idempotent, non-creating write (update) cannot be reconciled by natural key.
        // Version preconditions below decide: if the update applied, the version moved and the check fails loudly.
        this.log.warn('resuming commit with unknown prior outcome', { changeId });
      }
      const checks = await this.adapter.checkPreconditions(rec.plan);
      const failed = checks.filter((c) => !c.ok);
      if (failed.length) {
        rec.status = 'failed';
        rec.error = { code: 'PRECONDITION_FAILED', message: describeFailures(failed) };
        await this.store.put(rec);
        await this.audit.record({ at: now.toISOString(), kind: 'commit', tool: 'commit_change', changeId, outcome: 'error', error: rec.error });
        throw new WmsError('PRECONDITION_FAILED', `Cannot commit ${changeId}: ${describeFailures(failed)}`, {
          hint: 'The upstream state changed since the preview. Re-run the prepare tool and review the new preview before committing.',
          details: { failed: failed.map((f) => ({ description: f.precondition.description, actual: f.actual, message: f.message })) },
        });
      }
      const outcome = await this.adapter.executeMutation(rec.plan);
      return await this.finish(rec, { ...outcome, via: 'executed' }, now, opts);
    } catch (e) {
      if (isWmsError(e) && (e.code === 'PRECONDITION_FAILED' || e.code === 'SCOPE_DENIED' || e.code === 'WRITES_DISABLED')) throw e;
      const err = toWmsError(e);
      if (err.code === 'OUTCOME_UNKNOWN') {
        rec.status = 'outcome_unknown';
        rec.error = { code: err.code, message: err.message };
        await this.store.put(rec);
        await this.audit.record({ at: now.toISOString(), kind: 'commit', tool: 'commit_change', changeId, outcome: 'error', error: rec.error });
        throw new WmsError('OUTCOME_UNKNOWN', `${err.message} Change ${changeId} is marked outcome-unknown.`, {
          hint: 'Call commit_change again with the same change id: the engine will look the resource up by its reference number before doing anything else, so this is safe and will not double-write.',
          retryable: true,
          cause: e,
        });
      }
      // Never mark a change failed once the upstream write landed: a later commit would
      // then refuse to reconcile it, and the operator would be told nothing happened.
      if ((rec.status as ChangeStatus) === 'committed') {
        this.log.error('commit succeeded but post-write bookkeeping failed', { changeId, err: err.message });
        throw err;
      }
      rec.status = 'failed';
      rec.error = { code: err.code, message: err.message };
      await this.store.put(rec);
      await this.audit.record({ at: now.toISOString(), kind: 'commit', tool: 'commit_change', changeId, outcome: 'error', error: rec.error }).catch(() => undefined);
      throw err;
    }
  }

  private async finish(rec: ChangeRecord, outcome: MutationOutcome, now: Date, opts: { requestedBy?: string }): Promise<CommitResult> {
    rec.status = 'committed';
    rec.outcome = outcome;
    rec.committedAt = now.toISOString();
    rec.error = undefined;
    if (opts.requestedBy) rec.requestedBy = opts.requestedBy;
    await this.store.put(rec);
    // The write already happened and the change store is the authoritative record, so a
    // failed audit append must not turn a committed change into a reported failure.
    try {
      await this.audit.record({
        at: rec.committedAt,
        kind: 'commit',
        tool: 'commit_change',
        changeId: rec.id,
        outcome: 'ok',
        detail: { kind: rec.kind, summary: rec.plan.summary, scope: rec.plan.scope, via: outcome.via, resourceType: outcome.resourceType, resourceId: outcome.resourceId, referenceNum: outcome.referenceNum, upstream: rec.plan.upstream },
      });
    } catch (e) {
      this.log.error('commit succeeded but the audit entry could not be written', { changeId: rec.id, err: String(e) });
    }
    this.log.info('change committed', { changeId: rec.id, kind: rec.kind, via: outcome.via, resourceId: outcome.resourceId });
    return {
      changeId: rec.id,
      status: 'committed',
      kind: rec.kind,
      summary: rec.plan.summary,
      outcome,
      committedAt: rec.committedAt,
      message:
        outcome.via === 'found_existing'
          ? `The effect of change ${rec.id} was already present upstream (${outcome.resourceType} ${outcome.resourceId}); no new write was performed.`
          : `Change ${rec.id} committed: ${rec.plan.summary}.`,
    };
  }

  async discard(changeId: string): Promise<{ changeId: string; status: ChangeRecord['status'] }> {
    const rec = await this.store.get(changeId);
    if (!rec) throw new WmsError('CHANGE_UNKNOWN', `No change with id '${changeId}'.`);
    if (rec.status === 'prepared' || rec.status === 'failed' || rec.status === 'expired') {
      rec.status = 'discarded';
      await this.store.put(rec);
      await this.audit.record({ at: this.clock.now().toISOString(), kind: 'discard', changeId, outcome: 'ok' });
    }
    return { changeId, status: rec.status };
  }

  async get(changeId: string): Promise<ChangeRecord | undefined> {
    return this.store.get(changeId);
  }

  async listPending(): Promise<ChangeRecord[]> {
    const now = this.clock.now();
    const recs = await this.store.list({ status: ['prepared', 'committing', 'outcome_unknown'] });
    return recs.filter((r) => !this.isExpired(r, now) || r.status !== 'prepared');
  }

  private isExpired(rec: ChangeRecord, now: Date): boolean {
    return rec.status === 'prepared' && Date.parse(rec.expiresAt) <= now.getTime();
  }

  /**
   * Whether an existing change may stand in for a new prepare of the same intent.
   *
   * A still-pending change may. A committed one may only for as long as a prepared
   * change would have lived: beyond that, asking for the same thing again is a new
   * request, not an accidental double-submit. Without the window, an order that was
   * created and later cancelled could never be created again under the same reference,
   * because prepare would keep replaying the original commit and never write.
   */
  private isReusable(rec: ChangeRecord, now: Date): boolean {
    if (rec.status === 'prepared') return !this.isExpired(rec, now);
    if (rec.status === 'committing' || rec.status === 'outcome_unknown') return true;
    if (rec.status === 'committed') {
      // Only a create has a natural key that makes "already done" meaningful. An update or a
      // cancel is a repeatable intent: setting a carrier back to UPS after someone changed it
      // is byte-identical to the first request and must write again, not report the old
      // outcome. Creates stay deduped briefly to absorb a double-submit.
      if (rec.kind !== 'create_order' && rec.kind !== 'create_receipt') return false;
      const at = Date.parse(rec.committedAt ?? rec.createdAt);
      return Number.isFinite(at) && now.getTime() - at <= this.cfg.changeTtlSeconds * 1000;
    }
    return false;
  }

  private enforceBlastRadius(plan: MutationPlan): void {
    const lines = (plan.input as { lines?: { qty: number }[] }).lines;
    if (!lines) return;
    if (lines.length > this.cfg.maxLinesPerMutation) {
      throw new WmsError('VALIDATION', `${lines.length} lines exceeds the per-mutation cap of ${this.cfg.maxLinesPerMutation}.`, {
        hint: 'Split the request, or an operator can raise EXTENSIV_MCP_MAX_LINES_PER_MUTATION.',
      });
    }
    const units = lines.reduce((s, l) => s + (Number(l.qty) || 0), 0);
    if (units > this.cfg.maxUnitsPerMutation) {
      throw new WmsError('VALIDATION', `${units} units exceeds the per-mutation cap of ${this.cfg.maxUnitsPerMutation}.`, {
        hint: 'Split the request, or an operator can raise EXTENSIV_MCP_MAX_UNITS_PER_MUTATION.',
      });
    }
  }

  private toPrepareResult(rec: ChangeRecord, status: PrepareResult['status']): PrepareResult {
    const { plan } = rec;
    return {
      changeId: rec.id,
      status,
      kind: rec.kind,
      summary: plan.summary,
      environment: { system: rec.target.system, baseUrl: rec.target.baseUrl, label: rec.target.environmentLabel },
      scope: plan.scope,
      preview: plan.preview,
      warnings: plan.warnings,
      preconditions: plan.preconditions.map((p) => p.description),
      risk: plan.risk,
      upstream: plan.upstream,
      expiresAt: rec.expiresAt,
      outcome: rec.outcome,
      nextStep:
        status === 'already_committed'
          ? `This exact change was already committed as ${rec.id}; nothing more to do.`
          : `Nothing has been written. Show this preview to the operator; if they approve, call commit_change with change_id "${rec.id}" before ${rec.expiresAt}.`,
    };
  }
}

/**
 * Two tenants of the same vendor share a base URL and differ only by credentials, and two
 * server instances launched from one directory share a state dir. Comparing the base URL
 * alone would let a change prepared for one tenant commit against another, creating a real
 * order under whatever customer that id happens to mean there.
 */
function sameTarget(a: ChangeRecord['target'], b: ChangeRecord['target']): boolean {
  return (
    a.system === b.system &&
    a.baseUrl.replace(/\/+$/, '') === b.baseUrl.replace(/\/+$/, '') &&
    a.environmentLabel === b.environmentLabel &&
    (a.tenantKey ?? '') === (b.tenantKey ?? '')
  );
}

function describeFailures(failed: PreconditionResult[]): string {
  return failed.map((f) => `${f.precondition.description}${f.message ? ` (${f.message})` : ''}`).join('; ');
}

function summarizeInput(input: unknown): unknown {
  const s = JSON.stringify(input);
  return s.length > 1000 ? s.slice(0, 1000) + '…' : input;
}
