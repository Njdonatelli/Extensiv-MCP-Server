/**
 * Error taxonomy shared by core, adapters and the server. Every tool failure is
 * reported to the model as `{ error: { code, message, hint } }` so it can decide
 * whether to retry, ask the operator, or stop. Messages never carry secrets.
 */
export type ErrorCode =
  | 'AUTH_FAILED'
  | 'SCOPE_DENIED'
  | 'WRITES_DISABLED'
  | 'NOT_FOUND'
  | 'AMBIGUOUS'
  | 'VALIDATION'
  | 'PRECONDITION_FAILED'
  | 'CHANGE_EXPIRED'
  | 'CHANGE_UNKNOWN'
  | 'CHANGE_NOT_COMMITTABLE'
  | 'RATE_LIMITED'
  | 'UPSTREAM_ERROR'
  | 'UPSTREAM_UNAVAILABLE'
  | 'OUTCOME_UNKNOWN'
  | 'INTERNAL';

export class WmsError extends Error {
  readonly code: ErrorCode;
  readonly hint: string | undefined;
  readonly retryable: boolean;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    code: ErrorCode,
    message: string,
    opts: { hint?: string; retryable?: boolean; details?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'WmsError';
    this.code = code;
    this.hint = opts.hint;
    this.retryable = opts.retryable ?? false;
    this.details = opts.details;
  }

  toJSON(): { code: ErrorCode; message: string; hint?: string; retryable: boolean; details?: Record<string, unknown> } {
    return {
      code: this.code,
      message: this.message,
      ...(this.hint ? { hint: this.hint } : {}),
      retryable: this.retryable,
      ...(this.details ? { details: this.details } : {}),
    };
  }
}

export function isWmsError(e: unknown): e is WmsError {
  return e instanceof WmsError || (typeof e === 'object' && e !== null && (e as { name?: string }).name === 'WmsError');
}

export function toWmsError(e: unknown): WmsError {
  if (isWmsError(e)) return e;
  if (e instanceof Error) {
    return new WmsError('INTERNAL', e.message, { cause: e });
  }
  return new WmsError('INTERNAL', String(e));
}
