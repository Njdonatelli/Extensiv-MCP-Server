/**
 * Exception bodies exactly as the real API emits them.
 * SOURCE: https://3w.extensiv.com/Rels/exceptions — Newtonsoft `TypeNameHandling.Objects`, so every
 * body carries a `$type` and PascalCase members; ErrorCode values are short strings.
 */

export type ModelValidationErrorCode = 'Required' | 'DoesNotExist' | 'Duplicate' | 'Incompatible' | 'ValueNotSupported';
export type OperationErrorCode =
  | 'InUse'
  | 'WrongCustomerInBatch'
  | 'MixedFacilitiesInBatch'
  | 'OrderConfirmed'
  | 'AlreadyCompleted'
  | 'NotFullyAllocated'
  | 'DateInFuture'
  | 'DateBeforeFreeze'
  | 'OrderNotConfirmed'
  | 'OrderCanceled'
  | 'Unallocated'
  | 'FullyAllocated'
  // GUESS: no documented OperationException code covers "order is on hold"; the help center says
  // API actions are blocked while held (putting-orders-on-hold-in-3pl-warehouse-manager), so the
  // mock uses an undocumented code rather than misreporting a documented one.
  | 'OnHold';
export type QueryParameterErrorCode = 'Required' | 'NotParsable' | 'DoesNotExist';

// The documented example shows the assembly-qualified type only for QueryParameterException;
// the other names follow the same `WMS.V2.<Name>, WMS.V2.Generic.Models` pattern.
// GUESS: the assembly qualifier for the non-QueryParameter exceptions is inferred from the one example.
const TYPE_PREFIX = 'WMS.V2.Generic.Models.Exceptions.';
const ASSEMBLY = 'WMS.V2.Generic.Models';

export interface ModelValidationBody {
  $type: string;
  // SOURCE: Rels/exceptions ModelType 0 Api, 1 Orm, 2 Other.
  ModelType: number;
  Properties: { Name: string; Value: string | null }[];
  ErrorCode: ModelValidationErrorCode;
  Hint: string;
}
export interface OperationBody {
  $type: string;
  // SOURCE: Rels/exceptions ActionNameType 0 Rel, 1 ClassName, 2 Parser.
  ActionNameType: number;
  ActionName: string;
  ErrorCode: OperationErrorCode;
  Hint: string;
}
export interface QueryParameterBody {
  $type: string;
  Parameters: string[];
  ErrorCode: QueryParameterErrorCode;
  Hint: string;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
    public readonly contentType: string = 'application/json; charset=utf-8',
    public readonly headers: Record<string, string> = {},
  ) {
    super(`ApiError ${status}`);
  }

  toResponse(): Response {
    const headers = new Headers(this.headers);
    // SOURCE: Rels/exceptions — 401/404/412/428 have no documented body; 500 is plain text.
    // GUESS: the mock sends an empty body for those.
    if (this.body === null || this.body === undefined) {
      return new Response(null, { status: this.status, headers });
    }
    headers.set('Content-Type', this.contentType);
    const text = typeof this.body === 'string' ? this.body : JSON.stringify(this.body);
    return new Response(text, { status: this.status, headers });
  }
}

export function modelValidation(
  code: ModelValidationErrorCode,
  properties: { Name: string; Value?: string | number | null }[],
  hint: string,
): ApiError {
  const body: ModelValidationBody = {
    $type: `${TYPE_PREFIX}ModelValidationException, ${ASSEMBLY}`,
    ModelType: 0,
    Properties: properties.map((p) => ({ Name: p.Name, Value: p.Value === undefined || p.Value === null ? null : String(p.Value) })),
    ErrorCode: code,
    Hint: hint,
  };
  return new ApiError(400, body);
}

export function operation(code: OperationErrorCode, actionName: string, hint: string): ApiError {
  const body: OperationBody = {
    $type: `${TYPE_PREFIX}OperationException, ${ASSEMBLY}`,
    ActionNameType: 0,
    ActionName: actionName,
    ErrorCode: code,
    Hint: hint,
  };
  // SOURCE: Rels/exceptions — OperationException "results in Status 403".
  return new ApiError(403, body);
}

export function queryParameter(code: QueryParameterErrorCode, parameters: string[], hint: string): ApiError {
  const body: QueryParameterBody = {
    $type: `${TYPE_PREFIX}QueryParameterException, ${ASSEMBLY}`,
    Parameters: parameters,
    ErrorCode: code,
    Hint: hint,
  };
  return new ApiError(400, body);
}

/** SOURCE: Rels/exceptions 401 "Missing Authorization header with proper bearer token". Body undocumented → GUESS empty. */
export function unauthorized(): ApiError {
  return new ApiError(401, null);
}
/** SOURCE: Rels/exceptions 404 "Resource doesn't exist". Body undocumented → GUESS empty. */
export function notFound(): ApiError {
  return new ApiError(404, null);
}
/** SOURCE: Rels/exceptions 428 "Precondition required. If-Match header required." */
export function preconditionRequired(): ApiError {
  return new ApiError(428, null);
}
/** SOURCE: Rels/exceptions 412 "The If-Match header specified doesn't match the current state of the resource." */
export function preconditionFailed(): ApiError {
  return new ApiError(412, null);
}
/** GUESS: an unparsable JSON body is not documented; the mock answers 400 with a ModelValidation Required hint. */
export function badJson(): ApiError {
  return modelValidation('Required', [{ Name: 'Body', Value: null }], 'Request body is not valid JSON');
}
