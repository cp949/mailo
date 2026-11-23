import { createHmac, generateKeyPairSync, type KeyObject } from "node:crypto";
import { CompactEncrypt } from "jose";

/** 테스트용 RSA 3072 키 쌍. 생성에 시간이 걸리므로 이름별로 한 번만 만든다. 실제 시크릿이 아니다. */
export interface TestRsaKey {
  kid: string;
  privateKey: KeyObject;
  publicKey: KeyObject;
  /** PKCS#8 PEM. 개인키 변수·파일에 넣는다. */
  privatePem: string;
}

const rsaCache = new Map<string, TestRsaKey>();

export function rsaKey(kid: string): TestRsaKey {
  let key = rsaCache.get(kid);
  if (key === undefined) {
    const pair = generateKeyPairSync("rsa", { modulusLength: 3072 });
    key = {
      kid,
      privateKey: pair.privateKey,
      publicKey: pair.publicKey,
      privatePem: pair.privateKey
        .export({ type: "pkcs8", format: "pem" })
        .toString(),
    };
    rsaCache.set(kid, key);
  }
  return key;
}

export interface EncryptOptions {
  /** 보호 헤더 `caller`. 기본 `alpha`. */
  caller?: string;
  /** 평문. 객체면 JSON으로 직렬화하고 문자열이면 그대로 암호화한다. */
  content: Record<string, unknown> | string;
  /** 보호 헤더를 덮어쓴다(잘못된 alg·enc 시험). */
  header?: Record<string, unknown>;
}

/** 호출처가 하는 일: Mailo 공개키로 JWE(compact)를 만든다. */
export async function encryptContent(
  key: TestRsaKey,
  options: EncryptOptions,
): Promise<string> {
  const text =
    typeof options.content === "string"
      ? options.content
      : JSON.stringify(options.content);
  return new CompactEncrypt(new TextEncoder().encode(text))
    .setProtectedHeader({
      alg: "RSA-OAEP-256",
      enc: "A256GCM",
      kid: key.kid,
      caller: options.caller ?? "alpha",
      ...options.header,
    })
    .encrypt(key.publicKey);
}

/** compact JWE의 각 부분을 바꾼 사본을 만든다. 변조 시험용이다. */
export function replaceJweSegment(
  compact: string,
  index: number,
  replace: (segment: string) => string,
): string {
  const parts = compact.split(".");
  parts[index] = replace(parts[index] as string);
  return parts.join(".");
}

export function b64url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

export function jwsSecret(fill: number): Buffer {
  return Buffer.alloc(32, fill);
}

export interface SignOptions {
  secret: Buffer;
  /** 서명 대상 요청 JSON. 문자열이면 그대로 payload 바이트로 쓴다. */
  payload: Record<string, unknown> | string;
  kid?: string;
  caller?: string;
  /** 초 단위. 기본은 `nowMs` 기준 현재다. */
  iat?: number;
  nowMs?: number;
  /** 보호 헤더를 덮어쓴다(`alg: "none"` 같은 공격 시험). 값을 null로 주면 그 필드를 뺀다. */
  header?: Record<string, unknown>;
}

const HMAC_ALGS: Record<string, string> = {
  HS256: "sha256",
  HS384: "sha384",
  HS512: "sha512",
};

/** 호출처가 하는 일: flattened JWS(HS256)를 만든다. jose와 독립으로 직접 서명해 교차 검증한다. */
export function signJws(options: SignOptions): {
  protected: string;
  payload: string;
  signature: string;
} {
  const nowMs = options.nowMs ?? Date.now();
  const header: Record<string, unknown> = {
    alg: "HS256",
    kid: options.kid ?? "alpha-1",
    caller: options.caller ?? "alpha",
    iat: options.iat ?? Math.floor(nowMs / 1000),
    ...options.header,
  };
  for (const [name, value] of Object.entries(header))
    if (value === null) delete header[name];

  const protectedB64 = b64url(JSON.stringify(header));
  const payloadB64 = b64url(
    typeof options.payload === "string"
      ? options.payload
      : JSON.stringify(options.payload),
  );
  const digest = HMAC_ALGS[String(header["alg"])];
  const signature =
    digest === undefined
      ? ""
      : createHmac(digest, options.secret)
          .update(`${protectedB64}.${payloadB64}`)
          .digest("base64url");
  return { protected: protectedB64, payload: payloadB64, signature };
}
