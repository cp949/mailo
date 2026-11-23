import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type pg from "pg";
import { parseCallerRegistry } from "../../src/callers/index.js";
import { loadConfig } from "../../src/config/index.js";
import {
  createBodyCipher,
  createKeyRing,
  createQueueBodyCipher,
  createQueueFingerprinter,
  hashApiKey,
} from "../../src/crypto/index.js";
import {
  createJweDecryptor,
  createPrivateKeyRing,
  type OpenRequestDeps,
} from "../../src/envelope/index.js";
import {
  createFilePoller,
  type FilePoller,
  type FilePollerDeps,
} from "../../src/file-channel/index.js";
import { createJsonLogger } from "../../src/worker/index.js";
import { b64url, jwsSecret, rsaKey, signJws } from "./envelope.js";
import { testEnv } from "./rest-app.js";

/** 파일 채널 테스트의 호출처. `signed`만 서명이 `required`이고 `restonly`는 폴더를 쓰지 않는다. */
export const JWS_ENV_VAR = "MAILO_JWS_SECRET_SIGNED";
export const SIGNED_SECRET = jwsSecret(61);
export const SIGNED_KID = "signed-1";
export const MAILO_JWE_KID = "mailo-file-1";

const MAIL = {
  to: ["kim@example.com"],
  from: "no-reply@example.com",
  subject: "주문 접수 안내",
  text: "주문이 접수되었습니다.",
};

/** 파일 채널 요청 JSON(서명 없는 평문). 필드로 덮어쓴다. */
export function fileRequest(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return { version: 1, idempotencyKey: "outbox-1", ...MAIL, ...overrides };
}

/** 서명 `required` 호출처의 파일 내용(flattened JWS JSON). */
export function signedFile(
  request: Record<string, unknown> | string,
  options: {
    caller?: string;
    secret?: Buffer;
    iat?: number;
    kid?: string;
  } = {},
): string {
  return JSON.stringify(
    signJws({
      secret: options.secret ?? SIGNED_SECRET,
      payload: request,
      kid: options.kid ?? SIGNED_KID,
      caller: options.caller ?? "signed",
      ...(options.iat !== undefined && { iat: options.iat }),
    }),
  );
}

export interface FileHarness {
  root: string;
  /** 호출처 입력 폴더. 없으면 만든다. */
  inbox(callerId: string): string;
  /** 호출처가 하는 일: 점(.) 임시 이름으로 쓴 뒤 같은 폴더에서 rename한다. */
  drop(callerId: string, fileName: string, content: string | Buffer): string;
  /** 일부러 임시 이름으로만 두고 rename하지 않는다. */
  dropTemp(callerId: string, fileName: string, content: string): string;
  makePoller(overrides?: Partial<FilePollerDeps>): FilePoller;
  /** 로그 줄(JSON 문자열). */
  logs: string[];
  config: ReturnType<typeof loadConfig>;
  cleanup(): void;
}

export function mkfifo(file: string): void {
  execFileSync("mkfifo", [file]);
}

/**
 * 실제 PostgreSQL 풀과 임시 디렉터리로 폴러를 조립한다. 앱 조립(app.module.ts)과 같은 부품을 쓴다.
 * 호출처: alpha·beta(서명 none, 폴더 사용), signed(서명 required, 폴더 사용), restonly(폴더 미사용).
 */
export function createFileHarness(
  pool: pg.Pool,
  options: {
    env?: NodeJS.ProcessEnv;
    config?: Partial<Parameters<typeof createFilePoller>[0]["config"]>;
  } = {},
): FileHarness {
  const root = mkdtempSync(path.join(tmpdir(), "mailo-file-"));
  const env = testEnv({
    MAILO_CALLERS_FILE: "/unused/callers.json",
    MAILO_FILE_CHANNEL_ROOT: root,
    [JWS_ENV_VAR]: SIGNED_SECRET.toString("base64"),
    ...options.env,
  });
  const config = loadConfig(env);
  const registry = parseCallerRegistry(
    {
      callers: [
        {
          id: "alpha",
          apiKeyHashes: [
            hashApiKey("alpha-fake-api-key-0000000000000000000000001"),
          ],
          fileChannel: true,
          signature: { mode: "none" },
        },
        {
          id: "beta",
          apiKeyHashes: [
            hashApiKey("beta-fake-api-key-00000000000000000000000001"),
          ],
          fileChannel: true,
          signature: { mode: "none" },
        },
        {
          id: "signed",
          apiKeyHashes: [
            hashApiKey("signed-fake-api-key-000000000000000000000001"),
          ],
          fileChannel: true,
          signature: {
            mode: "required",
            keys: [{ kid: SIGNED_KID, secretVar: JWS_ENV_VAR }],
          },
        },
        {
          id: "restonly",
          apiKeyHashes: [
            hashApiKey("restonly-fake-api-key-000000000000000000001"),
          ],
          fileChannel: false,
          signature: { mode: "none" },
        },
      ],
    },
    { env },
  );
  const fingerprinter = createQueueFingerprinter(
    createKeyRing(config.keys.fingerprint.reveal()),
  );
  const cipher = createQueueBodyCipher(
    createBodyCipher(createKeyRing(config.keys.dbEncryption.reveal())),
  );
  const envelope: OpenRequestDeps = {
    limits: config.limits,
    decryptor: createJweDecryptor(
      createPrivateKeyRing([
        {
          kid: MAILO_JWE_KID,
          privateKey: rsaKey(MAILO_JWE_KID).privateKey,
          retiredAt: null,
        },
      ]),
    ),
    fingerprinter,
    iat: config.envelope.iat,
  };
  const logs: string[] = [];
  const logger = createJsonLogger((line) => void logs.push(line));
  const fileChannel = { ...config.fileChannel, root, ...options.config };

  function inbox(callerId: string): string {
    const dir = path.join(root, "inbox", callerId);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  return {
    root,
    inbox,
    drop(callerId, fileName, content) {
      const dir = inbox(callerId);
      const tmp = path.join(dir, `.${fileName}.tmp`);
      writeFileSync(tmp, content);
      const target = path.join(dir, fileName);
      renameSync(tmp, target);
      return target;
    },
    dropTemp(callerId, fileName, content) {
      const file = path.join(inbox(callerId), fileName);
      writeFileSync(file, content);
      return file;
    },
    makePoller(overrides = {}) {
      return createFilePoller({
        pool,
        registry,
        envelope,
        cipher,
        fingerprinter,
        config: fileChannel,
        jobExpirySeconds: config.queue.jobExpirySeconds,
        logger,
        ...overrides,
      });
    },
    logs,
    config,
    cleanup() {
      // 권한 테스트가 남긴 읽기 전용 폴더도 지울 수 있게 되돌린다.
      for (const id of ["alpha", "beta", "signed", "restonly"]) {
        try {
          chmodSync(path.join(root, "inbox", id), 0o755);
        } catch {
          // 폴더가 없으면 건너뛴다.
        }
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
}

export { b64url };
