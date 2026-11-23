/**
 * 발송 Worker(ADR-0002 결정 4·9~12, ADR-0007 결정 5, RQ-007·009·010·013·025).
 *
 * 흐름: 점유(`claim`) -> 본문 복호화 -> SMTP 전송 -> 결과 기록(`completeAttempt`).
 * - 점유 트랜잭션은 전송 전에 커밋되고, 전송은 트랜잭션 밖에서 한다(결정 9).
 * - 결과 기록은 별도 트랜잭션이며 lease 토큰이 맞을 때만 적용된다. lease가 이미 회수됐으면
 *   `LEASE_LOST`로 거부되고 이 Worker는 아무것도 쓰지 않는다(결정 6).
 * - 차단기: 계정 상태 오류는 `recordAccountFailure`, 정상 결과는 `recordAccountOk`다. 둘 다 `completeAttempt`의
 *   결과 기록 트랜잭션 안에서 호출된다(작업 행 -> 차단기 행 잠금 순서). Worker는 분류만 넘긴다.
 *   내부 오류(`internal`)는 계정 상태를 알려주지 않으므로 둘 다 부르지 않는다.
 *   차단기가 open이면 `claim`이 점유하지 않고, half_open이면 대표 작업 한 건만 점유한다.
 * - 별도 루프가 주기적으로 만료 sweep, lease 회수, 본문 삭제, 보존 삭제를 한다. sweep은 차단기가 open이어도 돈다(ADR-0007 결정 6).
 * - 종료: `pause()`가 새 점유를 멈추고(진행 중 전송은 계속) drain 시계를 시작한다. 종료 신호를 받은 맨 앞에서 부른다.
 *   `stop()`은 `pause()`를 포함하고 진행 중 전송을 기다린다. drain 상한(`drainTimeoutMs`)은 `pause()` 시점부터 센다.
 *   시간이 지나면 남은 전송을 끊고 결과를 기록하지 않는다. lease는 풀지 않는다.
 *   그 작업은 lease 만료 뒤 `LEASE_EXPIRED`로 회수된다(결정 12, 중복 발송 가능, RQ-013).
 * - 점유 경로(RQ-035): claim 호출마다 `claimRandom() < claimFifoRatio`이면 대기 순서 경로, 아니면 우선순위 경로다.
 *   경로 상태를 DB에 두지 않으므로 여러 인스턴스가 같은 규칙으로 동작한다.
 * - 시계·난수·발송기·BodyCipher는 주입한다. 작업 시각은 모두 DB `now()`다.
 */
import type pg from "pg";
import {
  claim,
  completeAttempt,
  MAINTENANCE_BATCH_SIZE,
  deleteExpiredBodies,
  deleteExpiredRecords,
  recoverExpiredLeases,
  sweepExpired,
  type AccountErrorReason,
  type AttemptOutcome,
  type BodyCipher,
  type ClaimedJob,
  type CompleteDeps,
  type SendControls,
} from "../queue/index.js";
import {
  SmtpAbortedError,
  isMessageStage,
  type MailSender,
  type SmtpMessage,
  type SmtpSendResult,
} from "../smtp/index.js";
import { DEFAULT_SMTP_ACCOUNT_ID } from "../config/index.js";
import { decodeBodyContent } from "./body-content.js";
import { systemClock, type Clock } from "./clock.js";
import {
  describeError,
  silentLogger,
  type AppLogger,
} from "../logging/index.js";
import { noopMetrics, type AppMetrics } from "../metrics/index.js";
import { countAttempt, countRecovered, countSwept } from "./metrics.js";
import {
  WorkerOptionsError,
  validateWorkerOptions,
  type WorkerOptions,
} from "./options.js";
import { accountSlotCap, claimLimit, rotateFrom } from "./slots.js";

/** 작업이 고정한 SMTP 계정 하나의 발송기와 기본 발신 주소(ADR-0013 결정 2). */
export interface WorkerAccount {
  sender: MailSender;
  /** 작업의 `envelope.from`이 null일 때 쓰는 이 계정의 발신 주소(`SmtpAccount.from`). */
  from: string;
  /**
   * 이 인스턴스가 이 계정에 동시에 쓰는 슬롯 상한(`SmtpAccount.concurrency`, 1~`options.concurrency`). 생략하거나 null이면
   * `max(1, C - (N - 1))`이다(ADR-0013 결정 3 바). 인스턴스별 상한이라 계정 하나의 전체 동시 전송 수는 인스턴스 수 × 이 값 이하다.
   */
  concurrency?: number | null;
  /** 이 계정의 24시간 rolling 발송 할당(`SmtpAccount.sendQuota24h`, RQ-055). 생략하거나 null이면 무제한이다. */
  sendQuota24h?: number | null;
}

export interface WorkerDeps {
  pool: pg.Pool;
  bodyCipher: BodyCipher;
  /**
   * 계정 ID별 발송기와 기본 발신 주소. 이 목록에 있는 계정의 작업만 점유한다(`claim`의 `accountIds`).
   * 점유한 작업은 자기 `account_id`의 발송기와 발신 주소로 전송한다. 이 인스턴스는 호출처 매핑을 읽지 않는다.
   * `sender`·`defaultFrom`과 함께 쓸 수 없다.
   */
  accounts?: ReadonlyMap<string, WorkerAccount>;
  /** `accounts`를 생략한 단일 계정 형태의 발송기. `default` 계정 하나가 된다. */
  sender?: MailSender;
  /** `accounts`를 생략한 단일 계정 형태의 발신 주소. `sender`와 함께 준다. */
  defaultFrom?: string;
  /** 생략하면 시스템 시계다. */
  clock?: Clock;
  /** [0, 1) 난수. 재시도 jitter와 폴링 간격에 쓴다. 생략하면 Math.random이다. */
  random?: () => number;
  /**
   * [0, 1) 난수. claim 경로 선택에만 쓴다(RQ-035). 생략하면 Math.random이다.
   * jitter 난수(`random`)와 나눈 이유: 테스트가 둘 중 하나만 고정해도 다른 쪽 결과가 바뀌지 않게 한다.
   */
  claimRandom?: () => number;
  logger?: AppLogger;
  /** counter 증가 대상(RQ-049, ADR-0012 결정 7). 생략하면 아무것도 세지 않는다. */
  metrics?: AppMetrics;
  /** 로그의 `instance`와 같은 값. 시도 기록(`mail_attempts.instance`)에 남겨 로그와 DB 행을 잇는다. 생략하면 NULL이다. */
  instance?: string;
  /**
   * 점유 루프가 예상 못한 예외로 끝났을 때 한 번 부른다. 루프는 되살리지 않는다.
   * 호출자가 정상 종료 경로(`pause`·`stop`)를 거쳐 프로세스를 끝내 재시작을 유도한다.
   * 즉시 exit하면 진행 중 SMTP 전송이 끊겨 중복 발송이 생긴다.
   */
  onFatal?: (reason: "poll_loop_crashed") => void;
}

/** 헬스가 읽는 Worker 상태. 메일 본문·수신자·작업 ID는 담지 않는다. */
export interface WorkerStatus {
  state: "idle" | "running" | "paused" | "stopping" | "stopped";
  inFlight: number;
  /** 점유 루프가 마지막으로 한 바퀴를 시작한 시각. 큐가 비어 있어도 갱신된다. 아직 안 돌았으면 null. */
  lastPollAt: Date | null;
  /** `lastPollAt`부터 지난 초(단조 시계). */
  lastPollAgeSeconds: number | null;
  /** 점유(`claim`)가 연속으로 실패한 횟수. 성공하면 0이다. */
  claimFailureStreak: number;
  /** 점유 루프가 예외로 끝났다. 이 상태에서는 더 점유하지 않는다. */
  pollLoopCrashed: boolean;
}

/** `src/worker-port.ts`의 `WorkerRunner`와 같은 모양이다. */
export interface WorkerHandle {
  /** 루프를 시작하고 바로 resolve한다. 두 번 불러도 한 번만 시작한다. */
  start(): Promise<void>;
  /**
   * 새 점유를 멈춘다. 진행 중 전송과 주기 작업은 계속한다. 이 호출이 resolve하면 더는 점유하지 않는다.
   * drain 대기 시간(`drainTimeoutMs`)의 시계가 여기서 시작한다. 여러 번 불러도 한 번만 동작한다.
   */
  pause(): Promise<void>;
  /** `pause()` 뒤 진행 중 전송을 기다린다. 대기 시간 상한(`drainTimeoutMs`)이 지나면 포기하고 resolve한다. */
  stop(): Promise<void>;
  /** 현재 상태 스냅샷. 쿼리를 보내지 않는다. */
  status(): WorkerStatus;
}

const SWEEP_BATCH = MAINTENANCE_BATCH_SIZE;
// 배치가 계속 가득 차는 경우에도 한 주기에서 이 횟수까지만 돈다. 다음 주기가 이어받는다.
const MAX_BATCHES_PER_CYCLE = 20;
const MAX_POLL_ERROR_BACKOFF_MS = 30_000;
// 결과 기록 재시도: 200ms부터 2배씩, 간격 상한 5초, ±20% jitter. 끝나는 시각은 lease 잔여 시간이 정한다.
const COMPLETE_RETRY_BASE_MS = 200;
const COMPLETE_RETRY_MAX_MS = 5_000;
// lease 만료 전에 기록을 마치기 위한 여유(smtp의 DEFAULT_LEASE_MARGIN_MS와 같다).
const COMPLETE_LEASE_MARGIN_MS = 10_000;

/** Mailo 내부 오류로 처리하지 못한 작업. 원문 없이 코드만 담는다. */
class JobDataError extends Error {
  constructor(
    readonly code:
      | "BODY_MISSING"
      | "RECIPIENTS_MALFORMED"
      | "ENVELOPE_MALFORMED"
      | "ACCOUNT_UNAVAILABLE",
  ) {
    super(`job data is unusable (code=${code})`);
    this.name = "JobDataError";
  }
}

/** `accounts` 또는 단일 계정 형태(`sender`+`defaultFrom`)를 계정 맵으로 바꾼다. 둘을 함께 주거나 둘 다 없으면 던진다. */
function resolveAccounts(deps: WorkerDeps): ReadonlyMap<string, WorkerAccount> {
  const single = deps.sender !== undefined || deps.defaultFrom !== undefined;
  if (deps.accounts !== undefined) {
    if (single)
      throw new Error("accounts와 sender·defaultFrom은 함께 쓸 수 없다");
    if (deps.accounts.size === 0) throw new Error("accounts가 비어 있다");
    return deps.accounts;
  }
  if (deps.sender === undefined || deps.defaultFrom === undefined)
    throw new Error("accounts 또는 sender와 defaultFrom이 필요하다");
  return new Map([
    [DEFAULT_SMTP_ACCOUNT_ID, { sender: deps.sender, from: deps.defaultFrom }],
  ]);
}

/** 24시간 할당의 rolling 창(초). 호출처 할당과 같다(RQ-032). */
const ACCOUNT_QUOTA_WINDOW_SECONDS = 86_400;

/**
 * 계정 구성이 Worker 옵션과 맞는지 확인한다(ADR-0013 결정 1·3). 어긋나면 기동을 거부한다.
 * - 계정 수 N은 전체 동시성 C 이하여야 한다. 계정마다 슬롯 하나를 보장하려는 조건이다.
 * - 계정의 `concurrency`는 1 이상 C 이하의 정수다.
 * - 계정의 `sendQuota24h`는 양의 정수다. 사용량은 최근 24시간의 시도 기록을 세므로 기록 보존이 24시간 이상이어야 한다.
 * 오류에는 필드 이름만 담는다. 계정 ID·한도 값은 담지 않는다.
 */
function validateAccounts(
  accounts: ReadonlyMap<string, WorkerAccount>,
  options: WorkerOptions,
): void {
  if (accounts.size > options.concurrency)
    throw new WorkerOptionsError("accounts");
  let hasQuota = false;
  for (const account of accounts.values()) {
    const { concurrency, sendQuota24h } = account;
    if (
      concurrency != null &&
      (!Number.isInteger(concurrency) ||
        concurrency < 1 ||
        concurrency > options.concurrency)
    )
      throw new WorkerOptionsError("accountConcurrency");
    if (sendQuota24h != null) {
      if (!Number.isInteger(sendQuota24h) || sendQuota24h < 1)
        throw new WorkerOptionsError("accountQuota");
      hasQuota = true;
    }
  }
  if (
    hasQuota &&
    options.retention.recordSeconds < ACCOUNT_QUOTA_WINDOW_SECONDS
  )
    throw new WorkerOptionsError("accountQuota.retention");
}

export function createWorker(
  deps: WorkerDeps,
  options: WorkerOptions,
): WorkerHandle {
  validateWorkerOptions(options);
  const { pool, bodyCipher } = deps;
  const accounts = resolveAccounts(deps);
  validateAccounts(accounts, options);
  const accountIds = [...accounts.keys()];
  // 계정별 슬롯 상한 `cap_a`(ADR-0013 결정 3 바). 기동 때 한 번 정한다.
  const caps = new Map(
    accountIds.map((id) => [
      id,
      accountSlotCap(
        { concurrency: accounts.get(id)!.concurrency ?? null },
        options.concurrency,
        accountIds.length,
      ),
    ]),
  );
  const clock = deps.clock ?? systemClock;
  const random = deps.random ?? Math.random;
  const claimRandom = deps.claimRandom ?? Math.random;
  const log = deps.logger ?? silentLogger;
  const metrics = deps.metrics ?? noopMetrics;
  const completeDeps: CompleteDeps = {
    retry: { ...options.retry, random },
    breaker: options.breaker,
  };

  type State = "idle" | "running" | "paused" | "stopping" | "stopped";
  let state: State = "idle";
  // 점유 루프만 멈춘다(`pause`). 진행 중 전송은 계속한다.
  const pauseController = new AbortController();
  // 주기 작업 루프까지 멈춘다(`stop`).
  const stopController = new AbortController();
  // drain 시간 초과 때 진행 중 전송을 끊는 신호. 끊긴 작업은 결과를 기록하지 않는다.
  const sendController = new AbortController();
  const inFlight = new Set<Promise<void>>();
  // 계정별 진행 중 전송 수. 슬롯 상한(`cap_a`)과 비교한다. `inFlight.size`의 계정별 분해다.
  const inFlightByAccount = new Map<string, number>();
  // 계정별 claim 오류 백오프의 끝(단조 시계 ms). 이 시각 전에는 그 계정의 claim을 부르지 않는다.
  const claimBackoffUntil = new Map<string, number>();
  // 24시간 할당을 넘긴 계정. 상태가 바뀔 때만 로그를 남긴다(RQ-055).
  const quotaBlockedAccounts = new Set<string>();
  // 할당 초과 호출처. 상태가 바뀔 때만 로그를 남겨 폴링마다 반복되지 않게 한다(RQ-032).
  let quotaBlocked = new Set<string>();
  // 마지막으로 관찰한 발송 정지 상태. 바뀔 때만 로그를 남긴다(RQ-043). 처음 관찰이 정지면 `send_paused`를 한 번 남긴다.
  let observedAllPaused = false;
  let observedPausedCallers = new Set<string>();
  let observedPausedAccounts = new Set<string>();
  let wakeUp: (() => void) | undefined;
  let pollLoop: Promise<void> | undefined;
  let lastPollMono: number | undefined;
  let lastPollWall: number | undefined;
  let claimFailureStreak = 0;
  // 계정별 연속 claim 실패 횟수. 성공하면 지운다. `claimFailureStreak`은 이 중 최댓값이다.
  const claimFailures = new Map<string, number>();
  let pollLoopCrashed = false;
  let pollLoopDone = false;
  let maintenanceLoop: Promise<void> | undefined;
  let stopPromise: Promise<void> | undefined;
  let pausePromise: Promise<void> | undefined;
  // drain 시간 상한. `pause()`에서 시작해 `true`(시간 초과) 또는 취소 때 resolve한다.
  let drainDeadline: Promise<boolean> | undefined;
  const drainTimerStop = new AbortController();

  // --- 점유·전송 루프 ---------------------------------------------------------

  function track(work: Promise<void>, accountId: string): void {
    inFlightByAccount.set(
      accountId,
      (inFlightByAccount.get(accountId) ?? 0) + 1,
    );
    const wrapped: Promise<void> = work.finally(() => {
      inFlight.delete(wrapped);
      inFlightByAccount.set(
        accountId,
        (inFlightByAccount.get(accountId) ?? 1) - 1,
      );
      wakeUp?.();
    });
    inFlight.add(wrapped);
  }

  /** 폴링 간격을 ±10% 흩뿌려 인스턴스들이 같은 순간에 DB를 두드리지 않게 한다. */
  function pollDelay(): number {
    return Math.round(options.pollMs * (1 + 0.1 * (2 * random() - 1)));
  }

  /** 할당 초과 호출처 집합이 바뀐 경우에만 로그를 남긴다. 호출처 ID와 한도만 담는다. */
  function reportQuotaBlocked(
    blocked: ReadonlyArray<{ callerId: string; limit: number }>,
  ): void {
    const next = new Set(blocked.map((b) => b.callerId));
    for (const b of blocked) {
      if (!quotaBlocked.has(b.callerId))
        log.warn("caller_quota_exceeded", {
          callerId: b.callerId,
          limit: b.limit,
        });
    }
    for (const id of quotaBlocked) {
      if (!next.has(id)) log.info("caller_quota_recovered", { callerId: id });
    }
    quotaBlocked = next;
  }

  /** 계정 24시간 할당 초과 상태가 바뀐 경우에만 로그를 남긴다. 계정 ID와 한도만 담는다(RQ-055). */
  function reportAccountQuota(
    accountId: string,
    blocked: { limit: number } | null,
  ): void {
    if (blocked) {
      if (!quotaBlockedAccounts.has(accountId)) {
        quotaBlockedAccounts.add(accountId);
        log.warn("account_quota_exceeded", { accountId, limit: blocked.limit });
      }
    } else if (quotaBlockedAccounts.delete(accountId)) {
      log.info("account_quota_recovered", { accountId });
    }
  }

  /** 발송 정지 상태가 바뀐 경우에만 로그를 남긴다. 범위와 호출처·계정 ID만 담는다(ADR-0011 결정 2, ADR-0013 결정 3 다). */
  function reportSendControls(controls: SendControls): void {
    if (controls.allPaused !== observedAllPaused) {
      if (controls.allPaused) log.warn("send_paused", { scope: "all" });
      else log.info("send_resumed", { scope: "all" });
      observedAllPaused = controls.allPaused;
    }
    const next = new Set(controls.pausedCallerIds);
    for (const id of next) {
      if (!observedPausedCallers.has(id))
        log.warn("send_paused", { scope: "caller", callerId: id });
    }
    for (const id of observedPausedCallers) {
      if (!next.has(id))
        log.info("send_resumed", { scope: "caller", callerId: id });
    }
    observedPausedCallers = next;
    const nextAccounts = new Set(controls.pausedAccountIds);
    for (const id of nextAccounts) {
      if (!observedPausedAccounts.has(id))
        log.warn("send_paused", { scope: "account", accountId: id });
    }
    for (const id of observedPausedAccounts) {
      if (!nextAccounts.has(id))
        log.info("send_resumed", { scope: "account", accountId: id });
    }
    observedPausedAccounts = nextAccounts;
  }

  async function waitForWork(delayMs: number): Promise<void> {
    // 이미 중단된 신호에는 abort 이벤트가 다시 오지 않는다.
    if (pauseController.signal.aborted) return;
    const slotFreed = new Promise<void>((resolve) => {
      wakeUp = resolve;
    });
    const timerStop = new AbortController();
    const onStop = () => timerStop.abort();
    pauseController.signal.addEventListener("abort", onStop, { once: true });
    try {
      await Promise.race([clock.sleep(delayMs, timerStop.signal), slotFreed]);
    } finally {
      timerStop.abort();
      pauseController.signal.removeEventListener("abort", onStop);
      wakeUp = undefined;
    }
  }

  async function runPollLoop(): Promise<void> {
    while (!pauseController.signal.aborted) {
      lastPollMono = clock.now();
      lastPollWall = Date.now();
      const free = options.concurrency - inFlight.size;
      if (free <= 0) {
        // 슬롯이 하나 비면 깨어난다.
        await waitForWork(options.pollMs);
        continue;
      }
      const claimed: ClaimedJob[] = [];
      // lease는 claim 쿼리 안에서 시작하므로 호출 전 시각이 가장 이른 기준이다(단조 시계).
      const claimStartedAt = clock.now();
      // 계정마다 claim을 부른다(ADR-0013 결정 3 가·바). 라운드마다 시작 계정을 무작위로 돌려 앞 계정이 슬롯을 독점하지 않게 한다.
      // 계정 하나일 때는 난수를 뽑지 않는다. lease 복구는 라운드에서 처음 부르는 claim에서만 한다.
      // 구성에서 빠진 계정의 작업은 어느 호출도 점유하지 않는다. 만료 sweep이 EXPIRED로 만든다(ADR-0013 결정 2).
      const round =
        accountIds.length > 1
          ? rotateFrom(
              accountIds,
              Math.floor(claimRandom() * accountIds.length),
            )
          : accountIds;
      let recover = true;
      let attempted = 0;
      let failures = 0;
      let saturated = false;
      for (const accountId of round) {
        const remaining = free - claimed.length;
        if (remaining <= 0) break;
        const until = claimBackoffUntil.get(accountId);
        if (until !== undefined && clock.now() < until) continue;
        const limit = claimLimit({
          cap: caps.get(accountId)!,
          inFlight:
            (inFlightByAccount.get(accountId) ?? 0) +
            claimed.filter((j) => j.accountId === accountId).length,
          remaining,
        });
        if (limit <= 0) continue;
        attempted += 1;
        const quota = accounts.get(accountId)!.sendQuota24h ?? undefined;
        const recoverLeases = recover;
        recover = false;
        try {
          const jobs = await claim(pool, {
            accountId,
            recoverLeases,
            leaseSeconds: options.leaseSeconds,
            limit,
            deps: completeDeps,
            // [0, 1) 난수라 비율 0이면 항상 우선순위 경로, 1이면 항상 대기 순서 경로다.
            order: claimRandom() < options.claimFifoRatio ? "fifo" : "priority",
            onSendControls: reportSendControls,
            onLeaseRecovered: (transitions) =>
              countRecovered(metrics, transitions),
            ...(options.callerQuotas && {
              callerQuotas: options.callerQuotas,
              onQuotaBlocked: reportQuotaBlocked,
            }),
            ...(quota !== undefined && {
              accountQuota: quota,
              onAccountQuota: (blocked: { limit: number } | null) =>
                reportAccountQuota(accountId, blocked),
            }),
          });
          claimed.push(...jobs);
          // 요청한 만큼 가득 점유한 계정이 있으면 더 있을 수 있다.
          if (jobs.length >= limit) saturated = true;
          claimFailures.delete(accountId);
          claimBackoffUntil.delete(accountId);
          metrics.inc("mailo_claim_polls_total", {
            result: jobs.length > 0 ? "claimed" : "empty",
          });
        } catch (error) {
          failures += 1;
          const streak = (claimFailures.get(accountId) ?? 0) + 1;
          claimFailures.set(accountId, streak);
          // 한 계정의 오류는 그 계정에서만 지수 백오프한다. 다른 계정은 계속 점유한다.
          claimBackoffUntil.set(
            accountId,
            clock.now() + claimBackoffMs(streak),
          );
          metrics.inc("mailo_claim_polls_total", { result: "error" });
          log.error("claim_failed", {
            accountId,
            error: describeError(error),
            streak,
          });
        }
      }
      claimFailureStreak = Math.max(0, ...claimFailures.values());
      // drain 상한이 지나 전송을 끊은 뒤에 늦게 돌아온 점유는 처리하지 않는다. lease 만료 뒤 복구가 다룬다.
      if (sendController.signal.aborted) {
        if (claimed.length > 0)
          log.warn("claim_after_drain_timeout", { count: claimed.length });
        return;
      }
      for (const job of claimed)
        metrics.inc("mailo_claimed_jobs_total", { caller_id: job.callerId });
      // 점유한 작업은 종료 신호가 와도 끝까지 처리한다. 이미 SENDING이고 lease가 걸려 있다.
      for (const job of claimed)
        track(processJob(job, claimStartedAt), job.accountId);
      // 한 라운드에서 가득 점유한 계정이 있으면 바로 다음 라운드를 돌고, 아니면 쉰다.
      // 호출한 계정이 모두 실패했으면 연속 실패 횟수에 따라 지수 백오프한다(계정 하나일 때 이전 동작과 같다).
      if (attempted > 0 && failures === attempted)
        await waitForWork(claimBackoffMs(claimFailureStreak));
      else if (!saturated) await waitForWork(pollDelay());
    }
  }

  /** claim 오류 뒤 기다리는 시간. `pollMs`에서 시작해 연속 실패마다 2배, 상한 30초. */
  function claimBackoffMs(streak: number): number {
    return Math.min(
      MAX_POLL_ERROR_BACKOFF_MS,
      options.pollMs * 2 ** Math.min(streak, 10),
    );
  }

  async function processJob(
    job: ClaimedJob,
    claimStartedAt: number,
  ): Promise<void> {
    let outcome: AttemptOutcome;
    try {
      // `claim`이 구성한 계정만 점유하므로 정상 경로에서는 항상 찾는다. 못 찾으면 내부 오류로 끝낸다(차단기는 건드리지 않는다).
      const account = accounts.get(job.accountId);
      if (account === undefined) throw new JobDataError("ACCOUNT_UNAVAILABLE");
      const message = await buildMessage(job, account.from);
      const result = await account.sender.send(message, {
        signal: sendController.signal,
      });
      outcome = toOutcome(result);
    } catch (error) {
      if (error instanceof SmtpAbortedError) {
        // drain 시간 초과로 끊었다. 서버가 수락했는지 모르므로 기록하지 않고 lease 복구에 맡긴다.
        log.warn("send_aborted", { jobId: job.id });
        return;
      }
      outcome = internalFailure(job, error);
      log.error("job_internal_error", {
        jobId: job.id,
        error: describeError(error),
        attempt: job.attempts + 1,
      });
    }
    await record(job, outcome, claimStartedAt);
  }

  async function buildMessage(
    job: ClaimedJob,
    defaultFrom: string,
  ): Promise<SmtpMessage> {
    if (job.body === null) throw new JobDataError("BODY_MISSING");
    const plaintext = await bodyCipher.decrypt(job.id, job.body);
    const content = decodeBodyContent(plaintext);
    const recipients = asRecord(job.recipients);
    const to = stringList(recipients?.["to"]);
    const cc = stringList(recipients?.["cc"] ?? []);
    const bcc = stringList(recipients?.["bcc"] ?? []);
    if (!to || !cc || !bcc || to.length + cc.length + bcc.length === 0) {
      throw new JobDataError("RECIPIENTS_MALFORMED");
    }
    const envelope = asRecord(job.envelope);
    // 요청이 from을 생략하면 등록 때 null로 저장된다. 작업 계정의 기본 발신 주소로 채운다(ADR-0013 결정 6).
    const from = envelope?.["from"] ?? defaultFrom;
    const replyTo = envelope?.["replyTo"];
    if (
      typeof from !== "string" ||
      (replyTo != null && typeof replyTo !== "string")
    ) {
      throw new JobDataError("ENVELOPE_MALFORMED");
    }
    return {
      jobId: job.id,
      from,
      replyTo: replyTo ?? null,
      to,
      cc,
      bcc,
      subject: content.subject,
      text: content.text,
      html: content.html,
    };
  }

  /**
   * 내부 오류를 작업 결과로 바꾼다. 같은 작업이 `poisonMaxAttempts`번째 시도에서도 실패하면 FAILED다.
   * 본문이 없는 작업은 다시 시도해도 같으므로 바로 FAILED다.
   * `internal: true`로 표시해 큐가 차단기를 건드리지 않게 한다. 계정 상태를 확인하지 못한 결과라서,
   * half_open 대표 작업이 내부 오류로 끝나도 차단기가 closed로 돌아가면 안 된다.
   */
  function internalFailure(job: ClaimedJob, error: unknown): AttemptOutcome {
    const permanent =
      (error instanceof JobDataError && error.code === "BODY_MISSING") ||
      job.attempts + 1 >= options.poisonMaxAttempts;
    return {
      classification: permanent ? "PERMANENT" : "TRANSIENT",
      internal: true,
      stage: "WORKER",
      responseText: `internal_error ${describeError(error)}`,
    };
  }

  /**
   * 전송 결과를 기록한다. 기록에 실패하면 lease가 만료돼 중복 발송이 되므로 lease가 끝나기 전까지 backoff로 재시도한다.
   * 마감은 `claim` 호출 전 시각 + lease - 여유(단조 시계)다. lease가 5초 같이 짧으면 여유를 lease의 절반으로 줄인다.
   * 마감이 지났거나 drain 시간 초과로 전송을 끊었으면 포기한다. 첫 시도는 항상 한다.
   * 재시도는 "다음 시도 시작 + 시도 하나의 최악 시간(`recordAttemptMaxMs`) < 마감"일 때만 한다(N4). 마감 직전에 시작한 시도가
   * 응답 없는 연결에 걸려 lease를 넘기면 다른 인스턴스가 회수해 다시 발송하기 때문이다.
   */
  async function record(
    job: ClaimedJob,
    outcome: AttemptOutcome,
    claimStartedAt: number,
  ): Promise<void> {
    const leaseMs = options.leaseSeconds * 1000;
    const deadline =
      claimStartedAt +
      leaseMs -
      Math.min(COMPLETE_LEASE_MARGIN_MS, leaseMs / 2);
    for (let i = 0; ; i++) {
      try {
        const result = await completeAttempt(
          pool,
          {
            id: job.id,
            leaseToken: job.leaseToken,
            ...(deps.instance !== undefined && { instance: deps.instance }),
          },
          outcome,
          completeDeps,
        );
        if (!result.applied) {
          // 전송 중 lease가 회수됐다(타임아웃 설정이 lease보다 길거나 프로세스가 오래 멈췄다). 이 결과는 버린다.
          log.warn("lease_lost", {
            jobId: job.id,
            classification: outcome.classification,
          });
          return;
        }
        log.info("job_completed", {
          jobId: job.id,
          status: result.status,
          classification: outcome.classification,
          probe: job.isProbe,
        });
        countAttempt(metrics, job, outcome, result.status);
        const breaker = result.breaker;
        if (
          outcome.classification === "ACCOUNT" &&
          breaker &&
          breaker.state !== "closed"
        ) {
          log.warn("breaker_not_closed", {
            state: breaker.state,
            reason: breaker.lastReason,
            openUntil: breaker.openUntil?.toISOString() ?? null,
            waitSeconds: breaker.waitSeconds,
          });
        }
        return;
      } catch (error) {
        const base = Math.min(
          COMPLETE_RETRY_MAX_MS,
          COMPLETE_RETRY_BASE_MS * 2 ** Math.min(i, 10),
        );
        const delay = Math.round(base * (1 + 0.2 * (2 * random() - 1)));
        const retry =
          !sendController.signal.aborted &&
          clock.now() + delay + (options.recordAttemptMaxMs ?? 0) < deadline;
        log.error("complete_failed", {
          jobId: job.id,
          error: describeError(error),
          attempt: i + 1,
          retry,
        });
        if (!retry) return; // lease 복구가 이어받는다.
        await clock.sleep(delay, sendController.signal);
      }
    }
  }

  // --- 주기 작업 --------------------------------------------------------------

  async function drainBatches(
    name: string,
    step: () => Promise<number>,
  ): Promise<void> {
    try {
      for (
        let i = 0;
        i < MAX_BATCHES_PER_CYCLE && !stopController.signal.aborted;
        i++
      ) {
        const n = await step();
        if (n > 0) log.info(name, { count: n });
        if (n < SWEEP_BATCH) return;
      }
    } catch (error) {
      log.error(`${name}_failed`, { error: describeError(error) });
    }
  }

  async function runMaintenanceLoop(): Promise<void> {
    let nextCleanupAt = clock.now();
    while (!stopController.signal.aborted) {
      await drainBatches("sweep_expired", () =>
        sweepExpired(pool, SWEEP_BATCH, (t) => countSwept(metrics, t)),
      );
      // claim도 점유 전에 복구하지만, 점유가 멈춘 상태(차단기 open, 대기 작업 없음)에서도 회수가 돌게 한다.
      await drainBatches("lease_recovered", () =>
        recoverExpiredLeases(pool, completeDeps, SWEEP_BATCH, {
          exclusive: true,
          onRecovered: (t) => countRecovered(metrics, t),
        }),
      );
      if (clock.now() >= nextCleanupAt) {
        nextCleanupAt = clock.now() + options.cleanupIntervalMs;
        await drainBatches("bodies_deleted", () =>
          deleteExpiredBodies(
            pool,
            options.retention.bodyGraceSeconds,
            SWEEP_BATCH,
          ),
        );
        await drainBatches("records_deleted", async () => {
          const r = await deleteExpiredRecords(
            pool,
            options.retention.recordSeconds,
            SWEEP_BATCH,
          );
          return Math.max(r.jobs, r.rejections);
        });
      }
      await clock.sleep(options.sweepIntervalMs, stopController.signal);
    }
  }

  // --- 수명 주기 --------------------------------------------------------------

  async function start(): Promise<void> {
    if (state === "stopping" || state === "stopped")
      throw new Error("worker already stopped");
    if (state === "running") return;
    state = "running";
    // 루프 안에서 오류를 모두 처리하지만, 예상 못한 예외가 프로세스를 죽이지 않게 마지막 방어선을 둔다.
    pollLoop = runPollLoop()
      .catch((error: unknown) => {
        pollLoopCrashed = true;
        log.error("poll_loop_crashed", { error: describeError(error) });
        deps.onFatal?.("poll_loop_crashed");
      })
      .finally(() => {
        pollLoopDone = true;
      });
    maintenanceLoop = runMaintenanceLoop().catch((error: unknown) =>
      log.error("maintenance_loop_crashed", { error: describeError(error) }),
    );
    log.info("worker_started", {
      concurrency: options.concurrency,
      pollMs: options.pollMs,
      accounts: accountIds.length,
    });
  }

  function pause(): Promise<void> {
    pausePromise ??= (async () => {
      if (state === "idle") state = "stopped"; // 시작하지 않은 Worker는 바로 종료 상태다.
      if (state !== "running") return;
      state = "paused";
      log.info("worker_paused", { inFlight: inFlight.size });
      pauseController.abort();
      // drain 상한은 종료 신호를 받은 시점부터 센다. HTTP 서버를 닫는 시간도 포함한다.
      drainDeadline = clock
        .sleep(options.drainTimeoutMs, drainTimerStop.signal)
        .then(() => true);
      // 진행 중이던 점유 호출이 끝나 새 작업이 `inFlight`에 들어간 뒤에 resolve한다.
      // DB가 응답하지 않으면 점유 호출이 오래 걸릴 수 있다. drain 상한까지만 기다려 종료가 멈추지 않게 한다.
      // 늦게 돌아온 점유는 drain 시간 초과 뒤라면 `runPollLoop`가 버린다.
      const timedOut = await Promise.race([
        pollLoop!.then(() => false),
        drainDeadline.then(() => true),
      ]);
      if (timedOut)
        log.warn("pause_timeout", { drainTimeoutMs: options.drainTimeoutMs });
    })();
    return pausePromise;
  }

  function stop(): Promise<void> {
    stopPromise ??= (async () => {
      await pause();
      if (state !== "paused") {
        state = "stopped";
        return;
      }
      state = "stopping";
      log.info("worker_stopping", { inFlight: inFlight.size });
      stopController.abort();

      const drained = (async () => {
        await Promise.all([pollLoop, maintenanceLoop]);
        // 루프가 끝난 뒤에는 새 작업이 추가되지 않는다.
        while (inFlight.size > 0) await Promise.all(inFlight);
      })().then(() => false);

      const timedOut = await Promise.race([drained, drainDeadline!]);
      drainTimerStop.abort();
      // 시간이 먼저 지났어도 그 사이 전송이 모두 끝났으면 정상 종료다.
      // 점유 호출이 끝나지 않은 채 시간이 지났어도 미완료로 본다. 늦게 돌아온 점유를 버리게 전송 취소 신호를 올린다.
      const finished = (!timedOut || inFlight.size === 0) && pollLoopDone;

      if (!finished) {
        log.warn("drain_timeout", {
          inFlight: inFlight.size,
          drainTimeoutMs: options.drainTimeoutMs,
        });
        // 남은 전송을 끊는다. 결과는 기록하지 않고 lease는 풀지 않는다. lease 복구가 다룬다.
        sendController.abort();
      }
      state = "stopped";
      log.info("worker_stopped", { drained: finished });
    })();
    return stopPromise;
  }

  function status(): WorkerStatus {
    return {
      state,
      inFlight: inFlight.size,
      lastPollAt: lastPollWall === undefined ? null : new Date(lastPollWall),
      lastPollAgeSeconds:
        lastPollMono === undefined
          ? null
          : Math.max(0, Math.round((clock.now() - lastPollMono) / 1000)),
      claimFailureStreak,
      pollLoopCrashed,
    };
  }

  return { start, pause, stop, status };
}

// --- 변환 ---------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringList(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((v) => typeof v === "string")
    ? (value as string[])
    : undefined;
}

/** `smtp`의 사유를 큐의 차단기 사유로 바꾼다. 연결·TLS·인증은 초기 대기가 같지만 사유를 구분해 남긴다. */
function accountReason(
  result: Extract<SmtpSendResult, { kind: "ACCOUNT" }>,
): AccountErrorReason {
  if (result.reason === "DAILY_LIMIT") return "DAILY_LIMIT";
  if (result.reason === "BURST_LIMIT") return "RATE_LIMIT";
  switch (result.failure.stage) {
    case "CONN":
      return "CONNECTION";
    case "TLS":
      return "TLS";
    case "AUTH":
      return "AUTH";
    default:
      return "OTHER";
  }
}

export function toOutcome(result: SmtpSendResult): AttemptOutcome {
  if (result.kind === "SENT") {
    // 거부된 수신자가 없으면 null이다. 있으면 주소와 응답을 시도 기록과 JOB_SENT 이벤트에 남긴다(RQ-016).
    return {
      classification: "SENT",
      rejectedRecipients:
        result.rejectedRecipients.length > 0
          ? result.rejectedRecipients.map((r) => ({ ...r }))
          : null,
    };
  }
  const detail = {
    stage: result.failure.stage,
    responseCode: result.failure.responseCode ?? null,
    enhancedCode: result.failure.enhancedStatus ?? null,
    responseText: result.failure.responseText ?? null,
  };
  if (result.kind === "ACCOUNT") {
    return {
      classification: "ACCOUNT",
      reason: accountReason(result),
      // MAIL FROM 이후 단계의 계정 상태 오류만 작업별 account_trips로 센다(ADR-0007 결정 4).
      afterMailFrom: isMessageStage(result.failure.stage),
      ...detail,
    };
  }
  return { classification: result.kind, ...detail };
}
