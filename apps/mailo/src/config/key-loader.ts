/**
 * 버전별 키 로딩(ADR-0008 결정 5·6, ADR-0005 결정 3). DB 본문 키와 지문 키가 같은 규칙을 쓴다.
 *
 * 변수 이름 규칙(접두어는 `MAILO_DB_ENCRYPTION_KEY` 또는 `MAILO_FINGERPRINT_KEY`)
 * - `<접두어>_VERSION`: 새로 쓰는 현재 버전. 기본 1.
 * - `<접두어>_V<n>_FILE`: 버전 n의 키가 든 파일 경로(시크릿 마운트). 환경 변수보다 우선한다.
 * - `<접두어>_V<n>`: 버전 n의 키 값(환경 변수). 시크릿 파일이 없을 때 쓴다.
 * 이전 버전 키는 그 버전 행이 모두 삭제될 때까지 남겨 둔다. 이전 버전 변수를 지우지 않는다.
 *
 * 키 형식: 32바이트를 base64(표준 또는 URL-safe) 또는 64자 hex로 쓴다. 생성 예: `openssl rand -base64 32`.
 */
import { timingSafeEqual } from "node:crypto";
import type { KeyRingInput } from "../crypto/index.js";
import type { EnvReader } from "./env-reader.js";

const KEY_BYTES = 32;
const MAX_VERSION = 2_147_483_647;
const HEX_KEY = /^[0-9a-fA-F]{64}$/;
const BASE64_KEY = /^[A-Za-z0-9+/_-]{43}={0,1}$/;

// 저장소에 공개된 샘플 키(.env.example, docker-compose.volume-example.yml, scripts/container/common.sh). production에서는 거부한다.
// 값은 base64 문자열이 아니라 원문 32바이트다. base64·hex 어느 표기로 들어와도 같은 바이트로 비교한다.
const PUBLIC_SAMPLE_KEYS: readonly Buffer[] = [
  Buffer.from("fake-db-key-for-dev-only-0000000", "utf8"),
  Buffer.from("fake-fingerprint-key-dev-only-00", "utf8"),
];

/**
 * 공개된 샘플 키이거나 같은 바이트가 반복된 키인지 본다. 반복 바이트 키(`Buffer.alloc(32, n)`)는 테스트 픽스처가 쓰는 형태다.
 * 검사 대상 문자열을 오류 메시지에 넣지 않으므로 호출하는 쪽도 변수 이름만 적는다.
 */
function isPublicOrWeakKey(key: Buffer): boolean {
  if (key.every((byte) => byte === key[0])) return true;
  return PUBLIC_SAMPLE_KEYS.some(
    (sample) => sample.length === key.length && timingSafeEqual(sample, key),
  );
}

/** 32바이트 키 텍스트(base64·URL-safe base64·64자 hex)를 바이트로 바꾼다. 형식이 틀리면 undefined다. */
export function decodeKey(text: string): Buffer | undefined {
  const trimmed = text.trim();
  if (HEX_KEY.test(trimmed)) return Buffer.from(trimmed, "hex");
  // 32바이트의 base64는 패딩 포함 44자, 패딩 없이 43자다.
  if (!BASE64_KEY.test(trimmed)) return undefined;
  const key = Buffer.from(trimmed, "base64");
  return key.length === KEY_BYTES ? key : undefined;
}

export function loadKeyRing(
  reader: EnvReader,
  prefix: string,
): KeyRingInput | undefined {
  const currentVersion = reader.int(`${prefix}_VERSION`, 1, {
    min: 1,
    max: MAX_VERSION,
  });
  const pattern = new RegExp(`^${prefix}_V(\\d+)(_FILE)?$`);
  const versions = new Set<number>();
  for (const name of Object.keys(reader.env)) {
    const match = pattern.exec(name);
    if (!match || reader.raw(name) === undefined) continue;
    const digits = match[1]!;
    // `_V01`은 `_V1`과 다른 변수라 읽히지 않고 조용히 무시된다. 오타를 알리려고 거부한다.
    if (digits.length > 1 && digits.startsWith("0")) {
      reader.issue(
        `${name}의 버전 번호에 앞자리 0을 쓸 수 없다(${prefix}_V1처럼 쓴다)`,
      );
      continue;
    }
    versions.add(Number(digits));
  }
  // NODE_ENV가 development·test로 명시되지 않으면 production과 같이 검사한다(fail closed).
  const production = reader.strictEnv();

  const keys = new Map<number, Buffer>();
  for (const version of [...versions].sort((a, b) => a - b)) {
    const name = `${prefix}_V${version}`;
    if (version < 1 || version > MAX_VERSION) {
      reader.issue(`${name}의 버전은 1 이상 ${MAX_VERSION} 이하여야 한다`);
      continue;
    }
    const text = reader.secret(name);
    if (text === undefined) continue; // 파일 읽기 실패는 reader가 이미 기록했다.
    const key = decodeKey(text);
    if (key === undefined) {
      reader.issue(`${name}은 32바이트 키(base64 또는 64자 hex)여야 한다`);
      continue;
    }
    // 값은 오류에 싣지 않는다. 변수 이름과 사유만 적는다.
    if (production && isPublicOrWeakKey(key)) {
      reader.issue(
        `${name}은 저장소에 공개된 샘플 키이거나 같은 바이트가 반복된 키라 production에서 쓸 수 없다(openssl rand -base64 32로 새로 만든다)`,
      );
      continue;
    }
    keys.set(version, key);
  }

  if (!versions.has(currentVersion)) {
    reader.issue(
      `${prefix}_V${currentVersion} 또는 ${prefix}_V${currentVersion}_FILE이 필요하다(현재 버전 키)`,
    );
    return undefined;
  }
  if (!keys.has(currentVersion)) return undefined;
  return { currentVersion, keys };
}

/** 두 키링이 같은 키 바이트를 쓰면 안 된다(ADR-0008 결정 6: 지문 키와 DB 키 분리). */
export function assertDisjointKeyRings(
  reader: EnvReader,
  a: { label: string; ring: KeyRingInput },
  b: { label: string; ring: KeyRingInput },
): void {
  for (const keyA of a.ring.keys.values()) {
    for (const keyB of b.ring.keys.values()) {
      if (keyA.length === keyB.length && timingSafeEqual(keyA, keyB)) {
        reader.issue(
          `${a.label}와 ${b.label}가 같은 키를 쓴다. 두 키는 서로 달라야 한다`,
        );
        return;
      }
    }
  }
}
