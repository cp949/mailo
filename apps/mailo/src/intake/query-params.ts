/**
 * 헤더·쿼리 파라미터 검증. 오류는 파라미터 이름과 고정 코드만 담는다(요청 값은 담지 않는다).
 */
import type { EventType } from "../events/index.js";
import type { ValidationErrorItem } from "../validation/index.js";
import { validateIdempotencyKey } from "../validation/index.js";

export const EVENT_TYPES: readonly EventType[] = [
  "JOB_SENT",
  "JOB_FAILED",
  "JOB_EXPIRED",
  "INTAKE_REJECTED",
];
export const DEFAULT_EVENTS_LIMIT = 100;
export const MAX_EVENTS_LIMIT = 500;
const MAX_CURSOR_CHARS = 256;
const UUID =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export type Parsed<T> =
  | { ok: true; value: T }
  | { ok: false; errors: ValidationErrorItem[] };

/** `Idempotency-Key` 헤더 또는 `idempotencyKey` 쿼리 값을 검사한다. 없거나 빈 값이면 REQUIRED다. */
export function parseIdempotencyKey(
  raw: unknown,
  parameter: string,
): Parsed<string> {
  if (raw === undefined || raw === "")
    return { ok: false, errors: [{ parameter, code: "REQUIRED" }] };
  const checked = validateIdempotencyKey(raw);
  if (checked.ok) return { ok: true, value: checked.value };
  const code = checked.issues[0]?.code;
  return {
    ok: false,
    errors: [
      {
        parameter,
        code: code === "KEY_LENGTH" ? "TOO_LONG" : "INVALID_FORMAT",
      },
    ],
  };
}

export function parseJobId(raw: string): Parsed<string> {
  return UUID.test(raw)
    ? { ok: true, value: raw.toLowerCase() }
    : { ok: false, errors: [{ parameter: "jobId", code: "INVALID_FORMAT" }] };
}

export interface EventsQuery {
  after: string | null;
  types: EventType[];
  limit: number;
}

/** `after`, `type`(반복 가능), `limit`을 검사한다. cursor 내용 검사는 `listEvents`가 하고, 여기서는 길이와 형태만 본다. */
export function parseEventsQuery(
  query: Record<string, unknown>,
): Parsed<EventsQuery> {
  const errors: ValidationErrorItem[] = [];

  let after: string | null = null;
  const rawAfter = query["after"];
  if (rawAfter !== undefined) {
    if (typeof rawAfter !== "string" || rawAfter.length === 0) {
      errors.push({ parameter: "after", code: "INVALID_FORMAT" });
    } else if (rawAfter.length > MAX_CURSOR_CHARS) {
      errors.push({ parameter: "after", code: "TOO_LONG" });
    } else {
      after = rawAfter;
    }
  }

  const types: EventType[] = [];
  const rawType = query["type"];
  if (rawType !== undefined) {
    const items = Array.isArray(rawType) ? rawType : [rawType];
    for (const item of items) {
      const known = EVENT_TYPES.find((t) => t === item);
      // 계약의 uniqueItems를 따른다. 같은 종류를 반복하면 400이다.
      if (known === undefined || types.includes(known)) {
        errors.push({ parameter: "type", code: "INVALID_FORMAT" });
        break;
      }
      types.push(known);
    }
  }

  let limit = DEFAULT_EVENTS_LIMIT;
  const rawLimit = query["limit"];
  if (rawLimit !== undefined) {
    if (
      typeof rawLimit !== "string" ||
      !/^\d{1,6}$/.test(rawLimit) ||
      Number(rawLimit) < 1 ||
      Number(rawLimit) > MAX_EVENTS_LIMIT
    ) {
      errors.push({ parameter: "limit", code: "INVALID_FORMAT" });
    } else {
      limit = Number(rawLimit);
    }
  }

  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, value: { after, types, limit } };
}
