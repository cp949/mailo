#!/usr/bin/env node
// 프로토콜 적합성 벡터 생성기(RQ-064·065, ADR-0014 결정 4).
// `docs/api/conformance/vectors.json`을 만든다. 호출처가 JWS·JWE 구현을 서버 없이 확인하는 골든 벡터다.
//
// 사용법
//   node scripts/gen-conformance-vectors.mjs [--out <파일>] [--new-keys]
//
// 규칙
// - 서버 코드(`src/`)를 import하지 않는다. 케이스 정의와 기대값을 이 파일이 코드로 갖는다.
//   기대값을 서버 출력에서 가져오면 서버 오류가 벡터에 굳는다. 서버가 틀리게 판정하면 단위 테스트가 실패해야 한다.
// - JWS는 node:crypto의 HMAC-SHA256으로 서명 입력을 직접 계산한다. JWE는 암호 형식을 직접 만들지 않고 `jose`로 만든다(RQ-029).
// - 기본은 기존 `vectors.json`의 JWE 키 쌍을 재사용한다. 키를 새로 만들려면 `--new-keys`를 준다(파일이 없을 때도 필요하다).
//   키를 새로 만들면 출력하는 공개키 SHA-256으로 `envelope/key-file.ts`의 `PUBLIC_SAMPLE_JWE_KEY_SPKI_SHA256`를 고친다.
//   고치지 않으면 단위 테스트(`conformance-vectors.spec.ts`)가 실패한다.
// - JWE는 `RSA-OAEP-256`의 무작위 요소 때문에 매번 암호문이 달라진다. 재생성하면 모든 JWE 케이스가 바뀐다.
//   케이스 정의를 바꿀 때만 재생성하고 리뷰는 `id`와 `expect`의 변화를 본다.
// - 이 파일의 키는 모두 이 저장소에서만 쓰는 공개 가짜 키다. 운영에 쓰지 않는다. 실제 키·SMTP 인증 정보·주소를 넣지 않는다(RQ-027).
import {
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
} from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { CompactEncrypt } from "jose";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const DEFAULT_OUT = path.join(REPO_ROOT, "docs/api/conformance/vectors.json");

const { values } = parseArgs({
  options: {
    out: { type: "string", default: DEFAULT_OUT },
    "new-keys": { type: "boolean", default: false },
  },
});
const out = path.resolve(values.out);

// ---------------------------------------------------------------------------
// 설정과 키
// ---------------------------------------------------------------------------

/** 서버 기본값(`MAILO_ENVELOPE_IAT_*`)과 같다. 값이 바뀌면 호출처 계약 변경이다. */
const SETTINGS = { iat: { maxAgeSeconds: 604_800, skewSeconds: 300 } };
/** 모든 케이스가 같은 시각을 쓴다. 2026-11-24T12:00:00Z. */
const NOW = Date.UTC(2026, 10, 24, 12, 0, 0) / 1000;

/**
 * 호출처 JWS 비밀키. 32바이트 ASCII 텍스트이고 서버의 `PUBLIC_SAMPLE_KEYS`에 같은 값이 있다.
 * 값을 바꾸면 `config/key-loader.ts`의 목록도 바꾼다.
 */
const JWS_KEYS = [
  {
    callerId: "alpha",
    kid: "alpha-1",
    secret: "conformance-jws-alpha-1-key-0000",
  },
  {
    callerId: "alpha",
    kid: "alpha-2",
    secret: "conformance-jws-alpha-2-key-0000",
  },
  {
    callerId: "beta",
    kid: "beta-1",
    secret: "conformance-jws-beta-1-key-00000",
  },
];
for (const key of JWS_KEYS) {
  if (Buffer.byteLength(key.secret, "utf8") !== 32)
    throw new Error("JWS 비밀키는 32바이트여야 한다");
}
const secretOf = (kid) => {
  const key = JWS_KEYS.find((k) => k.kid === kid);
  if (key === undefined) throw new Error(`알 수 없는 JWS kid: ${kid}`);
  return Buffer.from(key.secret, "utf8");
};

const JWE_KIDS = [
  { kid: "conformance-1", role: "previous" },
  { kid: "conformance-2", role: "current" },
];

function spkiSha256(publicKey) {
  return createHash("sha256")
    .update(publicKey.export({ type: "spki", format: "der" }))
    .digest("hex");
}

function loadJweKeys() {
  if (values["new-keys"]) {
    return JWE_KIDS.map(({ kid, role }) => {
      const pair = generateKeyPairSync("rsa", { modulusLength: 3072 });
      return {
        kid,
        role,
        privateKeyPem: pair.privateKey
          .export({ type: "pkcs8", format: "pem" })
          .toString(),
        publicKeyPem: pair.publicKey
          .export({ type: "spki", format: "pem" })
          .toString(),
      };
    });
  }
  if (!existsSync(out)) {
    console.error(
      `${out}이 없다. 처음 만들 때는 --new-keys로 JWE 키 쌍을 새로 만든다`,
    );
    process.exit(1);
  }
  const existing = JSON.parse(readFileSync(out, "utf8"));
  return JWE_KIDS.map(({ kid, role }) => {
    const found = existing.keys.jwe.find((k) => k.kid === kid);
    if (found === undefined)
      throw new Error(`기존 벡터에 ${kid} 키가 없다. --new-keys를 쓴다`);
    return {
      kid,
      role,
      privateKeyPem: found.privateKeyPem,
      publicKeyPem: found.publicKeyPem,
    };
  });
}

const jweKeys = loadJweKeys();
const publicKeyOf = (kid) =>
  createPublicKey(jweKeys.find((k) => k.kid === kid).publicKeyPem);
for (const key of jweKeys) {
  // 개인키와 공개키가 짝인지 확인한다.
  const derived = spkiSha256(
    createPublicKey(createPrivateKey(key.privateKeyPem)),
  );
  if (derived !== spkiSha256(createPublicKey(key.publicKeyPem)))
    throw new Error(`${key.kid}: 개인키와 공개키가 짝이 아니다`);
}

// ---------------------------------------------------------------------------
// 메일 요청 고정값(예약 도메인 example.com만 쓴다)
// ---------------------------------------------------------------------------

const FROM = "sender@example.com";
const RECIPIENT = "recipient@example.com";
const SUBJECT = "[적합성 벡터] 주문 접수 안내";
const TEXT = "주문이 접수되었습니다.";
const HTML = "<p>주문이 접수되었습니다.</p>";
const KEY = "outbox-0001";

/** 수락 케이스의 기대 평문. 쓰지 않은 필드는 null 또는 빈 배열이다. */
const plainRequest = (overrides = {}) => ({
  from: FROM,
  replyTo: null,
  to: [RECIPIENT],
  cc: [],
  bcc: [],
  subject: SUBJECT,
  text: TEXT,
  html: null,
  ...overrides,
});

// ---------------------------------------------------------------------------
// JWS(flattened, HS256)
// ---------------------------------------------------------------------------

const b64url = (value) => Buffer.from(value).toString("base64url");
const hmac = (digest, secret, input) =>
  createHmac(digest, secret).update(input).digest("base64url");

/**
 * 파일 하나를 서명한다.
 * - `header`: protected header를 덮어쓴다. 값이 null이면 그 필드를 뺀다.
 * - `signWith`: 서명에 쓸 키의 kid. null이면 서명을 비운다(alg none).
 * - `digest`: 서명 HMAC 해시. 기본 sha256이다.
 * - `tamper`: 서명 뒤에 payload를 바꾼다. 서명은 바뀌지 않는다.
 * - `top`: 최상위에 더할 필드.
 */
function signFile(payload, options = {}) {
  const { kid = "alpha-1", caller = "alpha", iat = NOW } = options;
  const header = { alg: "HS256", kid, caller, iat, ...options.header };
  for (const [name, value] of Object.entries(header))
    if (value === null) delete header[name];
  const signWith = options.signWith === undefined ? kid : options.signWith;

  const protectedB64 = b64url(JSON.stringify(header));
  const text = typeof payload === "string" ? payload : JSON.stringify(payload);
  const signedInput = `${protectedB64}.${b64url(text)}`;
  const signature =
    signWith === null
      ? ""
      : hmac(options.digest ?? "sha256", secretOf(signWith), signedInput);

  let payloadB64 = b64url(text);
  let hmacKid =
    signWith === null || options.digest !== undefined ? null : signWith;
  if (options.tamper !== undefined) {
    payloadB64 = b64url(options.tamper);
    hmacKid = null;
  }
  const signingInput = `${protectedB64}.${payloadB64}`;
  return {
    fileText: JSON.stringify({
      protected: protectedB64,
      payload: payloadB64,
      signature,
      ...options.top,
    }),
    jws: { signingInput, signature, hmacKid },
  };
}

// ---------------------------------------------------------------------------
// JWE(compact, RSA-OAEP-256 + A256GCM)
// ---------------------------------------------------------------------------

/**
 * JWE를 만든다. `jose`의 `CompactEncrypt`를 쓴다.
 * - `kid`: protected header의 kid. 암호화에 쓰는 공개키는 `encryptTo`(기본 `kid`)다.
 * - `header`: protected header를 덮어쓴다.
 */
async function encrypt(plaintext, options = {}) {
  const kid = options.kid ?? "conformance-2";
  const text =
    typeof plaintext === "string" ? plaintext : JSON.stringify(plaintext);
  return new CompactEncrypt(new TextEncoder().encode(text))
    .setProtectedHeader({
      alg: "RSA-OAEP-256",
      enc: "A256GCM",
      kid,
      caller: options.caller ?? "alpha",
      ...options.header,
    })
    .encrypt(publicKeyOf(options.encryptTo ?? kid));
}

const flip = (segment) => (segment[0] === "A" ? "B" : "A") + segment.slice(1);

function replaceSegment(compact, index, replace) {
  const parts = compact.split(".");
  parts[index] = replace(parts[index]);
  return parts.join(".");
}

/** JWE 콘텐츠 시나리오. 파일(서명 포함)과 REST가 같은 시나리오를 쓴다. */
const CONTENT = { subject: SUBJECT, text: TEXT };
const JWE_SCENARIOS = [
  {
    id: "accepted-current-kid",
    title: "현재 kid(conformance-2)로 암호화한 JWE를 복호화해 수락한다",
    build: () =>
      encrypt(
        { subject: SUBJECT, text: TEXT, html: HTML },
        { kid: "conformance-2" },
      ),
    request: plainRequest({ subject: SUBJECT, text: TEXT, html: HTML }),
  },
  {
    id: "accepted-previous-kid",
    title:
      "키 교체 중 이전 kid(conformance-1)로 암호화한 JWE도 복호화해 수락한다",
    build: () => encrypt(CONTENT, { kid: "conformance-1" }),
    request: plainRequest(),
  },
  {
    id: "kid-unknown",
    title:
      "알 수 없는 kid의 JWE는 KID_UNKNOWN이다(파일 호출처는 DECRYPTION_FAILED로 본다)",
    build: () =>
      encrypt(CONTENT, { kid: "conformance-9", encryptTo: "conformance-2" }),
    reason: "KID_UNKNOWN",
    file: "DECRYPTION_FAILED",
    rest: [{ pointer: "/content", code: "KID_UNKNOWN" }],
  },
  {
    id: "caller-mismatch",
    title:
      "JWE protected header의 caller가 요청 호출처와 다르면 CALLER_MISMATCH다",
    build: () => encrypt(CONTENT, { caller: "beta" }),
    reason: "CALLER_MISMATCH",
    file: "CALLER_MISMATCH",
    rest: [{ pointer: "/content", code: "CALLER_MISMATCH" }],
  },
  {
    id: "alg-mismatch",
    title: "키 암호화 alg가 RSA-OAEP-256이 아니면 복호화하지 않는다",
    build: () => encrypt(CONTENT, { header: { alg: "RSA-OAEP" } }),
    reason: "DECRYPTION_FAILED",
    file: "DECRYPTION_FAILED",
    rest: [{ pointer: "/content", code: "DECRYPTION_FAILED" }],
  },
  {
    id: "enc-mismatch",
    title: "콘텐츠 암호화 enc가 A256GCM이 아니면 복호화하지 않는다",
    build: () => encrypt(CONTENT, { header: { enc: "A128GCM" } }),
    reason: "DECRYPTION_FAILED",
    file: "DECRYPTION_FAILED",
    rest: [{ pointer: "/content", code: "DECRYPTION_FAILED" }],
  },
  {
    id: "wrong-key",
    title: "kid가 가리키는 키와 다른 공개키로 암호화하면 복호화에 실패한다",
    build: () =>
      encrypt(CONTENT, { kid: "conformance-1", encryptTo: "conformance-2" }),
    reason: "DECRYPTION_FAILED",
    file: "DECRYPTION_FAILED",
    rest: [{ pointer: "/content", code: "DECRYPTION_FAILED" }],
  },
  {
    id: "ciphertext-tampered",
    title: "암호문(네 번째 부분)을 바꾸면 복호화에 실패한다",
    build: async () => replaceSegment(await encrypt(CONTENT), 3, flip),
    reason: "DECRYPTION_FAILED",
    file: "DECRYPTION_FAILED",
    rest: [{ pointer: "/content", code: "DECRYPTION_FAILED" }],
  },
  {
    id: "header-tampered",
    title: "protected header를 바꾸면 인증 태그가 맞지 않아 복호화에 실패한다",
    build: async () =>
      replaceSegment(await encrypt(CONTENT), 0, (segment) => {
        const header = JSON.parse(
          Buffer.from(segment, "base64url").toString("utf8"),
        );
        header.caller = "beta";
        return b64url(JSON.stringify(header));
      }),
    reason: "DECRYPTION_FAILED",
    file: "DECRYPTION_FAILED",
    rest: [{ pointer: "/content", code: "DECRYPTION_FAILED" }],
  },
  {
    id: "content-not-json",
    title: "복호화한 평문이 JSON이 아니면 VALIDATION_FAILED다",
    build: () => encrypt("this is not json"),
    reason: "VALIDATION_FAILED",
    file: "VALIDATION_FAILED",
    rest: [{ pointer: "/content", code: "INVALID_FORMAT" }],
  },
  {
    id: "content-unknown-field",
    title:
      "복호화한 평문에 subject·text·html 밖의 필드가 있으면 VALIDATION_FAILED다",
    build: () => encrypt({ ...CONTENT, priority: "HIGH" }),
    reason: "VALIDATION_FAILED",
    file: "VALIDATION_FAILED",
    rest: [{ pointer: "/content", code: "UNKNOWN_FIELD" }],
  },
  {
    id: "content-subject-line-break",
    title: "복호화한 제목에 줄바꿈이 있으면 VALIDATION_FAILED다",
    build: () => encrypt({ subject: "첫 줄\n둘째 줄", text: TEXT }),
    reason: "VALIDATION_FAILED",
    file: "VALIDATION_FAILED",
    rest: [{ pointer: "/content", code: "CONTROL_CHARACTER" }],
  },
  {
    id: "content-attachments",
    title: "복호화한 평문에 attachments가 있으면 ATTACHMENTS_NOT_SUPPORTED다",
    build: () => encrypt({ ...CONTENT, attachments: [] }),
    reason: "ATTACHMENTS_NOT_SUPPORTED",
    file: "ATTACHMENTS_NOT_SUPPORTED",
    rest: [{ pointer: "/content", code: "ATTACHMENTS_NOT_SUPPORTED" }],
  },
  {
    id: "content-body-missing",
    title: "복호화한 평문에 text와 html이 모두 없으면 VALIDATION_FAILED다",
    build: () => encrypt({ subject: SUBJECT }),
    reason: "VALIDATION_FAILED",
    file: "VALIDATION_FAILED",
    rest: [{ pointer: "/content", code: "REQUIRED" }],
  },
];

// ---------------------------------------------------------------------------
// 케이스 조립
// ---------------------------------------------------------------------------

const cases = [];

function add(vector) {
  cases.push({
    id: vector.id,
    title: vector.title,
    channel: vector.channel,
    callerId: vector.callerId,
    signatureMode: vector.signatureMode,
    nowEpochSeconds: NOW,
    input: vector.input,
    ...(vector.jws === undefined ? {} : { jws: vector.jws }),
    expect: vector.expect,
  });
}

const accepted = (request, { signed, encrypted }) => ({
  accepted: true,
  request,
  signed,
  encrypted,
});

const rejectedFile = (internalReason, reasonCode) => ({
  accepted: false,
  reasonCode,
  internalReason,
});

const rejectedRest = (internalReason, errors) => ({
  accepted: false,
  errors,
  internalReason,
});

/** 서명이 필요한 호출처(alpha)의 파일 케이스. */
function jwsFile(id, title, payload, expectation, options) {
  const signed = signFile(payload, options);
  add({
    id: `file-jws-${id}`,
    title,
    channel: "file",
    callerId: "alpha",
    signatureMode: "required",
    input: { fileText: signed.fileText },
    jws: signed.jws,
    expect: expectation,
  });
}

/** 서명 없이 평문 JSON 그대로 받는 호출처(gamma)의 파일 케이스. */
function noneFile(id, title, fileText, expectation) {
  add({
    id: `file-none-${id}`,
    title,
    channel: "file",
    callerId: "gamma",
    signatureMode: "none",
    input: { fileText },
    expect: expectation,
  });
}

const fileRequest = (overrides = {}) => ({
  version: 1,
  idempotencyKey: KEY,
  from: FROM,
  to: [RECIPIENT],
  subject: SUBJECT,
  text: TEXT,
  ...overrides,
});

// --- 파일 + JWS: 수락 ---

jwsFile(
  "accepted-plain",
  "서명한 평문 파일을 수락한다(cc, bcc, replyTo, html 포함)",
  fileRequest({
    to: [RECIPIENT, "second@example.com"],
    cc: ["copy@example.com"],
    bcc: ["hidden@example.com"],
    replyTo: "reply@example.com",
    html: HTML,
  }),
  accepted(
    plainRequest({
      to: [RECIPIENT, "second@example.com"],
      cc: ["copy@example.com"],
      bcc: ["hidden@example.com"],
      replyTo: "reply@example.com",
      html: HTML,
    }),
    { signed: true, encrypted: false },
  ),
);
jwsFile(
  "accepted-rotated-kid",
  "교체 중인 호출처의 두 번째 kid(alpha-2)로 서명한 파일도 수락한다",
  fileRequest(),
  accepted(plainRequest(), { signed: true, encrypted: false }),
  { kid: "alpha-2" },
);
jwsFile(
  "accepted-iat-max-age",
  "iat가 허용 기간(604800초)과 정확히 같으면 수락한다",
  fileRequest(),
  accepted(plainRequest(), { signed: true, encrypted: false }),
  { iat: NOW - SETTINGS.iat.maxAgeSeconds },
);
jwsFile(
  "accepted-iat-skew",
  "iat가 허용 오차(300초)만큼 미래이면 수락한다",
  fileRequest(),
  accepted(plainRequest(), { signed: true, encrypted: false }),
  { iat: NOW + SETTINGS.iat.skewSeconds },
);

// --- 파일 + JWS: 구조·서명·iat·caller ---

add({
  id: "file-jws-malformed-not-json",
  title: "파일이 JSON이 아니면 MALFORMED다",
  channel: "file",
  callerId: "alpha",
  signatureMode: "required",
  input: { fileText: "this is not json" },
  expect: rejectedFile("MALFORMED", "MALFORMED"),
});
add({
  id: "file-jws-signature-required",
  title:
    "서명이 필요한 호출처가 서명 없는 평문 파일을 보내면 SIGNATURE_REQUIRED다(파일 호출처는 SIGNATURE_INVALID로 본다)",
  channel: "file",
  callerId: "alpha",
  signatureMode: "required",
  input: { fileText: JSON.stringify(fileRequest()) },
  expect: rejectedFile("SIGNATURE_REQUIRED", "SIGNATURE_INVALID"),
});
jwsFile(
  "top-level-extra-field",
  "JWS 최상위에 protected·payload·signature 밖의 필드가 있으면 MALFORMED다",
  fileRequest(),
  rejectedFile("MALFORMED", "MALFORMED"),
  { top: { header: { kid: "alpha-1" } } },
);
jwsFile(
  "protected-extra-field",
  "protected header에 alg·kid·caller·iat 밖의 필드가 있으면 서명이 맞아도 MALFORMED다",
  fileRequest(),
  rejectedFile("MALFORMED", "MALFORMED"),
  { header: { typ: "JWT" } },
);
jwsFile(
  "iat-string",
  "iat가 숫자가 아닌 문자열이면 MALFORMED다",
  fileRequest(),
  rejectedFile("MALFORMED", "MALFORMED"),
  { header: { iat: String(NOW) } },
);
jwsFile(
  "iat-missing",
  "iat가 없으면 MALFORMED다",
  fileRequest(),
  rejectedFile("MALFORMED", "MALFORMED"),
  { header: { iat: null } },
);
jwsFile(
  "payload-not-json",
  "서명은 맞지만 payload가 JSON이 아니면 MALFORMED다",
  "this is not json",
  rejectedFile("MALFORMED", "MALFORMED"),
);
{
  const signed = signFile(fileRequest());
  const top = JSON.parse(signed.fileText);
  top.signature = "!!!";
  add({
    id: "file-jws-signature-not-base64url",
    title: "signature가 base64url이 아니면 MALFORMED다",
    channel: "file",
    callerId: "alpha",
    signatureMode: "required",
    input: { fileText: JSON.stringify(top) },
    jws: {
      signingInput: signed.jws.signingInput,
      signature: "!!!",
      hmacKid: null,
    },
    expect: rejectedFile("MALFORMED", "MALFORMED"),
  });
}
jwsFile(
  "alg-none",
  "alg가 none이면 SIGNATURE_INVALID다",
  fileRequest(),
  rejectedFile("SIGNATURE_INVALID", "SIGNATURE_INVALID"),
  { header: { alg: "none" }, signWith: null },
);
jwsFile(
  "alg-hs512",
  "alg가 HS256이 아니면(HS512) 서명이 맞아도 SIGNATURE_INVALID다",
  fileRequest(),
  rejectedFile("SIGNATURE_INVALID", "SIGNATURE_INVALID"),
  { header: { alg: "HS512" }, digest: "sha512" },
);
jwsFile(
  "kid-unknown",
  "호출처에 없는 kid이면 SIGNATURE_INVALID다",
  fileRequest(),
  rejectedFile("SIGNATURE_INVALID", "SIGNATURE_INVALID"),
  { kid: "alpha-9", signWith: "alpha-1" },
);
jwsFile(
  "kid-other-caller",
  "다른 호출처(beta)의 kid와 키로 서명하면 SIGNATURE_INVALID다",
  fileRequest(),
  rejectedFile("SIGNATURE_INVALID", "SIGNATURE_INVALID"),
  { kid: "beta-1" },
);
jwsFile(
  "wrong-key",
  "kid는 alpha-1이지만 다른 키(beta-1)로 서명하면 SIGNATURE_INVALID다",
  fileRequest(),
  rejectedFile("SIGNATURE_INVALID", "SIGNATURE_INVALID"),
  { kid: "alpha-1", signWith: "beta-1" },
);
jwsFile(
  "payload-tampered",
  "서명한 뒤 payload를 바꾸면 SIGNATURE_INVALID다",
  fileRequest(),
  rejectedFile("SIGNATURE_INVALID", "SIGNATURE_INVALID"),
  { tamper: JSON.stringify(fileRequest({ subject: "바뀐 제목" })) },
);
jwsFile(
  "caller-mismatch",
  "서명이 맞아도 protected header의 caller가 폴더의 호출처와 다르면 CALLER_MISMATCH다",
  fileRequest(),
  rejectedFile("CALLER_MISMATCH", "CALLER_MISMATCH"),
  { caller: "beta" },
);
jwsFile(
  "iat-expired",
  "iat가 허용 기간보다 1초 오래되면 IAT_OUT_OF_RANGE다",
  fileRequest(),
  rejectedFile("IAT_OUT_OF_RANGE", "IAT_OUT_OF_RANGE"),
  { iat: NOW - SETTINGS.iat.maxAgeSeconds - 1 },
);
jwsFile(
  "iat-future",
  "iat가 허용 오차보다 1초 미래이면 IAT_OUT_OF_RANGE다",
  fileRequest(),
  rejectedFile("IAT_OUT_OF_RANGE", "IAT_OUT_OF_RANGE"),
  { iat: NOW + SETTINGS.iat.skewSeconds + 1 },
);

// --- 파일 + JWS: 요청 스키마 ---

jwsFile(
  "version-missing",
  "version이 없으면 VALIDATION_FAILED다",
  fileRequest({ version: undefined }),
  rejectedFile("VALIDATION_FAILED", "VALIDATION_FAILED"),
);
jwsFile(
  "version-unsupported",
  "version이 1이 아니면 VALIDATION_FAILED다",
  fileRequest({ version: 2 }),
  rejectedFile("VALIDATION_FAILED", "VALIDATION_FAILED"),
);
jwsFile(
  "idempotency-key-missing",
  "idempotencyKey가 없으면 IDEMPOTENCY_KEY_MISSING이다",
  fileRequest({ idempotencyKey: undefined }),
  rejectedFile("IDEMPOTENCY_KEY_MISSING", "IDEMPOTENCY_KEY_MISSING"),
);
jwsFile(
  "idempotency-key-invalid",
  "idempotencyKey에 허용하지 않는 문자(공백)가 있으면 IDEMPOTENCY_KEY_INVALID다",
  fileRequest({ idempotencyKey: "outbox 0001" }),
  rejectedFile("IDEMPOTENCY_KEY_INVALID", "IDEMPOTENCY_KEY_INVALID"),
);
jwsFile(
  "attachments",
  "attachments 필드가 있으면 ATTACHMENTS_NOT_SUPPORTED다",
  fileRequest({ attachments: [] }),
  rejectedFile("ATTACHMENTS_NOT_SUPPORTED", "ATTACHMENTS_NOT_SUPPORTED"),
);
jwsFile(
  "unknown-field",
  "정의되지 않은 필드가 있으면 VALIDATION_FAILED다",
  fileRequest({ extra: "x" }),
  rejectedFile("VALIDATION_FAILED", "VALIDATION_FAILED"),
);
jwsFile(
  "recipient-missing",
  "to가 빈 배열이면 VALIDATION_FAILED다",
  fileRequest({ to: [] }),
  rejectedFile("VALIDATION_FAILED", "VALIDATION_FAILED"),
);
jwsFile(
  "body-missing",
  "평문 모드에서 text와 html이 모두 없으면 VALIDATION_FAILED다",
  fileRequest({ text: undefined }),
  rejectedFile("VALIDATION_FAILED", "VALIDATION_FAILED"),
);

// --- 파일 + 서명 없음(gamma) ---

noneFile(
  "accepted-plain",
  "서명을 쓰지 않는 호출처는 파일 전체가 요청 JSON이고 수락한다",
  JSON.stringify(fileRequest()),
  accepted(plainRequest(), { signed: false, encrypted: false }),
);
// --- JWE: 파일(서명) / 파일(서명 없음) / REST ---

for (const scenario of JWE_SCENARIOS) {
  const content = await scenario.build();
  const isAccepted = scenario.request !== undefined;

  jwsFile(
    `jwe-${scenario.id}`,
    `서명한 파일: ${scenario.title}`,
    fileRequest({ subject: undefined, text: undefined, content }),
    isAccepted
      ? accepted(scenario.request, { signed: true, encrypted: true })
      : rejectedFile(scenario.reason, scenario.file),
  );

  const restContent = await scenario.build();
  add({
    id: `rest-jwe-${scenario.id}`,
    title: `REST: ${scenario.title}`,
    channel: "rest",
    callerId: "alpha",
    signatureMode: "none",
    input: { body: { from: FROM, to: [RECIPIENT], content: restContent } },
    expect: isAccepted
      ? accepted(scenario.request, { signed: false, encrypted: true })
      : rejectedRest(scenario.reason, scenario.rest),
  });
}

noneFile(
  "jwe-accepted",
  "서명을 쓰지 않는 호출처의 JWE 파일을 복호화해 수락한다",
  JSON.stringify(
    fileRequest({
      subject: undefined,
      text: undefined,
      content: await encrypt(
        { subject: SUBJECT, text: TEXT },
        { caller: "gamma" },
      ),
    }),
  ),
  accepted(plainRequest(), { signed: false, encrypted: true }),
);

// --- REST: 평문과 요청 스키마 ---

add({
  id: "rest-plain-accepted",
  title: "REST: 평문 본문을 수락한다",
  channel: "rest",
  callerId: "alpha",
  signatureMode: "none",
  input: {
    body: { from: FROM, to: [RECIPIENT], subject: SUBJECT, text: TEXT },
  },
  expect: accepted(plainRequest(), { signed: false, encrypted: false }),
});
add({
  id: "rest-plain-attachments",
  title: "REST: attachments 필드가 있으면 ATTACHMENTS_NOT_SUPPORTED다",
  channel: "rest",
  callerId: "alpha",
  signatureMode: "none",
  input: {
    body: {
      from: FROM,
      to: [RECIPIENT],
      subject: SUBJECT,
      text: TEXT,
      attachments: [],
    },
  },
  expect: rejectedRest("ATTACHMENTS_NOT_SUPPORTED", [
    { pointer: "/attachments", code: "ATTACHMENTS_NOT_SUPPORTED" },
  ]),
});
add({
  id: "rest-plain-file-only-field",
  title:
    "REST: 파일 채널 전용 필드(idempotencyKey)를 본문에 넣으면 정의되지 않은 필드라 VALIDATION_FAILED다(Key는 Idempotency-Key 헤더로 보낸다)",
  channel: "rest",
  callerId: "alpha",
  signatureMode: "none",
  input: {
    body: {
      idempotencyKey: KEY,
      from: FROM,
      to: [RECIPIENT],
      subject: SUBJECT,
      text: TEXT,
    },
  },
  expect: rejectedRest("VALIDATION_FAILED", [
    { pointer: "", code: "UNKNOWN_FIELD" },
  ]),
});
add({
  id: "rest-content-not-compact",
  title:
    "REST: content가 JWE compact 형식(점으로 구분한 다섯 부분)이 아니면 VALIDATION_FAILED다",
  channel: "rest",
  callerId: "alpha",
  signatureMode: "none",
  input: { body: { from: FROM, to: [RECIPIENT], content: "not-a-jwe" } },
  expect: rejectedRest("VALIDATION_FAILED", [
    { pointer: "/content", code: "INVALID_FORMAT" },
  ]),
});
add({
  id: "rest-content-and-plain-conflict",
  title:
    "REST: content와 평문 필드(subject·text·html)를 함께 보내면 VALIDATION_FAILED다",
  channel: "rest",
  callerId: "alpha",
  signatureMode: "none",
  input: {
    body: {
      from: FROM,
      to: [RECIPIENT],
      subject: SUBJECT,
      text: TEXT,
      content: await encrypt({ subject: SUBJECT, text: TEXT }),
    },
  },
  expect: rejectedRest("VALIDATION_FAILED", [
    { pointer: "/content", code: "CONFLICTING_FIELDS" },
  ]),
});

// ---------------------------------------------------------------------------
// 출력
// ---------------------------------------------------------------------------

const vectors = {
  schemaVersion: 1,
  description:
    "Mailo 프로토콜 적합성 벡터. 호출처가 JWS(HS256)·JWE(RSA-OAEP-256, A256GCM) 구현을 서버 없이 확인한다. 읽는 방법은 README.md에 있다.",
  notice:
    "이 파일의 키(keys)는 모두 이 저장소에서만 쓰는 공개 가짜 키다. 실제 운영 키가 아니다. 운영에 쓰지 않는다. Mailo는 NODE_ENV가 development·test가 아니면 이 키로 기동하지 않는다.",
  generator: "apps/mailo/scripts/gen-conformance-vectors.mjs",
  profile: {
    jws: { alg: "HS256" },
    jwe: { alg: "RSA-OAEP-256", enc: "A256GCM", rsaModulusBits: 3072 },
  },
  settings: SETTINGS,
  keys: {
    jwe: jweKeys,
    jws: JWS_KEYS.map(({ callerId, kid, secret }) => ({
      callerId,
      kid,
      secretBase64: Buffer.from(secret, "utf8").toString("base64"),
    })),
  },
  cases,
};

mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(vectors, null, 2)}\n`);

console.error(`${out}: 케이스 ${cases.length}개`);
for (const key of jweKeys) {
  console.error(
    `${key.kid} 공개키 SHA-256(SPKI DER): ${spkiSha256(createPublicKey(key.publicKeyPem))}`,
  );
}
console.error(
  "위 해시가 envelope/key-file.ts의 PUBLIC_SAMPLE_JWE_KEY_SPKI_SHA256와 같아야 한다",
);
