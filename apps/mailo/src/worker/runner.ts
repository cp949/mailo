/**
 * 설정(`AppConfig`)에서 Worker를 조립한다(RQ-025, ADR-0002 결정 11·12).
 * `createWorker`는 순수 의존성만 받는다. 이 파일이 환경 변수에서 읽은 값을 Worker 옵션·SMTP 발송기 설정으로 바꾼다.
 */
import type pg from "pg";
import {
  DEFAULT_SMTP_ACCOUNT_ID,
  type AppConfig,
  type SmtpAccount,
} from "../config/index.js";
import { describeError, type AppLogger } from "../logging/index.js";
import type { AppMetrics } from "../metrics/index.js";
import {
  countOrphanAccountJobs,
  ensureBreakerRows,
  type BodyCipher,
} from "../queue/index.js";
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
import {
  createWorker,
  type WorkerAccount,
  type WorkerDeps,
  type WorkerHandle,
} from "./worker.js";

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
  /** counter 증가 대상(RQ-049). 생략하면 세지 않는다. */
  metrics?: AppMetrics;
  /** 호출처별 24시간 발송 할당(호출처 ID -> 건수, RQ-032). 생략하면 모든 호출처가 무제한이다. */
  callerQuotas?: ReadonlyMap<string, number>;
  /** 점유 루프가 예외로 끝났을 때 부른다(`WorkerDeps.onFatal`). */
  onFatal?: WorkerDeps["onFatal"];
}

/** 계정의 `security` 값과 발송기 연결 방식의 대응(RQ-005). */
const TLS_MODE: Record<SmtpAccount["security"], TlsMode> = {
  starttls: "STARTTLS",
  tls: "IMPLICIT",
  none: "NONE",
};

/** 평문 모드 경고의 고정 문구. 설정 값과 인증 정보는 넣지 않는다(RQ-027). */
const PLAINTEXT_WARNING =
  "평문 SMTP 모드(security=none, default 계정은 MAILO_SMTP_SECURITY=none)다. SMTP 인증 정보와 본문이 암호화 없이 전송된다. 사용 판단은 운영자 책임이다";

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
 * 계정의 SMTP 설정을 발송기 설정으로 바꾸고 lease 안에 들어가는지 확인한다(ADR-0002 결정 11).
 * 계정의 `timeoutSeconds`는 소켓 무응답 상한이다. 연결·greeting·DNS는 그 값과 10초 중 작은 값이고,
 * 한 건 전체 마감은 소켓 값의 3배와 `lease - 여유` 중 작은 값이다.
 * 어긋나면 `SmtpConfigError`로 기동이 실패한다.
 * `accountId`를 생략하면 `default` 계정이다. 계정이 구성에 없으면 던진다.
 */
export function toSenderConfig(
  config: AppConfig,
  trustedCa?: string,
  accountId: string = DEFAULT_SMTP_ACCOUNT_ID,
): SmtpSenderConfig {
  const account = config.smtpAccounts.find((a) => a.id === accountId);
  if (account === undefined) throw new Error("SMTP 계정이 구성에 없다");
  return accountSenderConfig(account, config.worker.lease.seconds, trustedCa);
}

function accountSenderConfig(
  account: SmtpAccount,
  leaseSeconds: number,
  trustedCa?: string,
): SmtpSenderConfig {
  const socketMs = account.timeoutSeconds * 1000;
  const phaseMs = Math.min(socketMs, 10_000);
  const leaseMs = leaseSeconds * 1000;
  const timeouts = {
    connectionMs: phaseMs,
    greetingMs: phaseMs,
    socketMs,
    dnsMs: phaseMs,
    totalMs: Math.min(socketMs * 3, leaseMs - DEFAULT_LEASE_MARGIN_MS),
  };
  checkSmtpTimeouts(timeouts, leaseSeconds);
  return {
    host: account.host,
    port: account.port,
    tlsMode: TLS_MODE[account.security],
    ...(account.auth && {
      auth: { user: account.auth.user, pass: account.auth.password.reveal() },
    }),
    timeouts,
    ...(trustedCa !== undefined && { trustedCa }),
    // Message-ID 도메인은 작업 계정의 발신 주소로 고정한다(ADR-0007 결정 8, ADR-0013 결정 2).
    accountAddress: account.from,
  };
}

export function createWorkerRunner(deps: WorkerRunnerDeps): WorkerHandle {
  const { config } = deps;
  // 계정마다 발송기를 만든다. 설정으로 발송기를 만들 때만 평문 경고를 남긴다. 주입한 발송기는 이 설정을 쓰지 않는다.
  // `auth`는 인증 정보가 평문으로 나가는지만 알린다(값은 싣지 않는다, RQ-005·027).
  const accounts = new Map<string, WorkerAccount>();
  for (const account of config.smtpAccounts) {
    if (deps.sender === undefined && account.security === "none")
      deps.logger.warn("smtp_plaintext_enabled", {
        accountId: account.id,
        auth: account.auth !== null,
        message: PLAINTEXT_WARNING,
      });
    accounts.set(account.id, {
      sender:
        deps.sender ??
        createSmtpSender(
          accountSenderConfig(
            account,
            config.worker.lease.seconds,
            deps.trustedCa,
          ),
        ),
      from: account.from,
    });
  }
  const inner = createWorker(
    {
      pool: deps.pool,
      accounts,
      bodyCipher: deps.bodyCipher,
      ...(deps.clock && { clock: deps.clock }),
      ...(deps.onFatal && { onFatal: deps.onFatal }),
      logger: deps.logger,
      ...(deps.metrics && { metrics: deps.metrics }),
      instance: config.instanceId,
    },
    toWorkerOptions(config, deps.callerQuotas),
  );
  const accountIds = [...accounts.keys()];
  return {
    ...inner,
    async start() {
      // 계정마다 차단기 행이 있어야 완료 경로가 갱신할 수 있다. 실패하면 Worker를 시작하지 않는다(fail-closed, ADR-0013 결정 3 나).
      await ensureBreakerRows(deps.pool, accountIds);
      await reportOrphanJobs(deps.pool, deps.logger, accountIds);
      await inner.start();
    },
  };
}

/**
 * 구성 밖 계정의 비종결 작업을 알린다(ADR-0013 결정 2). 이 작업은 점유되지 않고 만료 sweep이 EXPIRED로 만든다.
 * 계정 ID와 건수만 담는다. 확인 쿼리가 실패해도 기동을 막지 않고 오류 이름만 남긴다.
 */
async function reportOrphanJobs(
  pool: pg.Pool,
  logger: AppLogger,
  accountIds: readonly string[],
): Promise<void> {
  try {
    for (const orphan of await countOrphanAccountJobs(pool, accountIds))
      logger.warn("account_orphan_jobs", {
        accountId: orphan.accountId,
        count: orphan.count,
      });
  } catch (error) {
    logger.warn("account_orphan_check_failed", { error: describeError(error) });
  }
}
