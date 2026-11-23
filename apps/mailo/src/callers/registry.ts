/**
 * 호출처 레지스트리(RQ-028). JSON 파일에서 읽는다. 파일에는 API 키 평문이 아니라 SHA-256 해시(hex)만 둔다.
 *
 * 파일 형식
 * ```json
 * {
 *   "callers": [
 *     {
 *       "id": "billing",
 *       "apiKeyHashes": ["<sha256 hex>", "<교체용 두 번째 해시, 선택>"],
 *       "fileChannel": false,
 *       "signature": { "mode": "none" }
 *     }
 *   ]
 * }
 * ```
 * 선택 필드 `allowedFrom`: 이 호출처가 요청의 `from`으로 쓸 수 있는 발신 주소 목록(addr-spec, 생략하면 빈 목록).
 * 허용 집합은 `MAILO_SMTP_FROM`(또는 `MAILO_SMTP_USER`)의 기본 발신 주소에 이 목록을 더한 것이다.
 * 집합 밖의 `from`을 보낸 요청은 400 validation-failed(`FROM_NOT_ALLOWED`)다. `from`을 생략하면 기본 발신 주소를 쓴다. `replyTo`는 제한하지 않는다.
 * 선택 필드 `allowedRecipientDomains`: 이 호출처가 `to`·`cc`·`bcc`로 보낼 수 있는 수신 도메인 목록(1~50개, 생략하면 제한 없음, RQ-046).
 * 값은 소문자 ASCII(국제화 도메인은 A-label `xn--`)이고 `@` 뒤를 소문자로 바꿔 정확히 비교한다. 하위 도메인은 따로 적는다.
 * 대문자, U-label, 끝 점, `*`, 선행 점, 목록 안의 중복, 빈 배열, null은 기동을 거부한다. 모두 거부하려면 정지나 키 폐기를 쓴다.
 * 선택 필드 `sendQuota24h`: 호출처별 24시간 rolling 발송 할당(양의 정수, 생략하면 무제한, RQ-032).
 * 해시 만들기: `printf '%s' "$API_KEY" | sha256sum`. 키는 256비트 난수(`openssl rand -base64 32`)를 쓴다.
 *
 * 서명(ADR-0008 결정 2): `signature.mode`는 `required`|`none`이고 명시해야 기동한다(기본값 없음).
 * `required`이면 `signature.keys`에 HS256 키를 1~2개 둔다(교체 중 2개).
 * ```json
 * "signature": { "mode": "required", "keys": [{ "kid": "billing-2026-11", "secretVar": "MAILO_JWS_SECRET_BILLING_2026_11" }] }
 * ```
 * JWS 비밀키는 해시로 둘 수 없다. 서명을 검증하려면 원문이 필요하기 때문이다. 그래서 이 파일에는 키 값을 두지 않고
 * 변수 이름(`secretVar`)만 둔다. 값은 `<변수>_FILE`(시크릿 파일 마운트, 우선) 또는 `<변수>`(환경 변수)로 받는다.
 * 파일 권한은 마운트가 정한다(Mailo 계정만 읽도록 둔다). 이 파일은 비밀이 없어 검토·배포 대상으로 다뤄도 된다.
 * 키 형식은 32바이트의 base64 또는 64자 hex다(`openssl rand -base64 32`). 호출처마다 다른 키를 쓴다.
 * 같은 키 바이트가 다른 `kid`·호출처에 있으면 기동하지 않는다(어느 호출처의 서명인지 모호해진다). `options.otherKeys`로 받은
 * 다른 키링(DB 본문 키, 지문 키)과 같은 바이트여도 거부한다. 공개 샘플 키나 같은 바이트가 반복된 키는 production
 * (`NODE_ENV`가 development·test가 아닐 때)에서만 거부한다. DB 본문 키·지문 키와 같은 규칙이다.
 * `signature.mode`가 `none`이면 `keys`를 둘 수 없다. 서명 사용 여부를 한 곳에서만 정하기 위해서다.
 * `fileChannel`이 true인 호출처만 파일 채널 폴러가 `<root>/inbox/<id>/`를 수집한다(ADR-0004 결정 8). 기본은 false다.
 * `jwe`는 읽어 두기만 하고 해석하지 않는다.
 *
 * 오류 메시지에는 항목 위치와 고정 사유만 담는다. 해시와 키 값은 담지 않는다.
 */
import { readFileSync } from "node:fs";
import {
  EnvReader,
  Secret,
  decodeKey,
  isPublicOrWeakKey,
} from "../config/index.js";
import { verifyApiKeyAgainstAny } from "../crypto/index.js";
import {
  DEFAULT_MAIL_REQUEST_LIMITS,
  checkAddress,
  checkDomain,
} from "../validation/index.js";

/** 호출처의 JWS HS256 키. 값은 `Secret`으로 감싸 로그와 직렬화에 나오지 않게 한다. */
export interface CallerSignatureKey {
  kid: string;
  secret: Secret<Uint8Array>;
}

export interface CallerEntry {
  id: string;
  /** SHA-256 hex. 호출처당 1~2개(교체용, RQ-028). */
  apiKeyHashes: readonly string[];
  /** 파일 채널 폴더 사용 여부. true인 호출처만 폴러가 수집한다. */
  fileChannel: boolean;
  /** 서명 설정(ADR-0008 결정 2). `mode`는 명시해야 한다. `none`이면 `keys`는 비어 있다. */
  signature: { mode: "required" | "none"; keys: readonly CallerSignatureKey[] };
  /** JWE 설정(2단계). 1단계는 해석하지 않는다. */
  jwe: Record<string, unknown> | null;
  /**
   * 24시간 rolling 발송 할당(RQ-032, ADR-0007 결정 10). 양의 정수이고 null이면 무제한(기본)이다.
   * 단위는 메시지 시도 수이며 수신자 수로 가중하지 않는다. 할당을 넘기면 작업은 점유되지 않고 대기한다.
   */
  sendQuota24h: number | null;
  /** 요청의 `from`으로 쓸 수 있는 발신 주소(기본 발신 주소 외, 입력 표기 그대로). 비교는 대소문자를 무시한다. */
  allowedFrom: readonly string[];
  /**
   * 수신 도메인 허용 목록(RQ-046, ADR-0011 결정 8). 소문자 ASCII 도메인이다. null이면 수신자를 제한하지 않는다(기본).
   * 빈 배열은 만들 수 없다. 수신자의 `@` 뒤를 소문자로 바꿔 정확히 비교한다.
   */
  allowedRecipientDomains: readonly string[] | null;
}

export interface CallerRegistry {
  readonly callers: readonly CallerEntry[];
  /**
   * Bearer 키로 호출처를 찾는다. 모든 호출처의 모든 해시를 끝까지 비교해
   * 어느 호출처·어느 키에서 일치했는지 응답 시간으로 드러내지 않는다.
   * @returns 일치한 호출처 ID, 없으면 undefined
   */
  authenticate(presentedKey: string): string | undefined;
}

export class CallerRegistryError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(
      `호출처 레지스트리가 올바르지 않다:\n${issues.map((i) => `- ${i}`).join("\n")}`,
    );
    this.name = "CallerRegistryError";
  }
}

const CALLER_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** 호출처 ID 형식(레지스트리 `id`와 `/ops/pauses/callers/{callerId}`가 같은 규칙을 쓴다). */
export function isCallerId(value: string): boolean {
  return CALLER_ID.test(value);
}
const SHA256_HEX = /^[0-9a-f]{64}$/;
const ENTRY_FIELDS = new Set([
  "id",
  "apiKeyHashes",
  "fileChannel",
  "signature",
  "jwe",
  "sendQuota24h",
  "allowedFrom",
  "allowedRecipientDomains",
]);
const SIGNATURE_FIELDS = new Set(["mode", "keys"]);
const SIGNATURE_KEY_FIELDS = new Set(["kid", "secretVar"]);
const KID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const SECRET_VAR = /^MAILO_JWS_SECRET_[A-Z0-9_]{1,80}$/;
const MAX_KEYS_PER_CALLER = 2;
const MAX_SEND_QUOTA = 10_000_000;
const MAX_ALLOWED_FROM = 20;
const MAX_ALLOWED_RECIPIENT_DOMAINS = 50;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface RegistryOptions {
  env?: NodeJS.ProcessEnv;
  /** 서명 키와 겹치면 안 되는 다른 키링의 키 바이트. `label`은 오류 메시지에 쓴다. */
  otherKeys?: ReadonlyArray<{ label: string; keys: Iterable<Uint8Array> }>;
}

/** 파싱한 JSON을 검증해 레지스트리를 만든다. 문제를 모두 모아 `CallerRegistryError`로 던진다. */
export function parseCallerRegistry(
  json: unknown,
  options: RegistryOptions = {},
): CallerRegistry {
  const issues: string[] = [];
  // 서명 비밀키를 읽는 환경. 시크릿 파일 우선 규칙은 설정의 다른 시크릿과 같다.
  const secrets = new EnvReader(options.env ?? process.env);
  const entries: CallerEntry[] = [];

  if (
    !isRecord(json) ||
    !Array.isArray(json["callers"]) ||
    json["callers"].length === 0
  ) {
    throw new CallerRegistryError(["callers 배열이 하나 이상 필요하다"]);
  }
  for (const key of Object.keys(json)) {
    if (key !== "callers")
      issues.push(`알 수 없는 최상위 필드가 있다: ${safeName(key)}`);
  }

  const seenIds = new Set<string>();
  const seenHashes = new Set<string>();
  // 키 바이트(hex) -> 처음 쓴 위치. 호출처 사이·키 사이의 중복을 잡는다. 값은 오류에 싣지 않고 위치만 쓴다.
  const seenSecrets = new Map<string, string>();
  for (const other of options.otherKeys ?? [])
    for (const key of other.keys)
      seenSecrets.set(Buffer.from(key).toString("hex"), other.label);
  json["callers"].forEach((raw: unknown, index: number) => {
    const where = `callers[${index}]`;
    if (!isRecord(raw)) {
      issues.push(`${where}은 객체여야 한다`);
      return;
    }
    for (const key of Object.keys(raw)) {
      if (!ENTRY_FIELDS.has(key))
        issues.push(`${where}에 알 수 없는 필드가 있다: ${safeName(key)}`);
    }

    const id = raw["id"];
    if (typeof id !== "string" || !CALLER_ID.test(id)) {
      issues.push(
        `${where}.id는 영문·숫자·_·-로 이뤄진 1~64자여야 하고 영문·숫자로 시작해야 한다`,
      );
    } else if (seenIds.has(id)) {
      issues.push(`${where}.id가 다른 항목과 겹친다`);
    } else {
      seenIds.add(id);
    }

    const hashes = raw["apiKeyHashes"];
    const validHashes: string[] = [];
    if (
      !Array.isArray(hashes) ||
      hashes.length < 1 ||
      hashes.length > MAX_KEYS_PER_CALLER
    ) {
      issues.push(
        `${where}.apiKeyHashes는 해시 1~${MAX_KEYS_PER_CALLER}개의 배열이어야 한다`,
      );
    } else {
      for (const [i, hash] of hashes.entries()) {
        if (typeof hash !== "string" || !SHA256_HEX.test(hash)) {
          issues.push(
            `${where}.apiKeyHashes[${i}]는 소문자 hex SHA-256(64자)이어야 한다`,
          );
        } else if (seenHashes.has(hash)) {
          // 한 해시가 두 키로 쓰이면 어느 호출처인지 모호하다.
          issues.push(`${where}.apiKeyHashes[${i}]가 다른 키와 겹친다`);
        } else {
          seenHashes.add(hash);
          validHashes.push(hash);
        }
      }
    }

    const fileChannel = raw["fileChannel"] ?? false;
    if (typeof fileChannel !== "boolean")
      issues.push(`${where}.fileChannel은 boolean이어야 한다`);

    // 서명 사용 여부는 명시해야 한다. 기본값을 두지 않는다(RQ-028, ADR-0008 결정 2).
    const signature = raw["signature"];
    let mode: "required" | "none" = "none";
    let keys: CallerSignatureKey[] = [];
    if (
      !isRecord(signature) ||
      (signature["mode"] !== "required" && signature["mode"] !== "none")
    ) {
      issues.push(
        `${where}.signature.mode는 required 또는 none으로 명시해야 한다`,
      );
    } else {
      mode = signature["mode"];
      for (const key of Object.keys(signature)) {
        if (!SIGNATURE_FIELDS.has(key))
          issues.push(
            `${where}.signature에 알 수 없는 필드가 있다: ${safeName(key)}`,
          );
      }
      keys = parseSignatureKeys(
        signature["keys"],
        mode,
        where,
        issues,
        secrets,
        seenSecrets,
      );
    }

    const jwe = raw["jwe"];
    if (jwe !== undefined && jwe !== null && !isRecord(jwe))
      issues.push(`${where}.jwe는 객체여야 한다`);

    // 생략·null은 무제한이다. 0은 허용하지 않는다. 호출처만 멈추려면 `PUT /ops/pauses/callers/{callerId}`를 쓴다(ADR-0011 결정 3).
    // 레지스트리에서 호출처를 빼도 큐에 이미 있는 작업은 계속 발송된다(`claim`이 레지스트리를 읽지 않는다).
    const sendQuota = raw["sendQuota24h"] ?? null;
    if (
      sendQuota !== null &&
      (typeof sendQuota !== "number" ||
        !Number.isInteger(sendQuota) ||
        sendQuota < 1 ||
        sendQuota > MAX_SEND_QUOTA)
    ) {
      issues.push(
        `${where}.sendQuota24h는 1~${MAX_SEND_QUOTA}의 정수이거나 생략(무제한)이어야 한다`,
      );
    }

    const allowedFrom = parseAllowedFrom(raw["allowedFrom"], where, issues);
    const allowedRecipientDomains = parseAllowedRecipientDomains(
      raw["allowedRecipientDomains"],
      where,
      issues,
    );

    if (typeof id === "string" && CALLER_ID.test(id)) {
      entries.push({
        id,
        apiKeyHashes: validHashes,
        fileChannel: fileChannel === true,
        signature: { mode, keys },
        jwe: isRecord(jwe) ? jwe : null,
        sendQuota24h: typeof sendQuota === "number" ? sendQuota : null,
        allowedFrom,
        allowedRecipientDomains,
      });
    }
  });

  issues.push(...secrets.issues);
  if (issues.length > 0) throw new CallerRegistryError(issues);
  const frozen = entries.map((e) => Object.freeze(e));
  return {
    callers: frozen,
    authenticate(presentedKey) {
      let found: string | undefined;
      for (const entry of frozen) {
        if (verifyApiKeyAgainstAny(presentedKey, entry.apiKeyHashes))
          found = entry.id;
      }
      return found;
    },
  };
}

/** `allowedFrom`을 읽는다. 생략하면 빈 목록이다. 주소 형식은 요청의 `from`과 같은 규칙(`checkAddress`)이다. */
function parseAllowedFrom(
  raw: unknown,
  where: string,
  issues: string[],
): string[] {
  if (raw === undefined) return [];
  const at = `${where}.allowedFrom`;
  if (!Array.isArray(raw) || raw.length > MAX_ALLOWED_FROM) {
    issues.push(`${at}는 주소 0~${MAX_ALLOWED_FROM}개의 배열이어야 한다`);
    return [];
  }
  const addresses: string[] = [];
  raw.forEach((item: unknown, i: number) => {
    if (
      typeof item !== "string" ||
      checkAddress(item, DEFAULT_MAIL_REQUEST_LIMITS.maxAddressChars) !==
        undefined
    ) {
      issues.push(`${at}[${i}]는 addr-spec 주소 문자열이어야 한다`);
      return;
    }
    addresses.push(item);
  });
  return addresses;
}

/**
 * `allowedRecipientDomains`를 읽는다. 생략(undefined)하면 제한 없음(null)이다. null·빈 배열은 거부한다.
 * 형식은 접수 검증의 도메인 규칙(`checkDomain`)이고 소문자 ASCII만 받는다. 정규화하지 않고 거부해 오타를 바로 알게 한다.
 * 오류에는 항목 위치와 고정 사유만 싣고 값은 싣지 않는다(RQ-027).
 */
function parseAllowedRecipientDomains(
  raw: unknown,
  where: string,
  issues: string[],
): string[] | null {
  if (raw === undefined) return null;
  const at = `${where}.allowedRecipientDomains`;
  if (
    !Array.isArray(raw) ||
    raw.length < 1 ||
    raw.length > MAX_ALLOWED_RECIPIENT_DOMAINS
  ) {
    issues.push(
      `${at}는 도메인 1~${MAX_ALLOWED_RECIPIENT_DOMAINS}개의 배열이어야 한다(제한하지 않으려면 필드를 생략한다)`,
    );
    return null;
  }
  const domains: string[] = [];
  const seen = new Set<string>();
  let valid = true;
  raw.forEach((item: unknown, i: number) => {
    const reason = typeof item === "string" ? domainProblem(item) : "문자열";
    if (reason !== undefined) {
      issues.push(
        `${at}[${i}]는 소문자 ASCII 도메인이어야 한다(사유: ${reason})`,
      );
      valid = false;
    } else if (seen.has(item as string)) {
      issues.push(`${at}[${i}]가 같은 목록의 다른 항목과 중복이다(사유: 중복)`);
      valid = false;
    } else {
      seen.add(item as string);
      domains.push(item as string);
    }
  });
  return valid ? domains : null;
}

/** 도메인 값의 거부 사유. 문제가 없으면 undefined. 값이 아니라 사유 이름만 돌려준다. */
function domainProblem(domain: string): string | undefined {
  if (/[\u0080-\uFFFF]/.test(domain))
    return "비ASCII(U-label), A-label(xn--)로 적는다";
  if (domain !== domain.toLowerCase()) return "대문자";
  if (domain.endsWith(".")) return "끝 점";
  if (domain.startsWith(".")) return "선행 점";
  if (domain.includes("*")) return "와일드카드";
  return checkDomain(domain) === undefined ? undefined : "도메인 형식";
}

/**
 * `signature.keys`를 읽는다. `required`는 1~2개가 필요하고 `none`은 비어 있어야 한다.
 * 비밀키 읽기 실패 사유는 변수 이름과 errno 코드만 `secrets.issues`에 쌓인다.
 */
function parseSignatureKeys(
  raw: unknown,
  mode: "required" | "none",
  where: string,
  issues: string[],
  secrets: EnvReader,
  seenSecrets: Map<string, string>,
): CallerSignatureKey[] {
  const at = `${where}.signature.keys`;
  if (mode === "none") {
    if (raw !== undefined)
      issues.push(`${at}는 signature.mode가 none이면 둘 수 없다`);
    return [];
  }
  if (
    !Array.isArray(raw) ||
    raw.length < 1 ||
    raw.length > MAX_KEYS_PER_CALLER
  ) {
    issues.push(`${at}는 키 1~${MAX_KEYS_PER_CALLER}개의 배열이어야 한다`);
    return [];
  }
  const keys: CallerSignatureKey[] = [];
  const kids = new Set<string>();
  raw.forEach((item: unknown, i: number) => {
    const here = `${at}[${i}]`;
    if (!isRecord(item)) {
      issues.push(`${here}은 객체여야 한다`);
      return;
    }
    for (const name of Object.keys(item)) {
      if (!SIGNATURE_KEY_FIELDS.has(name))
        issues.push(`${here}에 알 수 없는 필드가 있다: ${safeName(name)}`);
    }
    const kid = item["kid"];
    if (typeof kid !== "string" || !KID.test(kid)) {
      issues.push(
        `${here}.kid는 영문·숫자·._:-로 이뤄진 1~64자여야 하고 영문·숫자로 시작해야 한다`,
      );
      return;
    }
    if (kids.has(kid)) {
      issues.push(`${here}.kid가 같은 호출처의 다른 키와 겹친다`);
      return;
    }
    kids.add(kid);
    const variable = item["secretVar"];
    if (typeof variable !== "string" || !SECRET_VAR.test(variable)) {
      issues.push(
        `${here}.secretVar는 MAILO_JWS_SECRET_으로 시작하는 대문자 변수 이름이어야 한다`,
      );
      return;
    }
    const text = secrets.secret(variable);
    if (text === undefined) {
      if (
        secrets.raw(variable) === undefined &&
        secrets.raw(`${variable}_FILE`) === undefined
      )
        issues.push(`${variable} 또는 ${variable}_FILE이 필요하다(${here})`);
      return; // 파일 읽기 실패는 secrets가 이미 기록했다.
    }
    const key = decodeKey(text);
    if (key === undefined) {
      issues.push(`${variable}은 32바이트 키(base64 또는 64자 hex)여야 한다`);
      return;
    }
    if (secrets.strictEnv() && isPublicOrWeakKey(key)) {
      issues.push(
        `${variable}은 공개된 샘플 키이거나 같은 바이트가 반복된 키라 production에서 쓸 수 없다(${here}, openssl rand -base64 32로 새로 만든다)`,
      );
      return;
    }
    const fingerprint = key.toString("hex");
    const sameAs = seenSecrets.get(fingerprint);
    if (sameAs !== undefined) {
      issues.push(
        `${here}가 다른 서명 키 또는 키링과 같은 키를 쓴다(${sameAs})`,
      );
      return;
    }
    seenSecrets.set(fingerprint, here);
    keys.push({ kid, secret: new Secret<Uint8Array>(key) });
  });
  return keys;
}

/** 필드 이름을 오류에 쓸 때 영숫자·밑줄만 남기고 길이를 제한한다. 이름에 값이 섞이는 것을 막는다. */
function safeName(name: string): string {
  return /^[A-Za-z0-9_]{1,40}$/.test(name) ? name : "(이름 생략)";
}

/** 파일에서 읽어 레지스트리를 만든다. 읽기·파싱 실패 사유에는 errno 코드만 적는다. */
export function loadCallerRegistryFile(
  path: string,
  options: RegistryOptions = {},
): CallerRegistry {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "UNKNOWN";
    throw new CallerRegistryError([
      `MAILO_CALLERS_FILE을 읽지 못했다(${code})`,
    ]);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new CallerRegistryError([
      "MAILO_CALLERS_FILE이 올바른 JSON이 아니다",
    ]);
  }
  return parseCallerRegistry(json, options);
}
