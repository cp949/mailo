/**
 * Idempotency-Key 내용 지문(ADR-0005 결정 3, RQ-011).
 * 지문 = HMAC-SHA256(지문 키, 정규화한 요청 평문). 지문 키는 본문 암호화 키와 분리한다.
 * 저장하는 값은 소문자 hex 문자열과 fingerprint_key_version이다.
 *
 * 정규화 규칙(코드로 고정. 규칙을 바꾸면 기존 지문과 달라지므로 FORMAT_TAG를 올린다)
 * - 출력은 고정 필드 순서의 JSON 문자열이다. 첫 필드는 형식 태그 "mailo-fp-v1"이다.
 *   필드 순서: v, from, replyTo, to, cc, bcc, subject, text, html, policy.
 * - 주소(from, replyTo, to, cc, bcc): 앞뒤 공백 제거, 도메인(마지막 `@` 뒤)만 소문자로 바꾼다.
 *   로컬 파트의 대소문자는 RFC 5321상 구분되므로 유지한다. 서로 다른 로컬 파트를 같은 요청으로
 *   판정하면 두 번째 메일이 사라지기 때문이다(보수적 선택). 표시 이름은 지원하지 않는다(검증이 거부한다).
 * - 수신자 목록(to, cc, bcc): 목록마다 중복을 제거하고 코드 유닛 순으로 정렬한다. 순서만 다른 재시도는
 *   같은 요청이다. 목록 사이의 중복(to와 cc에 같은 주소)은 합치지 않는다. 헤더에 보이는 결과가 다르다.
 *   빈 목록과 생략은 같다([]).
 * - from, replyTo: 없음(undefined)과 null은 같다(null).
 * - subject, text, html: 변환하지 않는다. 한 글자라도 다르면 다른 요청이다.
 *   text와 html은 undefined와 null이 같고(null), 빈 문자열("")은 null과 다르다.
 * - policy(요청별 정책 필드): 평탄한 맵. undefined 값은 버리고 키를 코드 유닛 순으로 정렬한다.
 *   값은 string, 유한한 number, boolean, null만 허용한다. 현재 정의된 정책 필드는 없다(메시지별 정책은
 *   미결정, RQ 미결정 항목). 필드가 추가되면 요청 스키마와 함께 이 맵에 넣어 지문 범위에서 빠지지 않게 한다.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { KeyRing } from "./key-ring.js";

const FORMAT_TAG = "mailo-fp-v1";

export type PolicyValue = string | number | boolean | null | undefined;

export interface FingerprintInput {
  /** 생략(undefined)과 null은 같다(null). `from`을 생략한 요청은 SMTP 발신 계정 기본값을 쓴다. */
  from?: string | null;
  replyTo?: string | null;
  to: readonly string[];
  cc?: readonly string[];
  bcc?: readonly string[];
  subject: string;
  text?: string | null;
  html?: string | null;
  policy?: Readonly<Record<string, PolicyValue>>;
}

export interface StoredFingerprint {
  /** 64자 소문자 hex. */
  fingerprint: string;
  keyVersion: number;
}

export type FingerprintErrorCode =
  | "UNKNOWN_KEY_VERSION"
  | "INVALID_POLICY_VALUE";

export class FingerprintError extends Error {
  constructor(readonly code: FingerprintErrorCode) {
    super(`fingerprint failed (code=${code})`);
    this.name = "FingerprintError";
  }
}

export interface Fingerprinter {
  /** 현재 키 버전으로 계산한다. 새 작업 등록에 쓴다. */
  compute(input: FingerprintInput): StoredFingerprint;
  /** 저장된 키 버전의 키로 다시 계산해 비교한다. 키를 교체한 뒤에도 정상 재시도를 같은 요청으로 판정한다. */
  matches(input: FingerprintInput, stored: StoredFingerprint): boolean;
}

function normalizeAddress(address: string): string {
  const trimmed = address.trim();
  const at = trimmed.lastIndexOf("@");
  if (at < 0) return trimmed;
  return trimmed.slice(0, at + 1) + trimmed.slice(at + 1).toLowerCase();
}

function normalizeList(list: readonly string[] | undefined): string[] {
  return [...new Set((list ?? []).map(normalizeAddress))].sort();
}

function normalizePolicy(
  policy: FingerprintInput["policy"],
): Array<[string, string | number | boolean | null]> {
  const entries: Array<[string, string | number | boolean | null]> = [];
  for (const key of Object.keys(policy ?? {}).sort()) {
    const value = policy![key];
    if (value === undefined) continue;
    if (typeof value === "number" && !Number.isFinite(value))
      throw new FingerprintError("INVALID_POLICY_VALUE");
    entries.push([key, value]);
  }
  return entries;
}

/** 지문 입력을 정규화한 문자열. 테스트와 문서화를 위해 공개한다. 이 문자열은 로그에 남기지 않는다. */
export function canonicalizeFingerprintInput(input: FingerprintInput): string {
  return JSON.stringify([
    FORMAT_TAG,
    input.from == null ? null : normalizeAddress(input.from),
    input.replyTo == null ? null : normalizeAddress(input.replyTo),
    normalizeList(input.to),
    normalizeList(input.cc),
    normalizeList(input.bcc),
    input.subject,
    input.text ?? null,
    input.html ?? null,
    normalizePolicy(input.policy),
  ]);
}

function hmacHex(key: Buffer, canonical: string): string {
  return createHmac("sha256", key).update(canonical, "utf8").digest("hex");
}

/**
 * 정규화한 문자열의 HMAC-SHA256 원시 값. 큐 모듈의 `register`가 정규화 문자열을 받으므로 이 형태가 필요하다.
 * `keyVersion`을 생략하면 현재 키를 쓴다. 키가 없으면 FingerprintError를 던진다.
 */
export function fingerprintCanonical(
  keyRing: KeyRing,
  canonical: string,
  keyVersion?: number,
): { digest: Buffer; keyVersion: number } {
  const version = keyVersion ?? keyRing.currentVersion;
  const key = keyRing.getKey(version);
  if (!key) throw new FingerprintError("UNKNOWN_KEY_VERSION");
  return {
    digest: createHmac("sha256", key).update(canonical, "utf8").digest(),
    keyVersion: version,
  };
}

export function createFingerprinter(keyRing: KeyRing): Fingerprinter {
  return {
    compute(input) {
      const key = keyRing.getKey(keyRing.currentVersion);
      if (!key) throw new FingerprintError("UNKNOWN_KEY_VERSION");
      return {
        fingerprint: hmacHex(key, canonicalizeFingerprintInput(input)),
        keyVersion: keyRing.currentVersion,
      };
    },
    matches(input, stored) {
      const key = keyRing.getKey(stored.keyVersion);
      // 키가 없을 때 false를 돌려주면 정상 재시도가 409가 된다. 설정 오류이므로 오류로 알린다.
      if (!key) throw new FingerprintError("UNKNOWN_KEY_VERSION");
      const expected = Buffer.from(
        hmacHex(key, canonicalizeFingerprintInput(input)),
        "utf8",
      );
      const actual = Buffer.from(stored.fingerprint, "utf8");
      return (
        expected.length === actual.length && timingSafeEqual(expected, actual)
      );
    },
  };
}
