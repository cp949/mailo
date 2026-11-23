/**
 * 환경 변수 전체를 읽어 검증한다(RQ-025). 잘못된 설정은 기동 시 `ConfigError`로 실패한다.
 * 오류에는 변수 이름과 고정 사유만 담는다. 값은 담지 않는다(RQ-027).
 * 시크릿(DB URL, SMTP 비밀번호, 키)은 `Secret`으로 감싸 객체를 로그에 찍어도 값이 나오지 않게 한다.
 *
 * 수치 기본값은 모두 요구사항·ADR의 추정값이다(RQ-008, RQ-030, ADR-0007 결정 4·5, ADR-0008 결정 7).
 */
import { isAbsolute } from "node:path";
import type { KeyRingInput } from "../crypto/index.js";
import type { IatPolicy } from "../envelope/index.js";
import {
  DEFAULT_MAIL_REQUEST_LIMITS,
  checkAddress,
  type MailRequestLimits,
} from "../validation/index.js";
import { EnvReader } from "./env-reader.js";
import { assertDisjointKeyRings, loadKeyRing } from "./key-loader.js";
import { Secret } from "./secret.js";
import type { WorkerAccountReason, WorkerOptions } from "./worker-options.js";

export interface SmtpConfig {
  host: string;
  port: number;
  /** `starttls`: 587 + STARTTLS 필수(기본). `tls`: 465 implicit TLS. 평문 연결 선택지는 없다(RQ-005). */
  security: "starttls" | "tls";
  /** 인증이 없는 릴레이(IP 허용)는 null이다. */
  auth: { user: string; password: Secret<string> } | null;
  /** 요청이 `from`을 생략했을 때 쓰는 발신 주소. */
  defaultFrom: string;
  /** 연결·응답 대기 초. lease보다 작아야 한다(추정). */
  timeoutSeconds: number;
}

/**
 * 파일 채널 설정(ADR-0004 결정 3·4·5, RQ-002). `root`가 없으면 파일 채널은 꺼져 있다(기본).
 * 수치 기본값은 모두 추정이다.
 */
export interface FileChannelConfig {
  /** 입력 루트의 절대 경로. 호출처 폴더는 `<root>/inbox/<caller_id>/`다. 없으면 null이고 폴러를 만들지 않는다. */
  root: string | null;
  /** 폴링 간격 ms(기본 30초). */
  pollIntervalMs: number;
  /** 파일 원시 바이트 상한(RQ-030, 기본은 `http.maxRequestBytes`와 같은 2 MiB). */
  maxFileBytes: number;
  /** 점(.) 임시 파일을 지우기까지의 시간 초(기본 1시간). */
  tempFileMaxAgeSeconds: number;
  /** 한 폴링에서 호출처 하나가 처리하는 파일 수 상한. 한 호출처가 다른 호출처를 굶기지 않게 한다. */
  batchPerCaller: number;
}

/** 앱이 부팅 때 읽는 설정. */
export interface AppConfig {
  env: "development" | "test" | "production";
  /** HTTP listen 포트. */
  port: number;
  database: {
    url: Secret<string>;
    poolMax: number;
    connectTimeoutMs: number;
  };
  http: {
    /** 원시 요청 본문 상한 바이트(RQ-030, 기본 2 MiB). */
    maxRequestBytes: number;
  };
  /** 복호화 뒤 입력 검증 상한(RQ-030). */
  limits: MailRequestLimits;
  queue: {
    /** 새 작업의 만료 TTL 초(RQ-008, 기본 24시간). */
    jobExpirySeconds: number;
  };
  worker: WorkerOptions;
  smtp: SmtpConfig;
  keys: {
    /** DB 본문 암호화 키링(ADR-0008 결정 6). */
    dbEncryption: Secret<KeyRingInput>;
    /** Idempotency-Key 지문 키링(ADR-0005 결정 3). DB 본문 키와 분리한다. */
    fingerprint: Secret<KeyRingInput>;
  };
  /** 호출처 레지스트리 JSON 파일 경로(RQ-028). 내용은 callers 모듈이 읽는다. */
  callersFile: string;
  fileChannel: FileChannelConfig;
  envelope: {
    /** Mailo JWE 개인키 목록 파일 경로(ADR-0008 결정 5). 없으면 null이고 모든 JWE `content`가 `KID_UNKNOWN`이다. 내용은 envelope 모듈이 읽는다. */
    keysFile: string | null;
    /** JWS `iat` 허용 기간·오차(ADR-0008 결정 4). */
    iat: IatPolicy;
  };
}

const MIB = 1024 * 1024;
const REASON_WAIT: Record<
  WorkerAccountReason,
  { variable: string; fallback: number }
> = {
  DAILY_LIMIT: {
    variable: "MAILO_BREAKER_WAIT_DAILY_LIMIT_SECONDS",
    fallback: 3600,
  },
  RATE_LIMIT: {
    variable: "MAILO_BREAKER_WAIT_RATE_LIMIT_SECONDS",
    fallback: 300,
  },
  CONNECTION: {
    variable: "MAILO_BREAKER_WAIT_CONNECTION_SECONDS",
    fallback: 60,
  },
  TLS: { variable: "MAILO_BREAKER_WAIT_TLS_SECONDS", fallback: 60 },
  AUTH: { variable: "MAILO_BREAKER_WAIT_AUTH_SECONDS", fallback: 60 },
  OTHER: { variable: "MAILO_BREAKER_WAIT_OTHER_SECONDS", fallback: 60 },
};
const HOSTNAME = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;

/**
 * 분리된 변수(MAILO_DB_HOST 등)로 접속 URL을 조립한다. 사용자·비밀번호·DB 이름은 URL 인코딩된다.
 * 비밀번호에 `@`, `/`, `:`, `#`, `%`가 있어도 compose가 문자열로 이어 붙일 때처럼 깨지지 않는다.
 * 호스트를 받지 못하면 undefined. 오류는 변수 이름만 적는다.
 */
function assembleDatabaseUrl(reader: EnvReader): string | undefined {
  const host = reader.raw("MAILO_DB_HOST");
  if (host === undefined) return undefined;
  const port = reader.int("MAILO_DB_PORT", 5432, { min: 1, max: 65535 });
  const user = reader.requiredString("MAILO_DB_USER");
  const name = reader.requiredString("MAILO_DB_NAME");
  const password = reader.secret("MAILO_DB_PASSWORD");
  if (user === undefined || name === undefined) return undefined;
  let hostPart: string;
  try {
    const probe = new URL("postgres://placeholder");
    probe.hostname = host;
    hostPart = probe.hostname;
  } catch {
    reader.issue("MAILO_DB_HOST가 올바른 호스트가 아니다");
    return undefined;
  }
  // URL.password 세터는 `%`를 인코딩하지 않아 직접 인코딩한다(pg는 사용자·비밀번호를 decodeURIComponent로 푼다).
  const credentials =
    password === undefined
      ? encodeURIComponent(user)
      : `${encodeURIComponent(user)}:${encodeURIComponent(password)}`;
  return `postgres://${credentials}@${hostPart}:${port}/${encodeURIComponent(name)}`;
}

function loadDatabaseUrl(reader: EnvReader): string | undefined {
  const hasUrl =
    reader.raw("MAILO_DATABASE_URL") !== undefined ||
    reader.raw("MAILO_DATABASE_URL_FILE") !== undefined;
  if (hasUrl && reader.raw("MAILO_DB_HOST") !== undefined) {
    reader.issue(
      "MAILO_DATABASE_URL과 MAILO_DB_HOST는 함께 쓸 수 없다. 하나만 설정한다",
    );
    return undefined;
  }
  const url = hasUrl
    ? reader.secret("MAILO_DATABASE_URL")
    : assembleDatabaseUrl(reader);
  if (url === undefined) {
    if (!hasUrl && reader.raw("MAILO_DB_HOST") === undefined)
      reader.issue(
        "MAILO_DATABASE_URL이 설정되지 않았다(또는 MAILO_DB_HOST·MAILO_DB_USER·MAILO_DB_NAME)",
      );
    return undefined;
  }
  try {
    const protocol = new URL(url).protocol;
    if (protocol !== "postgres:" && protocol !== "postgresql:")
      throw new Error("protocol");
  } catch {
    // URL 원문에 비밀번호가 있으므로 사유만 적는다.
    reader.issue(
      "MAILO_DATABASE_URL은 postgres:// 또는 postgresql:// URL이어야 한다",
    );
    return undefined;
  }
  return url;
}

/** DB 접속 URL만 읽는다. 마이그레이션 CLI가 SMTP·키 설정 없이 쓴다. */
export function loadDatabaseUrlOnly(
  env: NodeJS.ProcessEnv = process.env,
): Secret<string> {
  const reader = new EnvReader(env);
  const url = loadDatabaseUrl(reader);
  reader.finish();
  return new Secret(url as string);
}

function loadSmtp(
  reader: EnvReader,
  leaseSeconds: number,
): SmtpConfig | undefined {
  const host = reader.requiredString("MAILO_SMTP_HOST");
  if (host !== undefined && !HOSTNAME.test(host.trim())) {
    reader.issue("MAILO_SMTP_HOST는 호스트 이름이어야 한다");
  }
  const security = reader.oneOf(
    "MAILO_SMTP_SECURITY",
    ["starttls", "tls"] as const,
    "starttls",
  );
  const port = reader.int("MAILO_SMTP_PORT", security === "tls" ? 465 : 587, {
    min: 1,
    max: 65535,
  });
  const timeoutSeconds = reader.int("MAILO_SMTP_TIMEOUT_SECONDS", 30, {
    min: 1,
    max: 3600,
  });
  // 전송이 lease보다 오래 걸리면 다른 Worker가 같은 작업을 다시 잡아 중복 발송한다(ADR-0002).
  if (timeoutSeconds >= leaseSeconds) {
    reader.issue(
      "MAILO_SMTP_TIMEOUT_SECONDS는 MAILO_LEASE_SECONDS보다 작아야 한다",
    );
  }

  const user = reader.raw("MAILO_SMTP_USER");
  const password = reader.secret("MAILO_SMTP_PASSWORD");
  if ((user === undefined) !== (password === undefined)) {
    reader.issue(
      "MAILO_SMTP_USER와 MAILO_SMTP_PASSWORD(또는 _FILE)는 함께 설정해야 한다",
    );
  }

  const fromRaw = reader.raw("MAILO_SMTP_FROM") ?? user;
  let defaultFrom: string | undefined;
  if (fromRaw === undefined) {
    reader.issue(
      "MAILO_SMTP_FROM이 필요하다(MAILO_SMTP_USER가 없으면 기본 발신 주소를 정할 수 없다)",
    );
  } else if (
    checkAddress(
      fromRaw.trim(),
      DEFAULT_MAIL_REQUEST_LIMITS.maxAddressChars,
    ) !== undefined
  ) {
    reader.issue(
      "MAILO_SMTP_FROM(없으면 MAILO_SMTP_USER)은 주소 하나여야 한다",
    );
  } else {
    defaultFrom = fromRaw.trim();
  }

  if (host === undefined || defaultFrom === undefined) return undefined;
  return {
    host: host.trim(),
    port,
    security,
    auth:
      user !== undefined && password !== undefined
        ? { user, password: new Secret(password) }
        : null,
    defaultFrom,
    timeoutSeconds,
  };
}

function loadWorkerOptions(
  reader: EnvReader,
  jobExpirySeconds: number,
): WorkerOptions {
  const baseSeconds = reader.int("MAILO_RETRY_BASE_SECONDS", 60, {
    min: 1,
    max: 86_400,
  });
  const capSeconds = reader.int("MAILO_RETRY_CAP_SECONDS", 3600, {
    min: 1,
    max: 604_800,
  });
  if (capSeconds < baseSeconds)
    reader.issue(
      "MAILO_RETRY_CAP_SECONDS는 MAILO_RETRY_BASE_SECONDS 이상이어야 한다",
    );

  const initialWaitSeconds = {} as Record<WorkerAccountReason, number>;
  for (const [reason, def] of Object.entries(REASON_WAIT) as Array<
    [WorkerAccountReason, (typeof REASON_WAIT)[WorkerAccountReason]]
  >) {
    initialWaitSeconds[reason] = reader.int(def.variable, def.fallback, {
      min: 1,
      max: 604_800,
    });
  }

  const bodyGraceSeconds = reader.int("MAILO_BODY_RETENTION_SECONDS", 86_400, {
    min: 1,
    max: 31_536_000,
  });
  const recordRetentionSeconds = reader.int(
    "MAILO_RECORD_RETENTION_SECONDS",
    2_592_000,
    {
      min: 1,
      max: 31_536_000,
    },
  );
  // 보존 기간 순서: 본문 삭제 유예 <= 작업·시도·이벤트 보존(ADR-0005 결정 7).
  if (recordRetentionSeconds < bodyGraceSeconds) {
    reader.issue(
      "MAILO_RECORD_RETENTION_SECONDS는 MAILO_BODY_RETENTION_SECONDS 이상이어야 한다",
    );
  }
  // 작업 TTL보다 보존이 짧으면 종결 전 Key가 지워지는 일은 없지만, 재시도 기간 안의 재전달을 막지 못한다.
  if (recordRetentionSeconds < jobExpirySeconds) {
    reader.issue(
      "MAILO_RECORD_RETENTION_SECONDS는 MAILO_JOB_EXPIRY_SECONDS 이상이어야 한다",
    );
  }

  return {
    retry: {
      maxAttempts: reader.int("MAILO_RETRY_MAX_ATTEMPTS", 8, {
        min: 1,
        max: 100,
      }),
      mode: reader.oneOf(
        "MAILO_RETRY_MODE",
        ["exponential", "fixed"] as const,
        "exponential",
      ),
      baseSeconds,
      multiplier: reader.decimal("MAILO_RETRY_MULTIPLIER", 2, {
        min: 1,
        max: 10,
      }),
      capSeconds,
      jitterRatio: reader.decimal("MAILO_RETRY_JITTER_RATIO", 0.2, {
        min: 0,
        max: 1,
        maxExclusive: true,
      }),
    },
    breaker: {
      breakerKey: "default",
      failureThreshold: reader.int("MAILO_BREAKER_FAILURE_THRESHOLD", 3, {
        min: 1,
        max: 1000,
      }),
      initialWaitSeconds,
      capFloorSeconds: reader.int("MAILO_BREAKER_CAP_FLOOR_SECONDS", 1800, {
        min: 1,
        max: 604_800,
      }),
      immediateOpenReasons: ["DAILY_LIMIT", "RATE_LIMIT"],
      maxAccountTrips: reader.int("MAILO_BREAKER_MAX_ACCOUNT_TRIPS", 3, {
        min: 1,
        max: 100,
      }),
    },
    lease: {
      seconds: reader.int("MAILO_LEASE_SECONDS", 120, { min: 5, max: 86_400 }),
    },
    pollMs: reader.int("MAILO_WORKER_POLL_MS", 1000, { min: 50, max: 600_000 }),
    concurrency: reader.int("MAILO_WORKER_CONCURRENCY", 4, {
      min: 1,
      max: 100,
    }),
    retention: {
      bodyGraceSeconds,
      recordRetentionSeconds,
      maintenanceIntervalMs:
        reader.int("MAILO_MAINTENANCE_INTERVAL_SECONDS", 60, {
          min: 1,
          max: 86_400,
        }) * 1000,
    },
  };
}

/**
 * 봉투 설정(ADR-0008 결정 4). JWS 허용 기간은 "Key 보존 기간 − 허용 오차" 이하여야 한다.
 * 허용 기간 안에 처음 수집된 파일의 재전송은 허용 기간 + 오차가 지나면 `iat` 검사에 걸리고, 그 전에 Key 행이 지워지면
 * 같은 파일이 새 요청으로 등록되기 때문이다. Key 보존 기간은 `MAILO_RECORD_RETENTION_SECONDS`(종결 후 기준)다.
 */
function loadEnvelope(
  reader: EnvReader,
  keyRetentionSeconds: number,
): AppConfig["envelope"] {
  const maxAgeSeconds = reader.int("MAILO_JWS_IAT_MAX_AGE_SECONDS", 604_800, {
    min: 1,
    max: 31_536_000,
  });
  const skewSeconds = reader.int("MAILO_JWS_IAT_SKEW_SECONDS", 300, {
    min: 0,
    max: 3600,
  });
  if (maxAgeSeconds + skewSeconds > keyRetentionSeconds) {
    reader.issue(
      "MAILO_JWS_IAT_MAX_AGE_SECONDS는 MAILO_RECORD_RETENTION_SECONDS에서 MAILO_JWS_IAT_SKEW_SECONDS를 뺀 값 이하여야 한다",
    );
  }
  return {
    keysFile: reader.raw("MAILO_ENVELOPE_KEYS_FILE") ?? null,
    iat: { maxAgeSeconds, skewSeconds },
  };
}

/**
 * 파일 채널 설정. `MAILO_FILE_CHANNEL_ROOT`가 있을 때만 폴러가 켜진다.
 * 폴더 생성·권한은 코드가 정하지 않는다(ADR-0004 결정 8, 운영 문서의 몫).
 */
function loadFileChannel(
  reader: EnvReader,
  defaultMaxFileBytes: number,
): FileChannelConfig {
  const root = reader.raw("MAILO_FILE_CHANNEL_ROOT") ?? null;
  // 상대 경로는 프로세스 작업 디렉터리에 따라 가리키는 곳이 달라진다.
  if (root !== null && !isAbsolute(root))
    reader.issue("MAILO_FILE_CHANNEL_ROOT는 절대 경로여야 한다");
  return {
    root,
    pollIntervalMs: reader.int("MAILO_FILE_POLL_INTERVAL_MS", 30_000, {
      min: 50,
      max: 3_600_000,
    }),
    maxFileBytes: reader.int("MAILO_FILE_MAX_BYTES", defaultMaxFileBytes, {
      min: 1024,
      max: 64 * MIB,
    }),
    tempFileMaxAgeSeconds: reader.int("MAILO_FILE_TEMP_MAX_AGE_SECONDS", 3600, {
      min: 1,
      max: 31_536_000,
    }),
    batchPerCaller: reader.int("MAILO_FILE_BATCH_PER_CALLER", 100, {
      min: 1,
      max: 10_000,
    }),
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const reader = new EnvReader(env);

  const databaseUrl = loadDatabaseUrl(reader);
  const jobExpirySeconds = reader.int("MAILO_JOB_EXPIRY_SECONDS", 86_400, {
    min: 1,
    max: 31_536_000,
  });
  const worker = loadWorkerOptions(reader, jobExpirySeconds);
  const smtp = loadSmtp(reader, worker.lease.seconds);

  const maxRequestBytes = reader.int("MAILO_MAX_REQUEST_BYTES", 2 * MIB, {
    min: 1024,
    max: 64 * MIB,
  });
  const maxContentBytes = reader.int(
    "MAILO_MAX_CONTENT_BYTES",
    DEFAULT_MAIL_REQUEST_LIMITS.maxContentBytes,
    {
      min: 1,
      max: 64 * MIB,
    },
  );
  if (maxContentBytes > maxRequestBytes) {
    reader.issue(
      "MAILO_MAX_CONTENT_BYTES는 MAILO_MAX_REQUEST_BYTES 이하여야 한다",
    );
  }
  const maxRecipients = reader.int(
    "MAILO_MAX_RECIPIENTS",
    DEFAULT_MAIL_REQUEST_LIMITS.maxRecipients,
    {
      min: 1,
      max: 100,
    },
  );

  const dbEncryption = loadKeyRing(reader, "MAILO_DB_ENCRYPTION_KEY");
  const fingerprint = loadKeyRing(reader, "MAILO_FINGERPRINT_KEY");
  if (dbEncryption !== undefined && fingerprint !== undefined) {
    assertDisjointKeyRings(
      reader,
      { label: "DB 본문 암호화 키링", ring: dbEncryption },
      { label: "지문 키링", ring: fingerprint },
    );
  }

  const fileChannel = loadFileChannel(reader, maxRequestBytes);
  const envelope = loadEnvelope(
    reader,
    worker.retention.recordRetentionSeconds,
  );

  const callersFile = reader.requiredString("MAILO_CALLERS_FILE");
  const nodeEnv = reader.oneOf(
    "NODE_ENV",
    ["development", "test", "production"] as const,
    "development",
  );

  const config = {
    env: nodeEnv,
    port: reader.int("MAILO_PORT", 3000, { min: 1, max: 65535 }),
    database: {
      url: new Secret(databaseUrl ?? ""),
      poolMax: reader.int("MAILO_DB_POOL_MAX", 10, { min: 1, max: 200 }),
      connectTimeoutMs: reader.int("MAILO_DB_CONNECT_TIMEOUT_MS", 5000, {
        min: 100,
        max: 60_000,
      }),
    },
    http: { maxRequestBytes },
    limits: { ...DEFAULT_MAIL_REQUEST_LIMITS, maxContentBytes, maxRecipients },
    queue: { jobExpirySeconds },
    worker,
    smtp: smtp as SmtpConfig,
    keys: {
      dbEncryption: new Secret(dbEncryption as KeyRingInput),
      fingerprint: new Secret(fingerprint as KeyRingInput),
    },
    callersFile: callersFile ?? "",
    fileChannel,
    envelope,
  } satisfies AppConfig;

  // 오류가 하나라도 있으면 위에서 만든 임시 값은 쓰이지 않는다.
  reader.finish();
  return config;
}
