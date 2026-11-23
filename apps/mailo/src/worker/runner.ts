/**
 * 설정(`AppConfig`)에서 Worker를 조립한다(RQ-025, ADR-0002 결정 11·12).
 * `createWorker`는 순수 의존성만 받는다. 이 파일이 환경 변수에서 읽은 값을 Worker 옵션·SMTP 발송기 설정으로 바꾼다.
 */
import type pg from "pg";
import type { AppConfig } from "../config/index.js";
import type { AppLogger } from "../logging/index.js";
import type { BodyCipher } from "../queue/index.js";
import {
  checkSmtpTimeouts,
  createSmtpSender,
  DEFAULT_LEASE_MARGIN_MS,
  type MailSender,
  type SmtpSenderConfig,
  type TlsMode,
} from "../smtp/index.js";
import type { Clock } from "./clock.js";
import { workerOptionsFromConfig, type WorkerOptions } from "./options.js";
import { createWorker, type WorkerDeps, type WorkerHandle } from "./worker.js";

export interface WorkerRunnerDeps {
  pool: pg.Pool;
  config: AppConfig;
  bodyCipher: BodyCipher;
  /** 사설 relay·테스트 서버용 신뢰 CA(PEM). 인증서 검증을 끄는 옵션이 아니다(RQ-005). */
  trustedCa?: string;
  /** 발송기를 직접 넘기면 설정으로 만들지 않는다. 테스트용이다. */
  sender?: MailSender;
  clock?: Clock;
  /** 앱이 만든 로거. 로거는 `createApp` 한 곳에서 만든다(M10). */
  logger: AppLogger;
  /** 호출처별 24시간 발송 할당(호출처 ID -> 건수, RQ-032). 생략하면 모든 호출처가 무제한이다. */
  callerQuotas?: ReadonlyMap<string, number>;
  /** 점유 루프가 예외로 끝났을 때 부른다(`WorkerDeps.onFatal`). */
  onFatal?: WorkerDeps["onFatal"];
}

/** `MAILO_SMTP_SECURITY` 값과 발송기 연결 방식의 대응(RQ-005). */
const TLS_MODE: Record<AppConfig["smtp"]["security"], TlsMode> = {
  starttls: "STARTTLS",
  tls: "IMPLICIT",
  none: "NONE",
};

/** 평문 모드 경고의 고정 문구. 설정 값과 인증 정보는 넣지 않는다(RQ-027). */
const PLAINTEXT_WARNING =
  "평문 SMTP 모드(MAILO_SMTP_SECURITY=none)다. SMTP 인증 정보와 본문이 암호화 없이 전송된다. 사용 판단은 운영자 책임이다";

/** 설정 값을 Worker 옵션으로 바꾼다(`workerOptionsFromConfig`). */
export function toWorkerOptions(
  config: AppConfig,
  callerQuotas?: ReadonlyMap<string, number>,
): WorkerOptions {
  return {
    ...workerOptionsFromConfig(config.worker, callerQuotas),
    // 기록 재시도는 한 시도의 최악 시간(연결 대기 + 쿼리 응답 대기)이 마감 안에 들어갈 때만 한다(N4).
    recordAttemptMaxMs:
      config.database.connectTimeoutMs + config.database.timeouts.queryMs,
  };
}

/**
 * SMTP 설정을 발송기 설정으로 바꾸고 lease 안에 들어가는지 확인한다(ADR-0002 결정 11).
 * `MAILO_SMTP_TIMEOUT_SECONDS`는 소켓 무응답 상한이다. 연결·greeting·DNS는 그 값과 10초 중 작은 값이고,
 * 한 건 전체 마감은 소켓 값의 3배와 `lease - 여유` 중 작은 값이다.
 * 어긋나면 `SmtpConfigError`로 기동이 실패한다.
 */
export function toSenderConfig(
  config: AppConfig,
  trustedCa?: string,
): SmtpSenderConfig {
  const { smtp, worker } = config;
  const socketMs = smtp.timeoutSeconds * 1000;
  const phaseMs = Math.min(socketMs, 10_000);
  const leaseMs = worker.lease.seconds * 1000;
  const timeouts = {
    connectionMs: phaseMs,
    greetingMs: phaseMs,
    socketMs,
    dnsMs: phaseMs,
    totalMs: Math.min(socketMs * 3, leaseMs - DEFAULT_LEASE_MARGIN_MS),
  };
  checkSmtpTimeouts(timeouts, worker.lease.seconds);
  return {
    host: smtp.host,
    port: smtp.port,
    tlsMode: TLS_MODE[smtp.security],
    ...(smtp.auth && {
      auth: { user: smtp.auth.user, pass: smtp.auth.password.reveal() },
    }),
    timeouts,
    ...(trustedCa !== undefined && { trustedCa }),
    // Message-ID 도메인은 발신 계정 주소로 고정한다(ADR-0007 결정 8).
    accountAddress: smtp.defaultFrom,
  };
}

export function createWorkerRunner(deps: WorkerRunnerDeps): WorkerHandle {
  const { config } = deps;
  // 설정으로 발송기를 만들 때만 평문 경고를 남긴다. 주입한 발송기는 이 설정을 쓰지 않는다.
  // `auth`는 인증 정보가 평문으로 나가는지만 알린다(값은 싣지 않는다, RQ-005·027).
  if (deps.sender === undefined && config.smtp.security === "none")
    deps.logger.warn("smtp_plaintext_enabled", {
      auth: config.smtp.auth !== null,
      message: PLAINTEXT_WARNING,
    });
  const sender =
    deps.sender ?? createSmtpSender(toSenderConfig(config, deps.trustedCa));
  return createWorker(
    {
      pool: deps.pool,
      sender,
      bodyCipher: deps.bodyCipher,
      defaultFrom: config.smtp.defaultFrom,
      ...(deps.clock && { clock: deps.clock }),
      ...(deps.onFatal && { onFatal: deps.onFatal }),
      logger: deps.logger,
      instance: config.instanceId,
    },
    toWorkerOptions(config, deps.callerQuotas),
  );
}
