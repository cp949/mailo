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
 * - 종료: `stop()`은 새 점유를 멈추고 진행 중 전송을 `drainTimeoutMs`까지 기다린다. 시간이 지나면 남은 전송을 끊고
 *   결과를 기록하지 않는다. 그 작업은 lease 만료 뒤 `LEASE_EXPIRED`로 회수된다(결정 12, 중복 발송 가능, RQ-013).
 * - 시계·난수·발송기·BodyCipher는 주입한다. 작업 시각은 모두 DB `now()`다.
 */
import type pg from "pg";
import {
  claim,
  completeAttempt,
  deleteExpiredBodies,
  deleteExpiredRecords,
  recoverExpiredLeases,
  sweepExpired,
  type AccountErrorReason,
  type AttemptOutcome,
  type BodyCipher,
  type ClaimedJob,
  type CompleteDeps,
} from "../queue/index.js";
import {
  SmtpAbortedError,
  isMessageStage,
  type MailSender,
  type SmtpMessage,
  type SmtpSendResult,
} from "../smtp/index.js";
import { decodeBodyContent } from "./body-content.js";
import { systemClock, type Clock } from "./clock.js";
import { describeError, silentLogger, type WorkerLogger } from "./logger.js";
import { validateWorkerOptions, type WorkerOptions } from "./options.js";

export interface WorkerDeps {
  pool: pg.Pool;
  sender: MailSender;
  bodyCipher: BodyCipher;
  /** 작업의 `envelope.from`이 null일 때 쓰는 발신 주소(`config.smtp.defaultFrom`). */
  defaultFrom: string;
  /** 생략하면 시스템 시계다. */
  clock?: Clock;
  /** [0, 1) 난수. 재시도 jitter와 폴링 간격에 쓴다. 생략하면 Math.random이다. */
  random?: () => number;
  logger?: WorkerLogger;
}

/** `src/worker-port.ts`의 `WorkerRunner`와 같은 모양이다. */
export interface WorkerHandle {
  /** 루프를 시작하고 바로 resolve한다. 두 번 불러도 한 번만 시작한다. */
  start(): Promise<void>;
  /** 새 점유를 멈추고 진행 중 전송을 기다린다. 대기 시간 상한(`drainTimeoutMs`)이 지나면 포기하고 resolve한다. */
  stop(): Promise<void>;
}

const SWEEP_BATCH = 500;
// 배치가 계속 가득 차는 경우에도 한 주기에서 이 횟수까지만 돈다. 다음 주기가 이어받는다.
const MAX_BATCHES_PER_CYCLE = 20;
const MAX_POLL_ERROR_BACKOFF_MS = 30_000;
const COMPLETE_RETRY_DELAYS_MS = [200, 800] as const;

/** Mailo 내부 오류로 처리하지 못한 작업. 원문 없이 코드만 담는다. */
class JobDataError extends Error {
  constructor(
    readonly code:
      | "BODY_MISSING"
      | "RECIPIENTS_MALFORMED"
      | "ENVELOPE_MALFORMED",
  ) {
    super(`job data is unusable (code=${code})`);
    this.name = "JobDataError";
  }
}

export function createWorker(
  deps: WorkerDeps,
  options: WorkerOptions,
): WorkerHandle {
  validateWorkerOptions(options);
  const { pool, sender, bodyCipher, defaultFrom } = deps;
  const clock = deps.clock ?? systemClock;
  const random = deps.random ?? Math.random;
  const log = deps.logger ?? silentLogger;
  const completeDeps: CompleteDeps = {
    retry: { ...options.retry, random },
    breaker: options.breaker,
  };

  type State = "idle" | "running" | "stopping" | "stopped";
  let state: State = "idle";
  const stopController = new AbortController();
  // drain 시간 초과 때 진행 중 전송을 끊는 신호. 끊긴 작업은 결과를 기록하지 않는다.
  const sendController = new AbortController();
  const inFlight = new Set<Promise<void>>();
  // 할당 초과 호출처. 상태가 바뀔 때만 로그를 남겨 폴링마다 반복되지 않게 한다(RQ-032).
  let quotaBlocked = new Set<string>();
  let wakeUp: (() => void) | undefined;
  let pollLoop: Promise<void> | undefined;
  let maintenanceLoop: Promise<void> | undefined;
  let stopPromise: Promise<void> | undefined;

  // --- 점유·전송 루프 ---------------------------------------------------------

  function track(work: Promise<void>): void {
    const wrapped: Promise<void> = work.finally(() => {
      inFlight.delete(wrapped);
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

  async function waitForWork(delayMs: number): Promise<void> {
    // 이미 중단된 신호에는 abort 이벤트가 다시 오지 않는다.
    if (stopController.signal.aborted) return;
    const slotFreed = new Promise<void>((resolve) => {
      wakeUp = resolve;
    });
    const timerStop = new AbortController();
    const onStop = () => timerStop.abort();
    stopController.signal.addEventListener("abort", onStop, { once: true });
    try {
      await Promise.race([clock.sleep(delayMs, timerStop.signal), slotFreed]);
    } finally {
      timerStop.abort();
      stopController.signal.removeEventListener("abort", onStop);
      wakeUp = undefined;
    }
  }

  async function runPollLoop(): Promise<void> {
    let errorStreak = 0;
    while (!stopController.signal.aborted) {
      const free = options.concurrency - inFlight.size;
      if (free <= 0) {
        // 슬롯이 하나 비면 깨어난다.
        await waitForWork(options.pollMs);
        continue;
      }
      let claimed: ClaimedJob[];
      try {
        claimed = await claim(pool, {
          leaseSeconds: options.leaseSeconds,
          limit: free,
          deps: completeDeps,
          ...(options.callerQuotas && {
            callerQuotas: options.callerQuotas,
            onQuotaBlocked: reportQuotaBlocked,
          }),
        });
        errorStreak = 0;
      } catch (error) {
        errorStreak += 1;
        log.error("claim_failed", {
          error: describeError(error),
          streak: errorStreak,
        });
        await waitForWork(
          Math.min(
            MAX_POLL_ERROR_BACKOFF_MS,
            options.pollMs * 2 ** Math.min(errorStreak, 10),
          ),
        );
        continue;
      }
      // 점유한 작업은 종료 신호가 와도 끝까지 처리한다. 이미 SENDING이고 lease가 걸려 있다.
      for (const job of claimed) track(processJob(job));
      // 요청한 만큼 가득 점유했으면 바로 다음 점유를 시도하고, 모자라면 쉰다.
      if (claimed.length < free) await waitForWork(pollDelay());
    }
  }

  async function processJob(job: ClaimedJob): Promise<void> {
    let outcome: AttemptOutcome;
    try {
      const message = await buildMessage(job);
      const result = await sender.send(message, {
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
    await record(job, outcome);
  }

  async function buildMessage(job: ClaimedJob): Promise<SmtpMessage> {
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
    // 요청이 from을 생략하면 등록 때 null로 저장된다. 발신 계정 기본 주소로 채운다.
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

  async function record(
    job: ClaimedJob,
    outcome: AttemptOutcome,
  ): Promise<void> {
    // 전송은 끝났다. 기록에 실패하면 lease가 만료돼 중복 발송이 되므로 짧게 재시도한다.
    for (let i = 0; ; i++) {
      try {
        const result = await completeAttempt(
          pool,
          { id: job.id, leaseToken: job.leaseToken },
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
        const delay = COMPLETE_RETRY_DELAYS_MS[i];
        log.error("complete_failed", {
          jobId: job.id,
          error: describeError(error),
          retry: delay !== undefined,
        });
        if (delay === undefined) return; // lease 복구가 이어받는다.
        await clock.sleep(delay);
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
        sweepExpired(pool, SWEEP_BATCH),
      );
      // claim도 점유 전에 복구하지만, 점유가 멈춘 상태(차단기 open, 대기 작업 없음)에서도 회수가 돌게 한다.
      await drainBatches("lease_recovered", () =>
        recoverExpiredLeases(pool, completeDeps, SWEEP_BATCH),
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

  return {
    async start() {
      if (state === "stopping" || state === "stopped")
        throw new Error("worker already stopped");
      if (state === "running") return;
      state = "running";
      // 루프 안에서 오류를 모두 처리하지만, 예상 못한 예외가 프로세스를 죽이지 않게 마지막 방어선을 둔다.
      pollLoop = runPollLoop().catch((error: unknown) =>
        log.error("poll_loop_crashed", { error: describeError(error) }),
      );
      maintenanceLoop = runMaintenanceLoop().catch((error: unknown) =>
        log.error("maintenance_loop_crashed", { error: describeError(error) }),
      );
      log.info("worker_started", {
        concurrency: options.concurrency,
        pollMs: options.pollMs,
      });
    },

    stop() {
      stopPromise ??= (async () => {
        if (state !== "running") {
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
        })().then(() => true);

        const timeoutStop = new AbortController();
        const timedOut = clock
          .sleep(options.drainTimeoutMs, timeoutStop.signal)
          .then(() => false);
        const finished = await Promise.race([drained, timedOut]);
        timeoutStop.abort();

        if (!finished) {
          log.warn("drain_timeout", {
            inFlight: inFlight.size,
            drainTimeoutMs: options.drainTimeoutMs,
          });
          // 남은 전송을 끊는다. 결과는 기록하지 않고 lease 복구가 다룬다.
          sendController.abort();
        }
        state = "stopped";
        log.info("worker_stopped", { drained: finished });
      })();
      return stopPromise;
    },
  };
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
