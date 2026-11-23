/**
 * 수집 공용 파이프라인(ADR-0008 결정 3). REST와 파일 채널이 같은 함수를 쓴다.
 *
 * 순서(바꾸지 않는다)
 * 1. JWS 구조 파싱 2. 서명 검증(`caller`·`iat` 포함) 3. payload 파싱·스키마 검증 4. 복호화
 * 5. 복호화한 제목·본문 입력 검증(RQ-030) 6. 지문 계산(ADR-0005). 우선순위(RQ-034)와 만료 TTL(RQ-039)은 지문의 `policy`에 넣는다.
 * 서명을 복호화보다 먼저 검증한다. 위조 파일의 복호화를 시도하지 않는다.
 * 제목이 암호화돼 있으면 CR/LF 검사를 복호화 전에 할 수 없으므로 5단계에서 한다.
 *
 * 입력
 * - `file`: 파일 바이트. 서명이 `required`인 호출처는 최상위가 flattened JWS여야 하고 요청 JSON은 payload 안에 있다.
 *   `none`이면 파일 전체가 요청 JSON이다. 원시 크기 상한은 호출자가 읽기 전에 적용한다(RQ-030).
 * - `rest`: 이미 JSON으로 파싱한 본문. REST는 서명을 요구하지 않는다(ADR-0008 결정 2).
 *
 * 등록(7단계)은 호출자가 한다. 이 함수는 DB를 쓰지 않는다.
 * 실패에는 사유 코드와 위치만 담는다. 요청 값은 담지 않는다(RQ-027).
 */
import {
  canonicalizeFingerprintInput,
  type PolicyValue,
  type QueueFingerprinter,
} from "../crypto/index.js";
import { DEFAULT_PRIORITY, type Priority } from "../queue/index.js";
import {
  validateMailRequest,
  type MailRequestLimits,
  type ValidatedMailRequest,
  type ValidationErrorItem,
} from "../validation/index.js";
import { openJws, type IatPolicy, type JwsKey } from "./jws.js";
import type { JweDecryptor } from "./jwe.js";
import type { OpenRequestFailure } from "./reasons.js";
import { parseRequestSchema, toErrorItem } from "./request-schema.js";

export type OpenRequestInput =
  | { kind: "file"; bytes: Uint8Array }
  | { kind: "rest"; body: unknown };

export interface SignaturePolicy {
  /** 호출처 레지스트리의 `signature.mode`. 기본값이 없다(ADR-0004 결정 9). */
  mode: "required" | "none";
  /** 호출처의 HS256 키(교체 중에는 2개까지). `mode`가 `none`이면 쓰지 않는다. */
  keys: readonly JwsKey[];
}

/** 서명을 쓰지 않는 정책. REST가 쓴다. */
export const NO_SIGNATURE: SignaturePolicy = { mode: "none", keys: [] };

/** 호출처와 무관한 공용 의존성. 앱이 기동 때 한 번 만든다. */
export interface OpenRequestDeps {
  limits: MailRequestLimits;
  decryptor: JweDecryptor;
  fingerprinter: QueueFingerprinter;
  iat: IatPolicy;
  /** 요청 `ttlSeconds`의 상한(`MAILO_JOB_EXPIRY_MAX_SECONDS`, RQ-039). 하한은 `MIN_TTL_SECONDS`로 고정이다. */
  maxTtlSeconds: number;
  /** 현재 시각(ms). 테스트가 고정한다. */
  nowMs?: () => number;
}

export interface OpenRequestContext extends OpenRequestDeps {
  /** 요청 호출처. REST는 인증된 `caller_id`, 파일 채널은 폴더 이름이다. */
  callerId: string;
  signature: SignaturePolicy;
}

export interface OpenRequestSuccess {
  ok: true;
  /** 복호화·검증을 마친 평문 요청. */
  request: ValidatedMailRequest;
  /** 파일 채널의 `idempotencyKey`. REST는 null이고 호출자가 헤더에서 받는다. */
  idempotencyKey: string | null;
  /** 요청한 우선순위(RQ-033). 생략하면 `NORMAL`이다. 지문에 들어 있다. */
  priority: Priority;
  /** 요청한 만료 TTL 초(RQ-039). 생략하면 null이고 등록이 기본 만료 TTL을 쓴다. 지정했으면 지문에 들어 있다. */
  ttlSeconds: number | null;
  fingerprint: {
    /** 정규화한 평문 요청. `queue.register`의 `canonicalRequest`로 그대로 넘긴다. 평문을 포함하므로 로그에 남기지 않는다. */
    canonicalRequest: string;
    /** 현재 지문 키로 계산한 HMAC-SHA256. 기존 Key와 비교할 때는 `register`가 저장된 키 버전으로 다시 계산한다. */
    digest: Uint8Array;
    keyVersion: number;
  };
  /** 서명을 검증했는가. */
  signed: boolean;
  /** JWE로 복호화했는가. */
  encrypted: boolean;
}

export type OpenRequestResult = OpenRequestSuccess | OpenRequestFailure;

const DECRYPTED_FIELDS = new Set(["subject", "text", "html", "attachments"]);
/** 복호화한 평문의 검증 이슈 위치. 요청에는 이 필드들이 없으므로 `content` 하나로 알린다. */
const CONTENT_FIELDS = new Set([
  "subject",
  "text",
  "html",
  "text|html",
  "content",
  "attachments",
]);

/**
 * 지문 `policy`에 넣을 요청별 정책 필드(ADR-0005 결정 3). 기본값인 필드는 키를 넣지 않아 도입 전 지문과 같다.
 * - `priority`(RQ-034): `NORMAL`(생략 포함)은 키가 없다. 그 밖의 등급은 등급 이름이다. DB 순위 숫자는 넣지 않는다.
 * - `ttlSeconds`(RQ-039, ADR-0010): 생략하면 키가 없다. 지정하면 요청 값(정수)이다.
 *   기본 만료 TTL과 같은 값을 명시해도 넣는다. 생략 요청의 만료는 운영 설정에 따라 바뀌므로 같은 요청으로 보지 않는다.
 * 키 순서는 `canonicalizeFingerprintInput`이 이름 순으로 정렬한다.
 */
function requestPolicy(
  priority: Priority,
  ttlSeconds: number | null,
): Readonly<Record<string, PolicyValue>> {
  return {
    ...(priority !== DEFAULT_PRIORITY && { priority }),
    ...(ttlSeconds !== null && { ttlSeconds }),
  };
}

function decodeJson(bytes: Uint8Array): unknown {
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

function fail(
  reason: OpenRequestFailure["reason"],
  field?: string,
  issues?: readonly ValidationErrorItem[],
): OpenRequestFailure {
  return {
    ok: false,
    reason,
    ...(field !== undefined ? { field } : {}),
    ...(issues !== undefined ? { issues } : {}),
  };
}

export async function openRequest(
  input: OpenRequestInput,
  ctx: OpenRequestContext,
): Promise<OpenRequestResult> {
  const nowMs = (ctx.nowMs ?? Date.now)();
  let payload: unknown;
  let signed = false;

  // 1~2. JWS 구조 파싱과 서명 검증
  if (input.kind === "rest") {
    payload = input.body;
  } else {
    let top: unknown;
    try {
      top = decodeJson(input.bytes);
    } catch {
      return fail("MALFORMED", "");
    }
    if (ctx.signature.mode === "required") {
      const opened = await openJws(top, {
        callerId: ctx.callerId,
        keys: ctx.signature.keys,
        iat: ctx.iat,
        nowMs,
      });
      if (!opened.ok) return opened;
      try {
        payload = decodeJson(opened.payload);
      } catch {
        return fail("MALFORMED", "/payload");
      }
      signed = true;
    } else {
      payload = top;
    }
  }

  // 3. payload 파싱 뒤 스키마 검증
  const schema = parseRequestSchema(
    payload,
    ctx.limits,
    input.kind === "rest" ? "rest" : "file",
    { maxSeconds: ctx.maxTtlSeconds },
  );
  if (!schema.ok) return fail(schema.reason, undefined, schema.errors);

  // 4~5. 복호화와 복호화한 제목·본문 검증
  let request = schema.outer;
  const encrypted = schema.content !== null;
  if (schema.content !== null) {
    const decrypted = await ctx.decryptor.decrypt(schema.content, ctx.callerId);
    if (!decrypted.ok) return fail(decrypted.reason, "/content");
    const checked = checkDecrypted(decrypted.plaintext, schema.outer, ctx);
    if (!checked.ok) return checked;
    request = checked.request;
  }

  // 6. 지문 계산
  const canonicalRequest = canonicalizeFingerprintInput({
    ...request,
    policy: requestPolicy(schema.priority, schema.ttlSeconds),
  });
  const { digest, keyVersion } =
    ctx.fingerprinter.fingerprint(canonicalRequest);
  return {
    ok: true,
    request,
    idempotencyKey: schema.idempotencyKey,
    priority: schema.priority,
    ttlSeconds: schema.ttlSeconds,
    fingerprint: { canonicalRequest, digest, keyVersion },
    signed,
    encrypted,
  };
}

/** 복호화한 평문(`{subject, text, html}`)을 수신자·발신자와 합쳐 RQ-030 규칙으로 검증한다. */
function checkDecrypted(
  plaintext: Uint8Array,
  outer: ValidatedMailRequest,
  ctx: OpenRequestContext,
): { ok: true; request: ValidatedMailRequest } | OpenRequestFailure {
  const invalid = (code: ValidationErrorItem["code"]): OpenRequestFailure =>
    fail("VALIDATION_FAILED", "/content", [{ pointer: "/content", code }]);

  let parsed: unknown;
  try {
    parsed = decodeJson(plaintext);
  } catch {
    return invalid("INVALID_FORMAT");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    return invalid("INVALID_FORMAT");
  const fields = parsed as Record<string, unknown>;
  if (Object.keys(fields).some((name) => !DECRYPTED_FIELDS.has(name)))
    return invalid("UNKNOWN_FIELD");

  const merged: Record<string, unknown> = {
    from: outer.from,
    replyTo: outer.replyTo,
    to: outer.to,
    cc: outer.cc,
    bcc: outer.bcc,
    subject: fields["subject"],
    text: fields["text"],
    html: fields["html"],
  };
  if (Object.hasOwn(fields, "attachments"))
    merged["attachments"] = fields["attachments"];

  const checked = validateMailRequest(merged, ctx.limits, {
    fromOptional: true,
  });
  if (checked.ok) return { ok: true, request: checked.value };

  const seen = new Set<string>();
  const issues: ValidationErrorItem[] = [];
  for (const issue of checked.issues) {
    const item = toErrorItem(issue);
    const located = CONTENT_FIELDS.has(issue.field)
      ? { ...item, pointer: "/content" }
      : item;
    const id = `${located.pointer}|${located.code}`;
    if (seen.has(id)) continue;
    seen.add(id);
    issues.push(located);
  }
  const attachments = checked.issues.some(
    (i) => i.code === "ATTACHMENTS_NOT_SUPPORTED",
  );
  return fail(
    attachments ? "ATTACHMENTS_NOT_SUPPORTED" : "VALIDATION_FAILED",
    "/content",
    issues,
  );
}
