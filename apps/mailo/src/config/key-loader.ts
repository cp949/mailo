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
  const pattern = new RegExp(`^${prefix}_V(\\d{1,10})(_FILE)?$`);
  const versions = new Set<number>();
  for (const name of Object.keys(reader.env)) {
    const match = pattern.exec(name);
    if (match && reader.raw(name) !== undefined) versions.add(Number(match[1]));
  }

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
