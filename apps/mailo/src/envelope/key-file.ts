/**
 * Mailo JWE 개인키 목록 파일 로딩(ADR-0008 결정 5). `MAILO_ENVELOPE_KEYS_FILE`이 가리키는 JSON이다.
 * JSON에는 개인키가 없다. 개인키 PEM은 `privateKeyVar`가 가리키는 변수로 받는다. 기존 시크릿 규칙과 같다.
 * `<변수>_FILE`(시크릿 파일 마운트)이 `<변수>`(환경 변수)보다 우선한다. PEM의 줄바꿈은 환경 변수에서 `\n` 두 글자로 써도 된다.
 *
 * ```json
 * {
 *   "keys": [
 *     { "kid": "mailo-2026-11", "privateKeyVar": "MAILO_JWE_KEY_2026_11" },
 *     { "kid": "mailo-2026-05", "privateKeyVar": "MAILO_JWE_KEY_2026_05", "retiredAt": "2026-11-01T00:00:00Z" }
 *   ],
 *   "removed": [
 *     { "kid": "mailo-2025-11", "retiredAt": "2026-01-01T00:00:00Z", "removedAt": "2026-02-15T00:00:00Z" }
 *   ]
 * }
 * ```
 *
 * 키 교체와 삭제 규칙
 * - 교체는 새 `kid` 항목을 추가하고 이전 항목에 `retiredAt`(교체 시각)을 적는 것이다. 이전 항목은 지우지 않는다.
 * - 이전 키는 `retiredAt`부터 Key 보존 기간(`MAILO_RECORD_RETENTION_SECONDS`) 이상 보관한다. 이전 `kid`로 암호화한 REST 요청이
 *   relay 재시도 기간 동안 사용처 outbox에 남을 수 있기 때문이다.
 * - 항목을 지울 때는 `removed`에 `{kid, retiredAt, removedAt}`을 남긴다. `removedAt - retiredAt`이 보존 기간보다 짧거나 `removedAt`이 현재 시각보다 미래이면 기동을 거부한다.
 *   `removed`를 적지 않고 항목만 지우는 것은 감지하지 못한다. 운영 절차(3단계 문서)가 막아야 한다.
 * - `retiredAt`이 없는 항목이 하나 이상 있어야 한다(호출처가 쓰는 현재 키).
 *
 * `NODE_ENV`가 `development`·`test`가 아니면 저장소에 공개된 샘플 키(적합성 벡터의 JWE 키)를 거부한다(ADR-0014 결정 3).
 *
 * 오류 메시지에는 항목 위치와 고정 사유만 담는다. kid·키 값·파일 내용은 담지 않는다(RQ-027).
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  type KeyObject,
} from "node:crypto";
import { readFileSync } from "node:fs";
import { ConfigError, EnvReader } from "../config/index.js";
import {
  KID_PATTERN,
  RSA_MODULUS_BITS,
  checkPrivateKey,
  type PrivateKeyEntry,
} from "./key-ring.js";

/**
 * 저장소에 공개된 JWE 개인키의 공개키(SPKI DER) SHA-256(소문자 hex)이다. `NODE_ENV`가 `development`·`test`가 아니면 이 키를 거부한다.
 * 대상은 적합성 벡터(`docs/api/conformance/vectors.json`)의 Mailo JWE 키 쌍 둘이다(RQ-065, ADR-0014 결정 3).
 * 개인키가 아니라 해시만 둔다. `kid` 이름으로는 거부하지 않는다. 운영자가 같은 이름으로 다른 키를 쓸 수 있어야 한다.
 * 벡터를 `gen-conformance-vectors.mjs --new-keys`로 다시 만들면 이 값도 고친다. 어긋나면 `conformance-vectors.spec.ts`가 실패한다.
 */
export const PUBLIC_SAMPLE_JWE_KEY_SPKI_SHA256: readonly string[] = [
  "b78b85767f5f0420c448d9cb976e4c1d95037effa733f017ab494bea5598f7be",
  "20b4fbe3e5af655353acc4626584f5718084180bec92f50831c653fef907bd57",
];

function isPublicSampleJweKey(privateKey: KeyObject): boolean {
  const hash = createHash("sha256")
    .update(createPublicKey(privateKey).export({ type: "spki", format: "der" }))
    .digest("hex");
  return PUBLIC_SAMPLE_JWE_KEY_SPKI_SHA256.includes(hash);
}

/** `privateKeyVar` 형식(ADR-0008 결정 5). `X_REF` 해석의 허용 목록이 이 정규식을 쓴다(ADR-0016 결정 2). */
export const JWE_KEY_VARIABLE = /^MAILO_JWE_KEY_[A-Z0-9_]{1,80}$/;
const INSTANT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;
const KEY_FIELDS = new Set(["kid", "privateKeyVar", "retiredAt"]);
const REMOVED_FIELDS = new Set(["kid", "retiredAt", "removedAt"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseInstant(value: unknown): Date | undefined {
  if (typeof value !== "string" || !INSTANT.test(value)) return undefined;
  const time = Date.parse(value);
  return Number.isNaN(time) ? undefined : new Date(time);
}

function safeName(name: string): string {
  return /^[A-Za-z0-9_]{1,40}$/.test(name) ? name : "(이름 생략)";
}

export interface LoadEnvelopeKeysOptions {
  env: NodeJS.ProcessEnv;
  /** Key 보존 기간(초). 이전 키의 최소 보관 기간이다. */
  retentionSeconds: number;
  /** 현재 시각. `removedAt`이 이보다 미래이면 거부한다. 기본은 호출 시점이다(테스트가 고정해 쓴다). */
  now?: Date;
}

/** 파싱한 JSON을 검증하고 개인키를 읽는다. 문제를 모두 모아 `ConfigError`로 던진다. */
export function parseEnvelopeKeys(
  json: unknown,
  options: LoadEnvelopeKeysOptions,
): PrivateKeyEntry[] {
  const reader = new EnvReader(options.env);
  // NODE_ENV가 development·test로 명시되지 않으면 production과 같이 검사한다(fail closed).
  const strict = reader.strictEnv();
  const entries: PrivateKeyEntry[] = [];
  const kids = new Set<string>();

  if (
    !isRecord(json) ||
    !Array.isArray(json["keys"]) ||
    json["keys"].length === 0
  ) {
    throw new ConfigError([
      "MAILO_ENVELOPE_KEYS_FILE: keys 배열이 하나 이상 필요하다",
    ]);
  }
  for (const name of Object.keys(json)) {
    if (name !== "keys" && name !== "removed")
      reader.issue(
        `envelope keys: 알 수 없는 최상위 필드가 있다: ${safeName(name)}`,
      );
  }

  json["keys"].forEach((raw: unknown, index: number) => {
    const where = `envelope keys[${index}]`;
    if (!isRecord(raw)) {
      reader.issue(`${where}은 객체여야 한다`);
      return;
    }
    for (const name of Object.keys(raw)) {
      if (!KEY_FIELDS.has(name))
        reader.issue(`${where}에 알 수 없는 필드가 있다: ${safeName(name)}`);
    }

    const kid = raw["kid"];
    let kidOk = false;
    if (typeof kid !== "string" || !KID_PATTERN.test(kid)) {
      reader.issue(
        `${where}.kid는 영문·숫자·._:-로 이뤄진 1~64자여야 하고 영문·숫자로 시작해야 한다`,
      );
    } else if (kids.has(kid)) {
      reader.issue(`${where}.kid가 다른 항목과 겹친다`);
    } else {
      kids.add(kid);
      kidOk = true;
    }

    let retiredAt: Date | null = null;
    if (raw["retiredAt"] !== undefined) {
      const parsed = parseInstant(raw["retiredAt"]);
      if (parsed === undefined)
        reader.issue(
          `${where}.retiredAt은 시간대가 있는 ISO 8601 시각이어야 한다`,
        );
      else retiredAt = parsed;
    }

    const variable = raw["privateKeyVar"];
    if (
      typeof variable !== "string" ||
      !JWE_KEY_VARIABLE.test(variable) ||
      variable.endsWith("_REF")
    ) {
      reader.issue(
        `${where}.privateKeyVar는 MAILO_JWE_KEY_로 시작하는 대문자 변수 이름이어야 하고 _REF로 끝날 수 없다`,
      );
      return;
    }
    const pem = reader.secret(variable);
    if (pem === undefined) {
      if (
        reader.raw(variable) === undefined &&
        reader.raw(`${variable}_FILE`) === undefined
      )
        reader.issue(`${variable} 또는 ${variable}_FILE이 필요하다(${where})`);
      return; // 파일 읽기 실패는 reader가 이미 기록했다.
    }
    let privateKey;
    try {
      privateKey = createPrivateKey(pem.replace(/\\n/g, "\n"));
    } catch {
      reader.issue(`${variable}은 PEM 형식의 RSA 개인키여야 한다`);
      return;
    }
    const problem = checkPrivateKey(privateKey);
    if (problem === "BAD_MODULUS")
      reader.issue(`${variable}은 RSA ${RSA_MODULUS_BITS}비트 키여야 한다`);
    else if (problem !== undefined)
      reader.issue(`${variable}은 RSA 개인키여야 한다`);
    else if (strict && isPublicSampleJweKey(privateKey))
      // 위치만 적는다. 변수 이름·kid·키 값은 담지 않는다(RQ-027).
      reader.issue(
        `${where}: 저장소에 공개된 샘플 JWE 키라 production에서 쓸 수 없다(openssl genpkey로 새 키 쌍을 만든다)`,
      );
    else if (kidOk) entries.push({ kid: kid as string, privateKey, retiredAt });
  });

  if (
    entries.length > 0 &&
    reader.issues.length === 0 &&
    !entries.some((e) => e.retiredAt === null)
  ) {
    reader.issue(
      "envelope keys: retiredAt이 없는 현재 키가 하나 이상 필요하다",
    );
  }

  checkRemoved(
    json["removed"],
    kids,
    options.retentionSeconds,
    options.now ?? new Date(),
    reader,
  );
  reader.finish();
  return entries;
}

/** 삭제한 키의 기록을 검증한다. 보존 기간이 지나기 전에 지운 키는 거부한다. */
function checkRemoved(
  removed: unknown,
  keptKids: ReadonlySet<string>,
  retentionSeconds: number,
  now: Date,
  reader: EnvReader,
): void {
  if (removed === undefined) return;
  if (!Array.isArray(removed)) {
    reader.issue("envelope keys: removed는 배열이어야 한다");
    return;
  }
  removed.forEach((raw: unknown, index: number) => {
    const where = `envelope removed[${index}]`;
    if (!isRecord(raw)) {
      reader.issue(`${where}은 객체여야 한다`);
      return;
    }
    for (const name of Object.keys(raw)) {
      if (!REMOVED_FIELDS.has(name))
        reader.issue(`${where}에 알 수 없는 필드가 있다: ${safeName(name)}`);
    }
    const kid = raw["kid"];
    if (typeof kid !== "string" || !KID_PATTERN.test(kid))
      reader.issue(`${where}.kid 형식이 올바르지 않다`);
    else if (keptKids.has(kid)) reader.issue(`${where}.kid가 keys에도 있다`);
    const retiredAt = parseInstant(raw["retiredAt"]);
    const removedAt = parseInstant(raw["removedAt"]);
    if (retiredAt === undefined || removedAt === undefined) {
      reader.issue(
        `${where}.retiredAt과 removedAt은 시간대가 있는 ISO 8601 시각이어야 한다`,
      );
    } else if (removedAt.getTime() > now.getTime()) {
      // 미래 시각이면 아직 삭제하지 않았거나 시각을 잘못 적은 것이다. 보존 기간 검사를 통과시키면 안 된다.
      reader.issue(`${where}.removedAt이 현재 시각보다 미래다`);
    } else if (
      removedAt.getTime() - retiredAt.getTime() <
      retentionSeconds * 1000
    ) {
      reader.issue(
        `${where}: 교체 시각부터 Key 보존 기간(MAILO_RECORD_RETENTION_SECONDS)이 지나기 전에는 이전 키를 삭제할 수 없다`,
      );
    }
  });
}

/** 파일에서 읽어 개인키 목록을 만든다. 읽기·파싱 실패 사유에는 errno 코드만 적는다. */
export function loadEnvelopeKeyFile(
  path: string,
  options: LoadEnvelopeKeysOptions,
): PrivateKeyEntry[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "UNKNOWN";
    throw new ConfigError([`MAILO_ENVELOPE_KEYS_FILE을 읽지 못했다(${code})`]);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new ConfigError(["MAILO_ENVELOPE_KEYS_FILE이 올바른 JSON이 아니다"]);
  }
  return parseEnvelopeKeys(json, options);
}
