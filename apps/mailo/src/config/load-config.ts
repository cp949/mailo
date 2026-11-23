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
import type { AccountErrorReason } from "../queue/index.js";
import {
  DEFAULT_MAIL_REQUEST_LIMITS,
  checkAddress,
  type MailRequestLimits,
} from "../validation/index.js";
import { loadDatabaseSsl, type DatabaseSsl } from "./database-ssl.js";
import { EnvReader } from "./env-reader.js";
import { loadInstanceId } from "./instance-id.js";
import { assertDisjointKeyRings, loadKeyRing } from "./key-loader.js";
import { Secret } from "./secret.js";
import {
  SHUTDOWN_MARGIN_MS,
  workerDrainTimeoutMs,
  type WorkerConfig,
} from "./worker-options.js";

export interface SmtpConfig {
  host: string;
  port: number;
  /**
   * `starttls`: 587 + STARTTLS 필수(기본). `tls`: 465 implicit TLS. `none`: TLS 없는 평문 연결.
   * 연결 보안 방식은 운영자 설정이다. `none`은 NODE_ENV와 무관하게 받고 기동 때 warn 로그를 남긴다(RQ-005).
   */
  security: "starttls" | "tls" | "none";
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

export interface DatabaseTimeouts {
  /** 서버가 쿼리 하나에 허용하는 시간(`statement_timeout`). */
  statementMs: number;
  /** 잠금 대기 상한(`lock_timeout`). */
  lockMs: number;
  /** 트랜잭션을 연 채 쿼리 없이 머무는 시간 상한(`idle_in_transaction_session_timeout`). */
  idleInTransactionMs: number;
  /** 클라이언트 쪽 응답 대기 상한(pg `query_timeout`). 서버 쪽 `statementMs`보다 길다. */
  queryMs: number;
}

/**
 * `poolMax`에서 `concurrency`를 뺀 최소 여유. 결과 기록은 전송 한 건마다 커넥션 1개가 필요하고,
 * 그 밖에 점유 루프 1개, 주기 작업 1개, HTTP 요청·헬스·파일 폴러 몫이 필요하다(추정).
 */
export const POOL_RESERVE_CONNECTIONS = 4;

/** 공개 저장소에 있는 샘플 DB 비밀번호(docker-compose.yml 이전 기본값, .env.example). production에서 거부한다. */
const PUBLIC_SAMPLE_DB_PASSWORDS: readonly string[] = ["mailo-dev-password"];

/** 앱이 부팅 때 읽는 설정. */
export interface AppConfig {
  env: "development" | "test" | "production";
  /** HTTP listen 포트. */
  port: number;
  database: {
    url: Secret<string>;
    /** 연결 암호화(`MAILO_DB_SSLMODE`, L7). `MAILO_DATABASE_URL` 경로이거나 `disable`·미지정이면 null이다. */
    ssl: DatabaseSsl | null;
    poolMax: number;
    connectTimeoutMs: number;
    /**
     * DB 시간제한(ms). 연결 단절이나 잠금 대기로 쿼리가 끝나지 않을 때 점유·종료가 멈추는 것을 막는다.
     * 모두 추정 기본값이다. 마이그레이션 CLI는 이 값을 쓰지 않는다(DDL이 오래 걸릴 수 있다).
     */
    timeouts: DatabaseTimeouts;
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
  worker: WorkerConfig;
  /**
   * 컨테이너 `stop_grace_period`(compose `MAILO_STOP_GRACE_PERIOD`). 변수가 없으면 null이고 앱은 관계를 검사하지 않는다.
   * 앱이 오케스트레이터 설정을 알 수 없는 환경이 있기 때문이다.
   */
  stopGracePeriodMs: number | null;
  smtp: SmtpConfig;
  keys: {
    /** DB 본문 암호화 키링(ADR-0008 결정 6). */
    dbEncryption: Secret<KeyRingInput>;
    /** Idempotency-Key 지문 키링(ADR-0005 결정 3). DB 본문 키와 분리한다. */
    fingerprint: Secret<KeyRingInput>;
  };
  /**
   * 운영자 토큰(선택). 있으면 `/health/ready`가 이 토큰을 Bearer로 받은 호출에 호출처 전체 큐 수치와 Worker 상태를 준다.
   * 호출처 API 키로는 전역 수치를 볼 수 없다(다른 호출처의 발송량이 드러난다). 업무 endpoint에는 쓸 수 없다.
   */
  ops: { token: Secret<string> | null };
  /** 호출처 레지스트리 JSON 파일 경로(RQ-028). 내용은 callers 모듈이 읽는다. */
  callersFile: string;
  /** 로그 줄의 `instance` 값(`MAILO_INSTANCE_ID`, 없으면 호스트 이름). */
  instanceId: string;
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
  AccountErrorReason,
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
 * `MAILO_DB_HOST`를 URL의 호스트 부분으로 바꾼다. 호스트 이름, IPv4, 대괄호 IPv6(`[::1]`)만 받는다.
 * `URL.hostname` 세터는 `db:5433`·`db/x`·`bad host`처럼 잘못된 값을 오류 없이 무시하고 이전 값을 남기므로
 * 설정한 뒤 읽은 값이 입력과 같은지 확인한다. 다르면 undefined다.
 */
function databaseHostPart(host: string): string | undefined {
  const bracketedIpv6 = /^\[[0-9A-Fa-f:.]+\]$/.test(host);
  if (!bracketedIpv6 && !HOSTNAME.test(host)) return undefined;
  const probe = new URL("postgres://placeholder");
  probe.hostname = host;
  return probe.hostname === host ? host : undefined;
}

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
  const hostPart = databaseHostPart(host);
  if (hostPart === undefined) {
    reader.issue(
      "MAILO_DB_HOST가 올바른 호스트가 아니다(호스트 이름, IPv4, 대괄호 IPv6만 받고 포트·경로는 넣지 않는다)",
    );
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
  // 비밀번호 값은 오류에 싣지 않는다. 공개 샘플과 같으면 변수 이름과 사유만 적는다.
  if (reader.strictEnv()) {
    const password = databasePassword(url);
    if (password !== undefined && PUBLIC_SAMPLE_DB_PASSWORDS.includes(password))
      reader.issue(
        "DB 비밀번호가 저장소에 공개된 샘플 값이라 production(NODE_ENV가 development·test가 아닌 경우)에서 쓸 수 없다(POSTGRES_PASSWORD와 MAILO_DB_PASSWORD 또는 MAILO_DATABASE_URL을 새 값으로 바꾼다)",
      );
  }
  return url;
}

function databasePassword(url: string): string | undefined {
  try {
    const raw = new URL(url).password;
    return raw === "" ? undefined : decodeURIComponent(raw);
  } catch {
    return undefined;
  }
}

/** DB 접속 URL만 읽는다(연결 암호화 설정은 읽지 않는다). */
export function loadDatabaseUrlOnly(
  env: NodeJS.ProcessEnv = process.env,
): Secret<string> {
  const reader = new EnvReader(env);
  const url = loadDatabaseUrl(reader);
  reader.finish();
  return new Secret(url as string);
}

/** DB 접속 URL과 연결 암호화 설정만 읽는다. 마이그레이션 CLI가 SMTP·키 설정 없이 쓴다. */
export function loadDatabaseOnly(env: NodeJS.ProcessEnv = process.env): {
  url: Secret<string>;
  ssl: DatabaseSsl | null;
} {
  const reader = new EnvReader(env);
  const url = loadDatabaseUrl(reader);
  const ssl = loadDatabaseSsl(reader, url);
  reader.finish();
  return { url: new Secret(url as string), ssl };
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
    ["starttls", "tls", "none"] as const,
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

function loadWorkerConfig(
  reader: EnvReader,
  jobExpirySeconds: number,
): WorkerConfig {
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

  const initialWaitSeconds = {} as Record<AccountErrorReason, number>;
  for (const [reason, def] of Object.entries(REASON_WAIT) as Array<
    [AccountErrorReason, (typeof REASON_WAIT)[AccountErrorReason]]
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
    // RQ-035: 기본 0.1은 추정값이다. 범위 밖·숫자 아님은 기동 거부다.
    claimFifoRatio: reader.decimal("MAILO_CLAIM_FIFO_RATIO", 0.1, {
      min: 0,
      max: 1,
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

const DURATION_PART = /(\d+)(ms|h|m|s)/y;
const DURATION_UNIT_MS = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 } as const;

/** compose 기간 표기(`150s`, `2m30s`, `1h`)를 ms로 바꾼다. 형식이 틀리거나 0이면 undefined다. */
export function parseComposeDurationMs(text: string): number | undefined {
  const trimmed = text.trim();
  if (trimmed === "") return undefined;
  let total = 0;
  let index = 0;
  DURATION_PART.lastIndex = 0;
  while (index < trimmed.length) {
    DURATION_PART.lastIndex = index;
    const match = DURATION_PART.exec(trimmed);
    if (!match) return undefined;
    total += Number(match[1]) * DURATION_UNIT_MS[match[2] as "ms"];
    index = DURATION_PART.lastIndex;
  }
  return total > 0 ? total : undefined;
}

/**
 * `MAILO_STOP_GRACE_PERIOD`가 있으면 drain 상한 + 10초 이상인지 확인한다(ADR-0002 결정 12, RQ-025).
 * 어기면 종료 때 drain이 끝나기 전에 SIGKILL이 와서 진행 중 전송이 lease 회수로 재발송된다.
 */
function loadStopGracePeriod(
  reader: EnvReader,
  leaseSeconds: number,
): number | null {
  const raw = reader.raw("MAILO_STOP_GRACE_PERIOD");
  if (raw === undefined) return null;
  const ms = parseComposeDurationMs(raw);
  if (ms === undefined) {
    reader.issue(
      "MAILO_STOP_GRACE_PERIOD는 150s, 2m30s처럼 시·분·초(h, m, s, ms) 기간이어야 한다",
    );
    return null;
  }
  const needed = workerDrainTimeoutMs(leaseSeconds) + SHUTDOWN_MARGIN_MS;
  if (ms < needed) {
    reader.issue(
      `MAILO_STOP_GRACE_PERIOD는 MAILO_LEASE_SECONDS에서 10초를 뺀 drain 상한에 10초를 더한 값(${needed / 1000}초) 이상이어야 한다`,
    );
  }
  return ms;
}

/** 운영자 토큰은 사람이 고른 짧은 문자열을 막기 위해 최소 길이를 둔다. `openssl rand -base64 32`(44자)를 권한다. */
const OPS_TOKEN_MIN_CHARS = 32;

/** `MAILO_OPS_TOKEN_FILE`(우선) 또는 `MAILO_OPS_TOKEN`. 없으면 undefined이고 운영자 응답은 꺼진다. */
function loadOpsToken(reader: EnvReader): string | undefined {
  const token = reader.secret("MAILO_OPS_TOKEN")?.trim();
  if (token === undefined) return undefined;
  if (token.length < OPS_TOKEN_MIN_CHARS || /\s/.test(token)) {
    reader.issue(
      `MAILO_OPS_TOKEN은 공백 없는 ${OPS_TOKEN_MIN_CHARS}자 이상이어야 한다(openssl rand -base64 32)`,
    );
    return undefined;
  }
  return token;
}

/** 결과 기록의 마감 여유(ms). lease 만료 전에 기록을 끝내기 위해 worker가 같은 값을 쓴다(`worker.ts`의 `COMPLETE_LEASE_MARGIN_MS`). */
const DB_RECORD_LEASE_MARGIN_MS = 10_000;

/**
 * DB 시간제한(H1). 서버 쪽 `statement_timeout`이 먼저 쿼리를 취소해 연결이 살아남게 하고,
 * 서버 응답이 오지 않는 단절은 클라이언트 `query_timeout`이 끊는다. 그래서 `queryMs`가 더 길어야 한다.
 * 기본값은 모두 추정이다. 가장 오래 걸리는 정상 쿼리는 500건 배치 sweep·삭제이고 수 초 이하로 가정했다.
 * 결과 기록 시도 하나는 연결 대기(`connectMs`) 뒤 응답 없는 쿼리를 `queryMs`까지 기다릴 수 있다. 이 합이 lease에서 기록 마감 여유
 * (10초, worker의 `COMPLETE_LEASE_MARGIN_MS`)를 뺀 값보다 작아야 마감 직전에 시작한 시도가 lease 안에 끝난다(N4, N6).
 */
function loadDatabaseTimeouts(
  reader: EnvReader,
  leaseSeconds: number,
  connectMs: number,
): DatabaseTimeouts {
  const range = { min: 1000, max: 3_600_000 };
  const statementMs = reader.int(
    "MAILO_DB_STATEMENT_TIMEOUT_MS",
    30_000,
    range,
  );
  const lockMs = reader.int("MAILO_DB_LOCK_TIMEOUT_MS", 10_000, range);
  const idleInTransactionMs = reader.int(
    "MAILO_DB_IDLE_IN_TRANSACTION_TIMEOUT_MS",
    60_000,
    range,
  );
  const queryMs = reader.int("MAILO_DB_QUERY_TIMEOUT_MS", 35_000, range);
  if (queryMs <= statementMs) {
    reader.issue(
      "MAILO_DB_QUERY_TIMEOUT_MS는 MAILO_DB_STATEMENT_TIMEOUT_MS보다 커야 한다",
    );
  }
  const attemptBoundMs = connectMs + queryMs;
  const budgetMs = leaseSeconds * 1000 - DB_RECORD_LEASE_MARGIN_MS;
  if (attemptBoundMs >= budgetMs) {
    reader.issue(
      "MAILO_DB_QUERY_TIMEOUT_MS와 MAILO_DB_CONNECT_TIMEOUT_MS의 합은 MAILO_LEASE_SECONDS에서 10초를 뺀 값보다 작아야 한다",
    );
  }
  return { statementMs, lockMs, idleInTransactionMs, queryMs };
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

/**
 * 환경 변수 없이(`leaseSeconds`만 덮어써) 읽은 Worker 설정. 기본값의 단일 출처는 `loadWorkerConfig`다.
 * Worker 옵션의 기본값(`defaultWorkerOptions`)이 이 함수로 만들어져 `loadConfig`와 어긋나지 않는다.
 */
export function defaultWorkerConfig(leaseSeconds?: number): WorkerConfig {
  const reader = new EnvReader(
    leaseSeconds === undefined
      ? {}
      : { MAILO_LEASE_SECONDS: String(leaseSeconds) },
  );
  const worker = loadWorkerConfig(reader, 86_400);
  reader.finish();
  return worker;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const reader = new EnvReader(env);

  const databaseUrl = loadDatabaseUrl(reader);
  const databaseSsl = loadDatabaseSsl(reader, databaseUrl);
  const jobExpirySeconds = reader.int("MAILO_JOB_EXPIRY_SECONDS", 86_400, {
    min: 1,
    max: 31_536_000,
  });
  const worker = loadWorkerConfig(reader, jobExpirySeconds);
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

  const connectTimeoutMs = reader.int("MAILO_DB_CONNECT_TIMEOUT_MS", 5000, {
    min: 100,
    max: 60_000,
  });
  const dbTimeouts = loadDatabaseTimeouts(
    reader,
    worker.lease.seconds,
    connectTimeoutMs,
  );
  const poolMax = reader.int("MAILO_DB_POOL_MAX", 10, { min: 1, max: 200 });
  // 전송이 끝난 작업의 결과 기록은 커넥션 1개가 필요하다. 풀이 모자라면 기록이 대기하다 lease가 만료되어 중복 발송이 된다.
  if (poolMax < worker.concurrency + POOL_RESERVE_CONNECTIONS) {
    reader.issue(
      `MAILO_DB_POOL_MAX는 MAILO_WORKER_CONCURRENCY + ${POOL_RESERVE_CONNECTIONS} 이상이어야 한다`,
    );
  }

  const opsToken = loadOpsToken(reader);
  const stopGracePeriodMs = loadStopGracePeriod(reader, worker.lease.seconds);

  const callersFile = reader.requiredString("MAILO_CALLERS_FILE");
  const nodeEnv = reader.oneOf(
    "NODE_ENV",
    ["development", "test", "production"] as const,
    // 값이 없으면 production이다(fail closed). 로컬 시험은 NODE_ENV=development를 명시한다.
    "production",
  );

  const config = {
    env: nodeEnv,
    port: reader.int("MAILO_PORT", 3000, { min: 1, max: 65535 }),
    database: {
      url: new Secret(databaseUrl ?? ""),
      ssl: databaseSsl,
      poolMax,
      connectTimeoutMs,
      timeouts: dbTimeouts,
    },
    http: { maxRequestBytes },
    limits: { ...DEFAULT_MAIL_REQUEST_LIMITS, maxContentBytes, maxRecipients },
    queue: { jobExpirySeconds },
    worker,
    stopGracePeriodMs,
    smtp: smtp as SmtpConfig,
    keys: {
      dbEncryption: new Secret(dbEncryption as KeyRingInput),
      fingerprint: new Secret(fingerprint as KeyRingInput),
    },
    ops: { token: opsToken === undefined ? null : new Secret(opsToken) },
    callersFile: callersFile ?? "",
    instanceId: loadInstanceId(reader),
    fileChannel,
    envelope,
  } satisfies AppConfig;

  // 오류가 하나라도 있으면 위에서 만든 임시 값은 쓰이지 않는다.
  reader.finish();
  return config;
}
