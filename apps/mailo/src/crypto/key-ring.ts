/**
 * 버전별 키 조회. DB 본문 키(ADR-0008 결정 6)와 지문 키(ADR-0005 결정 3)가 각자 키링을 쓴다.
 * 두 키는 서로 분리해야 하므로 같은 키링 인스턴스를 공유하지 않는다.
 * 키 공급(시크릿 파일·환경 변수 읽기)은 config 모듈의 일이다. 여기서는 받은 바이트만 검증한다.
 */

/** AES-256 키와 HMAC-SHA256 지문 키 모두 32바이트로 고정한다. */
export const KEY_BYTES = 32;

/** PostgreSQL `integer` 상한. key_version 컬럼에 들어갈 수 있는 값이다(컬럼 타입은 추정). */
const MAX_VERSION = 2_147_483_647;

export class KeyRingError extends Error {
  constructor(
    readonly code:
      | "INVALID_VERSION"
      | "INVALID_KEY_LENGTH"
      | "CURRENT_VERSION_MISSING"
      | "EMPTY",
  ) {
    // 키 바이트와 길이를 메시지에 넣지 않는다.
    super(`invalid key ring (code=${code})`);
    this.name = "KeyRingError";
  }
}

export interface KeyRing {
  readonly currentVersion: number;
  /** 없는 버전이면 undefined. */
  getKey(version: number): Buffer | undefined;
}

export interface KeyRingInput {
  currentVersion: number;
  /** 버전 -> 32바이트 키. 이전 버전은 해당 버전 행이 모두 삭제될 때까지 남긴다. */
  keys: ReadonlyMap<number, Buffer>;
}

export function createKeyRing(input: KeyRingInput): KeyRing {
  if (input.keys.size === 0) throw new KeyRingError("EMPTY");
  const copy = new Map<number, Buffer>();
  for (const [version, key] of input.keys) {
    if (!Number.isInteger(version) || version < 1 || version > MAX_VERSION) {
      throw new KeyRingError("INVALID_VERSION");
    }
    if (key.length !== KEY_BYTES) throw new KeyRingError("INVALID_KEY_LENGTH");
    // 호출자가 원본 버퍼를 지워도 영향받지 않도록 복사한다.
    copy.set(version, Buffer.from(key));
  }
  if (!copy.has(input.currentVersion))
    throw new KeyRingError("CURRENT_VERSION_MISSING");
  return {
    currentVersion: input.currentVersion,
    getKey: (version) => copy.get(version),
  };
}
