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

/** 설정 값을 Worker 옵션으로 바꾼다(`workerOptionsFromConfig`). */
export function toWorkerOptions(
  config: AppConfig,
  callerQuotas?: ReadonlyMap<string, number>,
): WorkerOptions {
  return workerOptionsFromConfig(config.worker, callerQuotas);
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
    tlsMode: smtp.security === "tls" ? "IMPLICIT" : "STARTTLS",
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
    },
    toWorkerOptions(config, deps.callerQuotas),
  );
}
