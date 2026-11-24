/**
 * 결과 불명 `fail` 판정(RQ-073·074, ADR-0015 결정 5·7·8·9)의 큐 계층 검증. 실제 PostgreSQL을 쓴다.
 * 고정하는 것:
 * - 불명 두 경로(`LEASE_EXPIRED`, DATA 단계 응답 없는 `TRANSIENT`)가 각각 `retry`면 재시도, `fail`이면 `FAILED`·`OUTCOME_UNKNOWN`이다.
 * - 두 조건 밖(응답 코드가 있는 실패, DATA 이전 단계, 내부 오류, 계정 상태 오류, 성공)은 `fail`이어도 기존 판정이다.
 * - `OUTCOME_UNKNOWN`이 시도 소진·만료보다 먼저다.
 * - 차단기 영향이 `retry`와 같다(`recordAccountOk`는 일반 `TRANSIENT`만, `LEASE_EXPIRED`·내부 오류는 건드리지 않음).
 * - 판정 함수(`isUncertainOutcome`)가 읽기 쪽 SQL(`outcomeUncertain`, RQ-048)과 같은 조건이다.
 * - 컬럼 없이 만든 구버전 행은 `retry`로 취급한다.
 * 값은 모두 가짜(canary)다.
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "@jest/globals";
import {
  claim,
  completeAttempt,
  findJobById,
  getBreakerState,
  isUncertainOutcome,
  recoverExpiredLeases,
  register,
  type AttemptOutcome,
  type ClaimedJob,
  type JobTransition,
  type OnUncertain,
} from "../../src/queue/index.js";
import { UNCERTAIN_ATTEMPT_SQL } from "../../src/queue/uncertain.js";
import { createTestDatabase, type TestDatabase } from "../support/database.js";
import {
  completeDeps,
  createJob,
  jobInput,
  migrate,
  registerDeps,
} from "../support/queue-fixtures.js";

const CANARY_TO = "canary-to-u41c@example.invalid";
const RECIPIENTS = { to: [CANARY_TO] };

// 응답 없이 끝난 DATA 단계 일시 오류(타임아웃·연결 끊김)
const DATA_NO_RESPONSE: AttemptOutcome = {
  classification: "TRANSIENT",
  stage: "DATA",
};

describe("PostgreSQL 통합: 결과 불명 opt-in 종결(RQ-073·074, ADR-0015 결정 5~9)", () => {
  let db: TestDatabase;
  const deps = completeDeps({ maxAttempts: 3 });
  const claimOpts = { leaseSeconds: 120, limit: 1, deps };

  beforeAll(async () => {
    db = await createTestDatabase();
    await migrate(db.pool);
  });

  beforeEach(async () => {
    await db.pool.query("DELETE FROM mail_jobs");
    await db.pool.query(
      `UPDATE mail_circuit_breaker SET state = 'closed', open_until = NULL, probe_until = NULL,
         probe_job_id = NULL, consecutive_failures = 0, wait_seconds = 0, last_reason = NULL,
         last_trip_job_id = NULL, last_trip_token = NULL`,
    );
  });

  afterAll(async () => {
    await db.close();
  });

  const breaker = () => getBreakerState(db.pool, deps.breaker);

  const create = (onUncertain?: OnUncertain, overrides = {}) =>
    createJob(db.pool, {
      recipients: RECIPIENTS,
      ...(onUncertain !== undefined && { onUncertain }),
      ...overrides,
    });

  async function claimOne(id: string): Promise<ClaimedJob> {
    const [job] = await claim(db.pool, claimOpts);
    if (job?.id !== id) throw new Error("의도한 작업이 점유되지 않았다");
    return job;
  }

  async function jobRow(id: string) {
    const { rows } = await db.pool.query(
      `SELECT status, attempts, failure_reason, finished_at, next_attempt_at,
              on_uncertain, recipients, envelope, body_ciphertext
         FROM mail_jobs WHERE id = $1`,
      [id],
    );
    return rows[0];
  }

  /** 점유한 작업에 결과를 기록한다. */
  async function complete(id: string, outcome: AttemptOutcome) {
    const job = await claimOne(id);
    return completeAttempt(
      db.pool,
      { id, leaseToken: job.leaseToken },
      outcome,
      deps,
    );
  }

  /** 점유한 작업의 lease를 지나게 하고 회수 경로(`recoverExpiredLeases`)를 직접 돌린다. */
  async function recoverAfterLeaseExpiry(id: string): Promise<JobTransition[]> {
    await claimOne(id);
    await db.pool.query(
      "UPDATE mail_jobs SET lease_until = now() - interval '1 second' WHERE id = $1",
      [id],
    );
    const transitions: JobTransition[] = [];
    const recovered = await recoverExpiredLeases(db.pool, deps, 100, {
      onRecovered: (t) => transitions.push(...t),
    });
    expect(recovered).toBe(1);
    return transitions;
  }

  describe("등록 때 고정(RQ-073)", () => {
    it("생략하면 retry이고 retry·fail 명시는 그 값이 저장된다", async () => {
      const omitted = await create();
      const retry = await create("retry");
      const fail = await create("fail");

      expect((await jobRow(omitted)).on_uncertain).toBe("retry");
      expect((await jobRow(retry)).on_uncertain).toBe("retry");
      expect((await jobRow(fail)).on_uncertain).toBe("fail");
    });

    it("같은 Key의 재등록은 기존 행의 값을 바꾸지 않는다", async () => {
      const input = jobInput({ onUncertain: "fail" });
      const first = await register(db.pool, registerDeps, input);
      if (first.kind !== "created") throw new Error("신규 등록이어야 한다");

      // 같은 지문(canonicalRequest)이면 값이 달라도 중복이다. 판정은 지문이 하고 큐는 기존 행을 바꾸지 않는다.
      const again = await register(db.pool, registerDeps, {
        ...input,
        onUncertain: "retry",
      });

      expect(again).toMatchObject({ kind: "duplicate", jobId: first.jobId });
      expect((await jobRow(first.jobId)).on_uncertain).toBe("fail");
    });

    it("컬럼 없이 만든 구버전 행(INSERT에 on_uncertain 없음)은 retry로 취급한다", async () => {
      const { rows } = await db.pool.query<{ id: string }>(
        `INSERT INTO mail_jobs
           (id, caller_id, idempotency_key, fingerprint, fingerprint_key_version, recipients, expires_at)
         VALUES (gen_random_uuid(), 'caller-a', 'legacy-row', '\\x00', 1, $1::jsonb, now() + interval '1 day')
         RETURNING id`,
        [JSON.stringify(RECIPIENTS)],
      );
      const id = rows[0]!.id;
      expect((await jobRow(id)).on_uncertain).toBe("retry");

      const result = await complete(id, DATA_NO_RESPONSE);

      expect(result).toMatchObject({ applied: true, status: "RETRY_WAIT" });
    });
  });

  describe("결과 기록(completeAttempt): DATA 단계 응답 없는 TRANSIENT", () => {
    it("retry(기본)는 RETRY_WAIT이다(회귀)", async () => {
      for (const policy of [undefined, "retry"] as const) {
        const id = await create(policy);
        const result = await complete(id, DATA_NO_RESPONSE);
        expect(result).toMatchObject({ applied: true, status: "RETRY_WAIT" });
        const row = await jobRow(id);
        expect(row.failure_reason).toBeNull();
        expect(row.finished_at).toBeNull();
      }
    });

    it("fail이면 FAILED·OUTCOME_UNKNOWN으로 종결하고 이벤트·시도 기록을 같은 트랜잭션에서 쓴다", async () => {
      const id = await create("fail");

      const result = await complete(id, DATA_NO_RESPONSE);

      expect(result).toMatchObject({
        applied: true,
        status: "FAILED",
        nextAttemptAt: null,
        outcomeUnknown: true,
      });
      const row = await jobRow(id);
      expect(row).toMatchObject({
        status: "FAILED",
        attempts: 1,
        failure_reason: "OUTCOME_UNKNOWN",
      });
      expect(row.finished_at).toBeInstanceOf(Date);

      const events = await db.pool.query(
        "SELECT type, failure_reason, failure_detail, attempt_count, recipients FROM mail_events WHERE job_id = $1",
        [id],
      );
      expect(events.rows).toEqual([
        {
          type: "JOB_FAILED",
          failure_reason: "OUTCOME_UNKNOWN",
          failure_detail: null,
          attempt_count: 1,
          recipients: RECIPIENTS,
        },
      ]);
      const attempts = await db.pool.query(
        "SELECT classification, counted, stage, response_code FROM mail_attempts WHERE job_id = $1",
        [id],
      );
      expect(attempts.rows).toEqual([
        {
          classification: "TRANSIENT",
          counted: true,
          stage: "DATA",
          response_code: null,
        },
      ]);
    });

    it("종결 UPDATE가 본문·수신자·봉투를 비운다(RQ-071과 같은 문장)", async () => {
      const id = await create("fail");
      await complete(id, DATA_NO_RESPONSE);

      const row = await jobRow(id);
      expect(row.body_ciphertext).toBeNull();
      expect(row.recipients).toEqual({});
      expect(row.envelope).toEqual({});
    });

    it("조회(findJobById)는 FAILED·OUTCOME_UNKNOWN·outcomeUncertain true다", async () => {
      const id = await create("fail");
      await complete(id, DATA_NO_RESPONSE);

      const view = await findJobById(db.pool, "caller-a", id);

      expect(view).toMatchObject({
        status: "FAILED",
        failureReason: "OUTCOME_UNKNOWN",
        outcomeUncertain: true,
        attempts: 1,
      });
    });
  });

  describe("두 조건 밖의 결과는 fail이어도 기존 판정이다", () => {
    it.each<[string, AttemptOutcome, string, string | null]>([
      [
        "DATA 단계 451(응답 코드 있음)",
        { classification: "TRANSIENT", stage: "DATA", responseCode: 451 },
        "RETRY_WAIT",
        null,
      ],
      [
        "DATA 이전 단계의 연결 오류",
        { classification: "TRANSIENT", stage: "CONN" },
        "RETRY_WAIT",
        null,
      ],
      [
        "내부 오류 TRANSIENT(SMTP에 닿기 전)",
        { classification: "TRANSIENT", internal: true, stage: "WORKER" },
        "RETRY_WAIT",
        null,
      ],
      [
        "DATA 단계 550(영구 오류)",
        { classification: "PERMANENT", stage: "DATA", responseCode: 550 },
        "FAILED",
        "PERMANENT",
      ],
      [
        "내부 오류 PERMANENT",
        { classification: "PERMANENT", internal: true, stage: "WORKER" },
        "FAILED",
        "PERMANENT",
      ],
      [
        "계정 상태 오류(차단기가 closed로 남음)",
        {
          classification: "ACCOUNT",
          reason: "OTHER",
          afterMailFrom: false,
          stage: "DATA",
        },
        "RETRY_WAIT",
        null,
      ],
      ["성공", { classification: "SENT", stage: "DATA" }, "SENT", null],
    ])("%s", async (_name, outcome, status, failureReason) => {
      const id = await create("fail");

      const result = await complete(id, outcome);

      expect(result).toMatchObject({ applied: true, status });
      expect(result).not.toHaveProperty("outcomeUnknown");
      expect((await jobRow(id)).failure_reason).toBe(failureReason);
    });
  });

  describe("lease 회수(recoverExpiredLeases)", () => {
    it("retry는 RETRY_WAIT이고 fail은 FAILED·OUTCOME_UNKNOWN이며 LEASE_EXPIRED 시도는 횟수에 포함한다", async () => {
      const retryId = await create("retry");
      const retryTransitions = await recoverAfterLeaseExpiry(retryId);
      expect(retryTransitions).toEqual([
        { callerId: "caller-a", accountId: "default", status: "RETRY_WAIT" },
      ]);
      expect(await jobRow(retryId)).toMatchObject({
        status: "RETRY_WAIT",
        attempts: 1,
        failure_reason: null,
      });

      const failId = await create("fail");
      const failTransitions = await recoverAfterLeaseExpiry(failId);
      expect(failTransitions).toEqual([
        {
          callerId: "caller-a",
          accountId: "default",
          status: "FAILED",
          outcomeUnknown: true,
        },
      ]);
      expect(await jobRow(failId)).toMatchObject({
        status: "FAILED",
        attempts: 1,
        failure_reason: "OUTCOME_UNKNOWN",
      });
      const attempts = await db.pool.query(
        "SELECT classification, counted FROM mail_attempts WHERE job_id = $1",
        [failId],
      );
      expect(attempts.rows).toEqual([
        { classification: "LEASE_EXPIRED", counted: true },
      ]);
      const events = await db.pool.query(
        "SELECT type, failure_reason, recipients FROM mail_events WHERE job_id = $1",
        [failId],
      );
      expect(events.rows).toEqual([
        {
          type: "JOB_FAILED",
          failure_reason: "OUTCOME_UNKNOWN",
          recipients: RECIPIENTS,
        },
      ]);
    });

    it("claim 앞단의 lease 회수도 같은 판정이다(회수 경로가 둘이어도 판정은 한 곳)", async () => {
      const id = await create("fail");
      await claimOne(id);
      await db.pool.query(
        "UPDATE mail_jobs SET lease_until = now() - interval '1 second' WHERE id = $1",
        [id],
      );
      const seen: JobTransition[] = [];

      expect(
        await claim(db.pool, {
          ...claimOpts,
          onLeaseRecovered: (t) => seen.push(...t),
        }),
      ).toEqual([]);

      expect(await jobRow(id)).toMatchObject({
        status: "FAILED",
        failure_reason: "OUTCOME_UNKNOWN",
      });
      expect(seen).toMatchObject([{ status: "FAILED", outcomeUnknown: true }]);
    });
  });

  describe("우선순위: OUTCOME_UNKNOWN이 소진·만료보다 먼저다(결정 8)", () => {
    async function nearLastAttempt(id: string): Promise<void> {
      // maxAttempts 3에서 이번 시도가 마지막이 되도록 앞선 시도 2회를 센 상태로 만든다.
      await db.pool.query("UPDATE mail_jobs SET attempts = 2 WHERE id = $1", [
        id,
      ]);
    }
    async function expireNow(id: string): Promise<void> {
      await db.pool.query(
        "UPDATE mail_jobs SET expires_at = now() - interval '1 second' WHERE id = $1",
        [id],
      );
    }

    it("마지막 시도가 불명이면 fail은 OUTCOME_UNKNOWN이고 retry는 ATTEMPTS_EXHAUSTED다", async () => {
      const failId = await create("fail");
      await nearLastAttempt(failId);
      await complete(failId, DATA_NO_RESPONSE);
      expect(await jobRow(failId)).toMatchObject({
        status: "FAILED",
        attempts: 3,
        failure_reason: "OUTCOME_UNKNOWN",
      });

      const retryId = await create("retry");
      await nearLastAttempt(retryId);
      await complete(retryId, DATA_NO_RESPONSE);
      expect(await jobRow(retryId)).toMatchObject({
        status: "FAILED",
        attempts: 3,
        failure_reason: "ATTEMPTS_EXHAUSTED",
      });
    });

    it("전송 중에 만료 시각이 지난 불명이면 fail은 OUTCOME_UNKNOWN이고 retry는 EXPIRED다", async () => {
      const failId = await create("fail");
      const failJob = await claimOne(failId);
      await expireNow(failId);
      await completeAttempt(
        db.pool,
        { id: failId, leaseToken: failJob.leaseToken },
        DATA_NO_RESPONSE,
        deps,
      );
      expect(await jobRow(failId)).toMatchObject({
        status: "FAILED",
        failure_reason: "OUTCOME_UNKNOWN",
      });

      const retryId = await create("retry");
      const retryJob = await claimOne(retryId);
      await expireNow(retryId);
      await completeAttempt(
        db.pool,
        { id: retryId, leaseToken: retryJob.leaseToken },
        DATA_NO_RESPONSE,
        deps,
      );
      expect(await jobRow(retryId)).toMatchObject({
        status: "EXPIRED",
        failure_reason: "EXPIRED",
      });
    });

    it("lease 회수 경로도 소진·만료보다 OUTCOME_UNKNOWN이 먼저다", async () => {
      const exhausted = await create("fail");
      await nearLastAttempt(exhausted);
      await recoverAfterLeaseExpiry(exhausted);
      expect(await jobRow(exhausted)).toMatchObject({
        status: "FAILED",
        attempts: 3,
        failure_reason: "OUTCOME_UNKNOWN",
      });

      const expired = await create("fail");
      await claimOne(expired);
      await db.pool.query(
        `UPDATE mail_jobs SET lease_until = now() - interval '2 second',
                expires_at = now() - interval '1 second' WHERE id = $1`,
        [expired],
      );
      await recoverExpiredLeases(db.pool, deps);
      expect(await jobRow(expired)).toMatchObject({
        status: "FAILED",
        failure_reason: "OUTCOME_UNKNOWN",
      });
    });

    it("불명이 아닌 결과는 fail이어도 소진은 ATTEMPTS_EXHAUSTED, 만료는 EXPIRED다", async () => {
      const exhausted = await create("fail");
      await nearLastAttempt(exhausted);
      await complete(exhausted, { classification: "TRANSIENT", stage: "RCPT" });
      expect(await jobRow(exhausted)).toMatchObject({
        status: "FAILED",
        failure_reason: "ATTEMPTS_EXHAUSTED",
      });

      const expired = await create("fail");
      const job = await claimOne(expired);
      await expireNow(expired);
      await completeAttempt(
        db.pool,
        { id: expired, leaseToken: job.leaseToken },
        { classification: "TRANSIENT", stage: "RCPT" },
        deps,
      );
      expect(await jobRow(expired)).toMatchObject({
        status: "EXPIRED",
        failure_reason: "EXPIRED",
      });
    });
  });

  describe("차단기 영향은 retry와 같다(ADR-0015 결정 8, ADR-0007 결정 4·5)", () => {
    /** 차단기를 열고 대표 작업(`policy`)을 점유한 half_open 상태를 만든다. 대표가 아닌 작업 하나를 먼저 열린 상태로 둔다. */
    async function halfOpenProbe(policy: OnUncertain): Promise<ClaimedJob> {
      const tripper = await create("retry");
      const probeId = await create(policy);
      const trip = await claimOne(tripper);
      await completeAttempt(
        db.pool,
        { id: tripper, leaseToken: trip.leaseToken },
        {
          classification: "ACCOUNT",
          reason: "RATE_LIMIT",
          afterMailFrom: false,
        },
        deps,
      );
      await db.pool.query(
        "UPDATE mail_circuit_breaker SET open_until = now() - interval '1 second' WHERE state = 'open'",
      );
      const probe = await claimOne(probeId);
      expect(probe.isProbe).toBe(true);
      return probe;
    }

    it.each<OnUncertain>(["retry", "fail"])(
      "%s 대표 작업의 DATA 단계 불명 TRANSIENT는 계정이 응답한 것이라 차단기를 closed로 닫는다",
      async (policy) => {
        const probe = await halfOpenProbe(policy);

        const result = await completeAttempt(
          db.pool,
          { id: probe.id, leaseToken: probe.leaseToken },
          DATA_NO_RESPONSE,
          deps,
        );

        expect(result).toMatchObject({
          applied: true,
          status: policy === "fail" ? "FAILED" : "RETRY_WAIT",
        });
        const state = await breaker();
        expect(state.state).toBe("closed");
        expect(state.probeJobId).toBeNull();
        expect(state.consecutiveFailures).toBe(0);
      },
    );

    it.each<OnUncertain>(["retry", "fail"])(
      "%s 대표 작업의 lease 회수(LEASE_EXPIRED)는 차단기를 건드리지 않는다: half_open과 대표 작업이 그대로다",
      async (policy) => {
        const probe = await halfOpenProbe(policy);
        const before = await breaker();
        await db.pool.query(
          "UPDATE mail_jobs SET lease_until = now() - interval '1 second' WHERE id = $1",
          [probe.id],
        );

        await recoverExpiredLeases(db.pool, deps);

        const after = await breaker();
        expect(after.state).toBe("half_open");
        expect(after.probeJobId).toBe(probe.id);
        expect(after.consecutiveFailures).toBe(before.consecutiveFailures);
        expect((await jobRow(probe.id)).status).toBe(
          policy === "fail" ? "FAILED" : "RETRY_WAIT",
        );
      },
    );

    it.each<OnUncertain>(["retry", "fail"])(
      "%s 대표 작업이 내부 오류 TRANSIENT로 끝나면 closed로 돌아가지 않는다(internal은 불명이 아니다)",
      async (policy) => {
        const probe = await halfOpenProbe(policy);

        const result = await completeAttempt(
          db.pool,
          { id: probe.id, leaseToken: probe.leaseToken },
          { classification: "TRANSIENT", internal: true, stage: "WORKER" },
          deps,
        );

        expect(result).toMatchObject({ applied: true, status: "RETRY_WAIT" });
        const state = await breaker();
        expect(state.state).toBe("half_open");
        expect(state.probeJobId).toBe(probe.id);
      },
    );

    it("closed 차단기의 연속 실패 수는 불명 TRANSIENT가 retry·fail 모두에서 0으로 되돌린다", async () => {
      for (const policy of ["retry", "fail"] as const) {
        await db.pool.query(
          "UPDATE mail_circuit_breaker SET consecutive_failures = 2",
        );
        const id = await create(policy);
        await complete(id, DATA_NO_RESPONSE);
        expect((await breaker()).consecutiveFailures).toBe(0);
      }
    });
  });

  describe("판정 함수와 읽기 SQL의 일치(ADR-0015 결정 5)", () => {
    // `isUncertainOutcome`과 `outcomeUncertain` 도출 SQL이 같은 시도에서 같은 값을 내는지 본다.
    // 시도 행은 `completeAttempt`가 쓴 것과 같은 열 값이다(응답 코드가 없으면 NULL).
    const SHAPES: Array<
      [string, AttemptOutcome | { classification: "LEASE_EXPIRED" }]
    > = [
      ["LEASE_EXPIRED", { classification: "LEASE_EXPIRED" }],
      ["DATA 응답 없음", DATA_NO_RESPONSE],
      [
        "DATA 451",
        { classification: "TRANSIENT", stage: "DATA", responseCode: 451 },
      ],
      ["CONN", { classification: "TRANSIENT", stage: "CONN" }],
      ["RCPT", { classification: "TRANSIENT", stage: "RCPT" }],
      [
        "WORKER 내부 오류",
        { classification: "TRANSIENT", internal: true, stage: "WORKER" },
      ],
      [
        "DATA 550",
        { classification: "PERMANENT", stage: "DATA", responseCode: 550 },
      ],
      [
        "ACCOUNT",
        {
          classification: "ACCOUNT",
          reason: "AUTH",
          afterMailFrom: false,
          stage: "AUTH",
        },
      ],
      ["SENT", { classification: "SENT", stage: "DATA", responseCode: 250 }],
    ];

    it.each(SHAPES)("%s", async (_name, outcome) => {
      const id = await create();
      const detail = outcome as AttemptOutcome;
      await db.pool.query(
        `INSERT INTO mail_attempts (job_id, classification, counted, stage, response_code, started_at)
         VALUES ($1, $2, true, $3, $4, now())`,
        [
          id,
          outcome.classification,
          "stage" in detail ? (detail.stage ?? null) : null,
          "responseCode" in detail ? (detail.responseCode ?? null) : null,
        ],
      );
      const { rows } = await db.pool.query<{ uncertain: boolean }>(
        `SELECT ${UNCERTAIN_ATTEMPT_SQL} AS uncertain FROM mail_attempts a WHERE a.job_id = $1`,
        [id],
      );

      expect(rows[0]!.uncertain).toBe(isUncertainOutcome(outcome));
    });
  });
});
