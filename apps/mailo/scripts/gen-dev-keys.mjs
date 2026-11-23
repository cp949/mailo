#!/usr/bin/env node
// 개발·테스트 전용 키 생성기. 운영 키 발급·배포·교체 절차는 3단계 운영 문서에서 정한다(ADR-0008).
// Mailo JWE 키 쌍(RSA 3072)과 선택적으로 호출처 JWS 비밀키(32바이트)를 만든다.
//
// 사용법
//   node scripts/gen-dev-keys.mjs [--kid dev-1] [--out .dev-keys] [--jws-var MAILO_JWS_SECRET_DEV]
//
// 출력(--out 디렉터리, 개인키·비밀키 파일은 0600)
//   <kid>.private.pem    Mailo 개인키(PKCS#8). Mailo만 가진다.
//   <kid>.public.pem     공개키(SPKI). 호출처가 JWE 암호화에 쓴다.
//   envelope-keys.json   MAILO_ENVELOPE_KEYS_FILE이 가리키는 목록
//   jws-secret.txt       --jws-var를 줬을 때만. 호출처 JWS 비밀키(base64)
//   dev-keys.env         Mailo에 줄 환경 변수 예시(경로는 절대 경로)
// 생성한 파일은 저장소에 넣지 않는다(.gitignore가 .dev-keys/를 제외한다).
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

const KID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const JWS_VAR = /^MAILO_JWS_SECRET_[A-Z0-9_]{1,80}$/;

const { values } = parseArgs({
  options: {
    kid: { type: "string", default: "dev-1" },
    out: { type: "string", default: ".dev-keys" },
    "jws-var": { type: "string" },
  },
});

if (!KID.test(values.kid)) {
  console.error(
    "--kid는 영문·숫자·._:-로 이뤄진 1~64자이고 영문·숫자로 시작해야 한다",
  );
  process.exit(1);
}
const jwsVar = values["jws-var"];
if (jwsVar !== undefined && !JWS_VAR.test(jwsVar)) {
  console.error(
    "--jws-var는 MAILO_JWS_SECRET_으로 시작하는 대문자 변수 이름이어야 한다",
  );
  process.exit(1);
}

const out = path.resolve(values.out);
mkdirSync(out, { recursive: true, mode: 0o700 });

const { publicKey, privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 3072,
});
const keyVar = `MAILO_JWE_KEY_${values.kid.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
const privatePath = path.join(out, `${values.kid}.private.pem`);
const publicPath = path.join(out, `${values.kid}.public.pem`);
const keysPath = path.join(out, "envelope-keys.json");

function write(file, content, mode) {
  writeFileSync(file, content, { mode });
  chmodSync(file, mode); // 기존 파일이 있어도 권한을 맞춘다.
}

write(privatePath, privateKey.export({ type: "pkcs8", format: "pem" }), 0o600);
write(publicPath, publicKey.export({ type: "spki", format: "pem" }), 0o644);
write(
  keysPath,
  `${JSON.stringify({ keys: [{ kid: values.kid, privateKeyVar: keyVar }] }, null, 2)}\n`,
  0o644,
);

const env = [
  `MAILO_ENVELOPE_KEYS_FILE=${keysPath}`,
  `${keyVar}_FILE=${privatePath}`,
];
if (jwsVar !== undefined) {
  const secretPath = path.join(out, "jws-secret.txt");
  write(secretPath, `${randomBytes(32).toString("base64")}\n`, 0o600);
  env.push(`${jwsVar}_FILE=${secretPath}`);
}
write(path.join(out, "dev-keys.env"), `${env.join("\n")}\n`, 0o600);

console.log(`kid: ${values.kid}`);
console.log(`공개키(호출처에 배포): ${publicPath}`);
console.log(`Mailo 환경 변수: ${path.join(out, "dev-keys.env")}`);
if (jwsVar !== undefined)
  console.log(
    `호출처 signature.keys 항목 예: { "kid": "<kid>", "secretVar": "${jwsVar}" }`,
  );
