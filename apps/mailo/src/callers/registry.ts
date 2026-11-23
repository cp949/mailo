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
 * `signature.mode`가 `none`이면 `keys`를 둘 수 없다. 서명 사용 여부를 한 곳에서만 정하기 위해서다.
 * `fileChannel`이 true인 호출처만 파일 채널 폴러가 `<root>/inbox/<id>/`를 수집한다(ADR-0004 결정 8). 기본은 false다.
 * `jwe`는 읽어 두기만 하고 해석하지 않는다.
 *
 * 오류 메시지에는 항목 위치와 고정 사유만 담는다. 해시와 키 값은 담지 않는다.
 */
import { readFileSync } from "node:fs";
import { EnvReader, Secret, decodeKey } from "../config/index.js";
import { verifyApiKeyAgainstAny } from "../crypto/index.js";

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
const SHA256_HEX = /^[0-9a-f]{64}$/;
const ENTRY_FIELDS = new Set([
  "id",
  "apiKeyHashes",
  "fileChannel",
  "signature",
  "jwe",
  "sendQuota24h",
]);
const SIGNATURE_FIELDS = new Set(["mode", "keys"]);
const SIGNATURE_KEY_FIELDS = new Set(["kid", "secretVar"]);
const KID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const SECRET_VAR = /^MAILO_JWS_SECRET_[A-Z0-9_]{1,80}$/;
const MAX_KEYS_PER_CALLER = 2;
const MAX_SEND_QUOTA = 10_000_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 파싱한 JSON을 검증해 레지스트리를 만든다. 문제를 모두 모아 `CallerRegistryError`로 던진다. */
export function parseCallerRegistry(
  json: unknown,
  options: { env?: NodeJS.ProcessEnv } = {},
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
      );
    }

    const jwe = raw["jwe"];
    if (jwe !== undefined && jwe !== null && !isRecord(jwe))
      issues.push(`${where}.jwe는 객체여야 한다`);

    // 생략·null은 무제한이다. 0은 허용하지 않는다(발송 중지는 호출처를 빼서 표현한다).
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

    if (typeof id === "string" && CALLER_ID.test(id)) {
      entries.push({
        id,
        apiKeyHashes: validHashes,
        fileChannel: fileChannel === true,
        signature: { mode, keys },
        jwe: isRecord(jwe) ? jwe : null,
        sendQuota24h: typeof sendQuota === "number" ? sendQuota : null,
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
  options: { env?: NodeJS.ProcessEnv } = {},
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
