import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { inspect } from "node:util";
import {
  ConfigError,
  loadConfig,
  loadDatabaseUrlOnly,
  type WorkerOptions,
} from "../../src/config/index.js";
import { CANARY, testEnv } from "../support/rest-app.js";

const KEY_A = Buffer.alloc(32, 1).toString("base64");
const KEY_B = Buffer.alloc(32, 2).toString("base64");

function env(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return testEnv({ MAILO_CALLERS_FILE: "/etc/mailo/callers.json", ...extra });
}

function issuesOf(extra: NodeJS.ProcessEnv): string {
  try {
    loadConfig(env(extra));
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return (error as ConfigError).message;
  }
  throw new Error("설정 오류가 나야 한다");
}

describe("설정 로딩 (RQ-025, RQ-008, RQ-005)", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "mailo-config-"));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function secretFile(name: string, content: string): string {
    const file = path.join(dir, name);
    writeFileSync(file, content);
    return file;
  }

  it("선택 값이 없으면 요구사항의 기본값을 쓴다(재시도 8회·60초·배수 2·상한 1시간·jitter 20%, lease 120초)", () => {
    const config = loadConfig(env());

    expect(config.worker).toEqual({
      retry: {
        maxAttempts: 8,
        mode: "exponential",
        baseSeconds: 60,
        multiplier: 2,
        capSeconds: 3600,
        jitterRatio: 0.2,
      },
      breaker: {
        breakerKey: "default",
        failureThreshold: 3,
        initialWaitSeconds: {
          DAILY_LIMIT: 3600,
          RATE_LIMIT: 300,
          CONNECTION: 60,
          TLS: 60,
          AUTH: 60,
          OTHER: 60,
        },
        capFloorSeconds: 1800,
        immediateOpenReasons: ["DAILY_LIMIT", "RATE_LIMIT"],
        maxAccountTrips: 3,
      },
      lease: { seconds: 120 },
      pollMs: 1000,
      concurrency: 4,
      retention: {
        bodyGraceSeconds: 86_400,
        recordRetentionSeconds: 2_592_000,
        maintenanceIntervalMs: 60_000,
      },
    } satisfies WorkerOptions);
    expect(config.queue.jobExpirySeconds).toBe(86_400);
    expect(config.http.maxRequestBytes).toBe(2 * 1024 * 1024);
    expect(config.limits).toMatchObject({
      maxRecipients: 50,
      maxSubjectChars: 255,
      maxAddressChars: 254,
      maxContentBytes: 1024 * 1024,
    });
    expect(config.smtp).toMatchObject({
      host: "smtp.example.invalid",
      port: 587,
      security: "starttls",
      timeoutSeconds: 30,
    });
  });

  it("MAILO_SMTP_SECURITY=tls이면 포트 기본값이 465가 되고 명시한 포트를 우선한다(RQ-005)", () => {
    expect(loadConfig(env({ MAILO_SMTP_SECURITY: "tls" })).smtp).toMatchObject({
      port: 465,
      security: "tls",
    });
    expect(
      loadConfig(env({ MAILO_SMTP_SECURITY: "tls", MAILO_SMTP_PORT: "2465" }))
        .smtp.port,
    ).toBe(2465);
    expect(issuesOf({ MAILO_SMTP_SECURITY: "plain" })).toContain(
      "MAILO_SMTP_SECURITY",
    );
  });

  it("값 변경이 반영된다", () => {
    const config = loadConfig(
      env({
        MAILO_RETRY_MODE: "fixed",
        MAILO_RETRY_MAX_ATTEMPTS: "3",
        MAILO_LEASE_SECONDS: "300",
        MAILO_PORT: "8080",
      }),
    );

    expect(config.worker.retry).toMatchObject({
      mode: "fixed",
      maxAttempts: 3,
    });
    expect(config.worker.lease.seconds).toBe(300);
    expect(config.port).toBe(8080);
  });

  it("compose가 넘기는 빈 문자열은 설정하지 않은 값으로 본다", () => {
    const config = loadConfig(
      env({ MAILO_SMTP_PORT: "", MAILO_RETRY_MODE: "", MAILO_SMTP_FROM: "" }),
    );

    expect(config.smtp.port).toBe(587);
    expect(config.worker.retry.mode).toBe("exponential");
  });

  it("문제를 한 번에 모두 보고하고 변수 이름으로 가리킨다", () => {
    const message = issuesOf({
      MAILO_PORT: "70000",
      MAILO_RETRY_MAX_ATTEMPTS: "0",
      MAILO_RETRY_JITTER_RATIO: "1",
      MAILO_SMTP_HOST: "",
    });

    for (const name of [
      "MAILO_PORT",
      "MAILO_RETRY_MAX_ATTEMPTS",
      "MAILO_RETRY_JITTER_RATIO",
      "MAILO_SMTP_HOST",
    ]) {
      expect(message).toContain(name);
    }
  });

  it("오류에 시크릿 값이 들어가지 않는다(DB URL, 키, SMTP 비밀번호, 정수 파라미터 값)", () => {
    const message = issuesOf({
      MAILO_DATABASE_URL: `postgres-not-a-url ${CANARY.smtpPassword}-url`,
      MAILO_DB_ENCRYPTION_KEY_V1: `${CANARY.smtpPassword}-key`,
      MAILO_FINGERPRINT_KEY_V1: `${CANARY.smtpPassword}-fp`,
      MAILO_SMTP_USER: "",
      MAILO_SMTP_PASSWORD: CANARY.smtpPassword,
      MAILO_PORT: `${CANARY.smtpPassword}-port`,
    });

    expect(message).not.toContain(CANARY.smtpPassword);
    expect(message).toContain("MAILO_DATABASE_URL");
    expect(message).toContain("MAILO_DB_ENCRYPTION_KEY_V1");
    expect(message).toContain("MAILO_SMTP_USER");
  });

  it("DB URL의 비밀번호가 올바른 URL이어도 설정 객체 직렬화·inspect에 나오지 않는다", () => {
    const config = loadConfig(
      env({
        MAILO_DATABASE_URL: `postgres://u:${CANARY.smtpPassword}@db:5432/mailo`,
      }),
    );

    expect(JSON.stringify(config)).not.toContain(CANARY.smtpPassword);
    expect(inspect(config, { depth: 10 })).not.toContain(CANARY.smtpPassword);
    expect(config.database.url.reveal()).toContain(CANARY.smtpPassword);
  });

  it("SMTP 사용자와 비밀번호는 함께 설정하거나 함께 비워야 하고, 인증 없는 릴레이는 MAILO_SMTP_FROM이 필요하다", () => {
    expect(issuesOf({ MAILO_SMTP_PASSWORD: "" })).toContain(
      "MAILO_SMTP_USER와 MAILO_SMTP_PASSWORD",
    );
    expect(
      issuesOf({ MAILO_SMTP_USER: "", MAILO_SMTP_PASSWORD: "" }),
    ).toContain("MAILO_SMTP_FROM");
    const relay = loadConfig(
      env({
        MAILO_SMTP_USER: "",
        MAILO_SMTP_PASSWORD: "",
        MAILO_SMTP_FROM: "no-reply@example.com",
      }),
    );
    expect(relay.smtp.auth).toBeNull();
    expect(relay.smtp.defaultFrom).toBe("no-reply@example.com");
  });

  it("SMTP 타임아웃이 lease 이상이면 거부한다(전송 중 lease 만료로 중복 발송 방지)", () => {
    expect(issuesOf({ MAILO_SMTP_TIMEOUT_SECONDS: "120" })).toContain(
      "MAILO_SMTP_TIMEOUT_SECONDS",
    );
  });

  it("보존 기간 순서를 지킨다(본문 유예 <= 작업·이벤트 보존, ADR-0005 결정 7)", () => {
    expect(
      issuesOf({
        MAILO_BODY_RETENTION_SECONDS: "999999999",
        MAILO_RECORD_RETENTION_SECONDS: "100",
      }),
    ).toContain("MAILO_RECORD_RETENTION_SECONDS");
  });

  describe("봉투 설정 (ADR-0008 결정 4, RQ-024)", () => {
    it("기본값은 서명 허용 기간 7일, 허용 오차 5분이고 개인키 파일은 없다", () => {
      const config = loadConfig(env());

      expect(config.envelope).toEqual({
        keysFile: null,
        iat: { maxAgeSeconds: 604_800, skewSeconds: 300 },
      });
    });

    it("서명 허용 기간 + 허용 오차가 Key 보존 기간 이하이면 받고(경계 포함) 넘으면 기동을 거부한다", () => {
      const retention = 1_000_000;
      const ok = loadConfig(
        env({
          MAILO_RECORD_RETENTION_SECONDS: String(retention),
          MAILO_JWS_IAT_MAX_AGE_SECONDS: String(retention - 300),
        }),
      );
      const message = issuesOf({
        MAILO_RECORD_RETENTION_SECONDS: String(retention),
        MAILO_JWS_IAT_MAX_AGE_SECONDS: String(retention - 299),
      });

      expect(ok.envelope.iat.maxAgeSeconds).toBe(retention - 300);
      expect(message).toContain("MAILO_JWS_IAT_MAX_AGE_SECONDS");
      expect(message).toContain("MAILO_RECORD_RETENTION_SECONDS");
    });

    it("허용 오차를 키우면 같은 허용 기간이 거부된다", () => {
      expect(
        issuesOf({
          MAILO_RECORD_RETENTION_SECONDS: "1000000",
          MAILO_JWS_IAT_MAX_AGE_SECONDS: "999000",
          MAILO_JWS_IAT_SKEW_SECONDS: "3600",
        }),
      ).toContain("MAILO_JWS_IAT_SKEW_SECONDS");
    });

    it("기본 허용 기간(7일)보다 짧은 Key 보존 기간은 허용 기간을 함께 줄이지 않으면 거부한다", () => {
      expect(issuesOf({ MAILO_RECORD_RETENTION_SECONDS: "86400" })).toContain(
        "MAILO_JWS_IAT_MAX_AGE_SECONDS",
      );
    });

    it("개인키 목록 파일 경로를 받는다", () => {
      const config = loadConfig(
        env({ MAILO_ENVELOPE_KEYS_FILE: "/etc/mailo/envelope-keys.json" }),
      );

      expect(config.envelope.keysFile).toBe("/etc/mailo/envelope-keys.json");
    });
  });

  describe("파일 채널 설정 (ADR-0004 결정 3·4·5, RQ-002)", () => {
    it("기본은 꺼져 있고 폴링 30초, 파일 상한은 요청 상한(2 MiB), 임시 파일 1시간, 배치 100이다", () => {
      const config = loadConfig(env());

      expect(config.fileChannel).toEqual({
        root: null,
        pollIntervalMs: 30_000,
        maxFileBytes: 2 * 1024 * 1024,
        tempFileMaxAgeSeconds: 3600,
        batchPerCaller: 100,
      });
    });

    it("root와 수치를 환경 변수로 받는다", () => {
      const config = loadConfig(
        env({
          MAILO_FILE_CHANNEL_ROOT: "/srv/mailo-files",
          MAILO_FILE_POLL_INTERVAL_MS: "5000",
          MAILO_FILE_MAX_BYTES: "4096",
          MAILO_FILE_TEMP_MAX_AGE_SECONDS: "600",
          MAILO_FILE_BATCH_PER_CALLER: "7",
        }),
      );

      expect(config.fileChannel).toEqual({
        root: "/srv/mailo-files",
        pollIntervalMs: 5000,
        maxFileBytes: 4096,
        tempFileMaxAgeSeconds: 600,
        batchPerCaller: 7,
      });
    });

    it("파일 상한의 기본값은 MAILO_MAX_REQUEST_BYTES를 따른다", () => {
      expect(
        loadConfig(env({ MAILO_MAX_REQUEST_BYTES: "3145728" })).fileChannel
          .maxFileBytes,
      ).toBe(3_145_728);
    });

    it("상대 경로 root와 범위를 벗어난 수치는 변수 이름과 함께 거부한다", () => {
      const message = issuesOf({
        MAILO_FILE_CHANNEL_ROOT: "relative/dir",
        MAILO_FILE_POLL_INTERVAL_MS: "1",
        MAILO_FILE_BATCH_PER_CALLER: "0",
      });

      expect(message).toContain("MAILO_FILE_CHANNEL_ROOT");
      expect(message).toContain("MAILO_FILE_POLL_INTERVAL_MS");
      expect(message).toContain("MAILO_FILE_BATCH_PER_CALLER");
    });
  });

  describe("키링 (ADR-0008 결정 5·6, ADR-0005 결정 3)", () => {
    it("시크릿 파일이 환경 변수보다 우선하고 파일 끝 개행은 제거한다", () => {
      const file = secretFile("db-key-v1", `${KEY_B}\n`);

      const config = loadConfig(
        env({
          MAILO_DB_ENCRYPTION_KEY_V1: KEY_A,
          MAILO_DB_ENCRYPTION_KEY_V1_FILE: file,
        }),
      );

      const ring = config.keys.dbEncryption.reveal();
      expect(ring.keys.get(1)).toEqual(Buffer.from(KEY_B, "base64"));
    });

    it("hex 64자와 URL-safe base64도 받는다", () => {
      const hex = Buffer.alloc(32, 9).toString("hex");
      const url = Buffer.alloc(32, 250).toString("base64url");

      const config = loadConfig(
        env({ MAILO_DB_ENCRYPTION_KEY_V1: hex, MAILO_FINGERPRINT_KEY_V1: url }),
      );

      expect(config.keys.dbEncryption.reveal().keys.get(1)).toEqual(
        Buffer.alloc(32, 9),
      );
      expect(config.keys.fingerprint.reveal().keys.get(1)).toEqual(
        Buffer.alloc(32, 250),
      );
    });

    it("현재 버전과 이전 버전 키를 함께 읽는다(키 교체 뒤에도 이전 행 복호화)", () => {
      const config = loadConfig(
        env({
          MAILO_DB_ENCRYPTION_KEY_VERSION: "2",
          MAILO_DB_ENCRYPTION_KEY_V1: KEY_A,
          MAILO_DB_ENCRYPTION_KEY_V2: Buffer.alloc(32, 3).toString("base64"),
        }),
      );

      const ring = config.keys.dbEncryption.reveal();
      expect(ring.currentVersion).toBe(2);
      expect([...ring.keys.keys()].sort()).toEqual([1, 2]);
    });

    it("현재 버전 키가 없으면 거부한다", () => {
      const message = issuesOf({ MAILO_FINGERPRINT_KEY_VERSION: "3" });

      expect(message).toContain("MAILO_FINGERPRINT_KEY_V3");
    });

    it("32바이트가 아닌 키와 읽을 수 없는 파일을 거부한다. 오류에는 값 대신 이름과 사유 코드만 있다", () => {
      const message = issuesOf({
        MAILO_DB_ENCRYPTION_KEY_V1: Buffer.alloc(16, 1).toString("base64"),
        MAILO_FINGERPRINT_KEY_V1_FILE: path.join(dir, "없는-파일"),
      });

      expect(message).toContain("MAILO_DB_ENCRYPTION_KEY_V1은 32바이트");
      expect(message).toContain(
        "MAILO_FINGERPRINT_KEY_V1_FILE이 가리키는 파일을 읽지 못했다(ENOENT)",
      );
    });

    it("DB 본문 키와 지문 키가 같은 키 바이트를 쓰면 거부한다(키 분리)", () => {
      expect(
        issuesOf({
          MAILO_DB_ENCRYPTION_KEY_V1: KEY_A,
          MAILO_FINGERPRINT_KEY_V1: KEY_A,
        }),
      ).toContain("같은 키");
    });
  });

  it(".env.example의 활성 변수가 그대로 loadConfig를 통과하고 가짜 키 두 개는 서로 다르다", () => {
    const text = readFileSync(
      fileURLToPath(new URL("../../../../.env.example", import.meta.url)),
      "utf8",
    );
    const parsed: NodeJS.ProcessEnv = {};
    for (const line of text.split("\n")) {
      const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
      if (match) parsed[match[1]!] = match[2]!;
    }

    const config = loadConfig(parsed);

    expect(config.callersFile).toBe("./callers.json");
    expect(config.smtp.security).toBe("starttls");
    expect(config.worker.lease.seconds).toBe(120);
  });

  it("MAILO_DB_* 분리 변수로 접속 URL을 조립하고 비밀번호의 예약 문자를 인코딩한다", () => {
    const password = "p@ss/w:rd#1%2?x y";
    const url = loadDatabaseUrlOnly({
      MAILO_DB_HOST: "postgres",
      MAILO_DB_USER: "mailo",
      MAILO_DB_PASSWORD: password,
      MAILO_DB_NAME: "mailo",
    }).reveal();
    const parsed = new URL(url);

    expect(parsed.hostname).toBe("postgres");
    expect(parsed.port).toBe("5432");
    expect(parsed.pathname).toBe("/mailo");
    expect(decodeURIComponent(parsed.username)).toBe("mailo");
    expect(decodeURIComponent(parsed.password)).toBe(password);
  });

  it("분리 변수 조립은 MAILO_DB_PORT를 따르고 비밀번호는 _FILE로도 받는다", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mailo-dbpw-"));
    try {
      const file = path.join(dir, "pw");
      writeFileSync(file, "a/b@c\n");
      const parsed = new URL(
        loadDatabaseUrlOnly({
          MAILO_DB_HOST: "db.internal",
          MAILO_DB_PORT: "6543",
          MAILO_DB_USER: "u",
          MAILO_DB_PASSWORD_FILE: file,
          MAILO_DB_NAME: "n",
        }).reveal(),
      );
      expect(parsed.port).toBe("6543");
      expect(decodeURIComponent(parsed.password)).toBe("a/b@c");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("분리 변수에서 사용자·DB 이름이 없거나 URL과 함께 주면 변수 이름으로 거부한다(값은 싣지 않는다)", () => {
    expect(() => loadDatabaseUrlOnly({ MAILO_DB_HOST: "postgres" })).toThrow(
      /MAILO_DB_USER[\s\S]*MAILO_DB_NAME/,
    );
    let message = "";
    try {
      loadDatabaseUrlOnly({
        MAILO_DATABASE_URL: `postgres://u:${CANARY.smtpPassword}@db/x`,
        MAILO_DB_HOST: "postgres",
        MAILO_DB_USER: "u",
        MAILO_DB_NAME: "n",
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("MAILO_DB_HOST");
    expect(message).not.toContain(CANARY.smtpPassword);
  });

  it("마이그레이션 CLI는 DB URL만 읽는다(SMTP·키 설정 없이 동작)", () => {
    expect(
      loadDatabaseUrlOnly({
        MAILO_DATABASE_URL: "postgres://u:p@db/x",
      }).reveal(),
    ).toBe("postgres://u:p@db/x");
    expect(() => loadDatabaseUrlOnly({})).toThrow("MAILO_DATABASE_URL");
  });
});
